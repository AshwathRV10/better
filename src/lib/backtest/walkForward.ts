/**
 * Walk-forward backtesting.
 *
 * The only defensible way to evaluate a sports model is to make it predict
 * matches it was not trained on, in the order they happened:
 *
 *   for each test window:
 *     train on everything strictly before the window
 *     predict every match inside the window
 *     record the result
 *     advance
 *
 * Three specific leaks are prevented by construction:
 *
 *  1. Ratings, form and league baselines are rebuilt at each match's own
 *     kickoff, so a prediction never sees a later result.
 *  2. The ML model and calibrator are refitted per window from matches before
 *     that window only.
 *  3. Odds are filtered to quotes captured before kickoff, so a closing price
 *     can never inform a pre-match prediction.
 */

import { prisma } from '../db/prisma';
import { getSportModule } from '../prediction/sports/registry';
import { blendComponents, fitEnsembleWeights, type ComponentSample } from '../prediction/ensemble';
import { applyCalibration, fitCalibration, type CalibrationSample } from '../prediction/math/calibration';
import { trainWithValidation, type TrainingSample } from '../prediction/models/mlModel';
import type { ModelParameters, SportKey } from '../prediction/types';
import { buildLeagueBaseline, buildMatchContext, buildRatingsAsOf } from '../services/context';
import { getActiveModelVersion, loadModelParameters } from '../services/modelVersions';
import { evaluate, evaluateBetting, type BettingMetrics, type EvaluationMetrics, type ScoredPrediction } from './metrics';
import { removeMargin } from '../odds';

export interface BacktestConfig {
  readonly sportKey: SportKey;
  readonly leagueKey?: string;
  /** Matches used to fit before the first prediction is scored. */
  readonly initialTrainingSize?: number;
  /** Matches predicted per window before refitting. */
  readonly stepSize?: number;
  /** Only back selections with at least this model EV, when scoring ROI. */
  readonly minimumExpectedValue?: number;
  readonly stake?: number;
  /** Feature names the ML component consumes for this sport. */
  readonly mlFeatures?: readonly string[];
}

export interface BacktestResult {
  readonly config: Required<Omit<BacktestConfig, 'leagueKey' | 'mlFeatures'>> & {
    leagueKey: string | null;
  };
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly windows: number;
  readonly metrics: EvaluationMetrics;
  readonly betting: BettingMetrics;
  /** Metrics for the market's own margin-free probabilities, where available. */
  readonly marketBaseline: EvaluationMetrics | null;
  readonly perLeague: Array<{ leagueKey: string; metrics: EvaluationMetrics }>;
  /**
   * Each sub-model scored on its own. Shows whether a component earns its place
   * in the ensemble or is diluting it.
   */
  readonly perComponent: Array<{ component: string; weight: number; metrics: EvaluationMetrics }>;
}

const DEFAULT_INITIAL_TRAINING = 120;
const DEFAULT_STEP = 40;

/** Feature sets consumed by each sport's ML component. */
export const BACKTEST_ML_FEATURES: Record<SportKey, readonly string[]> = {
  football: ['elo_diff', 'form_diff', 'attack_diff', 'defence_diff', 'home_venue_edge', 'away_venue_edge', 'h2h_home_share', 'rest_diff', 'availability_diff', 'league_home_bias'],
  tennis: ['elo_diff', 'form_diff', 'h2h_home_share', 'rest_diff', 'home_win_rate', 'away_win_rate'],
  basketball: ['elo_diff', 'form_diff', 'offence_diff', 'defence_diff', 'home_venue_edge', 'away_venue_edge', 'rest_diff', 'availability_diff'],
};

export async function runBacktest(config: BacktestConfig): Promise<BacktestResult> {
  const sportModule = getSportModule(config.sportKey);
  const initialTrainingSize = config.initialTrainingSize ?? DEFAULT_INITIAL_TRAINING;
  const stepSize = config.stepSize ?? DEFAULT_STEP;
  const minimumExpectedValue = config.minimumExpectedValue ?? 0.02;
  const stake = config.stake ?? 1;
  const mlFeatures = config.mlFeatures ?? BACKTEST_ML_FEATURES[config.sportKey];

  const matches = await prisma.match.findMany({
    where: {
      sport: { key: config.sportKey },
      status: 'FINISHED',
      homeScore: { not: null },
      ...(config.leagueKey ? { league: { key: config.leagueKey } } : {}),
    },
    include: {
      league: { select: { id: true, key: true, name: true, strength: true } },
      sport: { select: { key: true } },
    },
    orderBy: { kickoff: 'asc' },
  });

  if (matches.length <= initialTrainingSize) {
    throw new Error(
      `Not enough finished matches to backtest ${config.sportKey}: ` +
        `${matches.length} available, at least ${initialTrainingSize + 1} required.`,
    );
  }

  const modelVersion = await getActiveModelVersion(config.sportKey);
  const baseParameters = loadModelParameters(modelVersion, config.sportKey);

  // Contexts are built once per match and reused across windows. Each is built
  // at its own kickoff, so this caching cannot leak anything forward.
  const ratingCache = new Map<string, Awaited<ReturnType<typeof buildRatingsAsOf>>>();
  const baselineCache = new Map<string, Awaited<ReturnType<typeof buildLeagueBaseline>>>();
  const cacheKey = (leagueId: string, at: Date) =>
    `${leagueId}:${Math.floor(at.getTime() / (7 * 86_400_000))}`;

  const contexts = new Map<string, Awaited<ReturnType<typeof buildMatchContext>>>();
  for (const match of matches) {
    const asOf = match.kickoff;
    const key = cacheKey(match.leagueId, asOf);
    let ratings = ratingCache.get(key);
    if (!ratings) {
      ratings = await buildRatingsAsOf(match.leagueId, asOf, config.sportKey);
      ratingCache.set(key, ratings);
    }
    let baseline = baselineCache.get(key);
    if (!baseline) {
      baseline = await buildLeagueBaseline(match.leagueId, asOf);
      baselineCache.set(key, baseline);
    }
    contexts.set(match.id, await buildMatchContext(match, { asOf, ratings, leagueBaseline: baseline }));
  }

  const scored: ScoredPrediction[] = [];
  const marketScored: ScoredPrediction[] = [];
  const componentScored = new Map<string, { weight: number; samples: ScoredPrediction[] }>();
  let windows = 0;

  for (let start = initialTrainingSize; start < matches.length; start += stepSize) {
    const trainSlice = matches.slice(0, start);
    const testSlice = matches.slice(start, start + stepSize);
    if (testSlice.length === 0) break;
    windows += 1;

    // ---- Refit on everything strictly before this window ----
    // The training block is split again: the ML model is fitted on the earlier
    // part and the ensemble weights and calibrator on the later part. Scoring a
    // component on data it was fitted on would hand the weight to whichever
    // component overfits hardest rather than to the one that generalises.
    const stackSize = Math.max(40, Math.floor(trainSlice.length * 0.3));
    const mlTrainSlice = trainSlice.slice(0, Math.max(1, trainSlice.length - stackSize));
    const stackSlice = trainSlice.slice(mlTrainSlice.length);

    const trainingSamples: TrainingSample[] = [];
    const newest = mlTrainSlice[mlTrainSlice.length - 1].kickoff.getTime();
    for (const match of mlTrainSlice) {
      const ctx = contexts.get(match.id);
      if (!ctx || match.homeScore === null || match.awayScore === null) continue;
      if (ctx.home.recentMatches.length < 3 || ctx.away.recentMatches.length < 3) continue;
      const features = sportModule.buildFeatures(ctx, baseParameters);
      const label = sportModule.classes.indexOf(
        sportModule.resultClass({ homeScore: match.homeScore, awayScore: match.awayScore }),
      );
      if (label < 0) continue;
      const ageDays = (newest - match.kickoff.getTime()) / 86_400_000;
      trainingSamples.push({
        features: mlFeatures.map((name) => features.byName[name] ?? 0),
        label,
        weight: Math.exp((-Math.log(2) * ageDays) / 240),
      });
    }

    const ml = trainWithValidation(trainingSamples, mlFeatures, sportModule.classes);
    const withMl: ModelParameters = { ...baseParameters, ml, calibration: null };

    // Calibrate on the most recent slice of the training block. It is still
    // strictly in the past, but the ML model was fitted on all of it, so this is
    // the one place the two stages overlap; the calibration parameters are few
    // enough (k+1) that this cannot meaningfully overfit.
    const calibrationSlice = stackSlice;
    const componentSamples: ComponentSample[] = [];
    const heldOut: Array<{ components: ReturnType<typeof sportModule.predict>['components']; actual: number }> = [];

    for (const match of calibrationSlice) {
      const ctx = contexts.get(match.id);
      if (!ctx || match.homeScore === null || match.awayScore === null) continue;
      if (ctx.home.recentMatches.length < 3 || ctx.away.recentMatches.length < 3) continue;
      const features = sportModule.buildFeatures(ctx, withMl);
      const { components } = sportModule.predict(ctx, features, withMl);
      const actual = sportModule.classes.indexOf(
        sportModule.resultClass({ homeScore: match.homeScore, awayScore: match.awayScore }),
      );
      if (actual < 0) continue;
      for (const component of components) {
        const probabilities = sportModule.classes.map(
          (selection) =>
            component.outcomes.find((o) => o.market === 'MATCH_WINNER' && o.selection === selection)?.probability ?? 0,
        );
        if (probabilities.some((p) => p <= 0)) continue;
        componentSamples.push({ component: component.component, probabilities, actual });
      }
      heldOut.push({ components, actual });
    }

    // Weights are refitted every window from past matches only, exactly as the
    // deployed training pipeline does it.
    const { weights: ensembleWeights } = fitEnsembleWeights(componentSamples, baseParameters.ensembleWeights);

    const calibrationSamples: CalibrationSample[] = [];
    for (const { components, actual } of heldOut) {
      const ensemble = blendComponents(
        components.map((component) => ({ ...component, weight: ensembleWeights[component.component] ?? 0 })),
      );
      const probabilities = sportModule.classes.map(
        (selection) =>
          ensemble.outcomes.find((o) => o.market === 'MATCH_WINNER' && o.selection === selection)?.probability ?? 0,
      );
      if (probabilities.some((p) => p <= 0)) continue;
      calibrationSamples.push({ probabilities, actual });
    }
    const calibration = fitCalibration(calibrationSamples, sportModule.classes);
    const parameters: ModelParameters = { ...baseParameters, ensembleWeights, ml, calibration };

    // ---- Predict the held-out window ----
    for (const match of testSlice) {
      const ctx = contexts.get(match.id);
      if (!ctx || match.homeScore === null || match.awayScore === null) continue;
      const actual = sportModule.classes.indexOf(
        sportModule.resultClass({ homeScore: match.homeScore, awayScore: match.awayScore }),
      );
      if (actual < 0) continue;

      const features = sportModule.buildFeatures(ctx, parameters);
      const { components } = sportModule.predict(ctx, features, parameters);
      const ensemble = blendComponents(components);
      const raw = sportModule.classes.map(
        (selection) =>
          ensemble.outcomes.find((o) => o.market === 'MATCH_WINNER' && o.selection === selection)?.probability ?? 0,
      );
      if (raw.some((p) => p <= 0)) continue;
      const probabilities = applyCalibration(raw, calibration);

      // Best price per selection from quotes captured before kickoff.
      const odds = sportModule.classes.map((selection) => {
        const quotes = ctx.odds.filter(
          (quote) =>
            quote.market === 'MATCH_WINNER' &&
            quote.selection === selection &&
            quote.capturedAt.getTime() <= match.kickoff.getTime(),
        );
        return quotes.length === 0 ? null : Math.max(...quotes.map((q) => q.price));
      });

      scored.push({
        probabilities,
        actual,
        odds,
        kickoff: match.kickoff,
        leagueKey: match.league.key,
      });

      // Score every sub-model on the same fixtures, uncalibrated, so the
      // ensemble can be checked against its own parts.
      for (const component of components) {
        const componentProbabilities = sportModule.classes.map(
          (selection) =>
            component.outcomes.find((o) => o.market === 'MATCH_WINNER' && o.selection === selection)
              ?.probability ?? 0,
        );
        if (componentProbabilities.some((p) => p <= 0)) continue;
        const entry = componentScored.get(component.component) ?? {
          weight: component.weight,
          samples: [],
        };
        entry.samples.push({
          probabilities: componentProbabilities,
          actual,
          kickoff: match.kickoff,
          leagueKey: match.league.key,
        });
        componentScored.set(component.component, entry);
      }

      // The bookmaker's own margin-free view, as a benchmark to beat.
      if (odds.every((price): price is number => price !== null)) {
        marketScored.push({
          probabilities: removeMargin(odds, 'shin'),
          actual,
          kickoff: match.kickoff,
          leagueKey: match.league.key,
        });
      }
    }
  }

  const leagueKeys = [...new Set(scored.map((s) => s.leagueKey).filter((k): k is string => !!k))];

  return {
    config: {
      sportKey: config.sportKey,
      leagueKey: config.leagueKey ?? null,
      initialTrainingSize,
      stepSize,
      minimumExpectedValue,
      stake,
    },
    periodStart: matches[initialTrainingSize].kickoff,
    periodEnd: matches[matches.length - 1].kickoff,
    windows,
    metrics: evaluate(scored),
    betting: evaluateBetting(scored, { minimumExpectedValue, stake }),
    marketBaseline: marketScored.length > 0 ? evaluate(marketScored) : null,
    perLeague: leagueKeys.map((leagueKey) => ({
      leagueKey,
      metrics: evaluate(scored.filter((s) => s.leagueKey === leagueKey)),
    })),
    perComponent: [...componentScored.entries()]
      .map(([component, entry]) => ({
        component,
        weight: entry.weight,
        metrics: evaluate(entry.samples),
      }))
      .sort((a, b) => a.metrics.logLoss - b.metrics.logLoss),
  };
}
