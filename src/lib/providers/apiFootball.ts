/**
 * api-football.com adapter.
 *
 * Real HTTP integration, activated by setting SPORTS_API_KEY. Without a key the
 * adapter reports itself as unconfigured and the registry falls back to the demo
 * provider rather than silently returning empty data.
 *
 * The API key is read from the environment on every call and is never logged,
 * embedded in an error message, or sent anywhere other than the provider host.
 */

import type { SportKey } from '../prediction/types';
import {
  ProviderError,
  ProviderNotConfiguredError,
  type FetchMatchesOptions,
  type ProviderAvailability,
  type ProviderLeague,
  type ProviderMatch,
  type ProviderOdds,
  type ProviderPlayer,
  type ProviderTeam,
  type SportsDataProvider,
} from './types';

const DEFAULT_BASE_URL = 'https://v3.football.api-sports.io';
const REQUEST_TIMEOUT_MS = 12_000;

interface ApiFixture {
  fixture: {
    id: number;
    date: string;
    venue?: { name?: string | null };
    status?: { short?: string };
  };
  league: { id: number; name: string; country?: string | null; season: number; round?: string };
  teams: { home: { id: number; name: string }; away: { id: number; name: string } };
  goals: { home: number | null; away: number | null };
}

interface ApiResponse<T> {
  response?: T[];
  errors?: unknown;
}

/** Maps api-football status codes onto the internal match status. */
function mapStatus(short: string | undefined): ProviderMatch['status'] {
  switch (short) {
    case 'FT':
    case 'AET':
    case 'PEN':
      return 'FINISHED';
    case '1H':
    case '2H':
    case 'HT':
    case 'ET':
    case 'LIVE':
      return 'LIVE';
    case 'PST':
      return 'POSTPONED';
    case 'CANC':
    case 'ABD':
      return 'CANCELLED';
    default:
      return 'SCHEDULED';
  }
}

/** Stable slug so provider records map onto the same rows across syncs. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export class ApiFootballProvider implements SportsDataProvider {
  readonly name = 'api-football';
  readonly origin = 'LIVE' as const;

  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: { apiKey?: string; baseUrl?: string } = {}) {
    this.apiKey = options.apiKey ?? process.env.SPORTS_API_KEY ?? '';
    this.baseUrl = (options.baseUrl ?? process.env.SPORTS_API_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) throw new ProviderNotConfiguredError(this.name, 'SPORTS_API_KEY');
  }

  private async request<T>(path: string, params: Record<string, string | number>): Promise<T[]> {
    this.assertConfigured();
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: { 'x-apisports-key': this.apiKey, Accept: 'application/json' },
        signal: controller.signal,
      });

      if (response.status === 429) {
        throw new ProviderError('Rate limit exceeded', this.name, undefined, true);
      }
      if (!response.ok) {
        // The URL is included but never the key, which lives in a header.
        throw new ProviderError(
          `Request to ${url.pathname} failed with HTTP ${response.status}`,
          this.name,
          undefined,
          response.status >= 500,
        );
      }

      const body = (await response.json()) as ApiResponse<T>;
      if (body.errors && Array.isArray(body.errors) && body.errors.length > 0) {
        throw new ProviderError(`Provider returned errors for ${url.pathname}`, this.name);
      }
      return body.response ?? [];
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ProviderError(`Request to ${path} timed out`, this.name, error, true);
      }
      throw new ProviderError(`Request to ${path} failed`, this.name, error, true);
    } finally {
      clearTimeout(timeout);
    }
  }

  async fetchLeagues(): Promise<ProviderLeague[]> {
    const leagues = await this.request<{
      league: { id: number; name: string; type: string };
      country: { name: string | null };
    }>('/leagues', { current: 'true' });

    return leagues
      .filter((entry) => entry.league.type === 'League')
      .map((entry) => ({
        key: slugify(entry.league.name),
        name: entry.league.name,
        country: entry.country?.name ?? null,
        sportKey: 'football' as SportKey,
        tier: 1,
        strength: 1,
        externalId: String(entry.league.id),
      }));
  }

  async fetchTeams(leagueKey: string): Promise<ProviderTeam[]> {
    const season = new Date().getUTCFullYear();
    const teams = await this.request<{ team: { id: number; name: string; code?: string | null; country?: string | null } }>(
      '/teams',
      { league: leagueKey, season },
    );
    return teams.map((entry) => ({
      key: slugify(entry.team.name),
      name: entry.team.name,
      shortName: entry.team.code ?? entry.team.name.slice(0, 3).toUpperCase(),
      leagueKey,
      sportKey: 'football' as SportKey,
      country: entry.team.country ?? null,
      externalId: String(entry.team.id),
    }));
  }

  async fetchPlayers(teamKey: string): Promise<ProviderPlayer[]> {
    const season = new Date().getUTCFullYear();
    const squad = await this.request<{ players: Array<{ id: number; name: string; position: string }> }>(
      '/players/squads',
      { team: teamKey, season },
    );
    const roster = squad[0]?.players ?? [];
    // The API exposes no per-player value, so importance is spread evenly rather
    // than invented. A flat prior is honest; a fabricated ranking would not be.
    const importance = roster.length > 0 ? 1 / roster.length : 0;
    return roster.map((player) => ({
      key: slugify(player.name),
      name: player.name,
      teamKey,
      position: player.position ?? null,
      importance,
      externalId: String(player.id),
    }));
  }

  async fetchMatches(options: FetchMatchesOptions): Promise<ProviderMatch[]> {
    const params: Record<string, string | number> = {};
    if (options.leagueKey) params.league = options.leagueKey;
    if (options.from) params.from = options.from.toISOString().slice(0, 10);
    if (options.to) params.to = options.to.toISOString().slice(0, 10);
    params.season = (options.from ?? new Date()).getUTCFullYear();

    const fixtures = await this.request<ApiFixture>('/fixtures', params);
    return fixtures.map((entry) => ({
      externalId: String(entry.fixture.id),
      sportKey: 'football' as SportKey,
      leagueKey: slugify(entry.league.name),
      season: String(entry.league.season),
      round: null,
      homeTeamKey: slugify(entry.teams.home.name),
      awayTeamKey: slugify(entry.teams.away.name),
      kickoff: new Date(entry.fixture.date),
      venue: entry.fixture.venue?.name ?? null,
      neutralVenue: false,
      status: mapStatus(entry.fixture.status?.short),
      homeScore: entry.goals.home,
      awayScore: entry.goals.away,
    }));
  }

  async fetchOdds(matchExternalIds: readonly string[]): Promise<ProviderOdds[]> {
    const quotes: ProviderOdds[] = [];
    for (const fixtureId of matchExternalIds) {
      const response = await this.request<{
        bookmakers: Array<{
          name: string;
          bets: Array<{ name: string; values: Array<{ value: string; odd: string }> }>;
        }>;
      }>('/odds', { fixture: fixtureId });

      const capturedAt = new Date();
      for (const entry of response) {
        for (const bookmaker of entry.bookmakers ?? []) {
          const matchWinner = bookmaker.bets?.find((bet) => bet.name === 'Match Winner');
          for (const value of matchWinner?.values ?? []) {
            const price = Number(value.odd);
            if (!Number.isFinite(price) || price <= 1) continue;
            const selection =
              value.value === 'Home' ? 'HOME' : value.value === 'Draw' ? 'DRAW' : 'AWAY';
            quotes.push({
              matchExternalId: fixtureId,
              bookmaker: bookmaker.name,
              market: 'MATCH_WINNER',
              selection,
              line: null,
              price,
              capturedAt,
            });
          }
        }
      }
    }
    return quotes;
  }

  async fetchAvailability(matchExternalIds: readonly string[]): Promise<ProviderAvailability[]> {
    const entries: ProviderAvailability[] = [];
    for (const fixtureId of matchExternalIds) {
      const injuries = await this.request<{
        player: { id: number; name: string };
        player_type?: string;
      }>('/injuries', { fixture: fixtureId });
      for (const injury of injuries) {
        entries.push({
          matchExternalId: fixtureId,
          playerKey: slugify(injury.player.name),
          status: 'INJURED',
          reason: null,
          reportedAt: new Date(),
        });
      }
    }
    return entries;
  }
}
