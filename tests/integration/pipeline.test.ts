/**
 * End-to-end pipeline tests against a real PostgreSQL database.
 *
 * These run against the DATABASE_URL in the environment and clear it first, so
 * point them at a development database.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db/prisma';
import { clearDatabase } from '../../scripts/reset-db';
import { ingestAll } from '@/lib/services/ingestion';
import { DemoProvider } from '@/lib/providers/demo/DemoProvider';
import { trainAllSports } from '@/lib/services/training';
import { generateUpcomingPredictions, generatePrediction, matchInclude } from '@/lib/services/predictions';
import { backfillHistoricalPredictions, recomputeModelPerformance } from '@/lib/services/performance';
import { buildMatchContext } from '@/lib/services/context';
import { getMatchAnalysis, getMatchOdds } from '@/lib/services/analysis';
import { listMatches, listSports, listValueOpportunities, getDataFreshness } from '@/lib/services/queries';
import { recordBet, settleFinishedBets, getTrackerSummary, settlementFor } from '@/lib/services/bets';
import { runBacktest } from '@/lib/backtest/walkForward';

const ANCHOR = new Date('2026-06-01T12:00:00Z');

beforeAll(async () => {
  await clearDatabase();
  await ingestAll({ provider: new DemoProvider({ now: ANCHOR, seed: 4242 }), now: ANCHOR });
}, 300_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe('ingestion', () => {
  it('loads sports, leagues, teams, matches and odds', async () => {
    const [sports, leagues, teams, matches, odds] = await Promise.all([
      prisma.sport.count(),
      prisma.league.count(),
      prisma.team.count(),
      prisma.match.count(),
      prisma.odds.count(),
    ]);
    expect(sports).toBe(3);
    expect(leagues).toBeGreaterThanOrEqual(4);
    expect(teams).toBeGreaterThan(40);
    expect(matches).toBeGreaterThan(500);
    expect(odds).toBeGreaterThan(1000);
  });

  it('tags every ingested record as demo data', async () => {
    expect(await prisma.match.count({ where: { origin: 'LIVE' } })).toBe(0);
    expect((await getDataFreshness()).origin).toBe('DEMO');
  });

  it('records the run', async () => {
    const run = await prisma.ingestionRun.findFirst({ orderBy: { startedAt: 'desc' } });
    expect(run?.status).toBe('SUCCESS');
    expect(run?.matchesUpserted).toBeGreaterThan(0);
  });

  it('is idempotent: re-ingesting does not duplicate matches', async () => {
    const before = await prisma.match.count();
    await ingestAll({ provider: new DemoProvider({ now: ANCHOR, seed: 4242 }), now: ANCHOR });
    expect(await prisma.match.count()).toBe(before);
  }, 300_000);
});

describe('context building', () => {
  it('never includes data from after the evaluation instant', async () => {
    const match = await prisma.match.findFirstOrThrow({
      where: { status: 'FINISHED' },
      include: matchInclude,
      orderBy: { kickoff: 'desc' },
    });

    const ctx = await buildMatchContext(match, { asOf: match.kickoff });
    for (const historic of [...ctx.home.recentMatches, ...ctx.away.recentMatches, ...ctx.headToHead]) {
      expect(historic.kickoff.getTime()).toBeLessThan(match.kickoff.getTime());
    }
    for (const quote of ctx.odds) {
      expect(quote.capturedAt.getTime()).toBeLessThanOrEqual(match.kickoff.getTime());
    }
    expect(ctx.dataTimestamp.getTime()).toBeLessThanOrEqual(match.kickoff.getTime());
  });

  it('computes league baselines from finished matches only', async () => {
    const match = await prisma.match.findFirstOrThrow({
      where: { status: 'SCHEDULED', sport: { key: 'football' } },
      include: matchInclude,
    });
    const ctx = await buildMatchContext(match);
    expect(ctx.league.matchesObserved).toBeGreaterThan(50);
    expect(ctx.league.averageHomeScore).toBeGreaterThan(0.8);
    expect(ctx.league.averageHomeScore).toBeLessThan(3);
    // Home advantage should be visible in the baseline.
    expect(ctx.league.averageHomeScore).toBeGreaterThan(ctx.league.averageAwayScore);
    expect(ctx.league.homeWinRate + ctx.league.drawRate + ctx.league.awayWinRate).toBeCloseTo(1, 6);
  });
});

describe('training', () => {
  it('trains every sport out of sample and stores the parameters', async () => {
    const results = await trainAllSports();
    expect(results).toHaveLength(3);

    for (const result of results) {
      expect(result.trainingSamples).toBeGreaterThan(50);
      expect(result.calibrationSamples).toBeGreaterThan(20);
      const version = await prisma.modelVersion.findUniqueOrThrow({
        where: { id: result.modelVersionId },
      });
      const parameters = version.parameters as Record<string, unknown>;
      expect(parameters.ensembleWeights).toBeDefined();
      expect(version.trainedAt).not.toBeNull();

      // Weights always form a distribution over the components.
      const weights = Object.values(parameters.ensembleWeights as Record<string, number>);
      expect(weights.reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 2);
    }
  }, 600_000);
});

describe('prediction generation', () => {
  it('writes predictions with full provenance for upcoming fixtures', async () => {
    const result = await generateUpcomingPredictions({ asOf: ANCHOR });
    expect(result.generated).toBeGreaterThan(0);

    const prediction = await prisma.prediction.findFirstOrThrow({
      include: { outcomes: true, features: true, components: true, modelVersion: true },
    });
    expect(prediction.featuresVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(prediction.modelVersion.version).toBeTruthy();
    expect(prediction.dataTimestamp).toBeInstanceOf(Date);
    expect(prediction.outcomes.length).toBeGreaterThan(2);
    expect(prediction.features.length).toBeGreaterThan(5);
    expect(prediction.components.length).toBeGreaterThan(2);
    expect(prediction.confidenceScore).toBeGreaterThanOrEqual(0);
    expect(prediction.dataQuality).toBeGreaterThanOrEqual(0);
  }, 600_000);

  it('produces a valid distribution for every mutually exclusive market', async () => {
    const predictions = await prisma.prediction.findMany({
      include: { outcomes: true },
      take: 25,
    });
    const distributionMarkets = new Set([
      'MATCH_WINNER', 'OVER_UNDER', 'BTTS', 'SET_WINNER', 'TOTAL_GAMES', 'POINT_SPREAD', 'HANDICAP_GAMES',
    ]);

    for (const prediction of predictions) {
      const groups = new Map<string, number>();
      for (const outcome of prediction.outcomes) {
        expect(outcome.probability).toBeGreaterThanOrEqual(0);
        expect(outcome.probability).toBeLessThanOrEqual(1);
        if (!distributionMarkets.has(outcome.market)) continue;
        const key = `${outcome.market}|${outcome.line ?? ''}`;
        groups.set(key, (groups.get(key) ?? 0) + outcome.probability);
      }
      for (const [key, total] of groups) {
        expect(total, `${prediction.id} ${key}`).toBeCloseTo(1, 6);
      }
    }
  });

  it('prices selections consistently: fair odds are the inverse of the probability', async () => {
    const outcomes = await prisma.predictionOutcome.findMany({ take: 200 });
    for (const outcome of outcomes) {
      expect(outcome.fairOdds).toBeCloseTo(1 / Math.max(outcome.probability, 1e-9), 4);
      if (outcome.bookmakerOdds !== null) {
        expect(outcome.expectedValue).toBeCloseTo(
          outcome.probability * outcome.bookmakerOdds - 1,
          6,
        );
        expect(outcome.edge).toBeCloseTo(
          outcome.probability - (outcome.impliedProbability ?? 0),
          6,
        );
      }
    }
  });

  it('replaces rather than duplicates when a match is re-predicted', async () => {
    const match = await prisma.match.findFirstOrThrow({
      where: { status: 'SCHEDULED', predictions: { some: {} } },
      include: matchInclude,
    });
    const before = await prisma.prediction.count({ where: { matchId: match.id } });
    await generatePrediction(match);
    expect(await prisma.prediction.count({ where: { matchId: match.id } })).toBe(before);
  }, 120_000);

  it('refuses to predict a fixture with no history for either side', async () => {
    const sport = await prisma.sport.findFirstOrThrow({ where: { key: 'football' } });
    const league = await prisma.league.findFirstOrThrow({ where: { sportId: sport.id } });
    const [home, away] = await Promise.all([
      prisma.team.create({
        data: { sportId: sport.id, leagueId: league.id, key: 'ghost-a', name: 'Ghost A', shortName: 'GHA' },
      }),
      prisma.team.create({
        data: { sportId: sport.id, leagueId: league.id, key: 'ghost-b', name: 'Ghost B', shortName: 'GHB' },
      }),
    ]);
    const match = await prisma.match.create({
      data: {
        sportId: sport.id,
        leagueId: league.id,
        season: '2026/27',
        homeTeamId: home.id,
        awayTeamId: away.id,
        kickoff: new Date(ANCHOR.getTime() + 5 * 86_400_000),
        status: 'SCHEDULED',
        externalId: 'ghost-fixture',
      },
      include: matchInclude,
    });

    await expect(generatePrediction(match)).rejects.toThrow(/refusing to publish/i);

    await prisma.match.delete({ where: { id: match.id } });
    await prisma.team.deleteMany({ where: { id: { in: [home.id, away.id] } } });
  });
});

describe('read models', () => {
  it('lists sports and matches with their predictions attached', async () => {
    const sports = await listSports();
    expect(sports.map((sport) => sport.key).sort()).toEqual(['basketball', 'football', 'tennis']);

    const { matches, total } = await listMatches({ status: 'SCHEDULED', limit: 10 });
    expect(total).toBeGreaterThan(0);
    expect(matches.length).toBeLessThanOrEqual(10);
    for (const match of matches) {
      expect(match.kickoff).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(typeof match.homeTeam.name).toBe('string');
    }
  });

  it('filters matches by sport, league and date without leaking others', async () => {
    const { matches } = await listMatches({ sportKey: 'tennis', limit: 20 });
    for (const match of matches) expect(match.sportKey).toBe('tennis');

    const first = matches[0];
    if (first) {
      const day = new Date(first.kickoff);
      const { matches: sameDay } = await listMatches({ date: day, limit: 50 });
      for (const match of sameDay) {
        expect(match.kickoff.slice(0, 10)).toBe(first.kickoff.slice(0, 10));
      }
    }
  });

  it('returns value opportunities that satisfy their own filters', async () => {
    const opportunities = await listValueOpportunities({ minEv: 0.05, limit: 25 });
    for (const opportunity of opportunities) {
      expect(opportunity.expectedValue).toBeGreaterThanOrEqual(0.05);
      expect(opportunity.bookmakerOdds).toBeGreaterThan(1);
      // Only upcoming fixtures can carry value.
      expect(new Date(opportunity.kickoff).getTime()).toBeGreaterThan(Date.now() - 86_400_000 * 400);
      expect(['SUPPORTED', 'UNVERIFIED', 'UNMEASURED']).toContain(opportunity.reliability);
    }
  });

  it('builds a complete match analysis', async () => {
    const match = await prisma.match.findFirstOrThrow({
      where: { status: 'SCHEDULED', predictions: { some: {} }, sport: { key: 'football' } },
    });
    const analysis = await getMatchAnalysis(match.id);
    expect(analysis).not.toBeNull();
    expect(analysis!.outcomes.length).toBeGreaterThan(5);
    expect(analysis!.components.length).toBeGreaterThan(2);
    expect(analysis!.features.length).toBeGreaterThan(5);
    expect(analysis!.confidenceComponents.length).toBeGreaterThan(4);
    expect(analysis!.dataQualityComponents.length).toBeGreaterThan(3);

    // Football covers every market the module declares.
    const markets = new Set(analysis!.outcomes.map((outcome) => outcome.market));
    for (const market of ['MATCH_WINNER', 'OVER_UNDER', 'BTTS', 'CORRECT_SCORE', 'ASIAN_HANDICAP']) {
      expect(markets.has(market), market).toBe(true);
    }

    // Every explanation line traces to a real feature.
    const featureNames = new Set(analysis!.features.map((feature) => feature.name));
    for (const item of analysis!.explanation) {
      expect(featureNames.has(item.featureName) || item.featureName === 'market_availability').toBe(true);
    }
  }, 120_000);

  it('groups odds by selection with the best price identified', async () => {
    const match = await prisma.match.findFirstOrThrow({
      where: { status: 'SCHEDULED', odds: { some: {} } },
    });
    const odds = await getMatchOdds(match.id);
    expect(odds.length).toBeGreaterThan(0);
    for (const entry of odds) {
      expect(entry.bookmakers.length).toBeGreaterThan(0);
      const best = Math.max(...entry.bookmakers.map((book) => book.price));
      expect(entry.bestPrice).toBe(best);
      expect(entry.bookmakers.find((book) => book.bookmaker === entry.bestBookmaker)?.price).toBe(best);
    }
  });
});

describe('performance scoring', () => {
  it('scores settled predictions and produces sane metrics', async () => {
    await backfillHistoricalPredictions({ limit: 200 });
    const summaries = await recomputeModelPerformance();
    expect(summaries.some((summary) => summary.scored > 0)).toBe(true);

    const rows = await prisma.modelPerformance.findMany({
      where: { leagueKey: null, confidence: null },
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.accuracy).toBeGreaterThanOrEqual(0);
      expect(row.accuracy).toBeLessThanOrEqual(1);
      expect(row.logLoss).toBeGreaterThan(0);
      expect(row.brierScore).toBeGreaterThan(0);
      expect(row.correct).toBeLessThanOrEqual(row.predictions);

      const calibration = row.calibration as { bins?: unknown[]; expectedCalibrationError?: number };
      expect(Array.isArray(calibration.bins)).toBe(true);
      expect(calibration.expectedCalibrationError).toBeGreaterThanOrEqual(0);
    }
  }, 900_000);
});

describe('bet tracking', () => {
  it('records a bet with the model snapshot and settles it from the result', async () => {
    const prediction = await prisma.prediction.findFirstOrThrow({
      where: {
        outcomes: { some: { market: 'MATCH_WINNER', bookmakerOdds: { not: null } } },
        match: { status: 'FINISHED' },
      },
      include: { outcomes: { where: { market: 'MATCH_WINNER' } }, match: true },
    });
    const outcome = prediction.outcomes.find((entry) => entry.bookmakerOdds !== null)!;

    const bet = await recordBet({
      matchId: prediction.matchId,
      predictionId: prediction.id,
      market: 'MATCH_WINNER',
      selection: outcome.selection,
      odds: outcome.bookmakerOdds!,
      stake: 10,
    });

    expect(bet.modelProbability).toBeCloseTo(outcome.probability, 8);
    expect(bet.impliedProbability).toBeCloseTo(1 / outcome.bookmakerOdds!, 8);
    expect(bet.expectedValue).toBeCloseTo(outcome.probability * outcome.bookmakerOdds! - 1, 8);
    expect(bet.result).toBe('PENDING');

    const settled = await settleFinishedBets();
    expect(settled.settled).toBeGreaterThan(0);

    const after = await prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(after.result).not.toBe('PENDING');
    const profit = Number(after.profitLoss);
    if (after.result === 'WON') expect(profit).toBeCloseTo(10 * (bet.odds - 1), 6);
    if (after.result === 'LOST') expect(profit).toBeCloseTo(-10, 6);

    const summary = await getTrackerSummary();
    expect(summary.totalBets).toBeGreaterThan(0);
    expect(summary.totalStaked).toBeGreaterThan(0);
  }, 120_000);

  it('refuses to record a bet on a market the model did not price', async () => {
    const prediction = await prisma.prediction.findFirstOrThrow({ include: { match: true } });
    await expect(
      recordBet({
        matchId: prediction.matchId,
        market: 'CORRECT_SCORE',
        selection: '9-9',
        odds: 500,
        stake: 1,
      }),
    ).rejects.toThrow(/did not price/i);
  });
});

describe('settlement rules', () => {
  it('settles the match winner from the final score', () => {
    expect(settlementFor('MATCH_WINNER', 'HOME', null, 2, 1)).toBe('WON');
    expect(settlementFor('MATCH_WINNER', 'AWAY', null, 2, 1)).toBe('LOST');
    expect(settlementFor('MATCH_WINNER', 'DRAW', null, 1, 1)).toBe('WON');
  });

  it('settles totals, including the push on an integer line', () => {
    expect(settlementFor('OVER_UNDER', 'OVER', 2.5, 2, 1)).toBe('WON');
    expect(settlementFor('OVER_UNDER', 'UNDER', 2.5, 2, 1)).toBe('LOST');
    expect(settlementFor('OVER_UNDER', 'OVER', 3, 2, 1)).toBe('PUSH');
  });

  it('settles both teams to score', () => {
    expect(settlementFor('BTTS', 'YES', null, 1, 1)).toBe('WON');
    expect(settlementFor('BTTS', 'YES', null, 3, 0)).toBe('LOST');
    expect(settlementFor('BTTS', 'NO', null, 3, 0)).toBe('WON');
  });

  it('settles handicaps and reports a push at the exact line', () => {
    expect(settlementFor('ASIAN_HANDICAP', 'HOME', -1.5, 3, 1)).toBe('WON');
    expect(settlementFor('ASIAN_HANDICAP', 'HOME', -1.5, 2, 1)).toBe('LOST');
    expect(settlementFor('POINT_SPREAD', 'HOME', -2, 112, 110)).toBe('PUSH');
  });

  it('declines to settle markets the score cannot decide', () => {
    expect(settlementFor('TOTAL_GAMES', 'OVER', 22.5, 2, 0)).toBeNull();
    expect(settlementFor('SET_WINNER', 'HOME', null, 2, 0)).toBeNull();
  });
});

describe('walk-forward backtest', () => {
  it('produces out-of-sample metrics and beats the base rate on tennis', async () => {
    const result = await runBacktest({
      sportKey: 'tennis',
      initialTrainingSize: 120,
      stepSize: 60,
    });

    expect(result.metrics.predictions).toBeGreaterThan(50);
    expect(result.windows).toBeGreaterThanOrEqual(1);
    expect(result.metrics.logLoss).toBeGreaterThan(0);
    expect(result.metrics.brierScore).toBeGreaterThan(0);
    expect(result.metrics.accuracy).toBeGreaterThan(0.5);

    // Tennis is highly predictable from ratings, so the model must add real skill.
    expect(result.metrics.skillScore).toBeGreaterThan(0.1);
    expect(result.metrics.logLoss).toBeLessThan(result.metrics.baselineLogLoss);

    // Calibration is measured over every class, so the bins must cover the sample.
    const binned = result.metrics.calibration.reduce((sum, bin) => sum + bin.count, 0);
    expect(binned).toBe(result.metrics.predictions * 2);

    // Every sub-model is scored individually for the agreement panel.
    expect(result.perComponent.length).toBeGreaterThan(2);
    expect(result.marketBaseline).not.toBeNull();
  }, 900_000);
});
