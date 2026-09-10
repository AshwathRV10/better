import { describe, expect, it } from 'vitest';
import {
  applyCalibration,
  calibrationBins,
  expectedCalibrationError,
  fitCalibration,
  identityCalibration,
  logLoss,
  type CalibrationSample,
} from '@/lib/prediction/math/calibration';
import { mulberry32 } from '../helpers/context';

const CLASSES = ['HOME', 'DRAW', 'AWAY'];

describe('applyCalibration', () => {
  it('is a no-op for identity parameters', () => {
    const input = [0.6, 0.25, 0.15];
    const output = applyCalibration(input, identityCalibration(CLASSES));
    output.forEach((p, i) => expect(p).toBeCloseTo(input[i], 10));
  });

  it('returns the input unchanged when there are no parameters', () => {
    expect(applyCalibration([0.5, 0.3, 0.2], null)).toEqual([0.5, 0.3, 0.2]);
  });

  it('always returns a valid distribution', () => {
    const params = { temperature: 1.7, classBias: [0.3, -0.2, 0.1], classes: CLASSES, fittedOn: 100 };
    const output = applyCalibration([0.7, 0.2, 0.1], params);
    expect(output.reduce((s, p) => s + p, 0)).toBeCloseTo(1, 10);
    for (const p of output) expect(p).toBeGreaterThan(0);
  });

  it('temperature above 1 softens an over-confident prediction toward uniform', () => {
    const params = { temperature: 2, classBias: [0, 0, 0], classes: CLASSES, fittedOn: 100 };
    const softened = applyCalibration([0.85, 0.1, 0.05], params);
    expect(softened[0]).toBeLessThan(0.85);
    expect(softened[2]).toBeGreaterThan(0.05);
  });

  it('temperature below 1 sharpens an under-confident prediction', () => {
    const params = { temperature: 0.6, classBias: [0, 0, 0], classes: CLASSES, fittedOn: 100 };
    const sharpened = applyCalibration([0.5, 0.3, 0.2], params);
    expect(sharpened[0]).toBeGreaterThan(0.5);
  });

  it('ignores parameters whose class count does not match', () => {
    const params = { temperature: 2, classBias: [0, 0], classes: ['A', 'B'], fittedOn: 10 };
    expect(applyCalibration([0.5, 0.3, 0.2], params)).toEqual([0.5, 0.3, 0.2]);
  });
});

describe('fitCalibration', () => {
  it('refuses to fit on too few samples', () => {
    const samples: CalibrationSample[] = [{ probabilities: [0.5, 0.3, 0.2], actual: 0 }];
    expect(fitCalibration(samples, CLASSES).fittedOn).toBe(0);
    expect(fitCalibration(samples, CLASSES).temperature).toBe(1);
  });

  it('reduces log loss on a systematically over-confident model', () => {
    // The model always says 90/5/5 but the true rate is 60/20/20.
    const random = mulberry32(7);
    const samples: CalibrationSample[] = [];
    for (let i = 0; i < 600; i += 1) {
      const roll = random();
      const actual = roll < 0.6 ? 0 : roll < 0.8 ? 1 : 2;
      samples.push({ probabilities: [0.9, 0.05, 0.05], actual });
    }
    const fitted = fitCalibration(samples, CLASSES);
    expect(fitted.fittedOn).toBe(600);
    expect(logLoss(samples, fitted)).toBeLessThan(logLoss(samples, null));
    // It should have softened the distribution.
    const calibrated = applyCalibration([0.9, 0.05, 0.05], fitted);
    expect(calibrated[0]).toBeLessThan(0.9);
  });

  it('leaves an already well-calibrated model close to identity', () => {
    const random = mulberry32(11);
    const probabilities = [0.5, 0.25, 0.25];
    const samples: CalibrationSample[] = [];
    for (let i = 0; i < 800; i += 1) {
      const roll = random();
      const actual = roll < 0.5 ? 0 : roll < 0.75 ? 1 : 2;
      samples.push({ probabilities, actual });
    }
    const fitted = fitCalibration(samples, CLASSES);
    const calibrated = applyCalibration(probabilities, fitted);
    calibrated.forEach((p, i) => expect(p).toBeCloseTo(probabilities[i], 1));
  });
});

describe('calibrationBins', () => {
  it('buckets predictions and measures observed frequency', () => {
    const predictions = [
      ...Array.from({ length: 10 }, () => ({ probability: 0.15, won: false })),
      ...Array.from({ length: 10 }, (_, i) => ({ probability: 0.85, won: i < 9 })),
    ];
    const bins = calibrationBins(predictions, 10);
    expect(bins).toHaveLength(10);
    const low = bins[1];
    expect(low.count).toBe(10);
    expect(low.predicted).toBeCloseTo(0.15, 10);
    expect(low.observed).toBe(0);
    const high = bins[8];
    expect(high.count).toBe(10);
    expect(high.observed).toBeCloseTo(0.9, 10);
  });

  it('handles an empty input without dividing by zero', () => {
    const bins = calibrationBins([], 10);
    expect(bins).toHaveLength(10);
    for (const bin of bins) {
      expect(bin.count).toBe(0);
      expect(Number.isFinite(bin.predicted)).toBe(true);
    }
  });

  it('places a probability of exactly 1 in the top bucket', () => {
    const bins = calibrationBins([{ probability: 1, won: true }], 10);
    expect(bins[9].count).toBe(1);
  });
});

describe('expectedCalibrationError', () => {
  it('is 0 for a perfectly calibrated model', () => {
    const predictions = [
      ...Array.from({ length: 100 }, (_, i) => ({ probability: 0.25, won: i < 25 })),
      ...Array.from({ length: 100 }, (_, i) => ({ probability: 0.75, won: i < 75 })),
    ];
    expect(expectedCalibrationError(calibrationBins(predictions, 10))).toBeCloseTo(0, 10);
  });

  it('grows with miscalibration', () => {
    const good = calibrationBins(Array.from({ length: 100 }, (_, i) => ({ probability: 0.5, won: i < 50 })), 10);
    const bad = calibrationBins(Array.from({ length: 100 }, (_, i) => ({ probability: 0.9, won: i < 50 })), 10);
    expect(expectedCalibrationError(bad)).toBeGreaterThan(expectedCalibrationError(good));
  });

  it('is 0 when there is nothing to measure', () => {
    expect(expectedCalibrationError(calibrationBins([], 10))).toBe(0);
  });
});
