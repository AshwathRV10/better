import { getMatchOdds } from '@/lib/services/analysis';
import { ok, route } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

export const GET = route(async (_request, context) => {
  const { id } = await context.params;
  return ok(await getMatchOdds(id));
});
