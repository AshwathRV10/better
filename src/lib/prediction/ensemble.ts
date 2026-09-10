/**
 * Ensemble blending.
 *
 * Each sub-model contributes an independent view of the same match. Blending
 * them reduces variance and guards against any single model's structural blind
 * spot (Elo ignores goals; Poisson ignores schedule strength; the ML model
 * ignores anything not in its feature list).
 *
 * Blending is done in probability space with normalised weights, per market and
 * per selection. Components that do not price a market are simply skipped for
 * that market, and the remaining weights are renormalised so the result is
 * always a valid distribution.
 */

import type { ComponentPrediction, EnsembleWeights, OutcomeProbability } from './types';
import { clamp, normalise, safeLog, standardDeviation } from './math/stats';

/** Market groups whose selections form one mutually exclusive distribution. */
function distributionKey(outcome: OutcomeProbability): string {
  return outcome.line === undefined
    ? outcome.market
    : `${outcome.market}@${outcome.line}`;
}

/**
 * Markets whose selections must sum to 1. Correct score is excluded because it
 * is truncated to the top N scores, and Asian handicap because pushes remove
 * mass from the two sides.
 */
const NORMALISED_MARKETS = new Set([
  'MATCH_WINNER',
  'OVER_UNDER',
  'BTTS',
  'SET_WINNER',
  'TOTAL_GAMES',
  'POINT_SPREAD',
  'HANDICAP_GAMES',
]);

export interface EnsembleResult {
  readonly outcomes: readonly OutcomeProbability[];
  /** Per-market spread of the component probabilities; drives model agreement. */
  readonly disagreement: number;
  readonly contributingComponents: readonly string[];
}

/**
 * Weighted blend of component predictions.
 *
 * Components with weight 0 (such as the market component) are reported for
 * comparison but never influence the blended probability - treating bookmaker
 * prices as a model input would make every reported "edge" circular.
 */
export function blendComponents(components: readonly ComponentPrediction[]): EnsembleResult {
  const contributing = components.filter((c) => c.weight > 0);
  if (contributing.length === 0) {
    return { outcomes: [], disagreement: 0, contributingComponents: [] };
  }

  // selectionKey -> { weightedSum, weightTotal, probabilities[] }
  const accumulator = new Map<
    string,
    {
      outcome: OutcomeProbability;
      weightedSum: number;
      weightTotal: number;
      probabilities: number[];
    }
  >();

  for (const component of contributing) {
    for (const outcome of component.outcomes) {
      const key = `${distributionKey(outcome)}|${outcome.selection}`;
      const entry = accumulator.get(key) ?? {
        outcome,
        weightedSum: 0,
        weightTotal: 0,
        probabilities: [],
      };
      entry.weightedSum += outcome.probability * component.weight;
      entry.weightTotal += component.weight;
      entry.probabilities.push(outcome.probability);
      accumulator.set(key, entry);
    }
  }

  const blended: OutcomeProbability[] = [];
  for (const entry of accumulator.values()) {
    const probability = entry.weightTotal > 0 ? entry.weightedSum / entry.weightTotal : 0;
    blended.push({ ...entry.outcome, probability: clamp(probability, 0, 1) });
  }

  // Renormalise each mutually exclusive market so probabilities remain a
  // distribution after blending components with different market coverage.
  const groups = new Map<string, OutcomeProbability[]>();
  for (const outcome of blended) {
    const key = distributionKey(outcome);
    const list = groups.get(key) ?? [];
    list.push(outcome);
    groups.set(key, list);
  }

  const normalised: OutcomeProbability[] = [];
  for (const [key, list] of groups) {
    const market = key.split('@')[0];
    if (NORMALISED_MARKETS.has(market) && list.length > 1) {
      const values = normalise(list.map((o) => o.probability));
      list.forEach((outcome, i) => normalised.push({ ...outcome, probability: values[i] }));
    } else {
      normalised.push(...list);
    }
  }

  // Disagreement is measured on the headline market only, where every component
  // prices every selection.
  const headline = [...accumulator.values()].filter(
    (entry) => entry.outcome.market === 'MATCH_WINNER',
  );
  const disagreement =
    headline.length === 0
      ? 0
      : headline.reduce((sum, entry) => sum + standardDeviation(entry.probabilities), 0) /
        headline.length;

  return {
    outcomes: normalised,
    disagreement,
    contributingComponents: contributing.map((c) => c.component),
  };
}

/** Extracts one market's selections, sorted by probability. */
export function outcomesForMarket(
  outcomes: readonly OutcomeProbability[],
  market: string,
  line?: number,
): OutcomeProbability[] {
  return outcomes
    .filter((o) => o.market === market && (line === undefined || o.line === line))
    .sort((a, b) => b.probability - a.probability);
}

/** The single most likely selection in a market, used for the headline call. */
export function topOutcome(
  outcomes: readonly OutcomeProbability[],
  market = 'MATCH_WINNER',
): OutcomeProbability | null {
  const candidates = outcomesForMarket(outcomes, market);
  return candidates[0] ?? null;
}

/** One component's probabilities on a single settled match. */
export interface ComponentSample {
  readonly component: string;
  /** Probabilities over the sport's classes, in class order. */
  readonly probabilities: readonly number[];
  readonly actual: number;
}

export interface WeightFitOptions {
  /** Minimum settled matches before weights are fitted at all. */
  readonly minSamples?: number;
  /** Floor applied to every component that scores above the baseline. */
  readonly minimumWeight?: number;
  /** Observations at which fitted weights are trusted half as much as measured. */
  readonly priorWeight?: number;
}

/**
 * Fits ensemble weights from held-out performance (stacked generalisation).
 *
 * Each component is scored on matches it did not contribute to fitting, and the
 * weights are set proportional to each component's skill over the base rate.
 * A component with no demonstrated skill gets no weight: an equal-weight
 * ensemble is only optimal when the members are equally good, and they are not.
 *
 * Components must be scored on data they were not trained on, or this degrades
 * into rewarding whichever component overfits hardest. The caller is responsible
 * for that split; `trainSport` and `runBacktest` both enforce it.
 */
export function fitEnsembleWeights(
  samples: readonly ComponentSample[],
  fallback: EnsembleWeights,
  options: WeightFitOptions = {},
): { weights: EnsembleWeights; fitted: boolean; skill: Record<string, number> } {
  const minSamples = options.minSamples ?? 40;
  const minimumWeight = options.minimumWeight ?? 0.05;

  const byComponent = new Map<string, ComponentSample[]>();
  for (const sample of samples) {
    const list = byComponent.get(sample.component) ?? [];
    list.push(sample);
    byComponent.set(sample.component, list);
  }

  const skill: Record<string, number> = {};
  const scores = new Map<string, number>();

  for (const [component, list] of byComponent) {
    // A component only counts if it was scored on enough matches, and the
    // market component never receives weight regardless of how well it scores.
    if (list.length < minSamples || component === 'market') continue;

    const classCount = list[0].probabilities.length;
    const counts = new Array<number>(classCount).fill(0);
    for (const sample of list) counts[sample.actual] += 1;
    const baseRates = counts.map((count) => count / list.length);

    let logLoss = 0;
    let baseline = 0;
    for (const sample of list) {
      logLoss -= safeLog(sample.probabilities[sample.actual]);
      baseline -= safeLog(baseRates[sample.actual]);
    }
    logLoss /= list.length;
    baseline /= list.length;

    const componentSkill = baseline > 0 ? 1 - logLoss / baseline : 0;
    skill[component] = componentSkill;
    if (componentSkill > 0) scores.set(component, componentSkill);
  }

  const total = [...scores.values()].reduce((sum, value) => sum + value, 0);
  if (scores.size === 0 || total <= 0) {
    return { weights: fallback, fitted: false, skill };
  }

  // Skill-proportional weights, with a floor so a single strong component does
  // not swallow the ensemble and lose the variance reduction that motivates it.
  const raw: Record<string, number> = {};
  for (const [component, value] of scores) {
    raw[component] = Math.max(minimumWeight, value / total);
  }
  const rawTotal = Object.values(raw).reduce((sum, value) => sum + value, 0);
  const fittedWeights: Record<string, number> = {};
  for (const [component, value] of Object.entries(raw)) {
    fittedWeights[component] = value / rawTotal;
  }

  // Skill measured on a few dozen matches is itself noisy, so the fitted weights
  // are shrunk toward the sport's defaults rather than replacing them outright.
  // Trust rises with the size of the held-out block, matching the empirical-Bayes
  // shrinkage used for team strength.
  const observations = Math.min(...[...byComponent.values()].map((list) => list.length));
  const trust = observations / (observations + (options.priorWeight ?? 150));

  const components = new Set([...Object.keys(fallback), ...Object.keys(fittedWeights)]);
  const blended: Record<string, number> = {};
  let blendedTotal = 0;
  for (const component of components) {
    if (component === 'market') continue;
    const value = (1 - trust) * (fallback[component] ?? 0) + trust * (fittedWeights[component] ?? 0);
    blended[component] = value;
    blendedTotal += value;
  }
  if (blendedTotal <= 0) return { weights: fallback, fitted: false, skill };

  const weights: Record<string, number> = {};
  for (const [component, value] of Object.entries(blended)) {
    weights[component] = Number((value / blendedTotal).toFixed(4));
  }

  return { weights, fitted: true, skill };
}
