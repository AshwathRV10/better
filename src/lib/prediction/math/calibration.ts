/**
 * Probability calibration.
 *
 * Raw ensemble output is usually over-confident: a bucket the model calls 80%
 * may only win 72% of the time. Calibration fits a small correction on
 * out-of-sample predictions so the published numbers can be read as real
 * frequencies.
 *
 * This uses temperature scaling with per-class bias (a vector-scaling variant of
 * Platt scaling). It has k+1 parameters for k classes, which is few enough to
 * fit on a few hundred matches without overfitting - unlike isotonic
 * regression, which needs thousands.
 */

import type { CalibrationParams } from '../types';
import { clamp, safeLog, softmax } from './stats';

export interface CalibrationSample {
  /** Uncalibrated probabilities, one per class, summing to 1. */
  readonly probabilities: readonly number[];
  /** Index of the class that actually occurred. */
  readonly actual: number;
}

export function identityCalibration(classes: readonly string[]): CalibrationParams {
  return {
    temperature: 1,
    classBias: classes.map(() => 0),
    classes: [...classes],
    fittedOn: 0,
  };
}

/** Applies temperature and per-class bias in log space, then renormalises. */
export function applyCalibration(
  probabilities: readonly number[],
  params: CalibrationParams | null,
): number[] {
  if (!params || probabilities.length !== params.classBias.length) {
    return [...probabilities];
  }
  const temperature = Math.max(params.temperature, 1e-3);
  const logits = probabilities.map((p, i) => safeLog(p) / temperature + params.classBias[i]);
  return softmax(logits);
}

/** Mean negative log-likelihood of a set of calibrated predictions. */
export function logLoss(samples: readonly CalibrationSample[], params: CalibrationParams | null): number {
  if (samples.length === 0) return 0;
  let total = 0;
  for (const sample of samples) {
    const calibrated = applyCalibration(sample.probabilities, params);
    total -= safeLog(calibrated[sample.actual]);
  }
  return total / samples.length;
}

/**
 * Fits temperature and class biases by coordinate descent on log loss.
 *
 * Log loss is a proper scoring rule, so minimising it drives the probabilities
 * toward their true frequencies rather than toward whatever maximises hit rate.
 * A coarse-to-fine grid search is used because the parameter space is tiny and
 * this avoids any dependence on a numerical-optimisation library.
 */
export function fitCalibration(
  samples: readonly CalibrationSample[],
  classes: readonly string[],
  options: { minSamples?: number } = {},
): CalibrationParams {
  const minSamples = options.minSamples ?? 50;
  const base = identityCalibration(classes);
  if (samples.length < minSamples) return base;

  let best: CalibrationParams = { ...base, fittedOn: samples.length };
  let bestLoss = logLoss(samples, best);

  // Spans strong sharpening to strong softening; a fit that lands on an endpoint
  // means the grid is too narrow, so both ends sit well beyond plausible values.
  const temperatureGrid = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.5, 1.8, 2.2, 2.8];
  for (const temperature of temperatureGrid) {
    const candidate: CalibrationParams = { ...best, temperature };
    const loss = logLoss(samples, candidate);
    if (loss < bestLoss) {
      bestLoss = loss;
      best = candidate;
    }
  }

  // Refine each class bias in turn, twice, with a shrinking step.
  for (const step of [0.2, 0.05]) {
    for (let round = 0; round < 2; round += 1) {
      for (let c = 0; c < classes.length; c += 1) {
        for (const delta of [-step, step]) {
          const classBias = [...best.classBias];
          classBias[c] += delta;
          const candidate: CalibrationParams = { ...best, classBias };
          const loss = logLoss(samples, candidate);
          if (loss < bestLoss - 1e-9) {
            bestLoss = loss;
            best = candidate;
          }
        }
      }
    }
  }

  return { ...best, fittedOn: samples.length };
}

export interface CalibrationBin {
  readonly bin: string;
  readonly lower: number;
  readonly upper: number;
  readonly predicted: number;
  readonly observed: number;
  readonly count: number;
}

/**
 * Reliability diagram data. For each probability band, compares the mean
 * predicted probability against the observed frequency. A well-calibrated model
 * sits on the diagonal.
 */
export function calibrationBins(
  predictions: ReadonlyArray<{ probability: number; won: boolean }>,
  bins = 10,
): CalibrationBin[] {
  const buckets: { sum: number; wins: number; count: number }[] = Array.from(
    { length: bins },
    () => ({ sum: 0, wins: 0, count: 0 }),
  );

  for (const { probability, won } of predictions) {
    const p = clamp(probability, 0, 0.999999);
    const index = Math.min(bins - 1, Math.floor(p * bins));
    buckets[index].sum += probability;
    buckets[index].wins += won ? 1 : 0;
    buckets[index].count += 1;
  }

  return buckets.map((bucket, i) => {
    const lower = i / bins;
    const upper = (i + 1) / bins;
    return {
      bin: `${Math.round(lower * 100)}-${Math.round(upper * 100)}%`,
      lower,
      upper,
      predicted: bucket.count > 0 ? bucket.sum / bucket.count : 0,
      observed: bucket.count > 0 ? bucket.wins / bucket.count : 0,
      count: bucket.count,
    };
  });
}

/**
 * Expected Calibration Error: the count-weighted mean gap between predicted and
 * observed frequency. 0 is perfect; above ~0.05 the probabilities are unusable
 * for value detection.
 */
export function expectedCalibrationError(bins: readonly CalibrationBin[]): number {
  const total = bins.reduce((sum, b) => sum + b.count, 0);
  if (total === 0) return 0;
  return bins.reduce(
    (sum, b) => sum + (b.count / total) * Math.abs(b.predicted - b.observed),
    0,
  );
}
