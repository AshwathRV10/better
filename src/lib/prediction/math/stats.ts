/** Numerical helpers shared by the statistical models. */

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Rescales a vector so it sums to 1. Returns a uniform vector if the sum is 0. */
export function normalise(values: readonly number[]): number[] {
  const total = values.reduce((sum, v) => sum + Math.max(0, v), 0);
  if (total <= 0 || !Number.isFinite(total)) {
    return values.map(() => 1 / values.length);
  }
  return values.map((v) => Math.max(0, v) / total);
}

/** log(sum(exp(x))) computed without overflow. */
export function logSumExp(values: readonly number[]): number {
  const max = Math.max(...values);
  if (!Number.isFinite(max)) return max;
  let sum = 0;
  for (const v of values) sum += Math.exp(v - max);
  return max + Math.log(sum);
}

export function softmax(logits: readonly number[]): number[] {
  const lse = logSumExp(logits);
  return logits.map((z) => Math.exp(z - lse));
}

/** Standard logistic function. */
export function sigmoid(x: number): number {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const ex = Math.exp(x);
  return ex / (1 + ex);
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function weightedMean(values: readonly number[], weights: readonly number[]): number {
  let num = 0;
  let den = 0;
  for (let i = 0; i < values.length; i += 1) {
    const w = weights[i] ?? 0;
    num += values[i] * w;
    den += w;
  }
  return den === 0 ? 0 : num / den;
}

export function standardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mu = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - mu) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Exponential decay weights for a chronologically ordered window, newest last.
 * A match `halfLife` positions older than the newest carries half its weight.
 */
export function exponentialWeights(count: number, halfLife: number): number[] {
  if (count <= 0) return [];
  const lambda = Math.log(2) / Math.max(halfLife, 1e-6);
  const weights: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const age = count - 1 - i; // 0 for the newest entry
    weights.push(Math.exp(-lambda * age));
  }
  return weights;
}

/** Abramowitz & Stegun 7.1.26 error-function approximation (|error| < 1.5e-7). */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

/** Cumulative distribution function of the normal distribution. */
export function normalCdf(x: number, mu = 0, sigma = 1): number {
  if (sigma <= 0) return x >= mu ? 1 : 0;
  return 0.5 * (1 + erf((x - mu) / (sigma * Math.SQRT2)));
}

/** Shrinks a sample estimate toward a prior; `k` is the prior's weight in observations. */
export function shrink(sampleValue: number, sampleSize: number, prior: number, k: number): number {
  if (sampleSize <= 0) return prior;
  return (sampleValue * sampleSize + prior * k) / (sampleSize + k);
}

export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Guards against log(0) when scoring probabilistic forecasts. */
export function safeLog(p: number, epsilon = 1e-15): number {
  return Math.log(clamp(p, epsilon, 1 - epsilon));
}
