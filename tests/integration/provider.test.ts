import { afterEach, describe, expect, it } from 'vitest';
import { DemoProvider } from '@/lib/providers/demo/DemoProvider';
import { ApiFootballProvider, resolveProvider } from '@/lib/providers/registry';
import { ProviderNotConfiguredError } from '@/lib/providers/types';
import { impliedProbability, removeMargin } from '@/lib/odds';

const ANCHOR = new Date('2026-06-01T12:00:00Z');

describe('DemoProvider', () => {
  const provider = new DemoProvider({ now: ANCHOR, seed: 1234 });

  it('is always configured and tagged as demo data', () => {
    expect(provider.isConfigured()).toBe(true);
    expect(provider.origin).toBe('DEMO');
  });

  it('produces leagues across all three sports', async () => {
    const leagues = await provider.fetchLeagues();
    expect(leagues.length).toBeGreaterThanOrEqual(4);
    expect(new Set(leagues.map((league) => league.sportKey))).toEqual(
      new Set(['football', 'basketball', 'tennis']),
    );
  });

  it('is deterministic: the same seed produces identical fixtures', async () => {
    const a = await new DemoProvider({ now: ANCHOR, seed: 99 }).fetchMatches({});
    const b = await new DemoProvider({ now: ANCHOR, seed: 99 }).fetchMatches({});
    expect(a.length).toBe(b.length);
    expect(a.map((m) => `${m.externalId}:${m.homeScore}:${m.awayScore}`)).toEqual(
      b.map((m) => `${m.externalId}:${m.homeScore}:${m.awayScore}`),
    );
  });

  it('produces different worlds for different seeds', async () => {
    const a = await new DemoProvider({ now: ANCHOR, seed: 1 }).fetchMatches({});
    const b = await new DemoProvider({ now: ANCHOR, seed: 2 }).fetchMatches({});
    const scoresA = a.map((m) => `${m.homeScore}:${m.awayScore}`).join(',');
    const scoresB = b.map((m) => `${m.homeScore}:${m.awayScore}`).join(',');
    expect(scoresA).not.toBe(scoresB);
  });

  it('generates both finished history and upcoming fixtures', async () => {
    const matches = await provider.fetchMatches({});
    const finished = matches.filter((match) => match.status === 'FINISHED');
    const scheduled = matches.filter((match) => match.status === 'SCHEDULED');
    expect(finished.length).toBeGreaterThan(100);
    expect(scheduled.length).toBeGreaterThan(0);

    // A finished match always has a score; a scheduled one never does.
    for (const match of finished) expect(match.homeScore).not.toBeNull();
    for (const match of scheduled) expect(match.homeScore).toBeNull();
  });

  it('never dates a finished match after the anchor, nor a scheduled one before it', async () => {
    const matches = await provider.fetchMatches({});
    for (const match of matches) {
      if (match.status === 'FINISHED') expect(match.kickoff.getTime()).toBeLessThan(ANCHOR.getTime());
      else expect(match.kickoff.getTime()).toBeGreaterThanOrEqual(ANCHOR.getTime());
    }
  });

  it('honours date and sport filters', async () => {
    const from = new Date(ANCHOR.getTime() - 30 * 86_400_000);
    const filtered = await provider.fetchMatches({ from, sportKey: 'football' });
    expect(filtered.length).toBeGreaterThan(0);
    for (const match of filtered) {
      expect(match.sportKey).toBe('football');
      expect(match.kickoff.getTime()).toBeGreaterThanOrEqual(from.getTime());
    }
  });

  it('produces realistic football scorelines', async () => {
    const matches = (await provider.fetchMatches({ sportKey: 'football' })).filter(
      (match) => match.status === 'FINISHED',
    );
    const totals = matches.map((m) => (m.homeScore ?? 0) + (m.awayScore ?? 0));
    const mean = totals.reduce((sum, value) => sum + value, 0) / totals.length;
    // Real football leagues average roughly 2.4-3.0 goals per match.
    expect(mean).toBeGreaterThan(2.2);
    expect(mean).toBeLessThan(3.2);
    expect(Math.max(...totals)).toBeLessThan(14);
  });

  it('produces realistic basketball margins', async () => {
    const matches = (await provider.fetchMatches({ sportKey: 'basketball' })).filter(
      (match) => match.status === 'FINISHED',
    );
    const margins = matches.map((m) => (m.homeScore ?? 0) - (m.awayScore ?? 0));
    const mean = margins.reduce((sum, value) => sum + value, 0) / margins.length;
    const sd = Math.sqrt(
      margins.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (margins.length - 1),
    );
    // NBA final margins have a standard deviation around 12-14 points.
    expect(sd).toBeGreaterThan(9);
    expect(sd).toBeLessThan(18);
    // Basketball has no draws.
    expect(margins.some((margin) => margin === 0)).toBe(false);
  });

  it('produces legal tennis set scores', async () => {
    const matches = (await provider.fetchMatches({ sportKey: 'tennis' })).filter(
      (match) => match.status === 'FINISHED',
    );
    expect(matches.length).toBeGreaterThan(0);
    for (const match of matches) {
      // Best of three: the winner takes exactly two sets.
      expect(Math.max(match.homeScore ?? 0, match.awayScore ?? 0)).toBe(2);
      expect(Math.min(match.homeScore ?? 0, match.awayScore ?? 0)).toBeLessThanOrEqual(1);
    }
  });

  it('prices every fixture with a margin-carrying market', async () => {
    const matches = await provider.fetchMatches({ sportKey: 'football' });
    const sample = matches.slice(0, 8).map((match) => match.externalId);
    const quotes = await provider.fetchOdds(sample);
    expect(quotes.length).toBeGreaterThan(0);

    for (const quote of quotes) {
      expect(quote.price).toBeGreaterThan(1);
      expect(Number.isFinite(quote.price)).toBe(true);
    }

    // Each bookmaker's 1X2 book must carry a positive overround.
    const first = sample[0];
    const book = quotes.filter(
      (quote) =>
        quote.matchExternalId === first &&
        quote.market === 'MATCH_WINNER' &&
        quote.bookmaker === 'DemoBook',
    );
    expect(book).toHaveLength(3);
    const booksum = book.reduce((sum, quote) => sum + impliedProbability(quote.price), 0);
    expect(booksum).toBeGreaterThan(1);
    expect(booksum).toBeLessThan(1.15);

    // After margin removal the market is a valid distribution.
    const fair = removeMargin(book.map((quote) => quote.price), 'shin');
    expect(fair.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 8);
  });

  it('never captures odds after kickoff', async () => {
    const matches = await provider.fetchMatches({});
    const byId = new Map(matches.map((match) => [match.externalId, match]));
    const quotes = await provider.fetchOdds([...byId.keys()].slice(0, 30));
    for (const quote of quotes) {
      const match = byId.get(quote.matchExternalId)!;
      expect(quote.capturedAt.getTime()).toBeLessThanOrEqual(match.kickoff.getTime());
    }
  });

  it('gives team-sport competitors a squad and tennis players none', async () => {
    const footballTeams = await provider.fetchTeams('premier-division');
    const squad = await provider.fetchPlayers(footballTeams[0].key);
    expect(squad.length).toBeGreaterThan(10);
    // Importance is a share of the squad, so it sums to 1.
    expect(squad.reduce((sum, player) => sum + player.importance, 0)).toBeCloseTo(1, 2);

    const tennisPlayers = await provider.fetchTeams('open-tour');
    expect(await provider.fetchPlayers(tennisPlayers[0].key)).toEqual([]);
  });

  it('reports availability only for fixtures that exist', async () => {
    const matches = await provider.fetchMatches({ sportKey: 'football' });
    const ids = matches.slice(0, 40).map((match) => match.externalId);
    const availability = await provider.fetchAvailability(ids);
    for (const entry of availability) {
      expect(ids).toContain(entry.matchExternalId);
      expect(['INJURED', 'SUSPENDED', 'DOUBTFUL']).toContain(entry.status);
    }
  });
});

describe('ApiFootballProvider', () => {
  it('reports itself unconfigured without an API key', () => {
    const provider = new ApiFootballProvider({ apiKey: '' });
    expect(provider.isConfigured()).toBe(false);
    expect(provider.origin).toBe('LIVE');
  });

  it('refuses to make a request when unconfigured, rather than returning empty data', async () => {
    const provider = new ApiFootballProvider({ apiKey: '' });
    await expect(provider.fetchLeagues()).rejects.toBeInstanceOf(ProviderNotConfiguredError);
  });

  it('reports configured once a key is supplied', () => {
    expect(new ApiFootballProvider({ apiKey: 'test-key' }).isConfigured()).toBe(true);
  });
});

describe('resolveProvider', () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env.DATA_PROVIDER = original.DATA_PROVIDER;
    process.env.SPORTS_API_KEY = original.SPORTS_API_KEY;
  });

  it('defaults to the real-data openfootball provider', () => {
    delete process.env.DATA_PROVIDER;
    const resolution = resolveProvider();
    expect(resolution.provider.name).toBe('openfootball');
    expect(resolution.provider.origin).toBe('LIVE');
  });

  it('returns the demo provider only when it is explicitly requested', () => {
    process.env.DATA_PROVIDER = 'demo';
    const resolution = resolveProvider();
    expect(resolution.provider.name).toBe('demo');
    expect(resolution.provider.origin).toBe('DEMO');
  });

  it('throws rather than silently serving demo data when a live provider lacks its key', () => {
    process.env.DATA_PROVIDER = 'api-football';
    process.env.SPORTS_API_KEY = '';
    expect(() => resolveProvider()).toThrow(ProviderNotConfiguredError);
  });

  it('rejects an unknown provider name instead of guessing', () => {
    process.env.DATA_PROVIDER = 'not-a-provider';
    expect(() => resolveProvider()).toThrow(/not a known provider/i);
  });

  it('uses the live provider when it is configured', () => {
    process.env.DATA_PROVIDER = 'api-football';
    process.env.SPORTS_API_KEY = 'test-key';
    expect(resolveProvider().provider.name).toBe('api-football');
  });
});
