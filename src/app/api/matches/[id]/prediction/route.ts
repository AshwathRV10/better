import { getMatchAnalysis } from '@/lib/services/analysis';
import { ok, route } from '@/lib/api/http';
import { notFound } from '@/lib/errors';

export const dynamic = 'force-dynamic';

export const GET = route(async (_request, context) => {
  const { id } = await context.params;
  const analysis = await getMatchAnalysis(id);
  if (!analysis) throw notFound(`No match with id ${id}`);
  return ok(analysis);
});
