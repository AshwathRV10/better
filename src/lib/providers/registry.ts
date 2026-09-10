/**
 * Provider registry.
 *
 * Chooses the active data provider from the environment.
 *
 * The one rule that matters: a live provider NEVER silently falls back to demo
 * data. Simulated fixtures presented as real sport would be worse than an
 * outage, so a misconfigured live provider raises and the interface shows the
 * error. Demo data is opt-in, explicit, and labelled everywhere it appears.
 */

import { DemoProvider } from './demo/DemoProvider';
import { ApiFootballProvider } from './apiFootball';
import { OpenFootballProvider } from './openFootball';
import { ProviderNotConfiguredError, type SportsDataProvider } from './types';

export type ProviderKey = 'openfootball' | 'demo' | 'api-football';

export const DEFAULT_PROVIDER: ProviderKey = 'openfootball';

export interface ProviderResolution {
  readonly provider: SportsDataProvider;
  readonly requested: string;
}

export function createProvider(
  key: ProviderKey,
  options: { now?: Date; seed?: number } = {},
): SportsDataProvider {
  switch (key) {
    case 'api-football':
      return new ApiFootballProvider();
    case 'demo':
      return new DemoProvider(options);
    case 'openfootball':
      return new OpenFootballProvider({ now: options.now });
    default: {
      const exhaustive: never = key;
      throw new Error(`Unknown data provider "${String(exhaustive)}"`);
    }
  }
}

export function isProviderKey(value: string): value is ProviderKey {
  return value === 'openfootball' || value === 'demo' || value === 'api-football';
}

/**
 * Resolves the provider named by DATA_PROVIDER.
 *
 * Throws rather than substituting demo data when a live provider is requested
 * but unusable — the caller is expected to surface that as an error.
 */
export function resolveProvider(options: { now?: Date; seed?: number } = {}): ProviderResolution {
  const requested = (process.env.DATA_PROVIDER ?? DEFAULT_PROVIDER).toLowerCase();

  if (!isProviderKey(requested)) {
    throw new Error(
      `DATA_PROVIDER is set to "${requested}", which is not a known provider. ` +
        'Valid values are: openfootball, demo, api-football.',
    );
  }

  const provider = createProvider(requested, options);
  if (!provider.isConfigured()) {
    throw new ProviderNotConfiguredError(
      provider.name,
      requested === 'api-football' ? 'SPORTS_API_KEY' : 'its required configuration',
    );
  }

  return { provider, requested };
}

export { DemoProvider, ApiFootballProvider, OpenFootballProvider };
export type { SportsDataProvider };
