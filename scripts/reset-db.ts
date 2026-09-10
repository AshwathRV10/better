/**
 * Truncates every application table without dropping the schema.
 *
 * Used by the integration test suite and by `npm run db:clear`. Deliberately
 * separate from `prisma migrate reset` so it can run non-interactively against
 * a local development database.
 */

import 'dotenv/config';
import { prisma } from '../src/lib/db/prisma';

const TABLES = [
  'bets', 'backtests', 'model_performance', 'model_component_outcomes',
  'prediction_features', 'prediction_outcomes', 'predictions', 'team_ratings',
  'odds', 'player_availability', 'player_statistics', 'team_statistics',
  'match_events', 'matches', 'players', 'teams', 'leagues', 'sports',
  'model_versions', 'ingestion_runs', 'users',
] as const;

export async function clearDatabase(): Promise<void> {
  const list = TABLES.map((table) => `"public"."${table}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE;`);
}

if (process.argv[1] && process.argv[1].includes('reset-db')) {
  clearDatabase()
    .then(() => console.log('Database cleared.'))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
