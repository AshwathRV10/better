/**
 * Multinomial logistic regression (softmax) trained by L2-regularised gradient
 * descent.
 *
 * This is the "ML baseline" of the ensemble. It is deliberately a small, fully
 * inspectable linear model rather than a black box: with a few hundred matches
 * per league, a linear model on well-chosen features generalises better than a
 * boosted forest, and its coefficients double as feature-importance values for
 * the explainability panel.
 *
 * Training is always walk-forward - the caller passes only samples from before
 * the prediction instant - so no future information can leak in.
 */

import type { MlWeights } from '../types';
import { logSumExp, softmax } from '../math/stats';

export interface TrainingSample {
  readonly features: readonly number[];
  /** Index into `classes`. */
  readonly label: number;
  /** Sample weight; used to down-weight older matches. */
  readonly weight?: number;
}

export interface TrainOptions {
  readonly learningRate?: number;
  readonly epochs?: number;
  /** L2 penalty. Higher values shrink coefficients toward zero. */
  readonly l2?: number;
  readonly minSamples?: number;
  readonly tolerance?: number;
}

const DEFAULTS = {
  learningRate: 0.35,
  epochs: 400,
  l2: 0.02,
  minSamples: 60,
  tolerance: 1e-7,
} as const;

/** Standardisation statistics, stored so inference matches training. */
export interface FeatureScaler {
  readonly means: readonly number[];
  readonly deviations: readonly number[];
}

export function fitScaler(samples: readonly TrainingSample[], featureCount: number): FeatureScaler {
  const means = new Array<number>(featureCount).fill(0);
  const deviations = new Array<number>(featureCount).fill(1);
  if (samples.length === 0) return { means, deviations };

  for (const sample of samples) {
    for (let j = 0; j < featureCount; j += 1) means[j] += sample.features[j] ?? 0;
  }
  for (let j = 0; j < featureCount; j += 1) means[j] /= samples.length;

  for (let j = 0; j < featureCount; j += 1) {
    let variance = 0;
    for (const sample of samples) variance += ((sample.features[j] ?? 0) - means[j]) ** 2;
    const sd = Math.sqrt(variance / Math.max(samples.length - 1, 1));
    // A constant feature would divide by zero; leave it unscaled.
    deviations[j] = sd > 1e-8 ? sd : 1;
  }
  return { means, deviations };
}

export function applyScaler(features: readonly number[], scaler: FeatureScaler): number[] {
  return features.map((value, j) => (value - (scaler.means[j] ?? 0)) / (scaler.deviations[j] ?? 1));
}

export interface TrainedModel extends MlWeights {
  readonly scaler: FeatureScaler;
  readonly logLoss: number;
}

/**
 * Fits softmax regression. Coefficients are stored as [class][feature] with the
 * bias appended at index `featureNames.length`.
 */
export function trainMultinomialLogistic(
  samples: readonly TrainingSample[],
  featureNames: readonly string[],
  classes: readonly string[],
  options: TrainOptions = {},
): TrainedModel | null {
  const opts = { ...DEFAULTS, ...options };
  if (samples.length < opts.minSamples) return null;

  const k = classes.length;
  const d = featureNames.length;
  const scaler = fitScaler(samples, d);
  const scaled = samples.map((sample) => ({
    x: applyScaler(sample.features, scaler),
    label: sample.label,
    weight: sample.weight ?? 1,
  }));
  const weightTotal = scaled.reduce((sum, s) => sum + s.weight, 0);
  if (weightTotal <= 0) return null;

  // coefficients[c] has length d + 1 (last entry is the bias).
  const coefficients: number[][] = Array.from({ length: k }, () => new Array<number>(d + 1).fill(0));

  let previousLoss = Number.POSITIVE_INFINITY;
  let loss = 0;

  for (let epoch = 0; epoch < opts.epochs; epoch += 1) {
    const gradients: number[][] = Array.from({ length: k }, () =>
      new Array<number>(d + 1).fill(0),
    );
    loss = 0;

    for (const sample of scaled) {
      const logits = new Array<number>(k).fill(0);
      for (let c = 0; c < k; c += 1) {
        let z = coefficients[c][d];
        for (let j = 0; j < d; j += 1) z += coefficients[c][j] * sample.x[j];
        logits[c] = z;
      }
      const lse = logSumExp(logits);
      loss -= (sample.weight * (logits[sample.label] - lse)) / weightTotal;

      const probabilities = logits.map((z) => Math.exp(z - lse));
      for (let c = 0; c < k; c += 1) {
        const error = (probabilities[c] - (c === sample.label ? 1 : 0)) * sample.weight;
        for (let j = 0; j < d; j += 1) gradients[c][j] += (error * sample.x[j]) / weightTotal;
        gradients[c][d] += error / weightTotal;
      }
    }

    // L2 penalty on the slopes only; biases stay unregularised.
    for (let c = 0; c < k; c += 1) {
      for (let j = 0; j < d; j += 1) {
        gradients[c][j] += opts.l2 * coefficients[c][j];
        loss += (opts.l2 * coefficients[c][j] ** 2) / 2;
      }
    }

    for (let c = 0; c < k; c += 1) {
      for (let j = 0; j <= d; j += 1) coefficients[c][j] -= opts.learningRate * gradients[c][j];
    }

    if (Math.abs(previousLoss - loss) < opts.tolerance) break;
    previousLoss = loss;
  }

  return {
    featureNames: [...featureNames],
    coefficients: coefficients.map((row) => [...row]),
    classes: [...classes],
    trainedOn: samples.length,
    trainedThrough: null,
    scaler,
    logLoss: loss,
  };
}

/** L2 penalties tried when the strength of regularisation is selected by validation. */
export const L2_GRID = [0.05, 0.15, 0.5, 1.5, 5, 15] as const;

/**
 * Fits softmax regression, choosing the L2 penalty by held-out validation.
 *
 * A fixed penalty cannot work across sports and sample sizes: with a few hundred
 * matches and ten features, too little regularisation memorises the training
 * block and scores *worse* than the base rate out of sample. The last slice of
 * the (chronologically ordered) samples is held back, each candidate penalty is
 * scored on it, and the best is refitted on everything.
 *
 * Returns null when no candidate beats predicting the base rate, so a model that
 * has learned nothing is never handed to the ensemble.
 */
export function trainWithValidation(
  samples: readonly TrainingSample[],
  featureNames: readonly string[],
  classes: readonly string[],
  options: TrainOptions & { validationFraction?: number } = {},
): TrainedModel | null {
  const opts = { ...DEFAULTS, ...options };
  if (samples.length < opts.minSamples) return null;

  const validationFraction = options.validationFraction ?? 0.25;
  const splitIndex = Math.floor(samples.length * (1 - validationFraction));
  const fitSlice = samples.slice(0, splitIndex);
  const validationSlice = samples.slice(splitIndex);
  if (fitSlice.length < opts.minSamples || validationSlice.length < 20) {
    return trainMultinomialLogistic(samples, featureNames, classes, options);
  }

  // The bar to clear: predicting the validation block's own base rate.
  const counts = new Array<number>(classes.length).fill(0);
  for (const sample of validationSlice) counts[sample.label] += 1;
  const baseRates = counts.map((count) => count / validationSlice.length);
  const scoreOf = (predict: (sample: TrainingSample) => readonly number[]): number => {
    let loss = 0;
    for (const sample of validationSlice) {
      const probabilities = predict(sample);
      loss -= Math.log(Math.max(probabilities[sample.label], 1e-15));
    }
    return loss / validationSlice.length;
  };
  const baselineLoss = scoreOf((sample) => {
    void sample;
    return baseRates;
  });

  let best: { l2: number; loss: number } | null = null;
  for (const l2 of L2_GRID) {
    const candidate = trainMultinomialLogistic(fitSlice, featureNames, classes, { ...options, l2 });
    if (!candidate) continue;
    const loss = scoreOf((sample) => {
      const byName: Record<string, number> = {};
      featureNames.forEach((name, i) => {
        byName[name] = sample.features[i] ?? 0;
      });
      return predictMultinomial(candidate, byName) ?? baseRates;
    });
    if (!best || loss < best.loss) best = { l2, loss };
  }

  // No penalty produced a model that beats the base rate: report nothing rather
  // than contributing noise to the ensemble.
  if (!best || best.loss >= baselineLoss) return null;

  return trainMultinomialLogistic(samples, featureNames, classes, { ...options, l2: best.l2 });
}

/** Runs a trained model. Returns null when the feature vector does not match. */
export function predictMultinomial(
  model: (MlWeights & { scaler?: FeatureScaler }) | null,
  featuresByName: Readonly<Record<string, number>>,
): number[] | null {
  if (!model || model.coefficients.length === 0) return null;
  const d = model.featureNames.length;
  const raw = model.featureNames.map((name) => featuresByName[name] ?? 0);
  const x = model.scaler ? applyScaler(raw, model.scaler) : raw;

  const logits = model.coefficients.map((row) => {
    let z = row[d] ?? 0;
    for (let j = 0; j < d; j += 1) z += (row[j] ?? 0) * x[j];
    return z;
  });
  return softmax(logits);
}

/**
 * Feature importance as the spread of a feature's coefficients across classes,
 * scaled by the feature's own standard deviation. A feature that moves every
 * class equally carries no discriminative information.
 */
export function featureImportance(
  model: (MlWeights & { scaler?: FeatureScaler }) | null,
): Array<{ feature: string; importance: number }> {
  if (!model) return [];
  const d = model.featureNames.length;
  return model.featureNames
    .map((feature, j) => {
      const column = model.coefficients.map((row) => row[j] ?? 0);
      const spread = Math.max(...column) - Math.min(...column);
      return { feature, importance: spread };
    })
    .filter((_, j) => j < d)
    .sort((a, b) => b.importance - a.importance);
}
