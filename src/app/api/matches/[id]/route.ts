import { getMatch } from '@/lib/services/queries';
import { ok, route } from '@/lib/api/http';
import { notFound } from '@/lib/errors';

export const dynamic = 'force-dynamic';

export const GET = route(async (_request, context) => {
  const { id } = await context.params;
  const match = await getMatch(id);
  if (!match) throw notFound(`No match with id ${id}`);
  return ok(match);
});
