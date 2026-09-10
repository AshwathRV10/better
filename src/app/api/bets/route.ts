import { getTrackerSummary, listBets, recordBet, settleFinishedBets } from '@/lib/services/bets';
import { ok, parseBody, parseQuery, requireApiKey, route } from '@/lib/api/http';
import { betsQuerySchema, createBetSchema } from '@/lib/api/schemas';

export const dynamic = 'force-dynamic';

export const GET = route(async (request) => {
  const query = parseQuery(request, betsQuerySchema);
  // Settle anything whose match has finished before reporting the ledger.
  await settleFinishedBets();
  const [bets, summary] = await Promise.all([
    listBets({ result: query.result, limit: query.limit }),
    getTrackerSummary(),
  ]);
  return ok(bets, { summary });
});

export const POST = route(async (request) => {
  requireApiKey(request);
  const body = await parseBody(request, createBetSchema);
  const bet = await recordBet(body);
  return ok(bet, {}, { status: 201 });
});
