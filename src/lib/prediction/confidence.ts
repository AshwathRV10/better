/**
 * Confidence scoring.
 *
 * Confidence is deliberately NOT the same thing as probability. A 90% favourite
 * predicted from three matches of history with no team news deserves low
 * confidence; a 45% call from a full season with four models in close agreement
 * deserves high confidence.
 *
 * The score combines eight observable signals, each of which is reported
 * individually so the user can see why the model is or is not confident.
 */

import type {
  ComponentPrediction,
  ConfidenceLevel,
  ConfidenceReport,
  DataQualityReport,
  MatchContext,
  OutcomeProbability,
} from './types';
import { clamp } from './math/stats';
import { outcomesForMarket } from './ensemble';

export interface ConfidenceInput {
  readonly ctx: MatchContext;
  readonly dataQuality: DataQualityReport;
  readonly components: readonly ComponentPrediction[];
  readonly outcomes: readonly OutcomeProbability[];
  readonly disagreement: number;
  /** Out-of-sample Brier score of this model version, if it has been evaluated. */
  readonly historicalBrier?: number;
  /** Expected calibration error of this model version, if measured. */
  readonly calibrationError?: number;
}

export const CONFIDENCE_THRESHOLDS = { high: 70, medium: 45 } as const;

/** A three-way market's Brier score is bounded above by 2/3 for a uniform guess. */
const UNINFORMATIVE_BRIER = 0.25;

export function levelFor(score: number): ConfidenceLevel {
  if (score >= CONFIDENCE_THRESHOLDS.high) return 'HIGH';
  if (score >= CONFIDENCE_THRESHOLDS.medium) return 'MEDIUM';
  return 'LOW';
}

export function assessConfidence(input: ConfidenceInput): ConfidenceReport {
  const { ctx, dataQuality, components, outcomes, disagreement } = input;

  // 1. Data quality, reused directly.
  const dataScore = dataQuality.score / 100;

  // 2. Sample size: how much history backs the two sides.
  const homeHistory = ctx.home.recentMatches.filter((m) => m.kickoff < ctx.asOf).length;
  const awayHistory = ctx.away.recentMatches.filter((m) => m.kickoff < ctx.asOf).length;
  const observations = Math.min(homeHistory, awayHistory);
  const sampleScore = clamp(observations / 15, 0, 1);

  // 3. Model agreement: low spread across components means a robust signal.
  //    A 0.12 standard deviation between components is treated as full
  //    disagreement, since that is a ~24-point swing between models.
  //
  //    Crucially, agreement is only evidence to the extent the models had data
  //    to disagree about. With no history every component falls back to the same
  //    league prior and "agrees" perfectly, which must not be read as
  //    confidence, so the score is shrunk toward neutral by the sample size.
  const rawAgreement = clamp(1 - disagreement / 0.12, 0, 1);
  const agreementScore = 0.5 + (rawAgreement - 0.5) * sampleScore;

  // 4. Prediction decisiveness: how far the leader is from a coin flip. This is
  //    the only component that uses the probability itself, and it is weighted
  //    lightly so a strong favourite alone cannot produce HIGH confidence.
  const headline = outcomesForMarket(outcomes, 'MATCH_WINNER');
  const leader = headline[0]?.probability ?? 0;
  const runnerUp = headline[1]?.probability ?? 0;
  const separationScore = clamp((leader - runnerUp) / 0.35, 0, 1);

  // 5. Availability certainty: unreported team news is a genuine unknown.
  const availabilityKnown =
    ctx.home.squadImportanceTotal > 0 && ctx.away.squadImportanceTotal > 0;
  const missingImportance = availabilityKnown
    ? (ctx.home.absentees.reduce((s, p) => s + p.importance, 0) / ctx.home.squadImportanceTotal +
        ctx.away.absentees.reduce((s, p) => s + p.importance, 0) / ctx.away.squadImportanceTotal) /
      2
    : 0;
  const availabilityScore = availabilityKnown ? clamp(1 - missingImportance * 2, 0, 1) : 0.35;

  // 6. Market availability: a priced market is independent corroboration.
  const marketComponent = components.find((c) => c.component === 'market');
  const marketScore = marketComponent ? 1 : 0.4;

  // 7. Historical out-of-sample performance of this model version.
  const brierScore =
    input.historicalBrier === undefined
      ? 0.5 // unknown: neither rewarded nor punished
      : clamp(1 - input.historicalBrier / UNINFORMATIVE_BRIER, 0, 1);

  // 8. Measured calibration. An ECE above 10 points makes probabilities unusable.
  const calibrationScore =
    input.calibrationError === undefined ? 0.5 : clamp(1 - input.calibrationError / 0.1, 0, 1);

  const componentScores = [
    { name: 'Data quality', score: dataScore, weight: 0.2, detail: `${dataQuality.score}/100 data-quality score` },
    { name: 'Sample size', score: sampleScore, weight: 0.16, detail: `${observations} matches of history on the thinner side` },
    {
      name: 'Model agreement',
      score: agreementScore,
      weight: 0.18,
      detail:
        observations === 0
          ? 'No history for the models to disagree about'
          : `${(disagreement * 100).toFixed(1)}pp average spread between models`,
    },
    { name: 'Prediction separation', score: separationScore, weight: 0.1, detail: `${((leader - runnerUp) * 100).toFixed(1)}pp between the top two selections` },
    { name: 'Team news certainty', score: availabilityScore, weight: 0.12, detail: availabilityKnown ? `${(missingImportance * 100).toFixed(0)}% of squad value unavailable` : 'Availability not reported' },
    { name: 'Market corroboration', score: marketScore, weight: 0.08, detail: marketComponent ? 'Bookmaker market available for comparison' : 'No market to compare against' },
    { name: 'Historical accuracy', score: brierScore, weight: 0.1, detail: input.historicalBrier === undefined ? 'Model version not yet evaluated' : `Brier ${input.historicalBrier.toFixed(3)} out of sample` },
    { name: 'Calibration', score: calibrationScore, weight: 0.06, detail: input.calibrationError === undefined ? 'Calibration not yet measured' : `Expected calibration error ${(input.calibrationError * 100).toFixed(1)}pp` },
  ];

  const total = componentScores.reduce((sum, c) => sum + c.score * c.weight, 0);
  const score = Math.round(clamp(total, 0, 1) * 100);

  return {
    level: levelFor(score),
    score,
    components: componentScores.map((c) => ({ ...c, score: Math.round(c.score * 100) })),
  };
}
