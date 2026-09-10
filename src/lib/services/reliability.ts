/**
 * Edge reliability.
 *
 * A large disagreement with a well-priced market is far more often a model error
 * than a market error. Presenting a +118% expected value as the best opportunity
 * on the board would be dishonest even though the arithmetic is correct: the
 * arithmetic assumes the model probability is right, and the model's own measured
 * out-of-sample record says how far it can be trusted.
 *
 * So every value opportunity is classified against the model's *measured*
 * calibration error rather than suppressed or silently blended toward the price.
 * The model probability stays independent - bookmaker odds are never treated as
 * ground truth - but the interface says plainly when a claimed edge is larger
 * than the model has ever demonstrated it can find.
 */

import { prisma } from '../db/prisma';

export type EdgeReliability = 'SUPPORTED' | 'UNVERIFIED' | 'UNMEASURED';

/**
 * Multiple of the measured expected-calibration-error at which an edge stops
 * being credible. Three is the usual "well outside normal variation" bar.
 */
export const RELIABILITY_MULTIPLE = 3;

/** Floor for the bound, so a very well-calibrated model does not flag everything. */
export const MINIMUM_PLAUSIBLE_EDGE = 0.05;

export interface ReliabilityModel {
  /** Largest edge this model version has demonstrated it can detect. */
  readonly plausibleEdge: number;
  readonly expectedCalibrationError: number | null;
  readonly skillScore: number | null;
  readonly sampleSize: number;
}

interface StoredCalibration {
  expectedCalibrationError?: number;
  skillScore?: number;
}

/**
 * Reads each sport's measured calibration from `model_performance`.
 *
 * Returns an empty map when nothing has been scored yet; callers then report
 * `UNMEASURED` rather than inventing a bound.
 */
export async function loadReliabilityModels(): Promise<Map<string, ReliabilityModel>> {
  const rows = await prisma.modelPerformance.findMany({
    where: { leagueKey: null, confidence: null, market: 'MATCH_WINNER' },
    include: { modelVersion: { select: { version: true } } },
    orderBy: { computedAt: 'desc' },
  });

  const models = new Map<string, ReliabilityModel>();
  for (const row of rows) {
    if (models.has(row.modelVersion.version)) continue;
    const calibration = (row.calibration ?? {}) as StoredCalibration;
    const ece = typeof calibration.expectedCalibrationError === 'number'
      ? calibration.expectedCalibrationError
      : null;
    models.set(row.modelVersion.version, {
      plausibleEdge:
        ece === null
          ? MINIMUM_PLAUSIBLE_EDGE
          : Math.max(MINIMUM_PLAUSIBLE_EDGE, ece * RELIABILITY_MULTIPLE),
      expectedCalibrationError: ece,
      skillScore: typeof calibration.skillScore === 'number' ? calibration.skillScore : null,
      sampleSize: row.predictions,
    });
  }
  return models;
}

export function classifyEdge(
  edge: number,
  model: ReliabilityModel | undefined,
): { reliability: EdgeReliability; plausibleEdge: number | null } {
  if (!model || model.sampleSize < 30) {
    return { reliability: 'UNMEASURED', plausibleEdge: null };
  }
  return {
    reliability: edge <= model.plausibleEdge ? 'SUPPORTED' : 'UNVERIFIED',
    plausibleEdge: model.plausibleEdge,
  };
}

export function reliabilityExplanation(
  reliability: EdgeReliability,
  model: ReliabilityModel | undefined,
): string {
  switch (reliability) {
    case 'SUPPORTED':
      return model?.expectedCalibrationError === undefined || model.expectedCalibrationError === null
        ? 'Edge is within the range this model version has demonstrated.'
        : `Edge is within ${RELIABILITY_MULTIPLE}x the model's measured calibration error of ${(model.expectedCalibrationError * 100).toFixed(1)}pp.`;
    case 'UNVERIFIED':
      return model
        ? `Edge exceeds ${(model.plausibleEdge * 100).toFixed(1)}pp, which is ${RELIABILITY_MULTIPLE}x this model version's measured calibration error. A gap this large against a priced market is more likely to be model error than market error.`
        : 'Edge exceeds what this model version has demonstrated out of sample.';
    case 'UNMEASURED':
    default:
      return 'This model version has too few settled predictions to judge whether an edge of this size is credible.';
  }
}
