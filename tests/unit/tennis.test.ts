import { describe, expect, it } from 'vitest';
import {
  gameWinProbability,
  gamesHandicapProbability,
  setScoreDistribution,
  tennisMatchDistribution,
  tiebreakWinProbability,
  totalGamesOver,
} from '@/lib/prediction/math/tennis';
import { estimateServeProbabilities, tennisMarkets } from '@/lib/prediction/sports/tennis';

describe('gameWinProbability', () => {
  it('is exactly 0.5 for a coin-flip point', () => {
    expect(gameWinProbability(0.5)).toBeCloseTo(0.5, 12);
  });

  it('amplifies a small point edge into a large game edge', () => {
    // A 62% point-win server holds ~78% of games: the hierarchy magnifies edges.
    const hold = gameWinProbability(0.62);
    expect(hold).toBeGreaterThan(0.75);
    expect(hold).toBeLessThan(0.81);
  });

  it('matches tour reality: 64% of service points is about an 81% hold', () => {
    expect(gameWinProbability(0.64)).toBeCloseTo(0.8126, 3);
  });

  it('is monotonic and bounded', () => {
    let previous = 0;
    for (const p of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
      const hold = gameWinProbability(p);
      expect(hold).toBeGreaterThan(previous);
      expect(hold).toBeGreaterThanOrEqual(0);
      expect(hold).toBeLessThanOrEqual(1);
      previous = hold;
    }
  });

  it('handles the degenerate extremes without NaN', () => {
    expect(gameWinProbability(0)).toBeCloseTo(0, 10);
    expect(gameWinProbability(1)).toBeCloseTo(1, 10);
  });
});

describe('tiebreakWinProbability', () => {
  it('is 0.5 when both players serve equally well', () => {
    expect(tiebreakWinProbability(0.62, 0.62)).toBeCloseTo(0.5, 10);
  });

  it('favours the better server', () => {
    expect(tiebreakWinProbability(0.7, 0.55)).toBeGreaterThan(0.7);
    expect(tiebreakWinProbability(0.55, 0.7)).toBeLessThan(0.3);
  });

  it('is complementary under a swap', () => {
    expect(tiebreakWinProbability(0.68, 0.58) + tiebreakWinProbability(0.58, 0.68)).toBeCloseTo(1, 10);
  });
});

describe('setScoreDistribution', () => {
  const hold = gameWinProbability(0.62);

  it('is a valid distribution over legal set scores', () => {
    const set = setScoreDistribution(hold, hold, 0.5);
    expect(set.scores.reduce((s, x) => s + x.probability, 0)).toBeCloseTo(1, 10);
    for (const score of set.scores) {
      const winner = Math.max(score.a, score.b);
      const loser = Math.min(score.a, score.b);
      expect(winner === 6 || winner === 7).toBe(true);
      if (winner === 6) expect(loser).toBeLessThanOrEqual(4);
      if (winner === 7) expect(loser === 5 || loser === 6).toBe(true);
    }
  });

  it('gives an even match a 50% set-win probability', () => {
    expect(setScoreDistribution(hold, hold, 0.5).aWins).toBeCloseTo(0.5, 10);
  });

  it('reflects serve order: the first server clinches 6-3 by holding, 6-4 by breaking', () => {
    const set = setScoreDistribution(hold, hold, 0.5);
    const find = (a: number, b: number) => set.scores.find((s) => s.a === a && s.b === b)?.probability ?? 0;
    // Player A serves games 1, 3, 5, 7, 9 - so 6-3 ends on A's serve and 6-4 does not.
    expect(find(6, 3)).toBeGreaterThan(find(6, 4));
    // The mirror image holds for the returner.
    expect(find(4, 6)).toBeGreaterThan(find(3, 6));
  });

  it('favours the stronger server', () => {
    const strong = setScoreDistribution(gameWinProbability(0.7), gameWinProbability(0.55), 0.75);
    expect(strong.aWins).toBeGreaterThan(0.75);
  });
});

describe('tennisMatchDistribution', () => {
  it('is exactly even for identical players', () => {
    const d = tennisMatchDistribution(0.62, 0.62, 3);
    expect(d.matchWinA).toBeCloseTo(0.5, 10);
    expect(d.setWinA).toBeCloseTo(0.5, 10);
  });

  it('produces a valid total-games distribution', () => {
    const d = tennisMatchDistribution(0.64, 0.6, 3);
    expect(d.totalGames.reduce((s, p) => s + p, 0)).toBeCloseTo(1, 8);
    for (const p of d.totalGames) expect(p).toBeGreaterThanOrEqual(0);
  });

  it('expects a realistic match length', () => {
    // A typical best-of-three match runs to roughly 20-27 games.
    const d = tennisMatchDistribution(0.63, 0.63, 3);
    expect(d.expectedTotalGames).toBeGreaterThan(20);
    expect(d.expectedTotalGames).toBeLessThan(28);
  });

  it('shortens the match when one player is much stronger', () => {
    const even = tennisMatchDistribution(0.63, 0.63, 3);
    const lopsided = tennisMatchDistribution(0.72, 0.54, 3);
    expect(lopsided.expectedTotalGames).toBeLessThan(even.expectedTotalGames);
  });

  it('gives the favourite a better chance over five sets than three', () => {
    const bo3 = tennisMatchDistribution(0.68, 0.58, 3);
    const bo5 = tennisMatchDistribution(0.68, 0.58, 5);
    expect(bo5.matchWinA).toBeGreaterThan(bo3.matchWinA);
    expect(bo5.expectedTotalGames).toBeGreaterThan(bo3.expectedTotalGames);
  });

  it('amplifies the set edge into a larger match edge', () => {
    const d = tennisMatchDistribution(0.66, 0.6, 3);
    expect(d.matchWinA).toBeGreaterThan(d.setWinA);
  });

  it('enumerates only legal best-of-three set scores', () => {
    const d = tennisMatchDistribution(0.64, 0.6, 3);
    const labels = d.setScoreProbabilities.map((s) => s.sets).sort();
    expect(labels).toEqual(['0-2', '1-2', '2-0', '2-1']);
    expect(d.setScoreProbabilities.reduce((s, x) => s + x.probability, 0)).toBeCloseTo(1, 8);
  });

  it('produces a game-margin distribution that sums to 1 and is centred for equals', () => {
    const d = tennisMatchDistribution(0.62, 0.62, 3);
    let total = 0;
    let mean = 0;
    for (const [margin, p] of d.gameMargin) {
      total += p;
      mean += margin * p;
    }
    expect(total).toBeCloseTo(1, 8);
    expect(mean).toBeCloseTo(0, 8);
  });
});

describe('totalGamesOver', () => {
  it('is monotonically decreasing in the line', () => {
    const d = tennisMatchDistribution(0.63, 0.62, 3);
    const o20 = totalGamesOver(d.totalGames, 20.5);
    const o22 = totalGamesOver(d.totalGames, 22.5);
    const o24 = totalGamesOver(d.totalGames, 24.5);
    expect(o20).toBeGreaterThan(o22);
    expect(o22).toBeGreaterThan(o24);
  });
});

describe('gamesHandicapProbability', () => {
  it('is 0.5 at a zero-ish line for equal players', () => {
    const d = tennisMatchDistribution(0.62, 0.62, 3);
    expect(gamesHandicapProbability(d.gameMargin, 0.5)).toBeGreaterThan(0.4);
    expect(gamesHandicapProbability(d.gameMargin, 0.5)).toBeLessThan(0.6);
  });

  it('increases as the handicap moves in the backer favour', () => {
    const d = tennisMatchDistribution(0.62, 0.62, 3);
    expect(gamesHandicapProbability(d.gameMargin, 4.5)).toBeGreaterThan(
      gamesHandicapProbability(d.gameMargin, -4.5),
    );
  });
});

describe('estimateServeProbabilities', () => {
  const vector = (byName: Record<string, number>) => ({
    features: [], byName, completeness: 1, version: '1.0.0',
  });

  it('centres both players on the tour baseline when nothing separates them', () => {
    const serve = estimateServeProbabilities(vector({}));
    expect(serve.home).toBeCloseTo(serve.away, 10);
    expect(serve.home).toBeCloseTo(0.63, 10);
  });

  it('shifts the pair symmetrically with the rating gap', () => {
    const serve = estimateServeProbabilities(vector({ elo_diff: 200 }));
    expect(serve.home).toBeGreaterThan(0.63);
    expect(serve.away).toBeLessThan(0.63);
    expect(serve.home + serve.away).toBeCloseTo(1.26, 10);
  });

  it('caps the adjustment so an extreme rating gap cannot break the model', () => {
    const serve = estimateServeProbabilities(vector({ elo_diff: 5000 }));
    expect(serve.home).toBeLessThanOrEqual(0.8);
    expect(serve.away).toBeGreaterThanOrEqual(0.45);
  });
});

describe('tennisMarkets', () => {
  it('prices every declared tennis market as a valid distribution', () => {
    const { outcomes, expectedGames } = tennisMarkets({ home: 0.65, away: 0.6 }, 3);
    const groups = new Map<string, number>();
    for (const outcome of outcomes) {
      const key = outcome.line === undefined ? outcome.market : `${outcome.market}@${outcome.line}`;
      groups.set(key, (groups.get(key) ?? 0) + outcome.probability);
    }
    for (const [key, total] of groups) expect(total, key).toBeCloseTo(1, 8);
    expect(expectedGames).toBeGreaterThan(15);
    expect(outcomes.some((o) => o.selection === 'DRAW')).toBe(false);
  });
});
