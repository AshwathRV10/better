/**
 * Data pipeline commands.
 *
 *   npm run data:bootstrap   first-time import: history, training, predictions
 *   npm run data:sync        routine update: new results, ratings, fixtures
 *
 * Bootstrap wipes and rebuilds; sync is incremental and safe to run on a cron.
 * Both refuse to mix real and simulated records: the active provider decides,
 * and its origin is written onto every row.
 */

import 'dotenv/config';
import { prisma } from '../src/lib/db/prisma';
import { ingestAll } from '../src/lib/services/ingestion';
import { resolveProvider } from '../src/lib/providers/registry';
import { trainAllSports } from '../src/lib/services/training';
import { generateUpcomingPredictions } from '../src/lib/services/predictions';
import {
  backfillHistoricalPredictions,
  recomputeModelPerformance,
} from '../src/lib/services/performance';
import { clearDatabase } from './reset-db';

const mode = process.argv.includes('--bootstrap') ? 'bootstrap' : 'sync';

/** Days of upcoming fixtures to predict. The MVP shows the next week. */
const FORECAST_DAYS = Number(process.env.FORECAST_DAYS ?? 8);

function heading(text: string) {
  console.log(`\n── ${text}`);
}

async function main() {
  const startedAt = Date.now();
  const { provider, requested } = resolveProvider();

  console.log(`Provider: ${provider.name} (${provider.origin}), requested as "${requested}"`);
  if (provider.origin !== 'LIVE') {
    console.warn('  ! This provider produces SIMULATED data. It is labelled DEMO throughout the app.');
  }

  if (mode === 'bootstrap') {
    heading('Clearing existing data');
    await clearDatabase();
    console.log('  database cleared');
  }

  heading('Importing fixtures and results');
  // History deep enough for ratings to converge; a short future window keeps
  // the request count (and any provider quota) small.
  const now = new Date();
  const ingestion = await ingestAll({
    provider,
    now,
    historyDays: Number(process.env.HISTORY_DAYS ?? 900),
    futureDays: FORECAST_DAYS,
  });
  console.log(
    `  ${ingestion.leagues} leagues, ${ingestion.teams} teams, ${ingestion.matches} matches, ` +
      `${ingestion.odds} odds in ${(ingestion.durationMs / 1000).toFixed(1)}s`,
  );

  const [finished, upcoming] = await Promise.all([
    prisma.match.count({ where: { status: 'FINISHED' } }),
    prisma.match.count({ where: { status: 'SCHEDULED', kickoff: { gte: now } } }),
  ]);
  console.log(`  ${finished} completed matches on record, ${upcoming} fixtures still to play`);

  if (finished === 0) {
    throw new Error(
      'No completed matches were imported, so there is no history to build ratings from. ' +
        'Check the provider configuration before continuing.',
    );
  }

  heading('Training models on completed matches');
  for (const result of await trainAllSports()) {
    const weights = Object.entries(result.ensembleWeights)
      .filter(([, weight]) => weight > 0)
      .map(([name, weight]) => `${name} ${(weight * 100).toFixed(0)}%`)
      .join(', ');
    console.log(
      `  ${result.sportKey}: ${result.trainingSamples} training / ${result.calibrationSamples} held out` +
        (weights ? ` | weights ${weights}` : ''),
    );
  }

  // Scoring settled predictions is what gives the confidence model its
  // historical-accuracy input, so it runs before the upcoming slate.
  heading('Scoring past predictions');
  const backfill = await backfillHistoricalPredictions({
    limit: Number(process.env.BACKFILL_LIMIT ?? 400),
  });
  console.log(`  ${backfill.generated} historical predictions scored, ${backfill.skipped} skipped`);
  for (const summary of await recomputeModelPerformance()) {
    if (summary.scored > 0) console.log(`  ${summary.modelVersion}: ${summary.scored} settled`);
  }

  heading('Predicting upcoming fixtures');
  const predictions = await generateUpcomingPredictions({
    from: now,
    to: new Date(now.getTime() + FORECAST_DAYS * 86_400_000),
  });
  console.log(`  ${predictions.generated} predictions written, ${predictions.skipped.length} skipped`);
  for (const skip of predictions.skipped.slice(0, 3)) {
    console.log(`    ${skip.matchId}: ${skip.reason}`);
  }

  console.log(`\nDone in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`);
  console.table({
    leagues: await prisma.league.count(),
    teams: await prisma.team.count(),
    completedMatches: finished,
    upcomingFixtures: upcoming,
    predictions: await prisma.prediction.count(),
  });
}

main()
  .catch((error) => {
    console.error('\nFailed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
