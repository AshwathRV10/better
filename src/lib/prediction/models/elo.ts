/**
 * Elo ratings with margin-of-victory scaling and a home-advantage term.
 *
 * Ratings are dynamic: every finished match moves both sides, and the size of
 * the move depends on how surprising the result was and how large the margin
 * was. Draws are handled natively via the 0.5 score convention, so this works
 * for football as well as for two-outcome sports.
 */

import type { EloConfig, HistoricalMatch } from '../types';

export const DEFAULT_ELO_CONFIG: EloConfig = {
  initialRating: 1500,
  kFactor: 20,
  homeAdvantage: 60,
  marginMultiplier: 1,
  scale: 400,
};

/**
 * Expected score (in [0,1]) for the home side, where a draw counts as 0.5.
 * `homeAdvantage` is expressed in rating points and is suppressed at neutral
 * venues.
 */
export function eloExpectedScore(
  homeRating: number,
  awayRating: number,
  config: EloConfig = DEFAULT_ELO_CONFIG,
  neutralVenue = false,
): number {
  const advantage = neutralVenue ? 0 : config.homeAdvantage;
  const diff = homeRating + advantage - awayRating;
  return 1 / (1 + 10 ** (-diff / config.scale));
}

/**
 * Margin-of-victory multiplier (FiveThirtyEight's formulation).
 *
 * The log term dampens blowouts so a 6-0 does not move ratings three times as
 * far as a 2-0, and the denominator corrects for autocorrelation: strong teams
 * naturally win by more, so their wins should count for slightly less.
 */
export function marginMultiplier(
  goalDifference: number,
  ratingDifference: number,
  multiplier = 1,
): number {
  const margin = Math.abs(goalDifference);
  if (margin === 0) return 1;
  const autocorrelation = 2.2 / (Math.abs(ratingDifference) * 0.001 + 2.2);
  return Math.log(margin + 1) * autocorrelation * multiplier;
}

export interface EloUpdate {
  readonly home: number;
  readonly away: number;
  readonly expectedHome: number;
  readonly actualHome: number;
  readonly change: number;
}

/** Actual score for the home side: 1 win, 0.5 draw, 0 loss. */
export function actualScore(homeScore: number, awayScore: number): number {
  if (homeScore > awayScore) return 1;
  if (homeScore === awayScore) return 0.5;
  return 0;
}

/** Applies one match result to a pair of ratings. Elo is zero-sum. */
export function updateElo(
  homeRating: number,
  awayRating: number,
  homeScore: number,
  awayScore: number,
  config: EloConfig = DEFAULT_ELO_CONFIG,
  neutralVenue = false,
): EloUpdate {
  const expectedHome = eloExpectedScore(homeRating, awayRating, config, neutralVenue);
  const actualHome = actualScore(homeScore, awayScore);
  const advantage = neutralVenue ? 0 : config.homeAdvantage;
  const mov = marginMultiplier(
    homeScore - awayScore,
    homeRating + advantage - awayRating,
    config.marginMultiplier,
  );
  const change = config.kFactor * mov * (actualHome - expectedHome);
  return {
    home: homeRating + change,
    away: awayRating - change,
    expectedHome,
    actualHome,
    change,
  };
}

export interface RatingTable {
  readonly ratings: ReadonlyMap<string, number>;
  readonly matchesPlayed: ReadonlyMap<string, number>;
}

/**
 * Replays a chronologically ordered match list to produce current ratings.
 *
 * The caller is responsible for only passing matches that finished before the
 * prediction instant - that is how look-ahead bias is prevented.
 */
export function buildRatings(
  matches: readonly HistoricalMatch[],
  config: EloConfig = DEFAULT_ELO_CONFIG,
  seed?: ReadonlyMap<string, number>,
): RatingTable {
  const ratings = new Map<string, number>(seed ?? []);
  const matchesPlayed = new Map<string, number>();
  const ordered = [...matches].sort((a, b) => a.kickoff.getTime() - b.kickoff.getTime());

  for (const match of ordered) {
    const home = ratings.get(match.homeTeamId) ?? config.initialRating;
    const away = ratings.get(match.awayTeamId) ?? config.initialRating;
    const update = updateElo(
      home,
      away,
      match.homeScore,
      match.awayScore,
      config,
      match.neutralVenue,
    );
    ratings.set(match.homeTeamId, update.home);
    ratings.set(match.awayTeamId, update.away);
    matchesPlayed.set(match.homeTeamId, (matchesPlayed.get(match.homeTeamId) ?? 0) + 1);
    matchesPlayed.set(match.awayTeamId, (matchesPlayed.get(match.awayTeamId) ?? 0) + 1);
  }

  return { ratings, matchesPlayed };
}

/**
 * Turns an Elo expectation into 1X2 probabilities.
 *
 * Elo gives P(home points share), not the three-way split, so the draw is
 * modelled separately: it peaks when the sides are evenly matched and decays as
 * the expectation moves away from 0.5. `drawPeak` is the league's observed draw
 * rate, which keeps the split honest per competition instead of hard-coded.
 */
export function eloOutcomeProbabilities(
  expectedHome: number,
  drawPeak: number,
): { home: number; draw: number; away: number } {
  const balance = 1 - Math.abs(expectedHome - 0.5) * 2; // 1 when even, 0 at the extremes
  const draw = Math.max(0, Math.min(drawPeak * balance, 0.95));
  const remaining = 1 - draw;
  // Split the non-draw mass in proportion to the Elo expectation.
  const home = remaining * expectedHome;
  const away = remaining * (1 - expectedHome);
  return { home, draw, away };
}
