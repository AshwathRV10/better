/**
 * Retrains every sport's model in place and rescores performance.
 *
 *   npm run models:train
 */

import 'dotenv/config';
import { prisma } from '../src/lib/db/prisma';
import { trainAllSports } from '../src/lib/services/training';
import { recomputeModelPerformance } from '../src/lib/services/performance';
import { generateUpcomingPredictions } from '../src/lib/services/predictions';

async function main() {
  console.log('Training models (walk-forward, out-of-sample)…');
  for (const result of await trainAllSports()) {
    console.log(
      `  ${result.sportKey}: ${result.trainingSamples} training samples, ` +
        `${result.calibrationSamples} held out, ML ${result.mlTrained ? 'trained' : 'skipped'}`,
    );
    if (result.weightsFitted) {
      console.log(
        `    weights: ${Object.entries(result.ensembleWeights)
          .map(([name, weight]) => `${name} ${weight.toFixed(2)}`)
          .join(', ')}`,
      );
      console.log(
        `    held-out skill: ${Object.entries(result.componentSkill)
          .map(([name, skill]) => `${name} ${(skill * 100).toFixed(1)}%`)
          .join(', ')}`,
      );
    }
  }

  console.log('Rescoring model performance…');
  for (const summary of await recomputeModelPerformance()) {
    console.log(`  ${summary.modelVersion}: ${summary.scored} settled predictions`);
  }

  console.log('Regenerating predictions for upcoming fixtures…');
  const result = await generateUpcomingPredictions();
  console.log(`  ${result.generated} written, ${result.skipped.length} skipped`);

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
