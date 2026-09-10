/**
 * Feature engineering.
 *
 * Every feature is computed only from data that existed before `ctx.asOf`, and
 * every feature reports whether it came from real observations or from a
 * neutral default. Missing data lowers confidence rather than being invented.
 */

import type {
  AbsentPlayer,
  Feature,
  FeatureCategory,
  FeatureVector,
  FormConfig,
  HistoricalMatch,
  LeagueBaseline,
  MatchContext,
  TeamContext,
} from '../types';
import { clamp, exponentialWeights, mean, shrink, weightedMean } from '../math/stats';

export const FEATURES_VERSION = '1.0.0';

/** Matches strictly before the cut-off, oldest first. Guards against leakage. */
export function matchesBefore(
  matches: readonly HistoricalMatch[],
  cutoff: Date,
  limit?: number,
): HistoricalMatch[] {
  const filtered = matches
    .filter((m) => m.kickoff.getTime() < cutoff.getTime())
    .sort((a, b) => a.kickoff.getTime() - b.kickoff.getTime());
  return limit === undefined ? filtered : filtered.slice(-limit);
}

export type MatchOutcome = 'W' | 'D' | 'L';

export function outcomeFor(match: HistoricalMatch, teamId: string): MatchOutcome {
  const isHome = match.homeTeamId === teamId;
  const scored = isHome ? match.homeScore : match.awayScore;
  const conceded = isHome ? match.awayScore : match.homeScore;
  if (scored > conceded) return 'W';
  if (scored === conceded) return 'D';
  return 'L';
}

export function pointsFor(match: HistoricalMatch, teamId: string): number {
  const outcome = outcomeFor(match, teamId);
  return outcome === 'W' ? 1 : outcome === 'D' ? 0.5 : 0;
}

export function goalsFor(match: HistoricalMatch, teamId: string): number {
  return match.homeTeamId === teamId ? match.homeScore : match.awayScore;
}

export function goalsAgainst(match: HistoricalMatch, teamId: string): number {
  return match.homeTeamId === teamId ? match.awayScore : match.homeScore;
}

export interface VenueRecord {
  readonly played: number;
  readonly won: number;
  readonly drawn: number;
  readonly lost: number;
  readonly goalsForPerMatch: number;
  readonly goalsAgainstPerMatch: number;
  readonly pointsPerMatch: number;
}

const EMPTY_VENUE_RECORD: VenueRecord = {
  played: 0, won: 0, drawn: 0, lost: 0,
  goalsForPerMatch: 0, goalsAgainstPerMatch: 0, pointsPerMatch: 0,
};

/**
 * Plain won/drawn/lost record split by venue, over matches before the cut-off.
 *
 * The model already accounts for venue through the home-advantage term and the
 * venue-edge features; this is the same information in the form a reader can
 * check against a league table, which is the point of showing it.
 *
 * Neutral-venue matches count as neither home nor away — attributing them to
 * either side would overstate whichever record absorbed them.
 */
export function venueRecord(
  team: TeamContext,
  cutoff: Date,
  venue: 'home' | 'away',
  lookback?: number,
): VenueRecord {
  const window = matchesBefore(team.recentMatches, cutoff, lookback).filter(
    (match) =>
      !match.neutralVenue &&
      (venue === 'home' ? match.homeTeamId === team.teamId : match.awayTeamId === team.teamId),
  );
  if (window.length === 0) return EMPTY_VENUE_RECORD;

  let won = 0;
  let drawn = 0;
  let scored = 0;
  let conceded = 0;
  for (const match of window) {
    const outcome = outcomeFor(match, team.teamId);
    if (outcome === 'W') won += 1;
    else if (outcome === 'D') drawn += 1;
    scored += goalsFor(match, team.teamId);
    conceded += goalsAgainst(match, team.teamId);
  }

  return {
    played: window.length,
    won,
    drawn,
    lost: window.length - won - drawn,
    goalsForPerMatch: scored / window.length,
    goalsAgainstPerMatch: conceded / window.length,
    pointsPerMatch: (won * 3 + drawn) / window.length,
  };
}

export function xgFor(match: HistoricalMatch, teamId: string): number | undefined {
  return match.homeTeamId === teamId ? match.homeXg : match.awayXg;
}

export function xgAgainst(match: HistoricalMatch, teamId: string): number | undefined {
  return match.homeTeamId === teamId ? match.awayXg : match.homeXg;
}

export interface FormSummary {
  /** Exponentially weighted points-per-match in [0,1]. */
  readonly weightedPoints: number;
  readonly unweightedPoints: number;
  readonly results: readonly MatchOutcome[];
  readonly goalsForPerMatch: number;
  readonly goalsAgainstPerMatch: number;
  readonly sampleSize: number;
}

/**
 * Recent form with exponential recency weighting.
 *
 * A match `halfLifeMatches` positions older than the newest counts half as
 * much, so yesterday's result never sits at the same weight as one from six
 * months ago.
 */
export function computeForm(
  team: TeamContext,
  cutoff: Date,
  config: FormConfig,
): FormSummary {
  const window = matchesBefore(team.recentMatches, cutoff, config.lookback);
  if (window.length === 0) {
    return {
      weightedPoints: 0.5,
      unweightedPoints: 0.5,
      results: [],
      goalsForPerMatch: 0,
      goalsAgainstPerMatch: 0,
      sampleSize: 0,
    };
  }

  const weights = exponentialWeights(window.length, config.halfLifeMatches);
  const points = window.map((m) => pointsFor(m, team.teamId));
  const scored = window.map((m) => goalsFor(m, team.teamId));
  const conceded = window.map((m) => goalsAgainst(m, team.teamId));

  return {
    weightedPoints: weightedMean(points, weights),
    unweightedPoints: mean(points),
    // Newest-first for display: "W-W-D-W-W" reads left to right as most recent.
    results: [...window].reverse().map((m) => outcomeFor(m, team.teamId)),
    goalsForPerMatch: weightedMean(scored, weights),
    goalsAgainstPerMatch: weightedMean(conceded, weights),
    sampleSize: window.length,
  };
}

export interface StrengthSummary {
  /**
   * Attacking strength relative to the league average (1.0 = average).
   * Blends the goals-based and xG-based estimates when xG is available.
   */
  readonly attack: number;
  /** Defensive strength relative to the league average (lower is better). */
  readonly defence: number;
  /** Goals-only estimates, kept separately for display. */
  readonly goalsAttack: number;
  readonly goalsDefence: number;
  readonly xgAttack: number | null;
  readonly xgDefence: number | null;
  readonly cleanSheetRate: number;
  readonly sampleSize: number;
}

/** Observations below this count are shrunk hard toward the league average. */
const STRENGTH_PRIOR_WEIGHT = 6;

/**
 * Weight given to the xG-based estimate when blending it with the goals-based
 * one.
 *
 * Expected goals is a lower-variance observation of a team's underlying scoring
 * rate than the goals it actually scored: finishing is close to random in the
 * short run, so past xG predicts future goals better than past goals do. It is
 * weighted above raw goals for exactly that reason, but not exclusively -
 * persistent finishing quality is real, if small.
 */
const XG_BLEND_WEIGHT = 0.65;

/**
 * League-relative attack and defence strength.
 *
 * Rates are shrunk toward 1.0 (league average) using an empirical-Bayes prior,
 * so a team with three matches played does not get an extreme rating from a
 * small sample.
 */
export function computeStrength(
  team: TeamContext,
  cutoff: Date,
  league: LeagueBaseline,
  lookback: number,
): StrengthSummary {
  const window = matchesBefore(team.recentMatches, cutoff, lookback);
  const leagueAverageScore = (league.averageHomeScore + league.averageAwayScore) / 2;
  if (window.length === 0 || leagueAverageScore <= 0) {
    return {
      attack: 1,
      defence: 1,
      goalsAttack: 1,
      goalsDefence: 1,
      xgAttack: null,
      xgDefence: null,
      cleanSheetRate: 0,
      sampleSize: 0,
    };
  }

  const scored = mean(window.map((m) => goalsFor(m, team.teamId)));
  const conceded = mean(window.map((m) => goalsAgainst(m, team.teamId)));
  const cleanSheets = window.filter((m) => goalsAgainst(m, team.teamId) === 0).length;

  const xgSamples = window.map((m) => xgFor(m, team.teamId)).filter((v): v is number => v !== undefined);
  const xgaSamples = window
    .map((m) => xgAgainst(m, team.teamId))
    .filter((v): v is number => v !== undefined);

  const goalsAttack = shrink(scored / leagueAverageScore, window.length, 1, STRENGTH_PRIOR_WEIGHT);
  const goalsDefence = shrink(conceded / leagueAverageScore, window.length, 1, STRENGTH_PRIOR_WEIGHT);
  const xgAttack =
    xgSamples.length > 0
      ? shrink(mean(xgSamples) / leagueAverageScore, xgSamples.length, 1, STRENGTH_PRIOR_WEIGHT)
      : null;
  const xgDefence =
    xgaSamples.length > 0
      ? shrink(mean(xgaSamples) / leagueAverageScore, xgaSamples.length, 1, STRENGTH_PRIOR_WEIGHT)
      : null;

  // The xG estimate is only trusted in proportion to how much of the window it
  // actually covers, so a couple of matches with xG cannot dominate twenty
  // without it.
  const xgCoverage = Math.min(xgSamples.length / window.length, 1);
  const blend = (goals: number, xg: number | null): number =>
    xg === null ? goals : goals * (1 - XG_BLEND_WEIGHT * xgCoverage) + xg * XG_BLEND_WEIGHT * xgCoverage;

  return {
    attack: blend(goalsAttack, xgAttack),
    defence: blend(goalsDefence, xgDefence),
    goalsAttack,
    goalsDefence,
    xgAttack,
    xgDefence,
    cleanSheetRate: cleanSheets / window.length,
    sampleSize: window.length,
  };
}

export interface VenueSummary {
  readonly homeWinRate: number;
  readonly awayWinRate: number;
  readonly homeGoalsPerMatch: number;
  readonly awayGoalsPerMatch: number;
  readonly homeSample: number;
  readonly awaySample: number;
}

/** Splits a team's record by venue, shrunk toward the league's venue baseline. */
export function computeVenueRecord(
  team: TeamContext,
  cutoff: Date,
  league: LeagueBaseline,
  lookback: number,
): VenueSummary {
  const window = matchesBefore(team.recentMatches, cutoff, lookback);
  const atHome = window.filter((m) => m.homeTeamId === team.teamId);
  const away = window.filter((m) => m.awayTeamId === team.teamId);

  const winRate = (matches: HistoricalMatch[]) =>
    matches.length === 0
      ? 0
      : matches.filter((m) => outcomeFor(m, team.teamId) === 'W').length / matches.length;

  return {
    homeWinRate: shrink(winRate(atHome), atHome.length, league.homeWinRate, 4),
    awayWinRate: shrink(winRate(away), away.length, league.awayWinRate, 4),
    homeGoalsPerMatch: shrink(
      mean(atHome.map((m) => goalsFor(m, team.teamId))),
      atHome.length,
      league.averageHomeScore,
      4,
    ),
    awayGoalsPerMatch: shrink(
      mean(away.map((m) => goalsFor(m, team.teamId))),
      away.length,
      league.averageAwayScore,
      4,
    ),
    homeSample: atHome.length,
    awaySample: away.length,
  };
}

export interface HeadToHeadSummary {
  /** Time-decayed home-side points share in [0,1]. 0.5 when there is no history. */
  readonly homeShare: number;
  readonly meetings: number;
  readonly homeWins: number;
  readonly draws: number;
  readonly awayWins: number;
  readonly averageTotalGoals: number;
}

/** Half-life for head-to-head decay. Meetings older than this fade fast. */
const H2H_HALF_LIFE_DAYS = 540;

/**
 * Head-to-head record with time decay, so a rivalry from five seasons ago
 * informs but does not dominate the prediction.
 */
export function computeHeadToHead(
  headToHead: readonly HistoricalMatch[],
  homeTeamId: string,
  awayTeamId: string,
  cutoff: Date,
): HeadToHeadSummary {
  const meetings = matchesBefore(headToHead, cutoff);
  if (meetings.length === 0) {
    return { homeShare: 0.5, meetings: 0, homeWins: 0, draws: 0, awayWins: 0, averageTotalGoals: 0 };
  }

  let weightedPoints = 0;
  let weightTotal = 0;
  let homeWins = 0;
  let draws = 0;
  let awayWins = 0;
  let goals = 0;

  for (const match of meetings) {
    const ageDays = (cutoff.getTime() - match.kickoff.getTime()) / 86_400_000;
    const weight = Math.exp((-Math.log(2) * ageDays) / H2H_HALF_LIFE_DAYS);
    weightedPoints += pointsFor(match, homeTeamId) * weight;
    weightTotal += weight;

    const outcome = outcomeFor(match, homeTeamId);
    if (outcome === 'W') homeWins += 1;
    else if (outcome === 'D') draws += 1;
    else awayWins += 1;
    goals += match.homeScore + match.awayScore;

    // Referenced so the away id stays part of the contract for callers.
    void awayTeamId;
  }

  return {
    homeShare: weightTotal > 0 ? weightedPoints / weightTotal : 0.5,
    meetings: meetings.length,
    homeWins,
    draws,
    awayWins,
    averageTotalGoals: goals / meetings.length,
  };
}

export interface RestSummary {
  readonly daysSinceLastMatch: number | null;
  /** Matches played in the 14 days before the cut-off. */
  readonly matchesInLast14Days: number;
  /** 0 = heavily congested, 1 = fully rested. */
  readonly freshness: number;
}

/** Days of rest at which a side is considered fully recovered. */
const FULL_REST_DAYS = 6;

export function computeRest(team: TeamContext, cutoff: Date): RestSummary {
  const window = matchesBefore(team.recentMatches, cutoff);
  const last = window[window.length - 1];
  if (!last) {
    return { daysSinceLastMatch: null, matchesInLast14Days: 0, freshness: 1 };
  }
  const days = (cutoff.getTime() - last.kickoff.getTime()) / 86_400_000;
  const recent = window.filter(
    (m) => (cutoff.getTime() - m.kickoff.getTime()) / 86_400_000 <= 14,
  ).length;
  // Rest saturates at FULL_REST_DAYS; each extra fixture in the window costs 10%.
  const restScore = clamp(days / FULL_REST_DAYS, 0, 1);
  const congestionPenalty = clamp(1 - Math.max(0, recent - 2) * 0.1, 0, 1);
  return {
    daysSinceLastMatch: days,
    matchesInLast14Days: recent,
    freshness: clamp(restScore * congestionPenalty, 0, 1),
  };
}

export interface AvailabilitySummary {
  /** Share of squad importance that is unavailable, in [0,1]. */
  readonly missingImportance: number;
  readonly absentees: readonly AbsentPlayer[];
  readonly reported: boolean;
}

export function computeAvailability(team: TeamContext): AvailabilitySummary {
  const total = team.squadImportanceTotal;
  if (total <= 0) {
    return { missingImportance: 0, absentees: team.absentees, reported: false };
  }
  const missing = team.absentees.reduce((sum, player) => sum + player.importance, 0);
  return {
    missingImportance: clamp(missing / total, 0, 1),
    absentees: team.absentees,
    reported: true,
  };
}

/** Helper used by sport modules to assemble a `FeatureVector`. */
export class FeatureBuilder {
  private readonly items: Feature[] = [];

  add(
    name: string,
    value: number,
    category: FeatureCategory,
    label: string,
    options: { imputed?: boolean; contribution?: number } = {},
  ): this {
    this.items.push({
      name,
      value: Number.isFinite(value) ? value : 0,
      category,
      label,
      imputed: options.imputed ?? false,
      contribution: options.contribution,
    });
    return this;
  }

  build(version: string): FeatureVector {
    const byName: Record<string, number> = {};
    for (const feature of this.items) byName[feature.name] = feature.value;
    const real = this.items.filter((f) => !f.imputed).length;
    return {
      features: this.items,
      byName,
      completeness: this.items.length === 0 ? 0 : real / this.items.length,
      version,
    };
  }
}

/** Convenience wrapper used by several sport modules. */
export function contextCutoff(ctx: MatchContext): Date {
  return ctx.asOf.getTime() < ctx.kickoff.getTime() ? ctx.asOf : ctx.kickoff;
}
