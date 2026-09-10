/**
 * Model performance tracking.
 *
 * Scores stored predictions against results once matches finish, and writes the
 * aggregates the performance dashboard reads. Predictions are only ever scored
 * after the fact, so nothing here can influence a live prediction.
 */

import type { ConfidenceLevel, Market, Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { getSportModule } from '../prediction/sports/registry';
import { evaluate, evaluateBetting, type ScoredPrediction } from '../backtest/metrics';
import type { SportKey } from '../prediction/types';

export interface PerformanceSummary {
  readonly modelVersion: string;
  readonly sportKey: string;
  readonly scored: number;
  readonly rows: number;
}

/**
 * Recomputes `model_performance` for every model version with settled
 * predictions, broken down by league and by confidence level.
 */
export async function recomputeModelPerformance(): Promise<PerformanceSummary[]> {
  const versions = await prisma.modelVersion.findMany();
  const summaries: PerformanceSummary[] = [];

  for (const version of versions) {
    const sportModule = getSportModule(version.sportKey);
    const predictions = await prisma.prediction.findMany({
      where: {
        modelVersionId: version.id,
        match: { status: 'FINISHED', homeScore: { not: null } },
      },
      include: {
        match: { include: { league: { select: { key: true } } } },
        outcomes: { where: { market: 'MATCH_WINNER' } },
      },
    });

    const scored: ScoredPrediction[] = [];
    for (const prediction of predictions) {
      const { match } = prediction;
      if (match.homeScore === null || match.awayScore === null) continue;
      const actual = sportModule.classes.indexOf(
        sportModule.resultClass({ homeScore: match.homeScore, awayScore: match.awayScore }),
      );
      if (actual < 0) continue;

      const probabilities = sportModule.classes.map(
        (selection) => prediction.outcomes.find((o) => o.selection === selection)?.probability ?? 0,
      );
      if (probabilities.some((p) => p <= 0)) continue;
      const odds = sportModule.classes.map(
        (selection) => prediction.outcomes.find((o) => o.selection === selection)?.bookmakerOdds ?? null,
      );

      scored.push({
        probabilities,
        actual,
        odds,
        kickoff: match.kickoff,
        leagueKey: match.league.key,
        confidence: prediction.confidence,
      });
    }

    if (scored.length === 0) {
      summaries.push({ modelVersion: version.version, sportKey: version.sportKey, scored: 0, rows: 0 });
      continue;
    }

    const periodStart = new Date(Math.min(...scored.map((s) => s.kickoff.getTime())));
    const periodEnd = new Date(Math.max(...scored.map((s) => s.kickoff.getTime())));

    // Overall, then per league, then per confidence level.
    const slices: Array<{ leagueKey: string | null; confidence: ConfidenceLevel | null; samples: ScoredPrediction[] }> = [
      { leagueKey: null, confidence: null, samples: scored },
    ];
    for (const leagueKey of new Set(scored.map((s) => s.leagueKey).filter((k): k is string => !!k))) {
      slices.push({ leagueKey, confidence: null, samples: scored.filter((s) => s.leagueKey === leagueKey) });
    }
    for (const confidence of ['LOW', 'MEDIUM', 'HIGH'] as const) {
      const samples = scored.filter((s) => s.confidence === confidence);
      if (samples.length > 0) slices.push({ leagueKey: null, confidence, samples });
    }

    let rows = 0;
    for (const slice of slices) {
      const metrics = evaluate(slice.samples);
      const betting = evaluateBetting(slice.samples, { minimumExpectedValue: 0.02 });
      const data = {
        modelVersionId: version.id,
        sportKey: version.sportKey,
        leagueKey: slice.leagueKey,
        confidence: slice.confidence,
        market: 'MATCH_WINNER' as Market,
        predictions: metrics.predictions,
        correct: metrics.correct,
        accuracy: metrics.accuracy,
        logLoss: metrics.logLoss,
        brierScore: metrics.brierScore,
        roi: betting.betsPlaced > 0 ? betting.roi : null,
        winRate: betting.betsPlaced > 0 ? betting.winRate : null,
        averageOdds: betting.betsPlaced > 0 ? betting.averageOdds : null,
        averageEdge: betting.betsPlaced > 0 ? betting.averageEdge : null,
        calibration: {
          bins: metrics.calibration,
          expectedCalibrationError: metrics.expectedCalibrationError,
          baselineLogLoss: metrics.baselineLogLoss,
          skillScore: metrics.skillScore,
          betsPlaced: betting.betsPlaced,
        } as unknown as Prisma.InputJsonValue,
        periodStart,
        periodEnd,
      };

      // Prisma cannot upsert on a compound unique that contains nullable
      // columns (leagueKey and confidence are both nullable here), so the row is
      // located explicitly first.
      const existing = await prisma.modelPerformance.findFirst({
        where: {
          modelVersionId: version.id,
          sportKey: version.sportKey,
          leagueKey: slice.leagueKey,
          confidence: slice.confidence,
          market: 'MATCH_WINNER',
        },
      });
      if (existing) {
        await prisma.modelPerformance.update({ where: { id: existing.id }, data });
      } else {
        await prisma.modelPerformance.create({ data });
      }
      rows += 1;
    }

    summaries.push({
      modelVersion: version.version,
      sportKey: version.sportKey,
      scored: scored.length,
      rows,
    });
  }

  return summaries;
}

/**
 * Generates predictions for already-finished matches so the performance page has
 * a settled history to score.
 *
 * Each prediction is made at that match's own kickoff, using only data that
 * existed beforehand - the same discipline the backtester enforces.
 */
export async function backfillHistoricalPredictions(options: {
  sportKey?: SportKey;
  limit?: number;
} = {}): Promise<{ generated: number; skipped: number }> {
  const { generatePrediction } = await import('./predictions');
  const matches = await prisma.match.findMany({
    where: {
      status: 'FINISHED',
      homeScore: { not: null },
      ...(options.sportKey ? { sport: { key: options.sportKey } } : {}),
      predictions: { none: {} },
    },
    include: {
      league: { select: { id: true, key: true, name: true, strength: true } },
      sport: { select: { key: true } },
    },
    orderBy: { kickoff: 'desc' },
    take: options.limit ?? 200,
  });

  let generated = 0;
  let skipped = 0;
  for (const match of matches) {
    try {
      await generatePrediction(match, { asOf: match.kickoff });
      generated += 1;
    } catch {
      skipped += 1;
    }
  }
  return { generated, skipped };
}
