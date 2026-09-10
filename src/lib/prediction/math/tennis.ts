/**
 * Hierarchical tennis model: point -> game -> set -> match.
 *
 * Tennis is scored as a nested sequence of independent-ish trials, so the
 * standard approach (Klaassen & Magnus) is to estimate each player's
 * probability of winning a point on their own serve and propagate that upward
 * analytically. This gives a genuine distribution over set scores and total
 * games instead of a guessed number, which is what the set-winner, total-games
 * and games-handicap markets need.
 *
 * Assumption made explicit: points are treated as independent and identically
 * distributed within a server's service games. This is the standard modelling
 * assumption; it slightly understates the variance of real matches.
 */

/** Probability the server wins a game, given their point-win probability. */
export function gameWinProbability(pointWin: number): number {
  const p = Math.min(Math.max(pointWin, 1e-9), 1 - 1e-9);
  const q = 1 - p;
  // Win to love / 15 / 30 outright.
  const toLove = p ** 4;
  const to15 = 4 * p ** 4 * q;
  const to30 = 10 * p ** 4 * q ** 2;
  // Reaching deuce (3-3 in points) then winning the deuce sub-game.
  const reachDeuce = 20 * p ** 3 * q ** 3;
  const winFromDeuce = p ** 2 / (p ** 2 + q ** 2);
  return toLove + to15 + to30 + reachDeuce * winFromDeuce;
}

/**
 * Probability that the player who serves first in a tiebreak wins it.
 *
 * Serve order in a 7-point tiebreak is A, BB, AA, BB, ... Solved by exact
 * dynamic programming over (pointsA, pointsB) with a closed form once both
 * players reach 6-6.
 */
export function tiebreakWinProbability(pServeA: number, pServeB: number): number {
  const memo = new Map<string, number>();

  // At 6-6 the pattern repeats every two points with A serving first.
  const pA = pServeA;
  const pB = pServeB;
  const winTwo = pA * (1 - pB); // A holds then breaks
  const loseTwo = (1 - pA) * pB; // A drops serve then B holds
  // From 6-6, the two-point cycle repeats until someone gains a two-point lead.
  const denominator = winTwo + loseTwo;
  const fromSixAll = denominator > 0 ? winTwo / denominator : 0.5;

  /** True when player A serves the (pointsPlayed + 1)-th point of the tiebreak. */
  const aServes = (pointsPlayed: number): boolean => {
    if (pointsPlayed === 0) return true;
    // After the first point, serve changes every two points.
    return Math.floor((pointsPlayed - 1) / 2) % 2 === 1;
  };

  const solve = (a: number, b: number): number => {
    if (a >= 7 && a - b >= 2) return 1;
    if (b >= 7 && b - a >= 2) return 0;
    if (a >= 6 && b >= 6) return fromSixAll;
    const key = `${a}:${b}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    const pAWinsPoint = aServes(a + b) ? pA : 1 - pB;
    const value = pAWinsPoint * solve(a + 1, b) + (1 - pAWinsPoint) * solve(a, b + 1);
    memo.set(key, value);
    return value;
  };

  return solve(0, 0);
}

export interface SetScoreDistribution {
  /** Probability of each (gamesA, gamesB) final set score. */
  readonly scores: ReadonlyArray<{ a: number; b: number; probability: number }>;
  readonly aWins: number;
}

/**
 * Full distribution over set scores, given both players' service-game hold
 * probabilities. Player A serves the first game of the set.
 *
 * Note that individual scorelines are deliberately NOT symmetric even when both
 * players are equally strong: the server is fixed by the game number, so the
 * player who serves first clinches 6-3 by holding but must break to clinch 6-4.
 * The set-win probability still comes out at exactly 0.5 for equal players.
 */
export function setScoreDistribution(holdA: number, holdB: number, tiebreakA: number): SetScoreDistribution {
  const results = new Map<string, number>();

  const record = (a: number, b: number, probability: number) => {
    if (probability <= 0) return;
    const key = `${a}:${b}`;
    results.set(key, (results.get(key) ?? 0) + probability);
  };

  const walk = (a: number, b: number, probability: number) => {
    if (probability < 1e-12) return;
    // Set won 6-0..6-4 or 7-5.
    if (a >= 6 && a - b >= 2) return record(a, b, probability);
    if (b >= 6 && b - a >= 2) return record(a, b, probability);
    if (a === 7 || b === 7) return record(a, b, probability);
    if (a === 6 && b === 6) {
      // Tiebreak decides a 7-6 set.
      record(7, 6, probability * tiebreakA);
      record(6, 7, probability * (1 - tiebreakA));
      return;
    }
    // Player A serves games 1, 3, 5, ... of the set.
    const aServing = (a + b) % 2 === 0;
    const pAWinsGame = aServing ? holdA : 1 - holdB;
    walk(a + 1, b, probability * pAWinsGame);
    walk(a, b + 1, probability * (1 - pAWinsGame));
  };

  walk(0, 0, 1);

  const scores = [...results.entries()]
    .map(([key, probability]) => {
      const [a, b] = key.split(':').map(Number);
      return { a, b, probability };
    })
    .sort((x, y) => y.probability - x.probability);

  const aWins = scores.reduce((sum, s) => (s.a > s.b ? sum + s.probability : sum), 0);
  return { scores, aWins };
}

export interface TennisMatchDistribution {
  readonly matchWinA: number;
  readonly setWinA: number;
  /** P(total games in match = n), indexed by n. */
  readonly totalGames: readonly number[];
  readonly expectedTotalGames: number;
  /** P(gamesA - gamesB = d) keyed by the margin d. */
  readonly gameMargin: ReadonlyMap<number, number>;
  readonly setScoreProbabilities: ReadonlyArray<{ sets: string; probability: number }>;
}

/**
 * Propagates the set distribution to a best-of-3 or best-of-5 match.
 *
 * Sets are treated as independent draws from the same set distribution, which
 * is the standard simplification: it ignores within-match momentum, which the
 * literature finds to be small relative to serve quality.
 */
function matchDistributionGivenFirstServer(
  pServeA: number,
  pServeB: number,
  bestOf: 3 | 5,
  aServesFirstGame: boolean,
): TennisMatchDistribution {
  const holdA = gameWinProbability(pServeA);
  const holdB = gameWinProbability(pServeB);
  const setsToWin = bestOf === 3 ? 2 : 3;

  // Two set distributions are needed because serve order carries across sets:
  // the player who serves the first game of a set is determined by how many
  // games the previous set lasted, not by a fresh coin toss. Ignoring this
  // biases the game-margin (and therefore the handicap market) toward whoever
  // opened the match.
  const setAServesFirst = setScoreDistribution(holdA, holdB, tiebreakWinProbability(pServeA, pServeB));
  const setBServesFirstRaw = setScoreDistribution(holdB, holdA, tiebreakWinProbability(pServeB, pServeA));
  // Re-express B-serves-first scores from A's point of view.
  const setBServesFirst = {
    scores: setBServesFirstRaw.scores.map((s) => ({ a: s.b, b: s.a, probability: s.probability })),
    aWins: 1 - setBServesFirstRaw.aWins,
  };

  /** Match state during the walk, keyed for aggregation. */
  interface State {
    setsA: number;
    setsB: number;
    /** True when player A serves the first game of the next set. */
    aServesFirst: boolean;
    games: number;
    margin: number;
  }
  const key = (s: State) => `${s.setsA}:${s.setsB}:${s.aServesFirst ? 1 : 0}:${s.games}:${s.margin}`;

  let active = new Map<string, { state: State; probability: number }>();
  const initial: State = { setsA: 0, setsB: 0, aServesFirst: aServesFirstGame, games: 0, margin: 0 };
  active.set(key(initial), { state: initial, probability: 1 });

  const totalGames = new Map<number, number>();
  const gameMargin = new Map<number, number>();
  const setScores = new Map<string, number>();
  let matchWinA = 0;

  const settle = (state: State, probability: number) => {
    if (state.setsA === setsToWin) matchWinA += probability;
    const label = `${state.setsA}-${state.setsB}`;
    setScores.set(label, (setScores.get(label) ?? 0) + probability);
    totalGames.set(state.games, (totalGames.get(state.games) ?? 0) + probability);
    gameMargin.set(state.margin, (gameMargin.get(state.margin) ?? 0) + probability);
  };

  // At most 2 * setsToWin - 1 sets can be played.
  for (let setIndex = 0; setIndex < 2 * setsToWin - 1; setIndex += 1) {
    const next = new Map<string, { state: State; probability: number }>();
    for (const { state, probability } of active.values()) {
      const distribution = state.aServesFirst ? setAServesFirst : setBServesFirst;
      for (const score of distribution.scores) {
        const weight = probability * score.probability;
        if (weight < 1e-12) continue;
        const gamesInSet = score.a + score.b;
        const updated: State = {
          setsA: state.setsA + (score.a > score.b ? 1 : 0),
          setsB: state.setsB + (score.b > score.a ? 1 : 0),
          // The serve keeps alternating across the set boundary, so the next
          // set opens with the same player only if the set lasted an even
          // number of games.
          aServesFirst: gamesInSet % 2 === 0 ? state.aServesFirst : !state.aServesFirst,
          games: state.games + gamesInSet,
          margin: state.margin + (score.a - score.b),
        };

        if (updated.setsA === setsToWin || updated.setsB === setsToWin) {
          settle(updated, weight);
          continue;
        }
        const k = key(updated);
        const existing = next.get(k);
        if (existing) existing.probability += weight;
        else next.set(k, { state: updated, probability: weight });
      }
    }
    active = next;
    if (active.size === 0) break;
  }

  const maxGames = Math.max(...totalGames.keys(), 0);
  const totalGamesArray = new Array<number>(maxGames + 1).fill(0);
  let expectedTotalGames = 0;
  for (const [games, probability] of totalGames) {
    totalGamesArray[games] = probability;
    expectedTotalGames += games * probability;
  }

  return {
    matchWinA,
    setWinA: aServesFirstGame ? setAServesFirst.aWins : setBServesFirst.aWins,
    totalGames: totalGamesArray,
    expectedTotalGames,
    gameMargin,
    setScoreProbabilities: [...setScores.entries()]
      .map(([sets, probability]) => ({ sets, probability }))
      .sort((x, y) => y.probability - x.probability),
  };
}

/**
 * Full match distribution, averaged over the opening serve.
 *
 * Who serves the first game is decided by a coin toss that is unknown at
 * prediction time, and it measurably shifts the game-margin distribution. Rather
 * than arbitrarily assuming one player opens, both cases are computed and
 * averaged, which leaves the margin unbiased for evenly matched players.
 */
export function tennisMatchDistribution(
  pServeA: number,
  pServeB: number,
  bestOf: 3 | 5 = 3,
): TennisMatchDistribution {
  const aFirst = matchDistributionGivenFirstServer(pServeA, pServeB, bestOf, true);
  const bFirst = matchDistributionGivenFirstServer(pServeA, pServeB, bestOf, false);

  const totalGames: number[] = [];
  const length = Math.max(aFirst.totalGames.length, bFirst.totalGames.length);
  for (let i = 0; i < length; i += 1) {
    totalGames.push(((aFirst.totalGames[i] ?? 0) + (bFirst.totalGames[i] ?? 0)) / 2);
  }

  const gameMargin = new Map<number, number>();
  for (const [margin, p] of aFirst.gameMargin) gameMargin.set(margin, (gameMargin.get(margin) ?? 0) + p / 2);
  for (const [margin, p] of bFirst.gameMargin) gameMargin.set(margin, (gameMargin.get(margin) ?? 0) + p / 2);

  const setScores = new Map<string, number>();
  for (const { sets, probability } of aFirst.setScoreProbabilities) {
    setScores.set(sets, (setScores.get(sets) ?? 0) + probability / 2);
  }
  for (const { sets, probability } of bFirst.setScoreProbabilities) {
    setScores.set(sets, (setScores.get(sets) ?? 0) + probability / 2);
  }

  return {
    matchWinA: (aFirst.matchWinA + bFirst.matchWinA) / 2,
    setWinA: (aFirst.setWinA + bFirst.setWinA) / 2,
    totalGames,
    expectedTotalGames: (aFirst.expectedTotalGames + bFirst.expectedTotalGames) / 2,
    gameMargin,
    setScoreProbabilities: [...setScores.entries()]
      .map(([sets, probability]) => ({ sets, probability }))
      .sort((x, y) => y.probability - x.probability),
  };
}

/** P(total games > line) from a total-games distribution. */
export function totalGamesOver(distribution: readonly number[], line: number): number {
  let over = 0;
  for (let games = 0; games < distribution.length; games += 1) {
    if (games > line) over += distribution[games] ?? 0;
  }
  return over;
}

/** P(player A's game margin beats the handicap `line`). */
export function gamesHandicapProbability(
  gameMargin: ReadonlyMap<number, number>,
  line: number,
): number {
  let win = 0;
  for (const [margin, probability] of gameMargin) {
    if (margin + line > 0) win += probability;
  }
  return win;
}
