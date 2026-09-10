/**
 * Model training.
 *
 * Trains the ML component and fits the probability calibrator, both strictly
 * out of sample:
 *
 *  1. Matches are ordered by kickoff and split chronologically.
 *  2. The ML model is fitted on the earlier block only.
 *  3. The calibrator is fitted on predictions the ML model has never seen.
 *
 * Training and evaluating on the same data would produce a model that looks
 * excellent and predicts badly, so the split is enforced here rather than left
 * to the caller.
 */

import { prisma } from '../db/prisma';
import { getSportModule } from '../prediction/sports/registry';
import { fitCalibration, type CalibrationSample } from '../prediction/math/calibration';
import { trainWithValidation, type TrainingSample } from '../prediction/models/mlModel';
import { blendComponents, fitEnsembleWeights, type ComponentSample } from '../prediction/ensemble';
import type { ModelParameters, SportKey } from '../prediction/types';
import { buildLeagueBaseline, buildMatchContext, buildRatingsAsOf } from './context';
import { getActiveModelVersion, loadModelParameters, saveModelParameters } from './modelVersions';
import { FOOTBALL_ML_FEATURES } from '../prediction/sports/football';

/** Share of the history used to fit the ML model; the rest calibrates. */
const TRAIN_SPLIT = 0.7;
/** Minimum finished matches before training is attempted at all. */
const MIN_MATCHES = 80;
/** Half-life in days for training-sample recency weights. */
const SAMPLE_HALF_LIFE_DAYS = 240;

/** Feature sets consumed by each sport's ML component. */
const ML_FEATURES: Record<SportKey, readonly string[]> = {
  football: FOOTBALL_ML_FEATURES,
  tennis: ['elo_diff', 'form_diff', 'h2h_home_share', 'rest_diff', 'home_win_rate', 'away_win_rate'],
  basketball: ['elo_diff', 'form_diff', 'offence_diff', 'defence_diff', 'home_venue_edge', 'away_venue_edge', 'rest_diff', 'availability_diff'],
};

export interface TrainingResult {
  readonly sportKey: SportKey;
  readonly modelVersionId: string;
  readonly trainingSamples: number;
  readonly calibrationSamples: number;
  readonly mlTrained: boolean;
  readonly calibrationFitted: boolean;
  readonly weightsFitted: boolean;
  readonly ensembleWeights: Readonly<Record<string, number>>;
  /** Held-out skill of each component over the base rate. */
  readonly componentSkill: Readonly<Record<string, number>>;
  readonly trainedThrough: Date | null;
}

export async function trainSport(sportKey: SportKey): Promise<TrainingResult> {
  const sportModule = getSportModule(sportKey);
  const modelVersion = await getActiveModelVersion(sportKey);
  const baseParameters = loadModelParameters(modelVersion, sportKey);

  const matches = await prisma.match.findMany({
    where: { sport: { key: sportKey }, status: 'FINISHED', homeScore: { not: null } },
    include: {
      league: { select: { id: true, key: true, name: true, strength: true } },
      sport: { select: { key: true } },
    },
    orderBy: { kickoff: 'asc' },
  });

  if (matches.length < MIN_MATCHES) {
    return {
      sportKey,
      modelVersionId: modelVersion.id,
      trainingSamples: 0,
      calibrationSamples: 0,
      mlTrained: false,
      calibrationFitted: false,
      weightsFitted: false,
      ensembleWeights: baseParameters.ensembleWeights,
      componentSkill: {},
      trainedThrough: null,
    };
  }

  const splitIndex = Math.floor(matches.length * TRAIN_SPLIT);
  const trainMatches = matches.slice(0, splitIndex);
  const calibrationMatches = matches.slice(splitIndex);
  const featureNames = ML_FEATURES[sportKey];
  const newest = matches[matches.length - 1].kickoff.getTime();

  // Ratings and baselines are rebuilt at each match's own kickoff, so a training
  // sample only ever sees what was knowable at the time.
  const ratingCache = new Map<string, Awaited<ReturnType<typeof buildRatingsAsOf>>>();
  const baselineCache = new Map<string, Awaited<ReturnType<typeof buildLeagueBaseline>>>();
  const cacheKey = (leagueId: string, at: Date) =>
    `${leagueId}:${Math.floor(at.getTime() / (7 * 86_400_000))}`;

  const buildSample = async (match: (typeof matches)[number]) => {
    const asOf = match.kickoff;
    const key = cacheKey(match.leagueId, asOf);
    let ratings = ratingCache.get(key);
    if (!ratings) {
      ratings = await buildRatingsAsOf(match.leagueId, asOf, sportKey);
      ratingCache.set(key, ratings);
    }
    let baseline = baselineCache.get(key);
    if (!baseline) {
      baseline = await buildLeagueBaseline(match.leagueId, asOf);
      baselineCache.set(key, baseline);
    }
    const ctx = await buildMatchContext(match, { asOf, ratings, leagueBaseline: baseline });
    return { ctx, match };
  };

  // ----- Stage 1: fit the ML component on the earlier block -----
  const trainingSamples: TrainingSample[] = [];
  for (const match of trainMatches) {
    if (match.homeScore === null || match.awayScore === null) continue;
    const { ctx } = await buildSample(match);
    if (ctx.home.recentMatches.length < 3 || ctx.away.recentMatches.length < 3) continue;

    const features = sportModule.buildFeatures(ctx, baseParameters);
    const label = sportModule.classes.indexOf(
      sportModule.resultClass({ homeScore: match.homeScore, awayScore: match.awayScore }),
    );
    if (label < 0) continue;

    // Older matches count for less, matching how the form model treats them.
    const ageDays = (newest - match.kickoff.getTime()) / 86_400_000;
    trainingSamples.push({
      features: featureNames.map((name) => features.byName[name] ?? 0),
      label,
      weight: Math.exp((-Math.log(2) * ageDays) / SAMPLE_HALF_LIFE_DAYS),
    });
  }

  // Sports whose ensemble excludes the learned component skip the fit entirely.
  const ml = sportModule.usesMl
    ? trainWithValidation(trainingSamples, featureNames, sportModule.classes)
    : null;
  const withMl: ModelParameters = { ...baseParameters, ml, calibration: null };

  // ----- Stage 2: score every component on the held-out block -----
  // Each held-out match is evaluated once; the per-component scores fit the
  // ensemble weights and the blended output fits the calibrator.
  const componentSamples: ComponentSample[] = [];
  const heldOut: Array<{ components: ReturnType<typeof sportModule.predict>['components']; actual: number }> = [];

  for (const match of calibrationMatches) {
    if (match.homeScore === null || match.awayScore === null) continue;
    const { ctx } = await buildSample(match);
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
          component.outcomes.find((o) => o.market === 'MATCH_WINNER' && o.selection === selection)
            ?.probability ?? 0,
      );
      if (probabilities.some((p) => p <= 0)) continue;
      componentSamples.push({ component: component.component, probabilities, actual });
    }
    heldOut.push({ components, actual });
  }

  // ----- Stage 3: fit ensemble weights, then calibrate the weighted blend -----
  const { weights: ensembleWeights, fitted: weightsFitted, skill } = fitEnsembleWeights(
    componentSamples,
    baseParameters.ensembleWeights,
  );
  const withWeights: ModelParameters = { ...withMl, ensembleWeights };

  const calibrationSamples: CalibrationSample[] = [];
  for (const { components, actual } of heldOut) {
    const reweighted = components.map((component) => ({
      ...component,
      weight: ensembleWeights[component.component] ?? 0,
    }));
    const ensemble = blendComponents(reweighted);
    const probabilities = sportModule.classes.map(
      (selection) =>
        ensemble.outcomes.find((o) => o.market === 'MATCH_WINNER' && o.selection === selection)
          ?.probability ?? 0,
    );
    if (probabilities.some((p) => p <= 0)) continue;
    calibrationSamples.push({ probabilities, actual });
  }

  const calibration = fitCalibration(calibrationSamples, sportModule.classes);
  const trained: ModelParameters = { ...withWeights, calibration };

  await saveModelParameters(modelVersion.id, trained, {
    trainedThrough: matches[splitIndex - 1]?.kickoff,
    trainingSampleSize: trainingSamples.length,
  });

  return {
    sportKey,
    modelVersionId: modelVersion.id,
    trainingSamples: trainingSamples.length,
    calibrationSamples: calibrationSamples.length,
    mlTrained: ml !== null,
    calibrationFitted: calibration.fittedOn > 0,
    weightsFitted: weightsFitted,
    ensembleWeights,
    componentSkill: skill,
    trainedThrough: matches[splitIndex - 1]?.kickoff ?? null,
  };
}

export async function trainAllSports(): Promise<TrainingResult[]> {
  const sports = await prisma.sport.findMany({ where: { active: true } });
  const results: TrainingResult[] = [];
  for (const sport of sports) {
    results.push(await trainSport(sport.key as SportKey));
  }
  return results;
}
