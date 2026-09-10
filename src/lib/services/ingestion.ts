/**
 * Ingestion service.
 *
 * Pulls normalised records from the active provider and upserts them into the
 * database. Every run is recorded in `ingestion_runs` so the admin page can show
 * when data last arrived and what failed.
 *
 * Upserts are keyed on the provider's external identifiers, so re-running is
 * idempotent and never duplicates a fixture.
 */

import type { DataOrigin, MatchStatus, Market, Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { resolveProvider } from '../providers/registry';
import type { ProviderMatch, SportsDataProvider } from '../providers/types';
import { DEMO_FUTURE_DAYS, DEMO_HISTORY_DAYS } from '../providers/demo/DemoProvider';

export interface IngestionSummary {
  readonly runId: string;
  readonly provider: string;
  readonly origin: DataOrigin;
  readonly leagues: number;
  readonly teams: number;
  readonly players: number;
  readonly matches: number;
  readonly odds: number;
  readonly availability: number;
  readonly durationMs: number;
}

export interface IngestOptions {
  readonly now?: Date;
  readonly seed?: number;
  readonly provider?: SportsDataProvider;
  readonly historyDays?: number;
  readonly futureDays?: number;
}

function toMatchStatus(status: ProviderMatch['status']): MatchStatus {
  return status as MatchStatus;
}

/**
 * Narrows a plain object to Prisma's JSON input type. Providers hand back
 * `Record<string, unknown>`, which Prisma will accept at runtime but not
 * structurally at compile time.
 */
function toJson(value: Record<string, unknown> | undefined): Prisma.InputJsonValue | undefined {
  return value === undefined ? undefined : (value as Prisma.InputJsonValue);
}

export async function ingestAll(options: IngestOptions = {}): Promise<IngestionSummary> {
  const startedAt = Date.now();
  const now = options.now ?? new Date();
  const resolution = resolveProvider({ now, seed: options.seed });
  const provider = options.provider ?? resolution.provider;
  const origin: DataOrigin = provider.origin;

  const run = await prisma.ingestionRun.create({
    data: { provider: provider.name, status: 'RUNNING' },
  });

  try {
    const from = new Date(now.getTime() - (options.historyDays ?? DEMO_HISTORY_DAYS) * 86_400_000);
    const to = new Date(now.getTime() + (options.futureDays ?? DEMO_FUTURE_DAYS) * 86_400_000);

    const leagues = await provider.fetchLeagues();
    const sportKeys = [...new Set(leagues.map((league) => league.sportKey))];

    // Sports
    const sportIdByKey = new Map<string, string>();
    for (const key of sportKeys) {
      const sport = await prisma.sport.upsert({
        where: { key },
        update: {},
        create: { key, name: key.charAt(0).toUpperCase() + key.slice(1) },
      });
      sportIdByKey.set(key, sport.id);
    }

    // Leagues
    const leagueIdByKey = new Map<string, string>();
    for (const league of leagues) {
      const sportId = sportIdByKey.get(league.sportKey);
      if (!sportId) continue;
      const record = await prisma.league.upsert({
        where: { sportId_key: { sportId, key: league.key } },
        update: {
          name: league.name,
          country: league.country,
          tier: league.tier,
          strength: league.strength,
          externalId: league.externalId,
          origin,
        },
        create: {
          sportId,
          key: league.key,
          name: league.name,
          country: league.country,
          tier: league.tier,
          strength: league.strength,
          externalId: league.externalId,
          origin,
        },
      });
      leagueIdByKey.set(league.key, record.id);
    }

    // Teams
    const teamIdByKey = new Map<string, string>();
    let teamCount = 0;
    for (const league of leagues) {
      const teams = await provider.fetchTeams(league.key);
      const sportId = sportIdByKey.get(league.sportKey);
      const leagueId = leagueIdByKey.get(league.key);
      if (!sportId || !leagueId) continue;
      for (const team of teams) {
        const record = await prisma.team.upsert({
          where: { sportId_key: { sportId, key: team.key } },
          update: { name: team.name, shortName: team.shortName, leagueId, country: team.country, externalId: team.externalId, origin },
          create: {
            sportId, leagueId, key: team.key, name: team.name, shortName: team.shortName,
            country: team.country, externalId: team.externalId, origin,
          },
        });
        teamIdByKey.set(team.key, record.id);
        teamCount += 1;
      }
    }

    // Players
    const playerIdByKey = new Map<string, string>();
    let playerCount = 0;
    for (const [teamKey, teamId] of teamIdByKey) {
      const players = await provider.fetchPlayers(teamKey);
      for (const player of players) {
        const record = await prisma.player.upsert({
          where: { teamId_key: { teamId, key: player.key } },
          update: { name: player.name, position: player.position, importance: player.importance, externalId: player.externalId },
          create: {
            teamId, key: player.key, name: player.name, position: player.position,
            importance: player.importance, externalId: player.externalId,
          },
        });
        playerIdByKey.set(player.key, record.id);
        playerCount += 1;
      }
    }

    // Matches
    const matches = await provider.fetchMatches({ from, to });
    const matchIdByExternal = new Map<string, string>();
    let matchCount = 0;
    for (const match of matches) {
      const sportId = sportIdByKey.get(match.sportKey);
      const leagueId = leagueIdByKey.get(match.leagueKey);
      const homeTeamId = teamIdByKey.get(match.homeTeamKey);
      const awayTeamId = teamIdByKey.get(match.awayTeamKey);
      if (!sportId || !leagueId || !homeTeamId || !awayTeamId) continue;

      const data = {
        sportId, leagueId, season: match.season, round: match.round,
        homeTeamId, awayTeamId, kickoff: match.kickoff, venue: match.venue,
        neutralVenue: match.neutralVenue, status: toMatchStatus(match.status),
        homeScore: match.homeScore, awayScore: match.awayScore,
        scoreDetail: toJson(match.scoreDetail),
        externalId: match.externalId, origin,
      };
      const record = await prisma.match.upsert({
        where: { sportId_externalId: { sportId, externalId: match.externalId } },
        update: data,
        create: data,
      });
      matchIdByExternal.set(match.externalId, record.id);
      matchCount += 1;

      // Per-team statistics for finished matches.
      for (const [stats, teamId, isHome] of [
        [match.homeStats, homeTeamId, true],
        [match.awayStats, awayTeamId, false],
      ] as const) {
        if (!stats) continue;
        const statData = {
          matchId: record.id, teamId, isHome,
          goalsFor: isHome ? match.homeScore : match.awayScore,
          goalsAgainst: isHome ? match.awayScore : match.homeScore,
          xg: stats.xg ?? null,
          xga: (isHome ? match.awayStats?.xg : match.homeStats?.xg) ?? null,
          shots: stats.shots ?? null,
          shotsOnTarget: stats.shotsOnTarget ?? null,
          possession: stats.possession ?? null,
          corners: stats.corners ?? null,
          extra: toJson(stats.extra),
        };
        await prisma.teamStatistic.upsert({
          where: { matchId_teamId: { matchId: record.id, teamId } },
          update: statData,
          create: statData,
        });
      }
    }

    // Odds
    const externalIds = [...matchIdByExternal.keys()];
    const quotes = await provider.fetchOdds(externalIds);
    let oddsCount = 0;
    if (quotes.length > 0) {
      const rows = quotes
        .map((quote) => {
          const matchId = matchIdByExternal.get(quote.matchExternalId);
          if (!matchId) return null;
          return {
            matchId,
            bookmaker: quote.bookmaker,
            market: quote.market as Market,
            selection: quote.selection,
            line: quote.line,
            price: quote.price,
            capturedAt: quote.capturedAt,
            origin,
          };
        })
        .filter((row): row is NonNullable<typeof row> => row !== null);
      const result = await prisma.odds.createMany({ data: rows, skipDuplicates: true });
      oddsCount = result.count;
    }

    // Availability
    const availability = await provider.fetchAvailability(externalIds);
    let availabilityCount = 0;
    for (const entry of availability) {
      const matchId = matchIdByExternal.get(entry.matchExternalId);
      const playerId = playerIdByKey.get(entry.playerKey);
      if (!matchId || !playerId) continue;
      await prisma.playerAvailability.upsert({
        where: { matchId_playerId: { matchId, playerId } },
        update: { status: entry.status, reason: entry.reason, reportedAt: entry.reportedAt },
        create: { matchId, playerId, status: entry.status, reason: entry.reason, reportedAt: entry.reportedAt },
      });
      availabilityCount += 1;
    }

    const durationMs = Date.now() - startedAt;
    await prisma.ingestionRun.update({
      where: { id: run.id },
      data: {
        status: 'SUCCESS',
        finishedAt: new Date(),
        matchesUpserted: matchCount,
        oddsUpserted: oddsCount,
        sportKey: sportKeys.join(','),
      },
    });

    return {
      runId: run.id,
      provider: provider.name,
      origin,
      leagues: leagues.length,
      teams: teamCount,
      players: playerCount,
      matches: matchCount,
      odds: oddsCount,
      availability: availabilityCount,
      durationMs,
    };
  } catch (error) {
    await prisma.ingestionRun.update({
      where: { id: run.id },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}
