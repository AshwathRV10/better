/**
 * Odds, margin and expected-value calculations.
 *
 * All prices are decimal odds. Every function here is pure and independently
 * unit-tested against hand-worked examples.
 */

import { clamp, normalise } from '../prediction/math/stats';

export const MIN_DECIMAL_ODDS = 1.0000001;

export function isValidDecimalOdds(price: unknown): price is number {
  return typeof price === 'number' && Number.isFinite(price) && price > 1;
}

/**
 * Raw implied probability of a decimal price: 1 / odds.
 *
 * This includes the bookmaker's margin, so a full market's raw probabilities
 * sum to more than 1. Use `removeMargin` for a fair comparison against model
 * probabilities.
 */
export function impliedProbability(decimalOdds: number): number {
  if (!isValidDecimalOdds(decimalOdds)) {
    throw new RangeError(`Decimal odds must be a finite number > 1, received ${decimalOdds}`);
  }
  return 1 / decimalOdds;
}

/** Break-even decimal price for a probability. */
export function fairOdds(probability: number): number {
  const p = clamp(probability, 1e-9, 1);
  return 1 / p;
}

/**
 * Bookmaker overround (vig) of a complete market.
 * A 1.90 / 1.90 two-way market returns ≈ 0.0526 (5.26%).
 */
export function overround(prices: readonly number[]): number {
  const total = prices.reduce((sum, price) => sum + impliedProbability(price), 0);
  return total - 1;
}

export type MarginMethod = 'multiplicative' | 'shin' | 'additive';

/**
 * Strips the bookmaker margin from a complete market's prices.
 *
 *  - `multiplicative` divides every raw probability by the booksum. Simple, but
 *    it assumes the margin is spread proportionally, which overstates the
 *    favourite's true chance.
 *  - `additive` removes an equal share of the margin from every selection.
 *  - `shin` solves Shin's (1993) insider-trading model, which takes more margin
 *    from longshots and is the closest of the three to observed closing lines.
 */
export function removeMargin(
  prices: readonly number[],
  method: MarginMethod = 'shin',
): number[] {
  if (prices.length === 0) return [];
  const raw = prices.map(impliedProbability);
  if (prices.length === 1) return raw;

  switch (method) {
    case 'multiplicative':
      return normalise(raw);
    case 'additive': {
      const excess = raw.reduce((s, p) => s + p, 0) - 1;
      const share = excess / raw.length;
      return normalise(raw.map((p) => p - share));
    }
    case 'shin':
      return shinProbabilities(raw);
    default:
      return normalise(raw);
  }
}

/**
 * Shin's method. Solves for z (the implied share of insider money) such that
 * the recovered probabilities sum to 1, then inverts the model.
 *
 *   p_i = ( sqrt(z^2 + 4(1-z) * pi_i^2 / booksum) - z ) / (2(1-z))
 *
 * Solved by bisection on z in [0, 1); falls back to proportional scaling when
 * the market has no margin to remove.
 */
export function shinProbabilities(rawProbabilities: readonly number[]): number[] {
  const booksum = rawProbabilities.reduce((s, p) => s + p, 0);
  if (booksum <= 1 + 1e-9) return normalise(rawProbabilities);

  const recover = (z: number): number[] => {
    const denom = 2 * (1 - z);
    return rawProbabilities.map((pi) => {
      const inner = z * z + (4 * (1 - z) * pi * pi) / booksum;
      return (Math.sqrt(Math.max(inner, 0)) - z) / denom;
    });
  };

  let lo = 0;
  let hi = 0.5;
  for (let i = 0; i < 80; i += 1) {
    const mid = (lo + hi) / 2;
    const sum = recover(mid).reduce((s, p) => s + p, 0);
    if (sum > 1) lo = mid;
    else hi = mid;
  }
  return normalise(recover((lo + hi) / 2));
}

/**
 * Expected value per unit staked: EV = (p * odds) - 1.
 *
 * A model probability of 0.60 at 2.00 gives +0.20, i.e. +20% expected return on
 * turnover *if the model probability is correct*. It is an estimate, not a
 * guarantee.
 */
export function expectedValue(modelProbability: number, decimalOdds: number): number {
  if (!isValidDecimalOdds(decimalOdds)) {
    throw new RangeError(`Decimal odds must be a finite number > 1, received ${decimalOdds}`);
  }
  const p = clamp(modelProbability, 0, 1);
  return p * decimalOdds - 1;
}

/** Model probability minus the margin-adjusted bookmaker probability. */
export function edge(modelProbability: number, marginFreeProbability: number): number {
  return clamp(modelProbability, 0, 1) - clamp(marginFreeProbability, 0, 1);
}

export interface KellyOptions {
  /** Fraction of full Kelly to stake. 0.25 is a common conservative setting. */
  readonly fraction?: number;
  /** Hard cap as a share of bankroll, applied after the fractional scaling. */
  readonly maxStakeFraction?: number;
}

export const DEFAULT_KELLY_FRACTION = 0.25;
export const DEFAULT_MAX_STAKE_FRACTION = 0.02;

/**
 * Fractional Kelly stake as a share of bankroll.
 *
 *   f* = (p * b - q) / b,  where b = odds - 1 and q = 1 - p
 *
 * Returns 0 when the bet has no edge. Full Kelly maximises long-run log growth
 * but is far too aggressive when probabilities are estimated rather than known,
 * so this defaults to quarter-Kelly with a 2% bankroll cap.
 */
export function kellyStake(
  modelProbability: number,
  decimalOdds: number,
  options: KellyOptions = {},
): number {
  if (!isValidDecimalOdds(decimalOdds)) return 0;
  const fraction = options.fraction ?? DEFAULT_KELLY_FRACTION;
  const cap = options.maxStakeFraction ?? DEFAULT_MAX_STAKE_FRACTION;
  const p = clamp(modelProbability, 0, 1);
  const b = decimalOdds - 1;
  const q = 1 - p;
  const full = (p * b - q) / b;
  if (full <= 0) return 0;
  return clamp(full * fraction, 0, cap);
}

export interface ValueAssessment {
  readonly modelProbability: number;
  readonly bookmakerOdds: number;
  readonly rawImpliedProbability: number;
  readonly impliedProbability: number;
  readonly edge: number;
  readonly expectedValue: number;
  readonly fairOdds: number;
  readonly kellyStake: number;
  readonly overround: number | null;
}

/**
 * Full value assessment for one selection.
 *
 * `marketPrices` should contain every price in the same market so the margin can
 * be removed. When it is omitted the raw implied probability is used and the
 * reported edge is conservative (it understates the model's advantage).
 */
export function assessValue(
  modelProbability: number,
  bookmakerOdds: number,
  marketPrices?: readonly number[],
  options: KellyOptions & { marginMethod?: MarginMethod } = {},
): ValueAssessment {
  const raw = impliedProbability(bookmakerOdds);
  let adjusted = raw;
  let book: number | null = null;

  if (marketPrices && marketPrices.length > 1) {
    const index = marketPrices.findIndex((price) => Math.abs(price - bookmakerOdds) < 1e-9);
    const fair = removeMargin(marketPrices, options.marginMethod ?? 'shin');
    if (index >= 0) adjusted = fair[index];
    book = overround(marketPrices);
  }

  return {
    modelProbability,
    bookmakerOdds,
    rawImpliedProbability: raw,
    impliedProbability: adjusted,
    edge: edge(modelProbability, adjusted),
    expectedValue: expectedValue(modelProbability, bookmakerOdds),
    fairOdds: fairOdds(modelProbability),
    kellyStake: kellyStake(modelProbability, bookmakerOdds, options),
    overround: book,
  };
}

/** Converts American odds to decimal, for provider payloads that use them. */
export function americanToDecimal(american: number): number {
  if (american === 0 || !Number.isFinite(american)) {
    throw new RangeError(`Invalid American odds: ${american}`);
  }
  return american > 0 ? american / 100 + 1 : 100 / Math.abs(american) + 1;
}

/** Converts fractional odds (e.g. 5/2) to decimal. */
export function fractionalToDecimal(numerator: number, denominator: number): number {
  if (denominator === 0) throw new RangeError('Fractional odds denominator must be non-zero');
  return numerator / denominator + 1;
}
