import { prisma } from '@/lib/db/prisma';
import { ok, parseQuery, route } from '@/lib/api/http';
import { performanceQuerySchema } from '@/lib/api/schemas';

export const dynamic = 'force-dynamic';

export const GET = route(async (request) => {
  const query = parseQuery(request, performanceQuerySchema);

  const rows = await prisma.modelPerformance.findMany({
    where: {
      ...(query.sport ? { sportKey: query.sport } : {}),
      ...(query.league ? { leagueKey: query.league } : {}),
      ...(query.confidence ? { confidence: query.confidence } : {}),
    },
    include: { modelVersion: { select: { version: true, trainedAt: true, trainingSampleSize: true } } },
    orderBy: [{ sportKey: 'asc' }, { computedAt: 'desc' }],
  });

  return ok(
    rows.map((row) => ({
      modelVersion: row.modelVersion.version,
      trainedAt: row.modelVersion.trainedAt?.toISOString() ?? null,
      trainingSampleSize: row.modelVersion.trainingSampleSize,
      sportKey: row.sportKey,
      leagueKey: row.leagueKey,
      confidence: row.confidence,
      market: row.market,
      predictions: row.predictions,
      correct: row.correct,
      accuracy: row.accuracy,
      logLoss: row.logLoss,
      brierScore: row.brierScore,
      roi: row.roi,
      winRate: row.winRate,
      averageOdds: row.averageOdds,
      averageEdge: row.averageEdge,
      calibration: row.calibration,
      periodStart: row.periodStart.toISOString(),
      periodEnd: row.periodEnd.toISOString(),
      computedAt: row.computedAt.toISOString(),
    })),
    {
      disclaimer:
        'Historical model performance does not guarantee future results. Metrics are computed out of sample.',
    },
  );
});
