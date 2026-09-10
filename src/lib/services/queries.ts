/**
 * Read models.
 *
 * Shared by the REST API and the server components so both render exactly the
 * same numbers. Everything returned is a plain, serialisable DTO - Prisma types
 * and Decimal instances never reach a client component.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import type { ConfidenceLevel } from '../prediction/types';
import { classifyEdge, loadReliabilityModels, type EdgeReliability } from './reliability';

export interface SportDto {
  readonly key: string;
  readonly name: string;
  readonly leagues: number;
  readonly upcomingMatches: number;
}

export async function listSports(): Promise<SportDto[]> {
  const sports = await prisma.sport.findMany({
    where: { active: true },
    include: { _count: { select: { leagues: true } } },
    orderBy: { key: 'asc' },
  });

  return Promise.all(
    sports.map(async (sport) => ({
      key: sport.key,
      name: sport.name,
      leagues: sport._count.leagues,
      upcomingMatches: await prisma.match.count({
        where: { sportId: sport.id, status: 'SCHEDULED', kickoff: { gte: new Date() } },
      }),
    })),
  );
}

export interface LeagueDto {
  readonly key: string;
  readonly name: string;
  readonly country: string | null;
  readonly sportKey: string;
  readonly tier: number;
  readonly origin: string;
  readonly upcomingMatches: number;
}

export async function listLeagues(sportKey?: string): Promise<LeagueDto[]> {
  const leagues = await prisma.league.findMany({
    where: sportKey ? { sport: { key: sportKey } } : {},
    include: { sport: { select: { key: true } } },
    orderBy: [{ tier: 'asc' }, { name: 'asc' }],
  });

  return Promise.all(
    leagues.map(async (league) => ({
      key: league.key,
      name: league.name,
      country: league.country,
      sportKey: league.sport.key,
      tier: league.tier,
      origin: league.origin,
      upcomingMatches: await prisma.match.count({
        where: { leagueId: league.id, status: 'SCHEDULED', kickoff: { gte: new Date() } },
      }),
    })),
  );
}

export interface OutcomeDto {
  readonly market: string;
  readonly selection: string;
  readonly line: number | null;
  readonly probability: number;
  readonly fairOdds: number;
  readonly bookmaker: string | null;
  readonly bookmakerOdds: number | null;
  readonly impliedProbability: number | null;
  readonly edge: number | null;
  readonly expectedValue: number | null;
  readonly kellyStake: number | null;
}

export interface PredictionSummaryDto {
  readonly id: string;
  readonly modelVersion: string;
  readonly featuresVersion: string;
  readonly predictedAt: string;
  readonly dataTimestamp: string;
  readonly expectedHomeScore: number | null;
  readonly expectedAwayScore: number | null;
  readonly confidence: ConfidenceLevel;
  readonly confidenceScore: number;
  readonly dataQuality: number;
  readonly outcomes: readonly OutcomeDto[];
}

export interface MatchDto {
  readonly id: string;
  readonly sportKey: string;
  readonly leagueKey: string;
  readonly leagueName: string;
  readonly season: string;
  readonly kickoff: string;
  readonly venue: string | null;
  readonly neutralVenue: boolean;
  readonly status: string;
  readonly origin: string;
  readonly homeTeam: { key: string; name: string; shortName: string };
  readonly awayTeam: { key: string; name: string; shortName: string };
  readonly homeScore: number | null;
  readonly awayScore: number | null;
  readonly prediction: PredictionSummaryDto | null;
}

const matchSelect = {
  include: {
    league: { select: { key: true, name: true } },
    sport: { select: { key: true } },
    homeTeam: { select: { key: true, name: true, shortName: true } },
    awayTeam: { select: { key: true, name: true, shortName: true } },
    predictions: {
      include: { outcomes: true, modelVersion: { select: { version: true } } },
      orderBy: { predictedAt: 'desc' as const },
      take: 1,
    },
  },
} satisfies Prisma.MatchDefaultArgs;

type MatchRow = Prisma.MatchGetPayload<typeof matchSelect>;

function toOutcomeDto(outcome: MatchRow['predictions'][number]['outcomes'][number]): OutcomeDto {
  return {
    market: outcome.market,
    selection: outcome.selection,
    line: outcome.line,
    probability: outcome.probability,
    fairOdds: outcome.fairOdds,
    bookmaker: outcome.bookmaker,
    bookmakerOdds: outcome.bookmakerOdds,
    impliedProbability: outcome.impliedProbability,
    edge: outcome.edge,
    expectedValue: outcome.expectedValue,
    kellyStake: outcome.kellyStake,
  };
}

export function toMatchDto(match: MatchRow): MatchDto {
  const prediction = match.predictions[0];
  return {
    id: match.id,
    sportKey: match.sport.key,
    leagueKey: match.league.key,
    leagueName: match.league.name,
    season: match.season,
    kickoff: match.kickoff.toISOString(),
    venue: match.venue,
    neutralVenue: match.neutralVenue,
    status: match.status,
    origin: match.origin,
    homeTeam: match.homeTeam,
    awayTeam: match.awayTeam,
    homeScore: match.homeScore,
    awayScore: match.awayScore,
    prediction: prediction
      ? {
          id: prediction.id,
          modelVersion: prediction.modelVersion.version,
          featuresVersion: prediction.featuresVersion,
          predictedAt: prediction.predictedAt.toISOString(),
          dataTimestamp: prediction.dataTimestamp.toISOString(),
          expectedHomeScore: prediction.expectedHomeScore,
          expectedAwayScore: prediction.expectedAwayScore,
          confidence: prediction.confidence as ConfidenceLevel,
          confidenceScore: prediction.confidenceScore,
          dataQuality: prediction.dataQuality,
          outcomes: prediction.outcomes.map(toOutcomeDto),
        }
      : null,
  };
}

export interface ListMatchesOptions {
  readonly sportKey?: string;
  readonly leagueKey?: string;
  readonly date?: Date;
  readonly from?: Date;
  readonly to?: Date;
  readonly status?: string;
  readonly limit?: number;
  readonly offset?: number;
}

/** Resolves the calendar-day window for a date filter, in UTC. */
function dayWindow(date: Date): { gte: Date; lte: Date } {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const end = new Date(start.getTime() + 86_400_000 - 1);
  return { gte: start, lte: end };
}

export async function listMatches(
  options: ListMatchesOptions = {},
): Promise<{ matches: MatchDto[]; total: number }> {
  const where: Prisma.MatchWhereInput = {};
  if (options.sportKey) where.sport = { key: options.sportKey };
  if (options.leagueKey) where.league = { key: options.leagueKey };
  if (options.status) where.status = options.status as Prisma.MatchWhereInput['status'];

  if (options.date) {
    where.kickoff = dayWindow(options.date);
  } else if (options.from || options.to) {
    where.kickoff = {
      ...(options.from ? { gte: options.from } : {}),
      ...(options.to ? { lte: options.to } : {}),
    };
  }

  const [rows, total] = await Promise.all([
    prisma.match.findMany({
      where,
      ...matchSelect,
      orderBy: { kickoff: 'asc' },
      take: options.limit ?? 50,
      skip: options.offset ?? 0,
    }),
    prisma.match.count({ where }),
  ]);

  return { matches: rows.map(toMatchDto), total };
}

export async function getMatch(id: string): Promise<MatchDto | null> {
  const match = await prisma.match.findUnique({ where: { id }, ...matchSelect });
  return match ? toMatchDto(match) : null;
}

export interface ValueOpportunityDto {
  readonly matchId: string;
  readonly kickoff: string;
  readonly sportKey: string;
  readonly leagueName: string;
  readonly leagueKey: string;
  readonly homeTeam: string;
  readonly awayTeam: string;
  readonly market: string;
  readonly selection: string;
  readonly line: number | null;
  readonly probability: number;
  readonly bookmaker: string | null;
  readonly bookmakerOdds: number;
  readonly impliedProbability: number;
  readonly edge: number;
  readonly expectedValue: number;
  readonly kellyStake: number | null;
  readonly confidence: ConfidenceLevel;
  readonly confidenceScore: number;
  readonly dataQuality: number;
  readonly modelVersion: string;
  readonly origin: string;
  /** Whether an edge this large is within the model's demonstrated accuracy. */
  readonly reliability: EdgeReliability;
  readonly plausibleEdge: number | null;
}

export interface ValueFilters {
  readonly sportKey?: string;
  readonly leagueKey?: string;
  readonly market?: string;
  readonly date?: Date;
  readonly minProbability?: number;
  readonly minEdge?: number;
  readonly minEv?: number;
  readonly confidence?: ConfidenceLevel;
  readonly limit?: number;
  /** Hide edges larger than the model's measured accuracy can support. */
  readonly onlySupported?: boolean;
}

/**
 * Selections whose model probability exceeds the market's, ranked by expected
 * value. Only upcoming matches are considered - a settled match has no value.
 */
export async function listValueOpportunities(
  filters: ValueFilters = {},
): Promise<ValueOpportunityDto[]> {
  const rows = await prisma.predictionOutcome.findMany({
    where: {
      expectedValue: { gte: filters.minEv ?? 0.02 },
      edge: { gte: filters.minEdge ?? 0 },
      probability: { gte: filters.minProbability ?? 0 },
      bookmakerOdds: { not: null },
      ...(filters.market ? { market: filters.market as Prisma.PredictionOutcomeWhereInput['market'] } : {}),
      prediction: {
        ...(filters.confidence ? { confidence: filters.confidence } : {}),
        match: {
          status: 'SCHEDULED',
          kickoff: filters.date ? dayWindow(filters.date) : { gte: new Date() },
          ...(filters.sportKey ? { sport: { key: filters.sportKey } } : {}),
          ...(filters.leagueKey ? { league: { key: filters.leagueKey } } : {}),
        },
      },
    },
    include: {
      prediction: {
        include: {
          modelVersion: { select: { version: true } },
          match: {
            include: {
              league: { select: { key: true, name: true } },
              sport: { select: { key: true } },
              homeTeam: { select: { name: true, shortName: true } },
              awayTeam: { select: { name: true, shortName: true } },
            },
          },
        },
      },
    },
    orderBy: { expectedValue: 'desc' },
    // Over-fetch so filtering out unsupported edges still fills the page.
    take: (filters.limit ?? 50) * (filters.onlySupported ? 4 : 1),
  });

  const reliabilityModels = await loadReliabilityModels();

  const mapped = rows.map((row) => {
    const model = reliabilityModels.get(row.prediction.modelVersion.version);
    const { reliability, plausibleEdge } = classifyEdge(row.edge ?? 0, model);
    return {
      matchId: row.prediction.match.id,
    kickoff: row.prediction.match.kickoff.toISOString(),
    sportKey: row.prediction.match.sport.key,
    leagueName: row.prediction.match.league.name,
    leagueKey: row.prediction.match.league.key,
    homeTeam: row.prediction.match.homeTeam.name,
    awayTeam: row.prediction.match.awayTeam.name,
    market: row.market,
    selection: row.selection,
    line: row.line,
    probability: row.probability,
    bookmaker: row.bookmaker,
    bookmakerOdds: row.bookmakerOdds as number,
    impliedProbability: row.impliedProbability ?? 0,
    edge: row.edge ?? 0,
    expectedValue: row.expectedValue ?? 0,
    kellyStake: row.kellyStake,
    confidence: row.prediction.confidence as ConfidenceLevel,
    confidenceScore: row.prediction.confidenceScore,
    dataQuality: row.prediction.dataQuality,
    modelVersion: row.prediction.modelVersion.version,
    origin: row.prediction.match.origin,
    reliability,
    plausibleEdge,
    };
  });

  const filtered = filters.onlySupported
    ? mapped.filter((row) => row.reliability !== 'UNVERIFIED')
    : mapped;
  return filtered.slice(0, filters.limit ?? 50);
}

export interface DataFreshnessDto {
  readonly lastIngestion: string | null;
  readonly lastIngestionStatus: string | null;
  readonly newestOdds: string | null;
  readonly newestPrediction: string | null;
  readonly provider: string | null;
  readonly origin: string;
}

/** Feeds the "last updated" and stale-data indicators. */
export async function getDataFreshness(): Promise<DataFreshnessDto> {
  const [run, odds, prediction, demoCount, liveCount] = await Promise.all([
    prisma.ingestionRun.findFirst({ orderBy: { startedAt: 'desc' } }),
    prisma.odds.findFirst({ orderBy: { capturedAt: 'desc' }, select: { capturedAt: true } }),
    prisma.prediction.findFirst({ orderBy: { predictedAt: 'desc' }, select: { predictedAt: true } }),
    prisma.match.count({ where: { origin: 'DEMO' } }),
    prisma.match.count({ where: { origin: 'LIVE' } }),
  ]);

  return {
    lastIngestion: run?.finishedAt?.toISOString() ?? run?.startedAt.toISOString() ?? null,
    lastIngestionStatus: run?.status ?? null,
    newestOdds: odds?.capturedAt.toISOString() ?? null,
    newestPrediction: prediction?.predictedAt.toISOString() ?? null,
    provider: run?.provider ?? null,
    // Any demo content at all means the interface must show the DEMO badge.
    origin: demoCount > 0 && liveCount === 0 ? 'DEMO' : demoCount > 0 ? 'MIXED' : 'LIVE',
  };
}
