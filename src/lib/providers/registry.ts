/**
 * Provider registry.
 *
 * Chooses the active data provider from the environment. If a live provider is
 * requested but not configured, the registry falls back to demo data and says
 * so, rather than starting up with an empty database.
 */

import { DemoProvider } from './demo/DemoProvider';
import { ApiFootballProvider } from './apiFootball';
import type { SportsDataProvider } from './types';

export type ProviderKey = 'demo' | 'api-football';

export interface ProviderResolution {
  readonly provider: SportsDataProvider;
  readonly requested: string;
  /** Set when the requested provider could not be used. */
  readonly fallbackReason: string | null;
}

export function createProvider(key: ProviderKey, options: { now?: Date; seed?: number } = {}): SportsDataProvider {
  switch (key) {
    case 'api-football':
      return new ApiFootballProvider();
    case 'demo':
    default:
      return new DemoProvider(options);
  }
}

/** Resolves the provider named by DATA_PROVIDER, falling back to demo. */
export function resolveProvider(options: { now?: Date; seed?: number } = {}): ProviderResolution {
  const requested = (process.env.DATA_PROVIDER ?? 'demo').toLowerCase();

  if (requested === 'demo') {
    return { provider: new DemoProvider(options), requested, fallbackReason: null };
  }

  const candidate = createProvider(requested as ProviderKey, options);
  if (candidate.isConfigured()) {
    return { provider: candidate, requested, fallbackReason: null };
  }

  return {
    provider: new DemoProvider(options),
    requested,
    fallbackReason:
      `Provider "${requested}" is not configured (missing API key). ` +
      'Falling back to demo data, which is labelled DEMO throughout the interface.',
  };
}

export { DemoProvider, ApiFootballProvider };
export type { SportsDataProvider };
