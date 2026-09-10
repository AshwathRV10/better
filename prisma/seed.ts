/**
 * Database seed.
 *
 * Ingests the configured provider (demo by default), trains the models on the
 * resulting history, generates predictions for upcoming fixtures and creates a
 * demo tracking account.
 *
 * Safe to re-run: every write is an upsert keyed on provider identifiers.
 */

import 'dotenv/config';
import { prisma } from '../src/lib/db/prisma';
import { ingestAll } from '../src/lib/services/ingestion';
import { generateUpcomingPredictions } from '../src/lib/services/predictions';
import { trainAllSports } from '../src/lib/services/training';
import { backfillHistoricalPredictions, recomputeModelPerformance } from '../src/lib/services/performance';

async function main() {
  const startedAt = Date.now();
  console.log('→ Ingesting sports data…');
  const ingestion = await ingestAll();
  if (ingestion.fallbackReason) console.warn(`  ! ${ingestion.fallbackReason}`);
  console.log(
    `  ${ingestion.provider} (${ingestion.origin}): ${ingestion.leagues} leagues, ` +
      `${ingestion.teams} teams, ${ingestion.players} players, ${ingestion.matches} matches, ` +
      `${ingestion.odds} odds in ${ingestion.durationMs}ms`,
  );

  console.log('→ Training models (walk-forward, out-of-sample)…');
  const training = await trainAllSports();
  for (const result of training) {
    console.log(
      `  ${result.sportKey}: ${result.trainingSamples} training samples, ` +
        `${result.calibrationSamples} calibration samples, ` +
        `ML ${result.mlTrained ? 'trained' : 'skipped (insufficient data)'}`,
    );
    if (result.weightsFitted) {
      const weights = Object.entries(result.ensembleWeights)
        .map(([name, weight]) => `${name} ${weight.toFixed(2)}`)
        .join(', ');
      console.log(`    ensemble weights (held-out skill): ${weights}`);
    }
  }

  console.log('→ Backfilling predictions for finished matches (scored at their own kickoff)…');
  const backfill = await backfillHistoricalPredictions({ limit: 450 });
  console.log(`  ${backfill.generated} historical predictions, ${backfill.skipped} skipped`);

  console.log('→ Scoring model performance…');
  for (const summary of await recomputeModelPerformance()) {
    console.log(`  ${summary.modelVersion}: ${summary.scored} settled predictions across ${summary.rows} breakdowns`);
  }

  console.log('→ Generating predictions for upcoming fixtures…');
  const predictions = await generateUpcomingPredictions();
  console.log(`  ${predictions.generated} predictions written, ${predictions.skipped.length} skipped`);
  for (const skip of predictions.skipped.slice(0, 5)) {
    console.log(`    skipped ${skip.matchId}: ${skip.reason}`);
  }

  console.log('→ Creating demo tracking account…');
  const user = await prisma.user.upsert({
    where: { email: 'demo@better.local' },
    update: {},
    create: { email: 'demo@better.local', displayName: 'Demo Analyst', bankroll: 1000 },
  });
  console.log(`  ${user.email}`);

  const counts = {
    sports: await prisma.sport.count(),
    leagues: await prisma.league.count(),
    teams: await prisma.team.count(),
    matches: await prisma.match.count(),
    finished: await prisma.match.count({ where: { status: 'FINISHED' } }),
    upcoming: await prisma.match.count({ where: { status: 'SCHEDULED' } }),
    odds: await prisma.odds.count(),
    predictions: await prisma.prediction.count(),
  };
  console.log('\nSeed complete in', `${Date.now() - startedAt}ms`);
  console.table(counts);
}

main()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
