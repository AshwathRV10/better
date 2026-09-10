/** Public surface of the prediction engine. */

export * from './types';
export { predictMatch, predictMatches } from './engine';
export type { EngineOptions } from './engine';
export { getSportModule, hasSportModule, listSportModules, SPORT_KEYS } from './sports/registry';
export { blendComponents, outcomesForMarket, topOutcome } from './ensemble';
export { assessConfidence, levelFor, CONFIDENCE_THRESHOLDS } from './confidence';
export { assessDataQuality } from './dataQuality';
export { buildExplanation, scoreFeatureInfluence } from './explain';
export { FEATURES_VERSION } from './features';
export {
  buildRatings,
  eloExpectedScore,
  eloOutcomeProbabilities,
  updateElo,
  DEFAULT_ELO_CONFIG,
} from './models/elo';
export {
  trainMultinomialLogistic,
  predictMultinomial,
  featureImportance,
} from './models/mlModel';
export {
  applyCalibration,
  calibrationBins,
  expectedCalibrationError,
  fitCalibration,
  identityCalibration,
} from './math/calibration';
export type { CalibrationBin, CalibrationSample } from './math/calibration';
export {
  buildScoreMatrix,
  outcomeProbabilities,
  overProbability,
  bttsProbability,
  topCorrectScores,
  poissonPmf,
  poissonCdf,
} from './math/poisson';
export { tennisMatchDistribution, gameWinProbability } from './math/tennis';
