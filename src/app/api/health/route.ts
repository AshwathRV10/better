import { prisma } from '@/lib/db/prisma';
import { getDataFreshness } from '@/lib/services/queries';
import { ok, route } from '@/lib/api/http';
import { getConfig } from '@/lib/config';

export const dynamic = 'force-dynamic';

/** Liveness and data-pipeline status for the admin page and for monitoring. */
export const GET = route(async () => {
  const startedAt = Date.now();
  let databaseOk = false;
  let databaseError: string | null = null;
  try {
    await prisma.$queryRaw`SELECT 1`;
    databaseOk = true;
  } catch (error) {
    databaseError = error instanceof Error ? error.message : 'Unknown database error';
  }

  // With the database unreachable the endpoint must still answer, so monitoring
  // sees "degraded" rather than a connection error of its own.
  const empty = { matches: 0, predictions: 0, odds: 0, teams: 0, bets: 0 };
  let counts = empty;
  let freshness = {
    lastIngestion: null as string | null,
    lastIngestionStatus: null as string | null,
    newestOdds: null as string | null,
    newestPrediction: null as string | null,
    provider: null as string | null,
    origin: 'UNKNOWN',
  };
  let recentRuns: Array<{
    id: string; provider: string; status: string; startedAt: Date;
    finishedAt: Date | null; matchesUpserted: number; oddsUpserted: number; error: string | null;
  }> = [];

  if (databaseOk) {
    const [matches, predictions, odds, teams, bets, freshnessResult, runs] = await Promise.all([
      prisma.match.count(),
      prisma.prediction.count(),
      prisma.odds.count(),
      prisma.team.count(),
      prisma.bet.count(),
      getDataFreshness(),
      prisma.ingestionRun.findMany({ orderBy: { startedAt: 'desc' }, take: 5 }),
    ]);
    counts = { matches, predictions, odds, teams, bets };
    freshness = freshnessResult;
    recentRuns = runs;
  }

  const config = getConfig();
  return ok({
    status: databaseOk ? 'ok' : 'degraded',
    databaseOk,
    databaseError,
    latencyMs: Date.now() - startedAt,
    provider: config.DATA_PROVIDER,
    // Whether a key is present, never the key itself.
    providerConfigured: config.DATA_PROVIDER === 'demo' || config.SPORTS_API_KEY.length > 0,
    apiKeyRequired: config.API_ACCESS_KEY.length > 0,
    counts,
    freshness,
    recentRuns: recentRuns.map((run) => ({
      id: run.id,
      provider: run.provider,
      status: run.status,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      matchesUpserted: run.matchesUpserted,
      oddsUpserted: run.oddsUpserted,
      error: run.error,
    })),
  });
});
