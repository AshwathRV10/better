import { describe, expect, it } from 'vitest';
import {
  asianHandicapProbabilities,
  bttsProbability,
  buildScoreMatrix,
  dixonColesTau,
  outcomeProbabilities,
  overProbability,
  poissonCdf,
  poissonPmf,
  topCorrectScores,
} from '@/lib/prediction/math/poisson';

describe('poissonPmf', () => {
  it('matches hand-computed values', () => {
    // P(X=0 | 2) = e^-2 = 0.135335
    expect(poissonPmf(0, 2)).toBeCloseTo(Math.exp(-2), 12);
    // P(X=1 | 2) = 2 e^-2
    expect(poissonPmf(1, 2)).toBeCloseTo(2 * Math.exp(-2), 12);
    // P(X=2 | 2) = 2 e^-2
    expect(poissonPmf(2, 2)).toBeCloseTo(2 * Math.exp(-2), 12);
    // P(X=3 | 1.5)
    expect(poissonPmf(3, 1.5)).toBeCloseTo((1.5 ** 3 * Math.exp(-1.5)) / 6, 12);
  });

  it('sums to 1 over a wide support', () => {
    let total = 0;
    for (let k = 0; k <= 60; k += 1) total += poissonPmf(k, 3.2);
    expect(total).toBeCloseTo(1, 10);
  });

  it('has mean equal to lambda', () => {
    const lambda = 1.72;
    let mean = 0;
    for (let k = 0; k <= 60; k += 1) mean += k * poissonPmf(k, lambda);
    expect(mean).toBeCloseTo(lambda, 8);
  });

  it('handles degenerate and invalid inputs', () => {
    expect(poissonPmf(0, 0)).toBe(1);
    expect(poissonPmf(2, 0)).toBe(0);
    expect(poissonPmf(-1, 2)).toBe(0);
    expect(poissonPmf(1.5, 2)).toBe(0);
  });

  it('does not overflow for large k', () => {
    expect(Number.isFinite(poissonPmf(150, 2))).toBe(true);
    expect(poissonPmf(150, 2)).toBeGreaterThanOrEqual(0);
  });
});

describe('poissonCdf', () => {
  it('accumulates the pmf', () => {
    expect(poissonCdf(2, 1.5)).toBeCloseTo(
      poissonPmf(0, 1.5) + poissonPmf(1, 1.5) + poissonPmf(2, 1.5),
      12,
    );
  });

  it('approaches 1 in the tail', () => {
    expect(poissonCdf(40, 2)).toBeCloseTo(1, 10);
  });
});

describe('dixonColesTau', () => {
  it('is a no-op for scores above 1-1', () => {
    expect(dixonColesTau(2, 1, 1.5, 1.1, -0.05)).toBe(1);
    expect(dixonColesTau(0, 3, 1.5, 1.1, -0.05)).toBe(1);
  });

  it('is the identity when rho is zero', () => {
    for (const [h, a] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
      expect(dixonColesTau(h, a, 1.5, 1.1, 0)).toBe(1);
    }
  });

  it('with negative rho lifts 0-0 and 1-1 and suppresses 1-0 and 0-1', () => {
    const rho = -0.05;
    expect(dixonColesTau(0, 0, 1.5, 1.1, rho)).toBeGreaterThan(1);
    expect(dixonColesTau(1, 1, 1.5, 1.1, rho)).toBeGreaterThan(1);
    expect(dixonColesTau(1, 0, 1.5, 1.1, rho)).toBeLessThan(1);
    expect(dixonColesTau(0, 1, 1.5, 1.1, rho)).toBeLessThan(1);
  });
});

describe('buildScoreMatrix', () => {
  it('always produces a valid probability distribution', () => {
    for (const [lh, la] of [[1.72, 0.94], [0.3, 0.3], [3.5, 2.8], [0.15, 6]]) {
      const sm = buildScoreMatrix(lh, la, { rho: -0.04 });
      let total = 0;
      for (const row of sm.matrix) for (const p of row) {
        expect(p).toBeGreaterThanOrEqual(0);
        total += p;
      }
      expect(total).toBeCloseTo(1, 10);
    }
  });

  it('reproduces independent Poisson marginals when rho is zero', () => {
    const sm = buildScoreMatrix(1.5, 1.2, { rho: 0, maxGoals: 25 });
    // Marginal P(home = 2) should equal poissonPmf(2, 1.5)
    let marginal = 0;
    for (let a = 0; a <= sm.maxGoals; a += 1) marginal += sm.matrix[2][a];
    expect(marginal).toBeCloseTo(poissonPmf(2, 1.5), 8);
  });

  it('is symmetric under swapping the two rates', () => {
    const a = buildScoreMatrix(1.8, 1.1, { rho: -0.04 });
    const b = buildScoreMatrix(1.1, 1.8, { rho: -0.04 });
    expect(a.matrix[2][1]).toBeCloseTo(b.matrix[1][2], 12);
  });
});

describe('outcomeProbabilities', () => {
  it('sums to 1', () => {
    const p = outcomeProbabilities(buildScoreMatrix(1.72, 0.94, { rho: -0.04 }));
    expect(p.home + p.draw + p.away).toBeCloseTo(1, 10);
  });

  it('gives exactly equal home and away probabilities for equal rates', () => {
    const p = outcomeProbabilities(buildScoreMatrix(1.4, 1.4, { rho: -0.04 }));
    expect(p.home).toBeCloseTo(p.away, 12);
  });

  it('favours the side with the higher expected goals', () => {
    const p = outcomeProbabilities(buildScoreMatrix(1.72, 0.94, { rho: -0.04 }));
    expect(p.home).toBeGreaterThan(p.away);
    expect(p.home).toBeGreaterThan(0.5);
  });

  it('produces plausible values for the specification example (1.72 v 0.94)', () => {
    const p = outcomeProbabilities(buildScoreMatrix(1.72, 0.94, { rho: -0.04 }));
    // Sanity band rather than a magic number: a 1.72-0.94 fixture is a solid
    // home favourite but nowhere near a certainty.
    expect(p.home).toBeGreaterThan(0.5);
    expect(p.home).toBeLessThan(0.65);
    expect(p.draw).toBeGreaterThan(0.18);
    expect(p.draw).toBeLessThan(0.3);
    expect(p.away).toBeGreaterThan(0.13);
    expect(p.away).toBeLessThan(0.25);
  });
});

describe('overProbability', () => {
  it('is monotonically decreasing in the line', () => {
    const sm = buildScoreMatrix(1.6, 1.3, { rho: -0.04 });
    const o15 = overProbability(sm, 1.5);
    const o25 = overProbability(sm, 2.5);
    const o35 = overProbability(sm, 3.5);
    expect(o15).toBeGreaterThan(o25);
    expect(o25).toBeGreaterThan(o35);
  });

  it('is complementary to under', () => {
    const sm = buildScoreMatrix(1.6, 1.3, { rho: -0.04 });
    const over = overProbability(sm, 2.5);
    expect(over + (1 - over)).toBeCloseTo(1, 12);
  });

  it('rises with the expected total', () => {
    const low = overProbability(buildScoreMatrix(0.8, 0.7), 2.5);
    const high = overProbability(buildScoreMatrix(2.2, 1.9), 2.5);
    expect(high).toBeGreaterThan(low);
  });
});

describe('bttsProbability', () => {
  it('equals (1-P(home=0))(1-P(away=0)) under independence', () => {
    const sm = buildScoreMatrix(1.5, 1.2, { rho: 0, maxGoals: 25 });
    const expected = (1 - poissonPmf(0, 1.5)) * (1 - poissonPmf(0, 1.2));
    expect(bttsProbability(sm)).toBeCloseTo(expected, 6);
  });

  it('falls when one side is very unlikely to score', () => {
    expect(bttsProbability(buildScoreMatrix(2.0, 0.2))).toBeLessThan(0.3);
  });
});

describe('topCorrectScores', () => {
  it('returns scores in descending probability order', () => {
    const scores = topCorrectScores(buildScoreMatrix(1.72, 0.94, { rho: -0.04 }), 8);
    expect(scores).toHaveLength(8);
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i - 1].probability).toBeGreaterThanOrEqual(scores[i].probability);
    }
  });

  it('picks a plausible modal score for a 1.72 v 0.94 fixture', () => {
    const [top] = topCorrectScores(buildScoreMatrix(1.72, 0.94, { rho: -0.04 }), 1);
    expect(top.home).toBeGreaterThanOrEqual(1);
    expect(top.home).toBeLessThanOrEqual(2);
    expect(top.away).toBeLessThanOrEqual(1);
  });
});

describe('asianHandicapProbabilities', () => {
  it('win + push + loss sums to 1', () => {
    const sm = buildScoreMatrix(1.6, 1.2, { rho: -0.04 });
    for (const line of [-1.5, -1, -0.5, 0, 0.5, 1]) {
      const { win, push, loss } = asianHandicapProbabilities(sm, line);
      expect(win + push + loss).toBeCloseTo(1, 10);
    }
  });

  it('has no push on half-integer lines', () => {
    const sm = buildScoreMatrix(1.6, 1.2);
    expect(asianHandicapProbabilities(sm, -0.5).push).toBeCloseTo(0, 12);
  });

  it('at line 0 reduces to the draw-no-bet market', () => {
    const sm = buildScoreMatrix(1.6, 1.2, { rho: -0.04 });
    const outcomes = outcomeProbabilities(sm);
    const { win, push, loss } = asianHandicapProbabilities(sm, 0);
    expect(win).toBeCloseTo(outcomes.home, 10);
    expect(push).toBeCloseTo(outcomes.draw, 10);
    expect(loss).toBeCloseTo(outcomes.away, 10);
  });

  it('giving the home team a head start increases its cover probability', () => {
    const sm = buildScoreMatrix(1.4, 1.4, { rho: -0.04 });
    expect(asianHandicapProbabilities(sm, 1.5).win).toBeGreaterThan(
      asianHandicapProbabilities(sm, -1.5).win,
    );
  });
});
