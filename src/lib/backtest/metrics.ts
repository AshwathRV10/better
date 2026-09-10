/**
 * Forecast evaluation metrics.
 *
 * Accuracy alone is close to useless for a probabilistic model: a forecaster who
 * says 55% on every home team can beat one who is perfectly calibrated. These
 * are the proper scoring rules plus the betting metrics, reported together so
 * neither can be optimised in isolation.
 */

import { safeLog } from '../prediction/math/stats';
import { calibrationBins, expectedCalibrationError, type CalibrationBin } from '../prediction/math/calibration';

export interface ScoredPrediction {
  /** Probabilities over the sport's classes, in class order. */
  readonly probabilities: readonly number[];
  /** Index of the class that actually occurred. */
  readonly actual: number;
  /** Decimal odds available on each class, where a market existed. */
  readonly odds?: readonly (number | null)[];
  readonly kickoff: Date;
  readonly leagueKey?: string;
  readonly confidence?: string;
}

export interface EvaluationMetrics {
  readonly predictions: number;
  readonly correct: number;
  readonly accuracy: number;
  /** Mean negative log-likelihood. Lower is better; 1.0986 = uniform 3-way. */
  readonly logLoss: number;
  /** Multi-class Brier score. Lower is better; 0.6667 = uniform 3-way. */
  readonly brierScore: number;
  readonly calibration: readonly CalibrationBin[];
  readonly expectedCalibrationError: number;
  /** Log loss of always predicting the observed base rate. */
  readonly baselineLogLoss: number;
  /** Fractional improvement in log loss over that baseline. Higher is better. */
  readonly skillScore: number;
}

/**
 * Multi-class Brier score: the mean squared error between the forecast vector
 * and the one-hot outcome. It is a proper scoring rule, so it cannot be gamed by
 * shading probabilities toward the favourite.
 */
export function brierScore(probabilities: readonly number[], actual: number): number {
  let total = 0;
  for (let i = 0; i < probabilities.length; i += 1) {
    const outcome = i === actual ? 1 : 0;
    total += (probabilities[i] - outcome) ** 2;
  }
  return total;
}

export function evaluate(predictions: readonly ScoredPrediction[]): EvaluationMetrics {
  if (predictions.length === 0) {
    return {
      predictions: 0, correct: 0, accuracy: 0, logLoss: 0, brierScore: 0,
      calibration: [], expectedCalibrationError: 0, baselineLogLoss: 0, skillScore: 0,
    };
  }

  const classCount = predictions[0].probabilities.length;
  let correct = 0;
  let logLossTotal = 0;
  let brierTotal = 0;
  const classCounts = new Array<number>(classCount).fill(0);

  for (const prediction of predictions) {
    const best = prediction.probabilities.reduce(
      (bestIndex, p, i) => (p > prediction.probabilities[bestIndex] ? i : bestIndex),
      0,
    );
    if (best === prediction.actual) correct += 1;
    logLossTotal -= safeLog(prediction.probabilities[prediction.actual]);
    brierTotal += brierScore(prediction.probabilities, prediction.actual);
    classCounts[prediction.actual] += 1;
  }

  // The baseline is the observed base rate over the very same sample, which is
  // the strictest honest comparison: the model has to beat simply knowing how
  // often each outcome happens.
  const baseRates = classCounts.map((count) => count / predictions.length);
  let baselineLogLoss = 0;
  for (const prediction of predictions) {
    baselineLogLoss -= safeLog(baseRates[prediction.actual]);
  }
  baselineLogLoss /= predictions.length;

  const logLoss = logLossTotal / predictions.length;

  // Reliability is measured on every (class, probability) pair, not just the
  // favourite, so a model that is well calibrated on favourites but wild on
  // longshots is not flattered.
  const reliability = predictions.flatMap((prediction) =>
    prediction.probabilities.map((probability, i) => ({
      probability,
      won: i === prediction.actual,
    })),
  );
  const bins = calibrationBins(reliability, 10);

  return {
    predictions: predictions.length,
    correct,
    accuracy: correct / predictions.length,
    logLoss,
    brierScore: brierTotal / predictions.length,
    calibration: bins,
    expectedCalibrationError: expectedCalibrationError(bins),
    baselineLogLoss,
    skillScore: baselineLogLoss > 0 ? 1 - logLoss / baselineLogLoss : 0,
  };
}

export interface BettingMetrics {
  readonly betsPlaced: number;
  readonly staked: number;
  readonly returned: number;
  readonly profit: number;
  readonly roi: number;
  readonly wins: number;
  readonly winRate: number;
  readonly averageOdds: number;
  readonly averageEdge: number;
  readonly equityCurve: ReadonlyArray<{ date: string; bankroll: number; profit: number }>;
}

export interface BettingOptions {
  /** Only back selections whose model EV exceeds this threshold. */
  readonly minimumExpectedValue?: number;
  /** Flat stake per bet, in units. */
  readonly stake?: number;
  readonly startingBankroll?: number;
}

/**
 * Simulates flat-stake betting on positive-EV selections.
 *
 * ROI here is a diagnostic, never a target. Optimising a model for backtest ROI
 * produces something that fits the noise in one odds history; optimising for log
 * loss and calibration produces something that generalises. Both are reported so
 * ROI can be read in the context of whether the probabilities are any good.
 */
export function evaluateBetting(
  predictions: readonly ScoredPrediction[],
  options: BettingOptions = {},
): BettingMetrics {
  const minimumEv = options.minimumExpectedValue ?? 0.02;
  const stake = options.stake ?? 1;
  let bankroll = options.startingBankroll ?? 100;

  let staked = 0;
  let returned = 0;
  let wins = 0;
  let oddsTotal = 0;
  let edgeTotal = 0;
  const equityCurve: Array<{ date: string; bankroll: number; profit: number }> = [];

  const ordered = [...predictions].sort((a, b) => a.kickoff.getTime() - b.kickoff.getTime());

  for (const prediction of ordered) {
    if (!prediction.odds) continue;
    for (let i = 0; i < prediction.probabilities.length; i += 1) {
      const price = prediction.odds[i];
      if (price === null || price === undefined || price <= 1) continue;
      const ev = prediction.probabilities[i] * price - 1;
      if (ev < minimumEv) continue;

      staked += stake;
      oddsTotal += price;
      edgeTotal += prediction.probabilities[i] - 1 / price;
      if (i === prediction.actual) {
        returned += stake * price;
        bankroll += stake * (price - 1);
        wins += 1;
      } else {
        bankroll -= stake;
      }
      equityCurve.push({
        date: prediction.kickoff.toISOString().slice(0, 10),
        bankroll: Number(bankroll.toFixed(2)),
        profit: Number((returned - staked).toFixed(2)),
      });
    }
  }

  const betsPlaced = staked / stake;
  return {
    betsPlaced,
    staked,
    returned,
    profit: returned - staked,
    roi: staked > 0 ? (returned - staked) / staked : 0,
    wins,
    winRate: betsPlaced > 0 ? wins / betsPlaced : 0,
    averageOdds: betsPlaced > 0 ? oddsTotal / betsPlaced : 0,
    averageEdge: betsPlaced > 0 ? edgeTotal / betsPlaced : 0,
    equityCurve,
  };
}
