import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';

// Integration tests truncate every table, so they are pinned to their own
// database via .env.test and can never touch the development data.
loadEnv({ path: path.resolve(__dirname, '.env.test'), override: true });

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    exclude: ['tests/e2e/**'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
});
