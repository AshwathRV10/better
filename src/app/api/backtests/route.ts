import { prisma } from '@/lib/db/prisma';
import { ok, parseQuery, route } from '@/lib/api/http';
import { z } from 'zod';
import { sportKeySchema } from '@/lib/api/schemas';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  sport: sportKeySchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export const GET = route(async (request) => {
  const query = parseQuery(request, querySchema);
  const rows = await prisma.backtest.findMany({
    where: query.sport ? { sportKey: query.sport } : {},
    include: { modelVersion: { select: { version: true } } },
    orderBy: { createdAt: 'desc' },
    take: query.limit,
  });

  return ok(
    rows.map((row) => ({
      id: row.id,
      label: row.label,
      modelVersion: row.modelVersion.version,
      sportKey: row.sportKey,
      leagueKey: row.leagueKey,
      config: row.config,
      periodStart: row.periodStart.toISOString(),
      periodEnd: row.periodEnd.toISOString(),
      matches: row.matches,
      accuracy: row.accuracy,
      logLoss: row.logLoss,
      brierScore: row.brierScore,
      roi: row.roi,
      betsPlaced: row.betsPlaced,
      staked: row.staked,
      profit: row.profit,
      calibration: row.calibration,
      equityCurve: row.equityCurve,
      createdAt: row.createdAt.toISOString(),
    })),
  );
});
