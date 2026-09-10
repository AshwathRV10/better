import { listMatches } from '@/lib/services/queries';
import { ok, parseQuery, route } from '@/lib/api/http';
import { matchesQuerySchema } from '@/lib/api/schemas';

export const dynamic = 'force-dynamic';

export const GET = route(async (request) => {
  const query = parseQuery(request, matchesQuerySchema);
  const { matches, total } = await listMatches({
    sportKey: query.sport,
    leagueKey: query.league,
    date: query.date,
    from: query.from,
    to: query.to,
    status: query.status,
    limit: query.limit,
    offset: query.offset,
  });
  return ok(matches, { total, limit: query.limit, offset: query.offset });
});
