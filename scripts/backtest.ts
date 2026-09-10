/**
 * Walk-forward backtest CLI.
 *
 *   npm run backtest -- --sport football --step 40 --initial 120 [--save]
 */

import 'dotenv/config';
import { prisma } from '../src/lib/db/prisma';
import { runBacktest } from '../src/lib/backtest/walkForward';
import { getActiveModelVersion } from '../src/lib/services/modelVersions';
import type { SportKey } from '../src/lib/prediction/types';
import type { Prisma } from '@prisma/client';

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main() {
  const requested = arg('sport');
  const sports = requested
    ? [requested as SportKey]
    : ((await prisma.sport.findMany()).map((s) => s.key) as SportKey[]);
  const save = process.argv.includes('--save');

  for (const sportKey of sports) {
    console.log(`\n=== ${sportKey.toUpperCase()} walk-forward backtest ===`);
    try {
      const result = await runBacktest({
        sportKey,
        leagueKey: arg('league'),
        initialTrainingSize: Number(arg('initial', '120')),
        stepSize: Number(arg('step', '40')),
        minimumExpectedValue: Number(arg('min-ev', '0.02')),
      });

      const m = result.metrics;
      console.log(`period      ${result.periodStart.toISOString().slice(0, 10)} → ${result.periodEnd.toISOString().slice(0, 10)} (${result.windows} windows)`);
      console.log(`predictions ${m.predictions}`);
      console.log(`accuracy    ${(m.accuracy * 100).toFixed(1)}%`);
      console.log(`log loss    ${m.logLoss.toFixed(4)}   (base rate ${m.baselineLogLoss.toFixed(4)}, skill ${(m.skillScore * 100).toFixed(1)}%)`);
      console.log(`Brier       ${m.brierScore.toFixed(4)}`);
      console.log(`calib. ECE  ${(m.expectedCalibrationError * 100).toFixed(2)}pp`);
      if (result.marketBaseline) {
        const b = result.marketBaseline;
        console.log(`market      log loss ${b.logLoss.toFixed(4)}, Brier ${b.brierScore.toFixed(4)}, accuracy ${(b.accuracy * 100).toFixed(1)}%`);
        console.log(`vs market   ${m.logLoss < b.logLoss ? 'BETTER' : 'worse'} by ${Math.abs(m.logLoss - b.logLoss).toFixed(4)} log loss`);
      }
      console.log('components  (standalone, uncalibrated):');
      for (const c of result.perComponent) {
        console.log(`  ${c.component.padEnd(13)} w=${c.weight.toFixed(2)}  log loss ${c.metrics.logLoss.toFixed(4)}  acc ${(c.metrics.accuracy * 100).toFixed(1)}%  skill ${(c.metrics.skillScore * 100).toFixed(1)}%`);
      }
      const bet = result.betting;
      console.log(`betting     ${bet.betsPlaced} bets, ROI ${(bet.roi * 100).toFixed(1)}%, win rate ${(bet.winRate * 100).toFixed(1)}%, avg odds ${bet.averageOdds.toFixed(2)}`);

      if (save) {
        const modelVersion = await getActiveModelVersion(sportKey);
        await prisma.backtest.create({
          data: {
            modelVersionId: modelVersion.id,
            sportKey,
            leagueKey: result.config.leagueKey,
            label: `${sportKey} walk-forward ${new Date().toISOString().slice(0, 10)}`,
            config: result.config as unknown as Prisma.InputJsonValue,
            periodStart: result.periodStart,
            periodEnd: result.periodEnd,
            matches: m.predictions,
            accuracy: m.accuracy,
            logLoss: m.logLoss,
            brierScore: m.brierScore,
            roi: bet.roi,
            betsPlaced: bet.betsPlaced,
            staked: bet.staked,
            profit: bet.profit,
            calibration: {
              bins: m.calibration,
              expectedCalibrationError: m.expectedCalibrationError,
              baselineLogLoss: m.baselineLogLoss,
              skillScore: m.skillScore,
              marketBaseline: result.marketBaseline
                ? { logLoss: result.marketBaseline.logLoss, brierScore: result.marketBaseline.brierScore, accuracy: result.marketBaseline.accuracy }
                : null,
            } as unknown as Prisma.InputJsonValue,
            equityCurve: bet.equityCurve as unknown as Prisma.InputJsonValue,
          },
        });
        console.log('saved to backtests table');
      }
    } catch (error) {
      console.error(`  failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
