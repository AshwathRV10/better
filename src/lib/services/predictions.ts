/**
 * Prediction service.
 *
 * Runs the engine over database fixtures, prices every selection against the
 * available market, and persists the result with full provenance (model
 * version, features version, prediction time, data time).
 */

import type { ConfidenceLevel, Market, Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { predictMatch } from '../prediction/engine';
import { getSportModule } from '../prediction/sports/registry';
import type { MatchContext, MatchPrediction, ModelParameters, SportKey } from '../prediction/types';
import { assessValue } from '../odds';
import { buildLeagueBaseline, buildMatchContext, buildRatingsAsOf } from './context';
import { getActiveModelVersion, loadModelParameters } from './modelVersions';
import { insufficientData } from '../errors';

const matchInclude = {
  league: { select: { id: true, key: true, name: true, strength: true } },
  sport: { select: { key: true } },
} satisfies Prisma.MatchInclude;

export type MatchWithRelations = Prisma.MatchGetPayload<{ include: typeof matchInclude }>;

export interface PricedOutcome {
  readonly market: string;
  readonly selection: string;
  readonly line: number | null;
  readonly probability: number;
  readonly fairOdds: number;
  readonly bookmaker: string | null;
  readonly bookmakerOdds: number | null;
  readonly impliedProbability: number | null;
  readonly edge: number | null;
  readonly expectedValue: number | null;
  readonly kellyStake: number | null;
}

/**
 * Attaches the best available market price to each model probability.
 *
 * "Best" means the highest decimal price across bookmakers for that selection,
 * which is what a bettor would actually be able to take. The margin is removed
 * using the full market from the same bookmaker so the reported edge is not
 * inflated by the overround.
 */
export function priceOutcomes(
  prediction: MatchPrediction,
  ctx: MatchContext,
): PricedOutcome[] {
  return prediction.outcomes.map((outcome) => {
    const candidates = ctx.odds.filter(
      (quote) =>
        quote.market === outcome.market &&
        quote.selection === outcome.selection &&
        (outcome.line === undefined ? quote.line === undefined || quote.line === null : quote.line === outcome.line),
    );

    if (candidates.length === 0) {
      return {
        market: outcome.market,
        selection: outcome.selection,
        line: outcome.line ?? null,
        probability: outcome.probability,
        fairOdds: 1 / Math.max(outcome.probability, 1e-9),
        bookmaker: null,
        bookmakerOdds: null,
        impliedProbability: null,
        edge: null,
        expectedValue: null,
        kellyStake: null,
      };
    }

    const best = candidates.reduce((a, b) => (b.price > a.price ? b : a));
    // The rest of that bookmaker's book for this market, for margin removal.
    const sameBook = ctx.odds.filter(
      (quote) =>
        quote.bookmaker === best.bookmaker &&
        quote.market === outcome.market &&
        (outcome.line === undefined ? quote.line === undefined || quote.line === null : quote.line === outcome.line),
    );
    // Deduplicate to the newest quote per selection.
    const latestBySelection = new Map<string, { price: number; at: number }>();
    for (const quote of sameBook) {
      const seen = latestBySelection.get(quote.selection);
      if (!seen || quote.capturedAt.getTime() >= seen.at) {
        latestBySelection.set(quote.selection, { price: quote.price, at: quote.capturedAt.getTime() });
      }
    }
    const marketPrices = [...latestBySelection.values()].map((entry) => entry.price);
    const assessment = assessValue(outcome.probability, best.price, marketPrices);

    return {
      market: outcome.market,
      selection: outcome.selection,
      line: outcome.line ?? null,
      probability: outcome.probability,
      fairOdds: assessment.fairOdds,
      bookmaker: best.bookmaker,
      bookmakerOdds: best.price,
      impliedProbability: assessment.impliedProbability,
      edge: assessment.edge,
      expectedValue: assessment.expectedValue,
      kellyStake: assessment.kellyStake,
    };
  });
}

export interface GeneratePredictionOptions {
  readonly asOf?: Date;
  readonly parameters?: ModelParameters;
  readonly modelVersionId?: string;
  readonly persist?: boolean;
  readonly force?: boolean;
}

/** Runs the engine for one match and (optionally) stores the result. */
export async function generatePrediction(
  match: MatchWithRelations,
  options: GeneratePredictionOptions = {},
): Promise<{ prediction: MatchPrediction; priced: PricedOutcome[]; predictionId: string | null }> {
  const sportKey = match.sport.key as SportKey;
  const modelVersion = options.modelVersionId
    ? await prisma.modelVersion.findUniqueOrThrow({ where: { id: options.modelVersionId } })
    : await getActiveModelVersion(sportKey);

  const ctx = await buildMatchContext(match, { asOf: options.asOf });

  // Refuse rather than fabricate: a prediction with no history behind either
  // side is not a prediction, it is a league-average prior dressed up as one.
  const hasHistory = ctx.home.recentMatches.length > 0 || ctx.away.recentMatches.length > 0;
  if (!hasHistory && !options.force) {
    throw insufficientData(
      `No completed matches on record for either side of ${match.id}; refusing to publish a prediction.`,
      { matchId: match.id, homeMatches: 0, awayMatches: 0 },
    );
  }

  const parameters = options.parameters ?? loadModelParameters(modelVersion, sportKey);
  const performance = await prisma.modelPerformance.findFirst({
    where: { modelVersionId: modelVersion.id, market: 'MATCH_WINNER', leagueKey: null, confidence: null },
    orderBy: { computedAt: 'desc' },
  });

  const prediction = predictMatch(ctx, {
    modelVersion: modelVersion.version,
    parameters,
    historicalBrier: performance?.brierScore,
    calibrationError: extractCalibrationError(performance?.calibration),
    predictedAt: options.asOf,
  });

  const priced = priceOutcomes(prediction, ctx);
  if (options.persist === false) {
    return { prediction, priced, predictionId: null };
  }

  const predictionId = await persistPrediction(match.id, modelVersion.id, prediction, priced);
  return { prediction, priced, predictionId };
}

function extractCalibrationError(calibration: Prisma.JsonValue | undefined): number | undefined {
  if (!calibration || typeof calibration !== 'object' || Array.isArray(calibration)) return undefined;
  const value = (calibration as Record<string, unknown>).expectedCalibrationError;
  return typeof value === 'number' ? value : undefined;
}

/** Writes a prediction and its fan-out rows in one transaction. */
export async function persistPrediction(
  matchId: string,
  modelVersionId: string,
  prediction: MatchPrediction,
  priced: readonly PricedOutcome[],
): Promise<string> {
  return prisma.$transaction(async (tx) => {
    // A model version produces exactly one current prediction per match; a
    // re-run replaces it rather than accumulating duplicates.
    await tx.prediction.deleteMany({ where: { matchId, modelVersionId } });

    const record = await tx.prediction.create({
      data: {
        matchId,
        modelVersionId,
        featuresVersion: prediction.featuresVersion,
        predictedAt: prediction.predictedAt,
        dataTimestamp: prediction.dataTimestamp,
        expectedHomeScore: prediction.expectedHomeScore ?? null,
        expectedAwayScore: prediction.expectedAwayScore ?? null,
        confidence: prediction.confidence.level as ConfidenceLevel,
        confidenceScore: prediction.confidence.score,
        dataQuality: prediction.dataQuality.score,
        explanation: {
          items: prediction.explanation,
          confidence: prediction.confidence.components,
          dataQuality: prediction.dataQuality.components,
          missing: prediction.dataQuality.missing,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    await tx.predictionOutcome.createMany({
      data: priced.map((outcome) => ({
        predictionId: record.id,
        market: outcome.market as Market,
        selection: outcome.selection,
        line: outcome.line,
        probability: outcome.probability,
        fairOdds: outcome.fairOdds,
        bookmaker: outcome.bookmaker,
        bookmakerOdds: outcome.bookmakerOdds,
        impliedProbability: outcome.impliedProbability,
        edge: outcome.edge,
        expectedValue: outcome.expectedValue,
        kellyStake: outcome.kellyStake,
      })),
    });

    await tx.predictionFeature.createMany({
      data: prediction.features.map((feature) => ({
        predictionId: record.id,
        name: feature.name,
        value: feature.value,
        contribution: feature.contribution ?? null,
        category: feature.category,
      })),
    });

    await tx.modelComponentOutcome.createMany({
      data: prediction.components.flatMap((component) =>
        component.outcomes
          // Only the headline market is shown in the agreement panel.
          .filter((outcome) => outcome.market === 'MATCH_WINNER')
          .map((outcome) => ({
            predictionId: record.id,
            component: component.component,
            market: outcome.market as Market,
            selection: outcome.selection,
            probability: outcome.probability,
            weight: component.weight,
          })),
      ),
    });

    return record.id;
  });
}

export interface GenerateBatchResult {
  readonly generated: number;
  readonly skipped: Array<{ matchId: string; reason: string }>;
}

/**
 * Generates predictions for every upcoming fixture in a window.
 *
 * Ratings and league baselines are computed once per league instead of once per
 * fixture, which is the difference between one query and several hundred.
 */
export async function generateUpcomingPredictions(options: {
  from?: Date;
  to?: Date;
  sportKey?: SportKey;
  asOf?: Date;
} = {}): Promise<GenerateBatchResult> {
  const now = options.asOf ?? new Date();
  const from = options.from ?? now;
  const to = options.to ?? new Date(now.getTime() + 14 * 86_400_000);

  const matches = await prisma.match.findMany({
    where: {
      status: 'SCHEDULED',
      kickoff: { gte: from, lte: to },
      ...(options.sportKey ? { sport: { key: options.sportKey } } : {}),
    },
    include: matchInclude,
    orderBy: { kickoff: 'asc' },
  });

  const skipped: Array<{ matchId: string; reason: string }> = [];
  let generated = 0;

  // Cache per league so ratings are replayed once, not once per fixture.
  const ratingCache = new Map<string, Awaited<ReturnType<typeof buildRatingsAsOf>>>();
  const baselineCache = new Map<string, Awaited<ReturnType<typeof buildLeagueBaseline>>>();

  for (const match of matches) {
    try {
      const sportKey = match.sport.key as SportKey;
      let ratings = ratingCache.get(match.leagueId);
      if (!ratings) {
        ratings = await buildRatingsAsOf(match.leagueId, now, sportKey);
        ratingCache.set(match.leagueId, ratings);
      }
      let baseline = baselineCache.get(match.leagueId);
      if (!baseline) {
        baseline = await buildLeagueBaseline(match.leagueId, now);
        baselineCache.set(match.leagueId, baseline);
      }

      const ctx = await buildMatchContext(match, { asOf: now, ratings, leagueBaseline: baseline });
      if (ctx.home.recentMatches.length === 0 && ctx.away.recentMatches.length === 0) {
        skipped.push({ matchId: match.id, reason: 'No completed matches for either side' });
        continue;
      }

      const modelVersion = await getActiveModelVersion(sportKey);
      const parameters = loadModelParameters(modelVersion, sportKey);
      const performance = await prisma.modelPerformance.findFirst({
        where: { modelVersionId: modelVersion.id, market: 'MATCH_WINNER', leagueKey: null, confidence: null },
        orderBy: { computedAt: 'desc' },
      });

      const prediction = predictMatch(ctx, {
        modelVersion: modelVersion.version,
        parameters,
        historicalBrier: performance?.brierScore,
        calibrationError: extractCalibrationError(performance?.calibration),
      });
      const priced = priceOutcomes(prediction, ctx);
      await persistPrediction(match.id, modelVersion.id, prediction, priced);
      generated += 1;
    } catch (error) {
      skipped.push({
        matchId: match.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { generated, skipped };
}

export { matchInclude, getSportModule };
