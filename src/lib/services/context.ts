/**
 * Builds a `MatchContext` from the database.
 *
 * This is the single place where look-ahead bias could enter the system, so
 * every query is bounded by the `asOf` instant: only matches that finished
 * before it, and only odds captured before it, are ever loaded.
 */

import type { Match, Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { DEFAULT_ELO_CONFIG, buildRatings } from '../prediction/models/elo';
import type {
  AbsentPlayer,
  HistoricalMatch,
  LeagueBaseline,
  MatchContext,
  OddsQuote,
  SportKey,
  TeamContext,
} from '../prediction/types';
import type { MarketKey } from '../prediction/types';

/** Matches loaded per team when building form and strength features. */
const HISTORY_LIMIT = 30;
/** Head-to-head meetings loaded per fixture. */
const H2H_LIMIT = 10;
/** Matches used to compute a league's scoring and home-advantage baselines. */
const BASELINE_LIMIT = 400;

const matchWithStats = {
  include: { statistics: true, league: { select: { key: true } } },
} satisfies Prisma.MatchDefaultArgs;

type MatchWithStats = Prisma.MatchGetPayload<typeof matchWithStats>;

/** Converts a database row into the engine's historical-match shape. */
export function toHistoricalMatch(match: MatchWithStats): HistoricalMatch | null {
  if (match.homeScore === null || match.awayScore === null) return null;
  const home = match.statistics.find((s) => s.isHome);
  const away = match.statistics.find((s) => !s.isHome);
  return {
    id: match.id,
    leagueKey: match.league.key,
    kickoff: match.kickoff,
    homeTeamId: match.homeTeamId,
    awayTeamId: match.awayTeamId,
    homeScore: match.homeScore,
    awayScore: match.awayScore,
    neutralVenue: match.neutralVenue,
    homeXg: home?.xg ?? undefined,
    awayXg: away?.xg ?? undefined,
    homeShots: home?.shots ?? undefined,
    awayShots: away?.shots ?? undefined,
    homeShotsOnTarget: home?.shotsOnTarget ?? undefined,
    awayShotsOnTarget: away?.shotsOnTarget ?? undefined,
    detail: (match.scoreDetail as Record<string, unknown> | null) ?? undefined,
  };
}

/**
 * League scoring and result baselines, computed from finished matches only.
 *
 * Falls back to sport-typical defaults when a league has too little history to
 * estimate from - stated defaults are honest, invented data is not.
 */
export async function buildLeagueBaseline(
  leagueId: string,
  asOf: Date,
): Promise<LeagueBaseline> {
  const league = await prisma.league.findUniqueOrThrow({
    where: { id: leagueId },
    include: { sport: { select: { key: true } } },
  });

  const matches = await prisma.match.findMany({
    where: { leagueId, status: 'FINISHED', kickoff: { lt: asOf } },
    orderBy: { kickoff: 'desc' },
    take: BASELINE_LIMIT,
    select: { homeScore: true, awayScore: true },
  });

  const scored = matches.filter(
    (m): m is { homeScore: number; awayScore: number } =>
      m.homeScore !== null && m.awayScore !== null,
  );

  const sportKey = league.sport.key as SportKey;
  const defaults = SPORT_BASELINE_DEFAULTS[sportKey] ?? SPORT_BASELINE_DEFAULTS.football;

  if (scored.length < 10) {
    return {
      leagueKey: league.key,
      name: league.name,
      strength: league.strength,
      ...defaults,
      matchesObserved: scored.length,
    };
  }

  const homeGoals = scored.reduce((sum, m) => sum + m.homeScore, 0) / scored.length;
  const awayGoals = scored.reduce((sum, m) => sum + m.awayScore, 0) / scored.length;
  const homeWins = scored.filter((m) => m.homeScore > m.awayScore).length;
  const draws = scored.filter((m) => m.homeScore === m.awayScore).length;

  return {
    leagueKey: league.key,
    name: league.name,
    strength: league.strength,
    averageHomeScore: homeGoals,
    averageAwayScore: awayGoals,
    homeWinRate: homeWins / scored.length,
    drawRate: draws / scored.length,
    awayWinRate: (scored.length - homeWins - draws) / scored.length,
    matchesObserved: scored.length,
  };
}

/** Sport-typical fallbacks used only when a league has too little history. */
const SPORT_BASELINE_DEFAULTS: Record<
  SportKey,
  Pick<LeagueBaseline, 'averageHomeScore' | 'averageAwayScore' | 'homeWinRate' | 'drawRate' | 'awayWinRate'>
> = {
  football: { averageHomeScore: 1.5, averageAwayScore: 1.2, homeWinRate: 0.44, drawRate: 0.26, awayWinRate: 0.3 },
  basketball: { averageHomeScore: 114, averageAwayScore: 111, homeWinRate: 0.57, drawRate: 0, awayWinRate: 0.43 },
  tennis: { averageHomeScore: 1.5, averageAwayScore: 1.0, homeWinRate: 0.5, drawRate: 0, awayWinRate: 0.5 },
};

async function buildTeamContext(
  teamId: string,
  matchId: string,
  asOf: Date,
  ratings: ReadonlyMap<string, number>,
  matchesPlayed: ReadonlyMap<string, number>,
): Promise<TeamContext> {
  const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId } });

  const history = await prisma.match.findMany({
    where: {
      status: 'FINISHED',
      kickoff: { lt: asOf },
      OR: [{ homeTeamId: teamId }, { awayTeamId: teamId }],
    },
    orderBy: { kickoff: 'desc' },
    take: HISTORY_LIMIT,
    ...matchWithStats,
  });

  const players = await prisma.player.findMany({ where: { teamId } });
  const squadImportanceTotal = players.reduce((sum, player) => sum + player.importance, 0);

  const absences = await prisma.playerAvailability.findMany({
    where: { matchId, player: { teamId } },
    include: { player: true },
  });

  const absentees: AbsentPlayer[] = absences.map((absence) => ({
    playerId: absence.playerId,
    name: absence.player.name,
    position: absence.player.position ?? undefined,
    importance: absence.player.importance,
    status: absence.status,
  }));

  return {
    teamId,
    name: team.name,
    shortName: team.shortName,
    recentMatches: history
      .map(toHistoricalMatch)
      .filter((m): m is HistoricalMatch => m !== null),
    rating: {
      teamId,
      elo: ratings.get(teamId) ?? DEFAULT_ELO_CONFIG.initialRating,
      attack: 1,
      defence: 1,
      matchesPlayed: matchesPlayed.get(teamId) ?? 0,
    },
    absentees,
    squadImportanceTotal,
  };
}

/**
 * Elo ratings as of a point in time.
 *
 * Ratings are replayed from the league's full finished history rather than
 * cached, which keeps backtests honest: predicting a match from last October
 * uses only the ratings that existed in last October.
 */
export async function buildRatingsAsOf(
  leagueId: string,
  asOf: Date,
  sportKey: SportKey,
): Promise<{ ratings: ReadonlyMap<string, number>; matchesPlayed: ReadonlyMap<string, number> }> {
  const matches = await prisma.match.findMany({
    where: { leagueId, status: 'FINISHED', kickoff: { lt: asOf } },
    orderBy: { kickoff: 'asc' },
    ...matchWithStats,
  });

  const historical = matches
    .map(toHistoricalMatch)
    .filter((m): m is HistoricalMatch => m !== null);

  const config =
    sportKey === 'tennis'
      ? { ...DEFAULT_ELO_CONFIG, kFactor: 24, homeAdvantage: 0 }
      : sportKey === 'basketball'
        ? { ...DEFAULT_ELO_CONFIG, kFactor: 18, homeAdvantage: 60, marginMultiplier: 0.6 }
        : { ...DEFAULT_ELO_CONFIG, kFactor: 20, homeAdvantage: 65 };

  return buildRatings(historical, config);
}

export interface BuildContextOptions {
  /** Evaluation instant. Nothing after it enters the context. */
  readonly asOf?: Date;
  /** Pre-computed ratings, so a batch of fixtures does not replay them each time. */
  readonly ratings?: { ratings: ReadonlyMap<string, number>; matchesPlayed: ReadonlyMap<string, number> };
  readonly leagueBaseline?: LeagueBaseline;
}

type MatchForContext = Match & {
  league: { id: string; key: string; name: string; strength: number };
  sport: { key: string };
};

export async function buildMatchContext(
  match: MatchForContext,
  options: BuildContextOptions = {},
): Promise<MatchContext> {
  const sportKey = match.sport.key as SportKey;
  // Predictions are made at kickoff-minus-nothing for upcoming fixtures, and at
  // the historical kickoff when backtesting.
  const asOf = options.asOf ?? new Date(Math.min(Date.now(), match.kickoff.getTime()));

  const ratings = options.ratings ?? (await buildRatingsAsOf(match.leagueId, asOf, sportKey));
  const league = options.leagueBaseline ?? (await buildLeagueBaseline(match.leagueId, asOf));

  const [home, away] = await Promise.all([
    buildTeamContext(match.homeTeamId, match.id, asOf, ratings.ratings, ratings.matchesPlayed),
    buildTeamContext(match.awayTeamId, match.id, asOf, ratings.ratings, ratings.matchesPlayed),
  ]);

  const h2hRows = await prisma.match.findMany({
    where: {
      status: 'FINISHED',
      kickoff: { lt: asOf },
      OR: [
        { homeTeamId: match.homeTeamId, awayTeamId: match.awayTeamId },
        { homeTeamId: match.awayTeamId, awayTeamId: match.homeTeamId },
      ],
    },
    orderBy: { kickoff: 'desc' },
    take: H2H_LIMIT,
    ...matchWithStats,
  });

  const oddsRows = await prisma.odds.findMany({
    where: { matchId: match.id, capturedAt: { lte: asOf } },
    orderBy: { capturedAt: 'desc' },
  });

  const odds: OddsQuote[] = oddsRows.map((row) => ({
    bookmaker: row.bookmaker,
    market: row.market as MarketKey,
    selection: row.selection,
    line: row.line ?? undefined,
    price: row.price,
    capturedAt: row.capturedAt,
  }));

  // The freshest data point that informed this prediction.
  const timestamps = [
    ...home.recentMatches.map((m) => m.kickoff.getTime()),
    ...away.recentMatches.map((m) => m.kickoff.getTime()),
    ...odds.map((o) => o.capturedAt.getTime()),
  ];
  const dataTimestamp = timestamps.length > 0 ? new Date(Math.max(...timestamps)) : asOf;

  return {
    matchId: match.id,
    sportKey,
    leagueKey: match.league.key,
    kickoff: match.kickoff,
    neutralVenue: match.neutralVenue,
    home,
    away,
    headToHead: h2hRows.map(toHistoricalMatch).filter((m): m is HistoricalMatch => m !== null),
    league,
    odds,
    dataTimestamp,
    asOf,
  };
}
