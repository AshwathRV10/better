import { listValueOpportunities } from '@/lib/services/queries';
import { ok, parseQuery, route } from '@/lib/api/http';
import { valueQuerySchema } from '@/lib/api/schemas';

export const dynamic = 'force-dynamic';

export const GET = route(async (request) => {
  const query = parseQuery(request, valueQuerySchema);
  const opportunities = await listValueOpportunities({
    sportKey: query.sport,
    leagueKey: query.league,
    market: query.market,
    date: query.date,
    minProbability: query.minProbability,
    minEdge: query.minEdge,
    minEv: query.minEv,
    confidence: query.confidence,
    limit: query.limit,
  });
  return ok(opportunities, {
    count: opportunities.length,
    filters: query,
    disclaimer:
      'Expected value is estimated from model probabilities and is not a guarantee of profit.',
  });
});
