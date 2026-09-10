/**
 * API route handler tests.
 *
 * The handlers are invoked directly with a Request, which exercises validation,
 * the error envelope, authentication and rate limiting without needing a server.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db/prisma';
import { resetRateLimiter } from '@/lib/api/http';
import { resetConfigCache } from '@/lib/config';

const BASE = 'http://localhost:3000';

async function json(response: Response) {
  return response.json() as Promise<{ data?: unknown; meta?: Record<string, unknown>; error?: { code: string; message: string; details?: unknown } }>;
}

/** Route handlers receive params as a promise in the App Router. */
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) });

let matchId = '';
let scheduledMatchId = '';

beforeAll(async () => {
  const scheduled = await prisma.match.findFirst({
    where: { status: 'SCHEDULED', predictions: { some: {} } },
  });
  const any = await prisma.match.findFirst();
  scheduledMatchId = scheduled?.id ?? '';
  matchId = any?.id ?? '';
  expect(matchId, 'the pipeline test seeds the database; run the whole suite').toBeTruthy();
});

afterEach(() => {
  resetRateLimiter();
});

describe('GET /api/sports', () => {
  it('returns the registered sports in an envelope', async () => {
    const { GET } = await import('@/app/api/sports/route');
    const response = await GET(new Request(`${BASE}/api/sports`), ctx({}));
    expect(response.status).toBe(200);

    const body = await json(response);
    expect(Array.isArray(body.data)).toBe(true);
    expect((body.data as unknown[]).length).toBe(3);
    expect(body.meta?.generatedAt).toBeTruthy();
  });
});

describe('GET /api/leagues', () => {
  it('filters by sport', async () => {
    const { GET } = await import('@/app/api/leagues/route');
    const response = await GET(new Request(`${BASE}/api/leagues?sport=football`), ctx({}));
    const body = await json(response);
    const leagues = body.data as Array<{ sportKey: string }>;
    expect(leagues.length).toBeGreaterThan(0);
    for (const league of leagues) expect(league.sportKey).toBe('football');
  });

  it('rejects an unknown sport with a validation error', async () => {
    const { GET } = await import('@/app/api/leagues/route');
    const response = await GET(new Request(`${BASE}/api/leagues?sport=curling`), ctx({}));
    expect(response.status).toBe(400);
    const body = await json(response);
    expect(body.error?.code).toBe('BAD_REQUEST');
    expect(body.error?.details).toBeDefined();
  });
});

describe('GET /api/matches', () => {
  it('paginates and reports the total', async () => {
    const { GET } = await import('@/app/api/matches/route');
    const response = await GET(new Request(`${BASE}/api/matches?limit=5`), ctx({}));
    const body = await json(response);
    expect((body.data as unknown[]).length).toBeLessThanOrEqual(5);
    expect(body.meta?.total).toBeGreaterThan(0);
    expect(body.meta?.limit).toBe(5);
  });

  it('rejects a limit beyond the maximum instead of silently clamping', async () => {
    const { GET } = await import('@/app/api/matches/route');
    const response = await GET(new Request(`${BASE}/api/matches?limit=5000`), ctx({}));
    expect(response.status).toBe(400);
    const body = await json(response);
    expect(JSON.stringify(body.error?.details)).toMatch(/less than or equal to 200/);
  });

  it('rejects a malformed date', async () => {
    const { GET } = await import('@/app/api/matches/route');
    const response = await GET(new Request(`${BASE}/api/matches?date=not-a-date`), ctx({}));
    expect(response.status).toBe(400);
  });

  it('rejects a negative offset', async () => {
    const { GET } = await import('@/app/api/matches/route');
    const response = await GET(new Request(`${BASE}/api/matches?offset=-5`), ctx({}));
    expect(response.status).toBe(400);
  });
});

describe('GET /api/matches/:id', () => {
  it('returns one match', async () => {
    const { GET } = await import('@/app/api/matches/[id]/route');
    const response = await GET(new Request(`${BASE}/api/matches/${matchId}`), ctx({ id: matchId }));
    expect(response.status).toBe(200);
    const body = await json(response);
    expect((body.data as { id: string }).id).toBe(matchId);
  });

  it('returns 404 for an unknown id', async () => {
    const { GET } = await import('@/app/api/matches/[id]/route');
    const response = await GET(new Request(`${BASE}/api/matches/missing`), ctx({ id: 'missing' }));
    expect(response.status).toBe(404);
    const body = await json(response);
    expect(body.error?.code).toBe('NOT_FOUND');
  });
});

describe('GET /api/matches/:id/prediction', () => {
  it('returns a full analysis', async () => {
    const { GET } = await import('@/app/api/matches/[id]/prediction/route');
    const response = await GET(
      new Request(`${BASE}/api/matches/${scheduledMatchId}/prediction`),
      ctx({ id: scheduledMatchId }),
    );
    expect(response.status).toBe(200);

    const analysis = (await json(response)).data as {
      outcomes: unknown[];
      components: unknown[];
      features: unknown[];
      modelVersion: string;
      confidence: string;
      dataQuality: number;
    };
    expect(analysis.outcomes.length).toBeGreaterThan(2);
    expect(analysis.components.length).toBeGreaterThan(1);
    expect(analysis.features.length).toBeGreaterThan(3);
    expect(analysis.modelVersion).toBeTruthy();
    expect(['LOW', 'MEDIUM', 'HIGH']).toContain(analysis.confidence);
    expect(analysis.dataQuality).toBeGreaterThanOrEqual(0);
  }, 120_000);

  it('returns 404 for an unknown match', async () => {
    const { GET } = await import('@/app/api/matches/[id]/prediction/route');
    const response = await GET(
      new Request(`${BASE}/api/matches/nope/prediction`),
      ctx({ id: 'nope' }),
    );
    expect(response.status).toBe(404);
  });
});

describe('GET /api/matches/:id/odds', () => {
  it('returns grouped market prices', async () => {
    const withOdds = await prisma.match.findFirstOrThrow({ where: { odds: { some: {} } } });
    const { GET } = await import('@/app/api/matches/[id]/odds/route');
    const response = await GET(
      new Request(`${BASE}/api/matches/${withOdds.id}/odds`),
      ctx({ id: withOdds.id }),
    );
    expect(response.status).toBe(200);
    const odds = (await json(response)).data as Array<{ bestPrice: number; bookmakers: unknown[] }>;
    expect(odds.length).toBeGreaterThan(0);
    for (const entry of odds) expect(entry.bestPrice).toBeGreaterThan(1);
  });
});

describe('GET /api/value-opportunities', () => {
  it('respects the EV threshold and carries the disclaimer', async () => {
    const { GET } = await import('@/app/api/value-opportunities/route');
    const response = await GET(
      new Request(`${BASE}/api/value-opportunities?minEv=0.1&limit=10`),
      ctx({}),
    );
    expect(response.status).toBe(200);

    const body = await json(response);
    const rows = body.data as Array<{ expectedValue: number; reliability: string }>;
    for (const row of rows) {
      expect(row.expectedValue).toBeGreaterThanOrEqual(0.1);
      expect(['SUPPORTED', 'UNVERIFIED', 'UNMEASURED']).toContain(row.reliability);
    }
    expect(String(body.meta?.disclaimer)).toMatch(/not a guarantee/i);
  });

  it('rejects an out-of-range probability filter', async () => {
    const { GET } = await import('@/app/api/value-opportunities/route');
    const response = await GET(
      new Request(`${BASE}/api/value-opportunities?minProbability=3`),
      ctx({}),
    );
    expect(response.status).toBe(400);
  });
});

describe('GET /api/model-performance', () => {
  it('returns scored metrics with the responsible-use note', async () => {
    const { GET } = await import('@/app/api/model-performance/route');
    const response = await GET(new Request(`${BASE}/api/model-performance`), ctx({}));
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(String(body.meta?.disclaimer)).toMatch(/does not guarantee/i);
  });
});

describe('GET /api/health', () => {
  it('reports database health and record counts without leaking secrets', async () => {
    const { GET } = await import('@/app/api/health/route');
    const response = await GET(new Request(`${BASE}/api/health`), ctx({}));
    expect(response.status).toBe(200);

    const health = (await json(response)).data as {
      status: string;
      databaseOk: boolean;
      counts: Record<string, number>;
      providerConfigured: boolean;
    };
    expect(health.status).toBe('ok');
    expect(health.databaseOk).toBe(true);
    expect(health.counts.matches).toBeGreaterThan(0);

    // The payload must never contain a key, only whether one is set.
    const raw = JSON.stringify(health);
    expect(raw).not.toMatch(/SPORTS_API_KEY|API_ACCESS_KEY/);
    expect(typeof health.providerConfigured).toBe('boolean');
  });
});

describe('authentication', () => {
  const original = process.env.API_ACCESS_KEY;
  afterEach(() => {
    process.env.API_ACCESS_KEY = original;
    resetConfigCache();
  });

  it('rejects a write without the key when one is configured', async () => {
    process.env.API_ACCESS_KEY = 'secret-key';
    resetConfigCache();

    const { POST } = await import('@/app/api/predictions/route');
    const response = await POST(
      new Request(`${BASE}/api/predictions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchId: scheduledMatchId }),
      }),
      ctx({}),
    );
    expect(response.status).toBe(401);
    expect((await json(response)).error?.code).toBe('UNAUTHORIZED');
  });

  it('rejects a wrong key', async () => {
    process.env.API_ACCESS_KEY = 'secret-key';
    resetConfigCache();

    const { POST } = await import('@/app/api/predictions/route');
    const response = await POST(
      new Request(`${BASE}/api/predictions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': 'wrong-key' },
        body: JSON.stringify({ matchId: scheduledMatchId }),
      }),
      ctx({}),
    );
    expect(response.status).toBe(401);
  });

  it('accepts the correct key', async () => {
    process.env.API_ACCESS_KEY = 'secret-key';
    resetConfigCache();

    const { POST } = await import('@/app/api/predictions/route');
    const response = await POST(
      new Request(`${BASE}/api/predictions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': 'secret-key' },
        body: JSON.stringify({ matchId: scheduledMatchId }),
      }),
      ctx({}),
    );
    expect(response.status).toBe(201);
  }, 120_000);

  it('leaves writes open when no key is configured', async () => {
    process.env.API_ACCESS_KEY = '';
    resetConfigCache();

    const { POST } = await import('@/app/api/predictions/route');
    const response = await POST(
      new Request(`${BASE}/api/predictions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchId: scheduledMatchId }),
      }),
      ctx({}),
    );
    expect(response.status).toBe(201);
  }, 120_000);
});

describe('POST /api/predictions validation', () => {
  it('rejects a malformed body', async () => {
    const { POST } = await import('@/app/api/predictions/route');
    const response = await POST(
      new Request(`${BASE}/api/predictions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      }),
      ctx({}),
    );
    expect(response.status).toBe(400);
  });

  it('rejects a missing matchId', async () => {
    const { POST } = await import('@/app/api/predictions/route');
    const response = await POST(
      new Request(`${BASE}/api/predictions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
      ctx({}),
    );
    expect(response.status).toBe(400);
  });

  it('returns 404 for an unknown match', async () => {
    const { POST } = await import('@/app/api/predictions/route');
    const response = await POST(
      new Request(`${BASE}/api/predictions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchId: 'does-not-exist' }),
      }),
      ctx({}),
    );
    expect(response.status).toBe(404);
  });
});

describe('POST /api/bets validation', () => {
  it('rejects odds of 1.0 or below, which cannot exist', async () => {
    const { POST } = await import('@/app/api/bets/route');
    const response = await POST(
      new Request(`${BASE}/api/bets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          matchId: scheduledMatchId,
          market: 'MATCH_WINNER',
          selection: 'HOME',
          odds: 1,
          stake: 10,
        }),
      }),
      ctx({}),
    );
    expect(response.status).toBe(400);
  });

  it('rejects a non-positive stake', async () => {
    const { POST } = await import('@/app/api/bets/route');
    const response = await POST(
      new Request(`${BASE}/api/bets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          matchId: scheduledMatchId,
          market: 'MATCH_WINNER',
          selection: 'HOME',
          odds: 2,
          stake: 0,
        }),
      }),
      ctx({}),
    );
    expect(response.status).toBe(400);
  });

  it('lists bets with a portfolio summary', async () => {
    const { GET } = await import('@/app/api/bets/route');
    const response = await GET(new Request(`${BASE}/api/bets`), ctx({}));
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.meta?.summary).toBeDefined();
  }, 60_000);
});

describe('rate limiting', () => {
  const original = { max: process.env.RATE_LIMIT_MAX, window: process.env.RATE_LIMIT_WINDOW_MS };
  afterEach(() => {
    process.env.RATE_LIMIT_MAX = original.max;
    process.env.RATE_LIMIT_WINDOW_MS = original.window;
    resetConfigCache();
    resetRateLimiter();
  });

  it('rejects a client that exceeds the window and says when to retry', async () => {
    process.env.RATE_LIMIT_MAX = '3';
    process.env.RATE_LIMIT_WINDOW_MS = '60000';
    resetConfigCache();
    resetRateLimiter();

    const { GET } = await import('@/app/api/sports/route');
    const request = () =>
      GET(new Request(`${BASE}/api/sports`, { headers: { 'x-forwarded-for': '203.0.113.7' } }), ctx({}));

    for (let i = 0; i < 3; i += 1) expect((await request()).status).toBe(200);

    const limited = await request();
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBeTruthy();
    expect((await json(limited)).error?.code).toBe('RATE_LIMITED');
  });

  it('tracks clients independently', async () => {
    process.env.RATE_LIMIT_MAX = '2';
    resetConfigCache();
    resetRateLimiter();

    const { GET } = await import('@/app/api/sports/route');
    const call = (ip: string) =>
      GET(new Request(`${BASE}/api/sports`, { headers: { 'x-forwarded-for': ip } }), ctx({}));

    expect((await call('198.51.100.1')).status).toBe(200);
    expect((await call('198.51.100.1')).status).toBe(200);
    expect((await call('198.51.100.1')).status).toBe(429);
    // A different client is unaffected.
    expect((await call('198.51.100.2')).status).toBe(200);
  });
});
