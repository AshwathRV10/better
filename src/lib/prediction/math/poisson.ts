import { clamp } from './stats';

/** Largest goal/point total kept in a score matrix before truncation. */
export const DEFAULT_MAX_GOALS = 12;

/** Poisson probability mass function: P(X = k | lambda). */
export function poissonPmf(k: number, lambda: number): number {
  if (k < 0 || !Number.isInteger(k)) return 0;
  if (lambda <= 0) return k === 0 ? 1 : 0;
  // Computed in log space so large k does not overflow the factorial.
  const logP = -lambda + k * Math.log(lambda) - logFactorial(k);
  return Math.exp(logP);
}

/** P(X <= k | lambda). */
export function poissonCdf(k: number, lambda: number): number {
  let sum = 0;
  for (let i = 0; i <= Math.floor(k); i += 1) sum += poissonPmf(i, lambda);
  return clamp(sum, 0, 1);
}

const LOG_FACTORIAL_CACHE: number[] = [0, 0];

export function logFactorial(n: number): number {
  if (n < 0) return Number.NaN;
  const idx = Math.floor(n);
  if (LOG_FACTORIAL_CACHE[idx] !== undefined) return LOG_FACTORIAL_CACHE[idx];
  let value = LOG_FACTORIAL_CACHE[LOG_FACTORIAL_CACHE.length - 1];
  for (let i = LOG_FACTORIAL_CACHE.length; i <= idx; i += 1) {
    value += Math.log(i);
    LOG_FACTORIAL_CACHE[i] = value;
  }
  return LOG_FACTORIAL_CACHE[idx];
}

export interface ScoreMatrix {
  /** matrix[h][a] = P(home scores h AND away scores a). */
  readonly matrix: readonly (readonly number[])[];
  readonly maxGoals: number;
  readonly lambdaHome: number;
  readonly lambdaAway: number;
}

/**
 * Dixon-Coles low-score correction.
 *
 * Independent Poisson marginals under-predict 0-0 and 1-1 and over-predict 1-0
 * and 0-1. `rho` shifts mass back; rho = 0 recovers the independent model.
 * Only the four low-score cells are adjusted, per Dixon & Coles (1997).
 */
export function dixonColesTau(
  homeGoals: number,
  awayGoals: number,
  lambdaHome: number,
  lambdaAway: number,
  rho: number,
): number {
  if (homeGoals === 0 && awayGoals === 0) return 1 - lambdaHome * lambdaAway * rho;
  if (homeGoals === 0 && awayGoals === 1) return 1 + lambdaHome * rho;
  if (homeGoals === 1 && awayGoals === 0) return 1 + lambdaAway * rho;
  if (homeGoals === 1 && awayGoals === 1) return 1 - rho;
  return 1;
}

/**
 * Builds the joint distribution over exact scores from the two expected-goal
 * rates. The matrix is renormalised after truncation and after the low-score
 * correction so it always sums to exactly 1.
 */
export function buildScoreMatrix(
  lambdaHome: number,
  lambdaAway: number,
  options: { maxGoals?: number; rho?: number } = {},
): ScoreMatrix {
  const maxGoals = options.maxGoals ?? DEFAULT_MAX_GOALS;
  const rho = options.rho ?? 0;
  const lh = Math.max(lambdaHome, 1e-6);
  const la = Math.max(lambdaAway, 1e-6);

  const homePmf = Array.from({ length: maxGoals + 1 }, (_, h) => poissonPmf(h, lh));
  const awayPmf = Array.from({ length: maxGoals + 1 }, (_, a) => poissonPmf(a, la));

  const matrix: number[][] = [];
  let total = 0;
  for (let h = 0; h <= maxGoals; h += 1) {
    const row: number[] = [];
    for (let a = 0; a <= maxGoals; a += 1) {
      // tau can go slightly negative for extreme rho; clamp to keep a valid pmf.
      const tau = Math.max(dixonColesTau(h, a, lh, la, rho), 0);
      const p = homePmf[h] * awayPmf[a] * tau;
      row.push(p);
      total += p;
    }
    matrix.push(row);
  }

  if (total > 0) {
    for (let h = 0; h <= maxGoals; h += 1) {
      for (let a = 0; a <= maxGoals; a += 1) matrix[h][a] /= total;
    }
  }

  return { matrix, maxGoals, lambdaHome: lh, lambdaAway: la };
}

export interface OutcomeProbabilities {
  readonly home: number;
  readonly draw: number;
  readonly away: number;
}

export function outcomeProbabilities(sm: ScoreMatrix): OutcomeProbabilities {
  let home = 0;
  let draw = 0;
  let away = 0;
  for (let h = 0; h <= sm.maxGoals; h += 1) {
    for (let a = 0; a <= sm.maxGoals; a += 1) {
      const p = sm.matrix[h][a];
      if (h > a) home += p;
      else if (h === a) draw += p;
      else away += p;
    }
  }
  return { home, draw, away };
}

/** P(total goals > line). Lines are half-integers, so no push case arises. */
export function overProbability(sm: ScoreMatrix, line: number): number {
  let over = 0;
  for (let h = 0; h <= sm.maxGoals; h += 1) {
    for (let a = 0; a <= sm.maxGoals; a += 1) {
      if (h + a > line) over += sm.matrix[h][a];
    }
  }
  return over;
}

/** P(both teams score at least one). */
export function bttsProbability(sm: ScoreMatrix): number {
  let yes = 0;
  for (let h = 1; h <= sm.maxGoals; h += 1) {
    for (let a = 1; a <= sm.maxGoals; a += 1) yes += sm.matrix[h][a];
  }
  return yes;
}

export interface CorrectScore {
  readonly home: number;
  readonly away: number;
  readonly probability: number;
}

export function topCorrectScores(sm: ScoreMatrix, limit = 8): CorrectScore[] {
  const scores: CorrectScore[] = [];
  for (let h = 0; h <= sm.maxGoals; h += 1) {
    for (let a = 0; a <= sm.maxGoals; a += 1) {
      scores.push({ home: h, away: a, probability: sm.matrix[h][a] });
    }
  }
  scores.sort((x, y) => y.probability - x.probability);
  return scores.slice(0, limit);
}

/**
 * Asian handicap applied to the home side. Positive `line` gives the home team a
 * head start. Returns win/push/loss probabilities for backing the home team.
 */
export function asianHandicapProbabilities(
  sm: ScoreMatrix,
  line: number,
): { win: number; push: number; loss: number } {
  let win = 0;
  let push = 0;
  let loss = 0;
  for (let h = 0; h <= sm.maxGoals; h += 1) {
    for (let a = 0; a <= sm.maxGoals; a += 1) {
      const margin = h + line - a;
      const p = sm.matrix[h][a];
      if (margin > 1e-9) win += p;
      else if (Math.abs(margin) <= 1e-9) push += p;
      else loss += p;
    }
  }
  return { win, push, loss };
}
