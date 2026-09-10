/**
 * Sports data provider abstraction.
 *
 * The rest of the application never talks to an external API directly. It asks
 * a `SportsDataProvider` for normalised records, so swapping providers - or
 * running entirely on demo data - changes one environment variable and nothing
 * else.
 */

import type { MarketKey, SportKey } from '../prediction/types';

export type DataOrigin = 'DEMO' | 'LIVE';

export interface ProviderLeague {
  readonly key: string;
  readonly name: string;
  readonly country: string | null;
  readonly sportKey: SportKey;
  readonly tier: number;
  /** Relative competition quality, used to compare ratings across leagues. */
  readonly strength: number;
  readonly externalId: string | null;
}

export interface ProviderTeam {
  readonly key: string;
  readonly name: string;
  readonly shortName: string;
  readonly leagueKey: string;
  readonly sportKey: SportKey;
  readonly country: string | null;
  readonly externalId: string | null;
}

export interface ProviderPlayer {
  readonly key: string;
  readonly name: string;
  readonly teamKey: string;
  readonly position: string | null;
  /** 0..1 share of the team's on-pitch value. */
  readonly importance: number;
  readonly externalId: string | null;
}

export interface ProviderTeamStats {
  readonly xg?: number;
  readonly shots?: number;
  readonly shotsOnTarget?: number;
  readonly possession?: number;
  readonly corners?: number;
  readonly extra?: Record<string, unknown>;
}

export interface ProviderMatch {
  readonly externalId: string;
  readonly sportKey: SportKey;
  readonly leagueKey: string;
  readonly season: string;
  readonly round: number | null;
  readonly homeTeamKey: string;
  readonly awayTeamKey: string;
  readonly kickoff: Date;
  readonly venue: string | null;
  readonly neutralVenue: boolean;
  readonly status: 'SCHEDULED' | 'LIVE' | 'FINISHED' | 'POSTPONED' | 'CANCELLED';
  readonly homeScore: number | null;
  readonly awayScore: number | null;
  readonly scoreDetail?: Record<string, unknown>;
  readonly homeStats?: ProviderTeamStats;
  readonly awayStats?: ProviderTeamStats;
}

export interface ProviderOdds {
  readonly matchExternalId: string;
  readonly bookmaker: string;
  readonly market: MarketKey;
  readonly selection: string;
  readonly line: number | null;
  readonly price: number;
  readonly capturedAt: Date;
}

export interface ProviderAvailability {
  readonly matchExternalId: string;
  readonly playerKey: string;
  readonly status: 'INJURED' | 'SUSPENDED' | 'DOUBTFUL';
  readonly reason: string | null;
  readonly reportedAt: Date;
}

export interface FetchMatchesOptions {
  readonly sportKey?: SportKey;
  readonly leagueKey?: string;
  readonly from?: Date;
  readonly to?: Date;
}

/**
 * The contract every data source implements.
 *
 * `origin` is surfaced all the way to the UI so simulated data can never be
 * mistaken for a live feed.
 */
export interface SportsDataProvider {
  readonly name: string;
  readonly origin: DataOrigin;
  /** Whether the adapter has the configuration it needs (API key, base URL). */
  isConfigured(): boolean;
  fetchLeagues(): Promise<ProviderLeague[]>;
  fetchTeams(leagueKey: string): Promise<ProviderTeam[]>;
  fetchPlayers(teamKey: string): Promise<ProviderPlayer[]>;
  fetchMatches(options: FetchMatchesOptions): Promise<ProviderMatch[]>;
  fetchOdds(matchExternalIds: readonly string[]): Promise<ProviderOdds[]>;
  fetchAvailability(matchExternalIds: readonly string[]): Promise<ProviderAvailability[]>;
}

/** Raised when a provider cannot serve a request. Never swallowed silently. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    override readonly cause?: unknown,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export class ProviderNotConfiguredError extends ProviderError {
  constructor(provider: string, missing: string) {
    super(
      `Provider "${provider}" is not configured: ${missing} is missing. ` +
        'Set it in the environment or switch DATA_PROVIDER to "demo".',
      provider,
    );
    this.name = 'ProviderNotConfiguredError';
  }
}
