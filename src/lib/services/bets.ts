/**
 * Bet / prediction tracking.
 *
 * An analytics ledger rather than a betting product: it records what the model
 * said, what price was taken, and what happened, so the user can check whether
 * the model's claimed edge showed up in practice.
 */

import { Prisma, type BetResult, type Market, type StakingMethod } from '@prisma/client';
import { prisma } from '../db/prisma';
import { impliedProbability } from '../odds';
import { badRequest, notFound } from '../errors';

export const DEMO_USER_EMAIL = 'demo@better.local';

/** The single local tracking account. Created on first use. */
export async function getTrackingUser() {
  return prisma.user.upsert({
    where: { email: DEMO_USER_EMAIL },
    update: {},
    create: { email: DEMO_USER_EMAIL, displayName: 'Demo Analyst', bankroll: 1000 },
  });
}

export interface RecordBetInput {
  readonly matchId: string;
  readonly predictionId?: string;
  readonly market: string;
  readonly selection: string;
  readonly line?: number;
  readonly odds: number;
  readonly stake: number;
  readonly stakingMethod?: string;
  readonly notes?: string;
}

export interface BetDto {
  readonly id: string;
  readonly matchId: string;
  readonly kickoff: string;
  readonly sportKey: string;
  readonly leagueName: string;
  readonly homeTeam: string;
  readonly awayTeam: string;
  readonly market: string;
  readonly selection: string;
  readonly line: number | null;
  readonly odds: number;
  readonly stake: number;
  readonly stakingMethod: string;
  readonly modelProbability: number;
  readonly impliedProbability: number;
  readonly edge: number;
  readonly expectedValue: number;
  readonly modelVersion: string;
  readonly result: string;
  readonly profitLoss: number | null;
  readonly placedAt: string;
  readonly settledAt: string | null;
  readonly notes: string | null;
}

/**
 * Records a bet, snapshotting the model's view at the moment it was placed.
 *
 * The model probability, edge and version are copied onto the row rather than
 * looked up later: the model will be retrained, and a tracker that silently
 * rewrites history cannot be used to evaluate anything.
 */
export async function recordBet(input: RecordBetInput): Promise<BetDto> {
  const user = await getTrackingUser();
  const match = await prisma.match.findUnique({ where: { id: input.matchId } });
  if (!match) throw notFound(`No match with id ${input.matchId}`);

  const prediction = input.predictionId
    ? await prisma.prediction.findUnique({
        where: { id: input.predictionId },
        include: { outcomes: true, modelVersion: true },
      })
    : await prisma.prediction.findFirst({
        where: { matchId: input.matchId },
        include: { outcomes: true, modelVersion: true },
        orderBy: { predictedAt: 'desc' },
      });

  if (!prediction) {
    throw badRequest(
      'No prediction exists for this match yet, so there is no model probability to record against the bet.',
    );
  }

  const outcome = prediction.outcomes.find(
    (candidate) =>
      candidate.market === input.market &&
      candidate.selection === input.selection &&
      (input.line === undefined ? candidate.line === null : candidate.line === input.line),
  );
  if (!outcome) {
    throw badRequest(
      `The model did not price ${input.market} / ${input.selection}${input.line !== undefined ? ` @ ${input.line}` : ''} for this match.`,
    );
  }

  const implied = impliedProbability(input.odds);
  const bet = await prisma.bet.create({
    data: {
      userId: user.id,
      matchId: input.matchId,
      predictionId: prediction.id,
      market: input.market as Market,
      selection: input.selection,
      line: input.line ?? null,
      odds: input.odds,
      stake: new Prisma.Decimal(input.stake),
      stakingMethod: (input.stakingMethod ?? 'FLAT') as StakingMethod,
      modelProbability: outcome.probability,
      impliedProbability: implied,
      edge: outcome.probability - implied,
      expectedValue: outcome.probability * input.odds - 1,
      modelVersion: prediction.modelVersion.version,
      notes: input.notes ?? null,
    },
  });

  return (await getBet(bet.id)) as BetDto;
}

const betInclude = {
  match: {
    include: {
      league: { select: { name: true } },
      sport: { select: { key: true } },
      homeTeam: { select: { name: true } },
      awayTeam: { select: { name: true } },
    },
  },
} satisfies Prisma.BetInclude;

type BetRow = Prisma.BetGetPayload<{ include: typeof betInclude }>;

function toBetDto(bet: BetRow): BetDto {
  return {
    id: bet.id,
    matchId: bet.matchId,
    kickoff: bet.match.kickoff.toISOString(),
    sportKey: bet.match.sport.key,
    leagueName: bet.match.league.name,
    homeTeam: bet.match.homeTeam.name,
    awayTeam: bet.match.awayTeam.name,
    market: bet.market,
    selection: bet.selection,
    line: bet.line,
    odds: bet.odds,
    stake: Number(bet.stake),
    stakingMethod: bet.stakingMethod,
    modelProbability: bet.modelProbability,
    impliedProbability: bet.impliedProbability,
    edge: bet.edge,
    expectedValue: bet.expectedValue,
    modelVersion: bet.modelVersion,
    result: bet.result,
    profitLoss: bet.profitLoss === null ? null : Number(bet.profitLoss),
    placedAt: bet.placedAt.toISOString(),
    settledAt: bet.settledAt?.toISOString() ?? null,
    notes: bet.notes,
  };
}

export async function getBet(id: string): Promise<BetDto | null> {
  const bet = await prisma.bet.findUnique({ where: { id }, include: betInclude });
  return bet ? toBetDto(bet) : null;
}

export async function listBets(options: { result?: string; limit?: number } = {}): Promise<BetDto[]> {
  const bets = await prisma.bet.findMany({
    where: options.result ? { result: options.result as BetResult } : {},
    include: betInclude,
    orderBy: { placedAt: 'desc' },
    take: options.limit ?? 100,
  });
  return bets.map(toBetDto);
}

/** Settles a bet and computes profit or loss from the stake and price. */
export async function settleBet(id: string, result: BetResult): Promise<BetDto> {
  const bet = await prisma.bet.findUnique({ where: { id } });
  if (!bet) throw notFound(`No bet with id ${id}`);

  const stake = Number(bet.stake);
  // A push or void returns the stake, so the P/L is zero rather than negative.
  const profitLoss =
    result === 'WON' ? stake * (bet.odds - 1) : result === 'LOST' ? -stake : 0;

  await prisma.bet.update({
    where: { id },
    data: { result, profitLoss: new Prisma.Decimal(profitLoss), settledAt: new Date() },
  });
  return (await getBet(id)) as BetDto;
}

/**
 * Settles every pending bet whose match has finished.
 *
 * Only markets whose settlement rules are unambiguous from the final score are
 * settled automatically; anything else is left pending for the user rather than
 * guessed at.
 */
export async function settleFinishedBets(): Promise<{ settled: number; skipped: number }> {
  const pending = await prisma.bet.findMany({
    where: { result: 'PENDING', match: { status: 'FINISHED', homeScore: { not: null } } },
    include: { match: true },
  });

  let settled = 0;
  let skipped = 0;
  for (const bet of pending) {
    const { homeScore, awayScore } = bet.match;
    if (homeScore === null || awayScore === null) {
      skipped += 1;
      continue;
    }
    const result = settlementFor(bet.market, bet.selection, bet.line, homeScore, awayScore);
    if (result === null) {
      skipped += 1;
      continue;
    }
    await settleBet(bet.id, result);
    settled += 1;
  }
  return { settled, skipped };
}

/** Returns null when the market cannot be settled from the final score alone. */
export function settlementFor(
  market: string,
  selection: string,
  line: number | null,
  homeScore: number,
  awayScore: number,
): BetResult | null {
  const total = homeScore + awayScore;
  const margin = homeScore - awayScore;

  switch (market) {
    case 'MATCH_WINNER': {
      const winner = margin > 0 ? 'HOME' : margin < 0 ? 'AWAY' : 'DRAW';
      return selection === winner ? 'WON' : 'LOST';
    }
    case 'OVER_UNDER': {
      if (line === null) return null;
      if (total === line) return 'PUSH';
      const isOver = total > line;
      return (selection === 'OVER') === isOver ? 'WON' : 'LOST';
    }
    case 'BTTS': {
      const both = homeScore > 0 && awayScore > 0;
      return (selection === 'YES') === both ? 'WON' : 'LOST';
    }
    case 'CORRECT_SCORE':
      return selection === `${homeScore}-${awayScore}` ? 'WON' : 'LOST';
    case 'ASIAN_HANDICAP':
    case 'POINT_SPREAD': {
      if (line === null) return null;
      const adjusted = selection === 'HOME' ? margin + line : -margin + line;
      if (Math.abs(adjusted) < 1e-9) return 'PUSH';
      return adjusted > 0 ? 'WON' : 'LOST';
    }
    default:
      // Set winner, total games and games handicap need the set/game detail,
      // which the score columns alone do not carry.
      return null;
  }
}

export interface TrackerSummary {
  readonly totalBets: number;
  readonly pending: number;
  readonly wins: number;
  readonly losses: number;
  readonly pushes: number;
  readonly winRate: number;
  readonly totalStaked: number;
  readonly profitLoss: number;
  readonly roi: number;
  readonly averageOdds: number;
  readonly averageEdge: number;
  readonly bankroll: number;
  readonly equityCurve: ReadonlyArray<{ date: string; profit: number; bankroll: number }>;
}

/** Portfolio metrics for the tracker dashboard. */
export async function getTrackerSummary(): Promise<TrackerSummary> {
  const user = await getTrackingUser();
  const bets = await prisma.bet.findMany({
    where: { userId: user.id },
    orderBy: { placedAt: 'asc' },
  });

  const settled = bets.filter((bet) => bet.result !== 'PENDING' && bet.result !== 'VOID');
  const wins = settled.filter((bet) => bet.result === 'WON').length;
  const losses = settled.filter((bet) => bet.result === 'LOST').length;
  const pushes = settled.filter((bet) => bet.result === 'PUSH').length;
  const totalStaked = settled.reduce((sum, bet) => sum + Number(bet.stake), 0);
  const profitLoss = settled.reduce((sum, bet) => sum + Number(bet.profitLoss ?? 0), 0);

  const startingBankroll = Number(user.bankroll);
  let running = startingBankroll;
  const equityCurve = settled.map((bet) => {
    running += Number(bet.profitLoss ?? 0);
    return {
      date: (bet.settledAt ?? bet.placedAt).toISOString().slice(0, 10),
      profit: Number((running - startingBankroll).toFixed(2)),
      bankroll: Number(running.toFixed(2)),
    };
  });

  // Win rate excludes pushes: a returned stake is neither a win nor a loss.
  const decided = wins + losses;
  return {
    totalBets: bets.length,
    pending: bets.filter((bet) => bet.result === 'PENDING').length,
    wins,
    losses,
    pushes,
    winRate: decided > 0 ? wins / decided : 0,
    totalStaked,
    profitLoss,
    roi: totalStaked > 0 ? profitLoss / totalStaked : 0,
    averageOdds: bets.length > 0 ? bets.reduce((sum, bet) => sum + bet.odds, 0) / bets.length : 0,
    averageEdge: bets.length > 0 ? bets.reduce((sum, bet) => sum + bet.edge, 0) / bets.length : 0,
    bankroll: running,
    equityCurve,
  };
}
