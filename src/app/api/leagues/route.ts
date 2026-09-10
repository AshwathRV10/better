import { z } from 'zod';
import { listLeagues } from '@/lib/services/queries';
import { ok, parseQuery, route } from '@/lib/api/http';
import { sportKeySchema } from '@/lib/api/schemas';

export const dynamic = 'force-dynamic';

const querySchema = z.object({ sport: sportKeySchema.optional() });

export const GET = route(async (request) => {
  const { sport } = parseQuery(request, querySchema);
  return ok(await listLeagues(sport));
});
