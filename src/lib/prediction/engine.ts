/**
 * Prediction engine.
 *
 * Orchestrates the pipeline for one fixture:
 *
 *   MatchContext -> FeatureEngineering -> sub-models -> Ensemble
 *                -> ProbabilityCalibrator -> Confidence + DataQuality + Explain
 *
 * The engine itself is sport-agnostic; each sport supplies a `SportModule` that
 * owns its feature set, its markets and its sub-models.
 */

import type {
  CalibrationParams,
  ComponentPrediction,
  MatchContext,
  MatchPrediction,
  ModelParameters,
  OutcomeProbability,
} from './types';
import { getSportModule } from './sports/registry';
import { blendComponents, outcomesForMarket } from './ensemble';
import { applyCalibration } from './math/calibration';
import { assessConfidence } from './confidence';
import { assessDataQuality } from './dataQuality';
import { buildExplanation, scoreFeatureInfluence } from './explain';
import { normalise } from './math/stats';

export interface EngineOptions {
  readonly modelVersion: string;
  readonly parameters?: ModelParameters;
  readonly historicalBrier?: number;
  readonly calibrationError?: number;
  readonly predictedAt?: Date;
}

/**
 * Applies the calibrator to the headline market.
 *
 * Only the match-winner market is calibrated: it is the only one with enough
 * settled observations per model version to fit a correction without
 * overfitting. Derived markets keep the goal model's internal consistency.
 */
function calibrateHeadline(
  outcomes: readonly OutcomeProbability[],
  classes: readonly string[],
  calibration: CalibrationParams | null,
): OutcomeProbability[] {
  if (!calibration) return [...outcomes];

  const headline = classes
    .map((selection) => outcomes.find((o) => o.market === 'MATCH_WINNER' && o.selection === selection))
    .filter((o): o is OutcomeProbability => o !== undefined);
  if (headline.length !== classes.length) return [...outcomes];

  const calibrated = applyCalibration(
    normalise(headline.map((o) => o.probability)),
    calibration,
  );

  return outcomes.map((outcome) => {
    if (outcome.market !== 'MATCH_WINNER') return outcome;
    const index = classes.indexOf(outcome.selection);
    return index >= 0 ? { ...outcome, probability: calibrated[index] } : outcome;
  });
}

export function predictMatch(ctx: MatchContext, options: EngineOptions): MatchPrediction {
  const sportModule = getSportModule(ctx.sportKey);
  const parameters = options.parameters ?? sportModule.defaultParameters;

  const features = sportModule.buildFeatures(ctx, parameters);
  const { components, expectedHomeScore, expectedAwayScore } = sportModule.predict(
    ctx,
    features,
    parameters,
  );

  const ensemble = blendComponents(components);
  if (ensemble.outcomes.length === 0) {
    throw new Error(
      `No model component produced a prediction for match ${ctx.matchId}. ` +
        'Check that the ensemble weights are non-zero.',
    );
  }

  const outcomes = calibrateHeadline(ensemble.outcomes, sportModule.classes, parameters.calibration);
  const dataQuality = assessDataQuality(ctx, features);
  const confidence = assessConfidence({
    ctx,
    dataQuality,
    components,
    outcomes,
    disagreement: ensemble.disagreement,
    historicalBrier: options.historicalBrier,
    calibrationError: options.calibrationError,
  });

  const scoredFeatures = scoreFeatureInfluence(features);
  const headline = outcomesForMarket(outcomes, 'MATCH_WINNER')[0];
  const favoured = (headline?.selection ?? 'HOME') as 'HOME' | 'AWAY' | 'DRAW';
  const explanation = buildExplanation(ctx, scoredFeatures, favoured);

  return {
    matchId: ctx.matchId,
    sportKey: ctx.sportKey,
    modelVersion: options.modelVersion,
    featuresVersion: features.version,
    predictedAt: options.predictedAt ?? new Date(),
    dataTimestamp: ctx.dataTimestamp,
    expectedHomeScore,
    expectedAwayScore,
    outcomes,
    components: components as readonly ComponentPrediction[],
    features: scoredFeatures,
    explanation,
    dataQuality,
    confidence,
  };
}

/**
 * Predicts a batch of fixtures. Failures are isolated: one bad context must not
 * take down a whole slate, and the caller receives the reasons.
 */
export function predictMatches(
  contexts: readonly MatchContext[],
  options: EngineOptions,
): {
  predictions: MatchPrediction[];
  failures: Array<{ matchId: string; reason: string }>;
} {
  const predictions: MatchPrediction[] = [];
  const failures: Array<{ matchId: string; reason: string }> = [];

  for (const ctx of contexts) {
    try {
      predictions.push(predictMatch(ctx, options));
    } catch (error) {
      failures.push({
        matchId: ctx.matchId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { predictions, failures };
}
