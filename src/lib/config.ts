/**
 * Environment configuration.
 *
 * Parsed once, validated, and never read ad hoc elsewhere. Secrets are read
 * from the environment only - nothing is hard-coded and nothing is exposed to
 * the browser unless it carries the NEXT_PUBLIC_ prefix.
 */

import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  NEXT_PUBLIC_APP_URL: z.string().url().default('http://localhost:3000'),
  DATA_PROVIDER: z.enum(['demo', 'api-football']).default('demo'),
  SPORTS_API_KEY: z.string().optional().default(''),
  ODDS_API_KEY: z.string().optional().default(''),
  API_ACCESS_KEY: z.string().optional().default(''),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type AppConfig = z.infer<typeof schema>;

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test hook: forces the next getConfig() call to re-read the environment. */
export function resetConfigCache(): void {
  cached = null;
}

/** True when mutating API routes require the shared secret. */
export function isApiKeyRequired(): boolean {
  return getConfig().API_ACCESS_KEY.length > 0;
}
