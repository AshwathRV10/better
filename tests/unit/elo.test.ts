import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ELO_CONFIG,
  actualScore,
  buildRatings,
  eloExpectedScore,
  eloOutcomeProbabilities,
  marginMultiplier,
  updateElo,
} from '@/lib/prediction/models/elo';
import { DAY, makeMatch } from '../helpers/context';

const NEUTRAL = { ...DEFAULT_ELO_CONFIG, homeAdvantage: 0 };

describe('eloExpectedScore', () => {
  it('is exactly 0.5 for equal ratings at a neutral venue', () => {
    expect(eloExpectedScore(1500, 1500, DEFAULT_ELO_CONFIG, true)).toBeCloseTo(0.5, 12);
  });

  it('applies home advantage when the venue is not neutral', () => {
    const home = eloExpectedScore(1500, 1500, DEFAULT_ELO_CONFIG, false);
    expect(home).toBeGreaterThan(0.5);
    // 60 points of advantage on a 400 scale
    expect(home).toBeCloseTo(1 / (1 + 10 ** (-60 / 400)), 12);
  });

  it('matches the textbook 400-point gap value of 10/11', () => {
    expect(eloExpectedScore(1900, 1500, NEUTRAL, true)).toBeCloseTo(10 / 11, 10);
  });

  it('is symmetric: E(A vs B) + E(B vs A) = 1', () => {
    const a = eloExpectedScore(1650, 1480, NEUTRAL, true);
    const b = eloExpectedScore(1480, 1650, NEUTRAL, true);
    expect(a + b).toBeCloseTo(1, 12);
  });

  it('is monotonic in the rating difference', () => {
    let previous = 0;
    for (const rating of [1300, 1400, 1500, 1600, 1700]) {
      const value = eloExpectedScore(rating, 1500, NEUTRAL, true);
      expect(value).toBeGreaterThan(previous);
      previous = value;
    }
  });
});

describe('actualScore', () => {
  it('maps results to 1 / 0.5 / 0', () => {
    expect(actualScore(2, 0)).toBe(1);
    expect(actualScore(1, 1)).toBe(0.5);
    expect(actualScore(0, 3)).toBe(0);
  });
});

describe('marginMultiplier', () => {
  it('is 1 for a draw', () => {
    expect(marginMultiplier(0, 100)).toBe(1);
  });

  it('grows with the margin but sub-linearly', () => {
    const one = marginMultiplier(1, 0);
    const two = marginMultiplier(2, 0);
    const six = marginMultiplier(6, 0);
    expect(two).toBeGreaterThan(one);
    expect(six).toBeGreaterThan(two);
    // A 6-goal win is worth well under 3x a 2-goal win.
    expect(six / two).toBeLessThan(2);
  });

  it('discounts big wins by strong favourites (autocorrelation correction)', () => {
    const evenMatch = marginMultiplier(3, 0);
    const heavyFavourite = marginMultiplier(3, 600);
    expect(heavyFavourite).toBeLessThan(evenMatch);
  });

  it('is symmetric in the sign of the goal difference', () => {
    expect(marginMultiplier(3, 200)).toBeCloseTo(marginMultiplier(-3, 200), 12);
  });
});

describe('updateElo', () => {
  it('is zero-sum: the winner gains exactly what the loser drops', () => {
    const result = updateElo(1500, 1500, 2, 0, DEFAULT_ELO_CONFIG);
    expect(result.home - 1500).toBeCloseTo(-(result.away - 1500), 10);
  });

  it('rewards an upset more than an expected win', () => {
    const upset = updateElo(1300, 1700, 1, 0, NEUTRAL);
    const expected = updateElo(1700, 1300, 1, 0, NEUTRAL);
    expect(upset.change).toBeGreaterThan(expected.change);
  });

  it('moves a favourite down after a draw', () => {
    const result = updateElo(1700, 1300, 1, 1, NEUTRAL);
    expect(result.change).toBeLessThan(0);
    expect(result.actualHome).toBe(0.5);
    expect(result.expectedHome).toBeGreaterThan(0.5);
  });

  it('barely moves ratings when the result matches expectation', () => {
    // A 1-1 draw between equal sides is exactly the expected outcome.
    const result = updateElo(1500, 1500, 1, 1, NEUTRAL);
    expect(Math.abs(result.change)).toBeLessThan(1e-9);
  });

  it('suppresses home advantage at a neutral venue', () => {
    const atHome = updateElo(1500, 1500, 1, 1, DEFAULT_ELO_CONFIG, false);
    const neutral = updateElo(1500, 1500, 1, 1, DEFAULT_ELO_CONFIG, true);
    // At home, a draw is a below-par result, so the home rating falls.
    expect(atHome.change).toBeLessThan(0);
    expect(neutral.change).toBeCloseTo(0, 10);
  });
});

describe('buildRatings', () => {
  const base = new Date('2026-01-01T12:00:00Z');

  it('ranks a consistently winning team above a losing one', () => {
    const matches = [];
    for (let i = 0; i < 10; i += 1) {
      matches.push(
        makeMatch({
          kickoff: new Date(base.getTime() + i * DAY),
          homeTeamId: 'strong',
          awayTeamId: 'weak',
          homeScore: 3,
          awayScore: 0,
        }),
      );
    }
    const { ratings, matchesPlayed } = buildRatings(matches);
    expect(ratings.get('strong')!).toBeGreaterThan(1500);
    expect(ratings.get('weak')!).toBeLessThan(1500);
    expect(matchesPlayed.get('strong')).toBe(10);
  });

  it('conserves total rating mass across the league', () => {
    const matches = [
      makeMatch({ kickoff: base, homeTeamId: 'a', awayTeamId: 'b', homeScore: 2, awayScore: 1 }),
      makeMatch({ kickoff: new Date(base.getTime() + DAY), homeTeamId: 'b', awayTeamId: 'c', homeScore: 0, awayScore: 3 }),
      makeMatch({ kickoff: new Date(base.getTime() + 2 * DAY), homeTeamId: 'c', awayTeamId: 'a', homeScore: 1, awayScore: 1 }),
    ];
    const { ratings } = buildRatings(matches);
    const total = [...ratings.values()].reduce((s, r) => s + r, 0);
    expect(total).toBeCloseTo(3 * DEFAULT_ELO_CONFIG.initialRating, 8);
  });

  it('processes matches chronologically regardless of input order', () => {
    const matches = [
      makeMatch({ kickoff: new Date(base.getTime() + 2 * DAY), homeTeamId: 'a', awayTeamId: 'b', homeScore: 0, awayScore: 2 }),
      makeMatch({ kickoff: base, homeTeamId: 'a', awayTeamId: 'b', homeScore: 3, awayScore: 0 }),
    ];
    const forward = buildRatings(matches);
    const reversed = buildRatings([...matches].reverse());
    expect(forward.ratings.get('a')).toBeCloseTo(reversed.ratings.get('a')!, 12);
  });

  it('accepts seeded starting ratings', () => {
    const seed = new Map([['a', 1800]]);
    const { ratings } = buildRatings([], DEFAULT_ELO_CONFIG, seed);
    expect(ratings.get('a')).toBe(1800);
  });

  it('returns empty tables for no matches', () => {
    const { ratings, matchesPlayed } = buildRatings([]);
    expect(ratings.size).toBe(0);
    expect(matchesPlayed.size).toBe(0);
  });
});

describe('eloOutcomeProbabilities', () => {
  it('sums to 1', () => {
    for (const expectation of [0.1, 0.35, 0.5, 0.72, 0.95]) {
      const p = eloOutcomeProbabilities(expectation, 0.26);
      expect(p.home + p.draw + p.away).toBeCloseTo(1, 10);
    }
  });

  it('peaks the draw when the sides are evenly matched', () => {
    const even = eloOutcomeProbabilities(0.5, 0.26);
    const lopsided = eloOutcomeProbabilities(0.9, 0.26);
    expect(even.draw).toBeCloseTo(0.26, 10);
    expect(lopsided.draw).toBeLessThan(even.draw);
  });

  it('is symmetric around an even expectation', () => {
    const a = eloOutcomeProbabilities(0.7, 0.26);
    const b = eloOutcomeProbabilities(0.3, 0.26);
    expect(a.home).toBeCloseTo(b.away, 12);
    expect(a.draw).toBeCloseTo(b.draw, 12);
  });

  it('uses the league draw rate rather than a fixed constant', () => {
    const lowDraw = eloOutcomeProbabilities(0.5, 0.15);
    const highDraw = eloOutcomeProbabilities(0.5, 0.32);
    expect(highDraw.draw).toBeGreaterThan(lowDraw.draw);
  });
});
