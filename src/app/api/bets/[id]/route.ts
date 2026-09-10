import { getBet, settleBet } from '@/lib/services/bets';
import { ok, parseBody, requireApiKey, route } from '@/lib/api/http';
import { settleBetSchema } from '@/lib/api/schemas';
import { notFound } from '@/lib/errors';

export const dynamic = 'force-dynamic';

export const GET = route(async (_request, context) => {
  const { id } = await context.params;
  const bet = await getBet(id);
  if (!bet) throw notFound(`No bet with id ${id}`);
  return ok(bet);
});

/** Settles a bet manually, for markets the automatic settler cannot resolve. */
export const PATCH = route(async (request, context) => {
  requireApiKey(request);
  const { id } = await context.params;
  const body = await parseBody(request, settleBetSchema);
  return ok(await settleBet(id, body.result));
});
