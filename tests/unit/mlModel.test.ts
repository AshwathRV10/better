import { describe, expect, it } from 'vitest';
import {
  applyScaler,
  featureImportance,
  fitScaler,
  predictMultinomial,
  trainMultinomialLogistic,
  type TrainingSample,
} from '@/lib/prediction/models/mlModel';
import { mulberry32 } from '../helpers/context';

const FEATURES = ['x1', 'x2'];
const CLASSES = ['A', 'B'];

function makeSeparableSamples(count: number, seed = 3): TrainingSample[] {
  const random = mulberry32(seed);
  const samples: TrainingSample[] = [];
  for (let i = 0; i < count; i += 1) {
    const x1 = random() * 2 - 1;
    const x2 = random() * 2 - 1;
    // Class A when x1 is positive, with a little noise.
    const label = x1 + (random() - 0.5) * 0.2 > 0 ? 0 : 1;
    samples.push({ features: [x1, x2], label });
  }
  return samples;
}

describe('fitScaler', () => {
  it('standardises to mean 0 and unit deviation', () => {
    const samples: TrainingSample[] = [
      { features: [10, 1], label: 0 },
      { features: [20, 1], label: 0 },
      { features: [30, 1], label: 1 },
    ];
    const scaler = fitScaler(samples, 2);
    expect(scaler.means[0]).toBeCloseTo(20, 10);
    expect(scaler.deviations[0]).toBeCloseTo(10, 10);
    expect(applyScaler([30, 1], scaler)[0]).toBeCloseTo(1, 10);
  });

  it('leaves a constant feature unscaled instead of dividing by zero', () => {
    const scaler = fitScaler([{ features: [5], label: 0 }, { features: [5], label: 1 }], 1);
    expect(scaler.deviations[0]).toBe(1);
    expect(Number.isFinite(applyScaler([5], scaler)[0])).toBe(true);
  });

  it('handles an empty sample set', () => {
    const scaler = fitScaler([], 2);
    expect(scaler.means).toEqual([0, 0]);
    expect(scaler.deviations).toEqual([1, 1]);
  });
});

describe('trainMultinomialLogistic', () => {
  it('refuses to train below the minimum sample size', () => {
    expect(trainMultinomialLogistic(makeSeparableSamples(10), FEATURES, CLASSES)).toBeNull();
  });

  it('learns a separable boundary', () => {
    const model = trainMultinomialLogistic(makeSeparableSamples(400), FEATURES, CLASSES);
    expect(model).not.toBeNull();
    const positive = predictMultinomial(model, { x1: 0.9, x2: 0 })!;
    const negative = predictMultinomial(model, { x1: -0.9, x2: 0 })!;
    expect(positive[0]).toBeGreaterThan(0.7);
    expect(negative[0]).toBeLessThan(0.3);
  });

  it('produces probabilities that sum to 1', () => {
    const model = trainMultinomialLogistic(makeSeparableSamples(300), FEATURES, CLASSES);
    for (const x1 of [-1, -0.3, 0, 0.4, 1]) {
      const p = predictMultinomial(model, { x1, x2: 0.2 })!;
      expect(p.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 10);
    }
  });

  it('supports three classes', () => {
    const random = mulberry32(21);
    const samples: TrainingSample[] = [];
    for (let i = 0; i < 600; i += 1) {
      const x1 = random() * 2 - 1;
      const label = x1 < -0.33 ? 0 : x1 < 0.33 ? 1 : 2;
      samples.push({ features: [x1, random()], label });
    }
    const model = trainMultinomialLogistic(samples, FEATURES, ['A', 'B', 'C']);
    const p = predictMultinomial(model, { x1: 0.9, x2: 0.5 })!;
    expect(p).toHaveLength(3);
    expect(p.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 10);
    expect(p[2]).toBeGreaterThan(p[0]);
  });

  it('honours sample weights', () => {
    const samples: TrainingSample[] = [
      ...Array.from({ length: 100 }, () => ({ features: [1, 0], label: 0, weight: 1 })),
      ...Array.from({ length: 100 }, () => ({ features: [1, 0], label: 1, weight: 4 })),
    ];
    const model = trainMultinomialLogistic(samples, FEATURES, CLASSES);
    const p = predictMultinomial(model, { x1: 1, x2: 0 })!;
    expect(p[1]).toBeGreaterThan(p[0]);
  });

  it('is deterministic for the same input', () => {
    const samples = makeSeparableSamples(200, 5);
    const a = trainMultinomialLogistic(samples, FEATURES, CLASSES);
    const b = trainMultinomialLogistic(samples, FEATURES, CLASSES);
    expect(a!.coefficients).toEqual(b!.coefficients);
  });

  it('regularisation shrinks coefficients toward zero', () => {
    const samples = makeSeparableSamples(300, 9);
    const weak = trainMultinomialLogistic(samples, FEATURES, CLASSES, { l2: 0.001 })!;
    const strong = trainMultinomialLogistic(samples, FEATURES, CLASSES, { l2: 5 })!;
    const magnitude = (m: typeof weak) =>
      m.coefficients.reduce((sum, row) => sum + row.slice(0, 2).reduce((s, c) => s + Math.abs(c), 0), 0);
    expect(magnitude(strong)).toBeLessThan(magnitude(weak));
  });
});

describe('predictMultinomial', () => {
  it('returns null without a model', () => {
    expect(predictMultinomial(null, { x1: 1 })).toBeNull();
  });

  it('treats an unknown feature as 0 rather than crashing', () => {
    const model = trainMultinomialLogistic(makeSeparableSamples(200), FEATURES, CLASSES);
    const p = predictMultinomial(model, {})!;
    expect(p.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 10);
  });
});

describe('featureImportance', () => {
  it('ranks the informative feature above the noise feature', () => {
    const model = trainMultinomialLogistic(makeSeparableSamples(500), FEATURES, CLASSES);
    const importance = featureImportance(model);
    expect(importance[0].feature).toBe('x1');
    expect(importance[0].importance).toBeGreaterThan(importance[1].importance);
  });

  it('returns an empty list without a model', () => {
    expect(featureImportance(null)).toEqual([]);
  });
});
