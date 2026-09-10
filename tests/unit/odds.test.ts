import { describe, expect, it } from 'vitest';
import {
  americanToDecimal,
  assessValue,
  edge,
  expectedValue,
  fairOdds,
  fractionalToDecimal,
  impliedProbability,
  kellyStake,
  overround,
  removeMargin,
  shinProbabilities,
} from '@/lib/odds';

describe('impliedProbability', () => {
  it('matches the worked example: odds 2.00 -> 50%', () => {
    expect(impliedProbability(2.0)).toBe(0.5);
  });

  it('matches the dashboard example: odds 1.75 -> 57.1%', () => {
    expect(impliedProbability(1.75)).toBeCloseTo(0.5714285714, 9);
  });

  it('is the exact inverse of fairOdds', () => {
    for (const p of [0.05, 0.25, 0.5, 0.67, 0.99]) {
      expect(impliedProbability(fairOdds(p))).toBeCloseTo(p, 12);
    }
  });

  it('rejects odds that cannot exist', () => {
    expect(() => impliedProbability(1)).toThrow(RangeError);
    expect(() => impliedProbability(0)).toThrow(RangeError);
    expect(() => impliedProbability(-2)).toThrow(RangeError);
    expect(() => impliedProbability(Number.NaN)).toThrow(RangeError);
  });
});

describe('expectedValue', () => {
  it('matches the worked example: p=0.60 at 2.00 -> +0.20', () => {
    expect(expectedValue(0.6, 2.0)).toBeCloseTo(0.2, 12);
  });

  it('matches the prediction-card example: p=0.67 at 1.75 -> +17.25%', () => {
    expect(expectedValue(0.67, 1.75)).toBeCloseTo(0.1725, 10);
  });

  it('is zero exactly at the fair price', () => {
    expect(expectedValue(0.5, 2.0)).toBeCloseTo(0, 12);
    expect(expectedValue(0.25, 4.0)).toBeCloseTo(0, 12);
  });

  it('is negative when the model disagrees with the price', () => {
    expect(expectedValue(0.4, 2.0)).toBeCloseTo(-0.2, 12);
  });

  it('returns -1 for an impossible outcome at any price', () => {
    expect(expectedValue(0, 5.0)).toBe(-1);
  });
});

describe('edge', () => {
  it('matches the dashboard example: 67% model vs 57.1% implied -> +9.9%', () => {
    expect(edge(0.67, impliedProbability(1.75))).toBeCloseTo(0.098571, 6);
  });
});

describe('overround', () => {
  it('is zero for a perfectly fair two-way market', () => {
    expect(overround([2.0, 2.0])).toBeCloseTo(0, 12);
  });

  it('is ~5.26% for a 1.90/1.90 market', () => {
    expect(overround([1.9, 1.9])).toBeCloseTo(0.0526315789, 9);
  });

  it('handles three-way markets', () => {
    expect(overround([2.1, 3.4, 3.6])).toBeCloseTo(1 / 2.1 + 1 / 3.4 + 1 / 3.6 - 1, 12);
  });
});

describe('removeMargin', () => {
  const prices = [1.8, 3.6, 4.5];

  it.each(['multiplicative', 'additive', 'shin'] as const)(
    '%s produces probabilities that sum to exactly 1',
    (method) => {
      const fair = removeMargin(prices, method);
      expect(fair.reduce((s, p) => s + p, 0)).toBeCloseTo(1, 10);
      for (const p of fair) expect(p).toBeGreaterThan(0);
    },
  );

  it('always lowers every raw probability when the book has margin', () => {
    const raw = prices.map(impliedProbability);
    const fair = removeMargin(prices, 'multiplicative');
    fair.forEach((p, i) => expect(p).toBeLessThan(raw[i]));
  });

  it('shin takes proportionally more margin from the longshot than the favourite', () => {
    const raw = prices.map(impliedProbability);
    const fair = shinProbabilities(raw);
    const favouriteRetention = fair[0] / raw[0];
    const longshotRetention = fair[2] / raw[2];
    expect(favouriteRetention).toBeGreaterThan(longshotRetention);
  });

  it('leaves a margin-free market untouched', () => {
    const fair = removeMargin([2.0, 2.0], 'shin');
    expect(fair[0]).toBeCloseTo(0.5, 10);
    expect(fair[1]).toBeCloseTo(0.5, 10);
  });

  it('returns an empty array for an empty market', () => {
    expect(removeMargin([])).toEqual([]);
  });
});

describe('kellyStake', () => {
  it('quarter-Kelly on a p=0.6 @ 2.00 bet is 5% of bankroll, capped at 2%', () => {
    // full Kelly f* = (0.6*1 - 0.4)/1 = 0.20 -> quarter = 0.05 -> cap 0.02
    expect(kellyStake(0.6, 2.0, { fraction: 1, maxStakeFraction: 1 })).toBeCloseTo(0.2, 12);
    expect(kellyStake(0.6, 2.0, { fraction: 0.25, maxStakeFraction: 1 })).toBeCloseTo(0.05, 12);
    expect(kellyStake(0.6, 2.0)).toBeCloseTo(0.02, 12);
  });

  it('stakes nothing without an edge', () => {
    expect(kellyStake(0.5, 2.0, { fraction: 1, maxStakeFraction: 1 })).toBe(0);
    expect(kellyStake(0.4, 2.0, { fraction: 1, maxStakeFraction: 1 })).toBe(0);
  });

  it('never exceeds the configured cap', () => {
    expect(kellyStake(0.99, 10, { fraction: 1, maxStakeFraction: 0.05 })).toBe(0.05);
  });

  it('returns 0 rather than throwing on invalid odds', () => {
    expect(kellyStake(0.6, 0.5)).toBe(0);
  });
});

describe('assessValue', () => {
  it('reproduces the specification prediction card end to end', () => {
    const result = assessValue(0.67, 1.75);
    expect(result.rawImpliedProbability).toBeCloseTo(0.5714, 4);
    expect(result.edge).toBeCloseTo(0.0986, 4);
    expect(result.expectedValue).toBeCloseTo(0.1725, 4);
    expect(result.fairOdds).toBeCloseTo(1.4925, 4);
  });

  it('uses margin-free probabilities when the full market is supplied', () => {
    const market = [1.75, 3.9, 4.6];
    const withMarket = assessValue(0.67, 1.75, market);
    const withoutMarket = assessValue(0.67, 1.75);
    expect(withMarket.impliedProbability).toBeLessThan(withoutMarket.impliedProbability);
    expect(withMarket.edge).toBeGreaterThan(withoutMarket.edge);
    expect(withMarket.overround).toBeGreaterThan(0);
    // EV is a function of the offered price only, so it is unchanged.
    expect(withMarket.expectedValue).toBeCloseTo(withoutMarket.expectedValue, 12);
  });

  it('reports no overround when the market is not supplied', () => {
    expect(assessValue(0.5, 2.0).overround).toBeNull();
  });
});

describe('odds format conversion', () => {
  it('converts American odds', () => {
    expect(americanToDecimal(100)).toBeCloseTo(2.0, 12);
    expect(americanToDecimal(-110)).toBeCloseTo(1.9090909091, 9);
    expect(americanToDecimal(250)).toBeCloseTo(3.5, 12);
    expect(() => americanToDecimal(0)).toThrow(RangeError);
  });

  it('converts fractional odds', () => {
    expect(fractionalToDecimal(5, 2)).toBeCloseTo(3.5, 12);
    expect(fractionalToDecimal(1, 1)).toBeCloseTo(2.0, 12);
    expect(() => fractionalToDecimal(1, 0)).toThrow(RangeError);
  });
});
