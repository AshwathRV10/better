/**
 * Basketball sport module.
 *
 * Markets: moneyline (match winner), point spread, total points.
 *
 * Basketball scores are the sum of ~100 possessions per side, so by the central
 * limit theorem the margin and the total are both close to normal. That makes a
 * normal model both more accurate and far cheaper than a Poisson score matrix,
 * and it prices spreads and totals directly from the same two parameters.
 */

import type {
  ComponentPrediction,
  FeatureVector,
  MatchContext,
  ModelParameters,
  OutcomeProbability,
  SportModule,
} from '../types';
import {
  FEATURES_VERSION,
  FeatureBuilder,
  computeForm,
  computeHeadToHead,
  computeRest,
  computeStrength,
  computeVenueRecord,
  contextCutoff,
} from '../features';
import { DEFAULT_ELO_CONFIG, eloExpectedScore } from '../models/elo';
import { clamp, normalCdf, normalise, sigmoid } from '../math/stats';
import { predictMultinomial } from '../models/mlModel';
import { removeMargin } from '../../odds';

export const BASKETBALL_CLASSES = ['HOME', 'AWAY'] as const;

export const BASKETBALL_SPREAD_LINES = [-7.5, -4.5, -2.5, 2.5, 4.5, 7.5] as const;

/**
 * Standard deviation of the final margin. Empirically ~11-12 points in the NBA
 * and stable across seasons; it is the single most important constant in a
 * spread model.
 */
const MARGIN_STANDARD_DEVIATION = 11.5;

/** Standard deviation of the combined total. Wider than the margin's. */
const TOTAL_STANDARD_DEVIATION = 15.5;

/** Home-court advantage in points, applied as a margin shift. */
const HOME_COURT_POINTS = 2.4;

const AVAILABILITY_POINTS_SENSITIVITY = 14;
const REST_POINTS_SENSITIVITY = 2.5;

export const BASKETBALL_DEFAULT_PARAMETERS: ModelParameters = {
  ensembleWeights: { normal: 0.45, elo: 0.3, form: 0.15, ml: 0.1 },
  calibration: null,
  ml: null,
  // 60 Elo points is a ~58% home win rate, matching observed basketball home
  // advantage. The 85 used previously implied 62%, which no league sustains.
  elo: { ...DEFAULT_ELO_CONFIG, kFactor: 18, homeAdvantage: 60, marginMultiplier: 0.6 },
  form: { lookback: 12, halfLifeMatches: 5 },
};

function buildBasketballFeatures(ctx: MatchContext, params: ModelParameters): FeatureVector {
  const cutoff = contextCutoff(ctx);
  const homeForm = computeForm(ctx.home, cutoff, params.form);
  const awayForm = computeForm(ctx.away, cutoff, params.form);
  const homeStrength = computeStrength(ctx.home, cutoff, ctx.league, 20);
  const awayStrength = computeStrength(ctx.away, cutoff, ctx.league, 20);
  const homeVenue = computeVenueRecord(ctx.home, cutoff, ctx.league, 20);
  const awayVenue = computeVenueRecord(ctx.away, cutoff, ctx.league, 20);
  const h2h = computeHeadToHead(ctx.headToHead, ctx.home.teamId, ctx.away.teamId, cutoff);
  const homeRest = computeRest(ctx.home, cutoff);
  const awayRest = computeRest(ctx.away, cutoff);
  const homeMissing = ctx.home.squadImportanceTotal > 0
    ? ctx.home.absentees.reduce((s, p) => s + p.importance, 0) / ctx.home.squadImportanceTotal
    : 0;
  const awayMissing = ctx.away.squadImportanceTotal > 0
    ? ctx.away.absentees.reduce((s, p) => s + p.importance, 0) / ctx.away.squadImportanceTotal
    : 0;

  const eloDiff = ctx.home.rating.elo - ctx.away.rating.elo;
  const builder = new FeatureBuilder();

  builder
    .add('elo_diff', eloDiff, 'RATING', `Elo ${Math.round(eloDiff) >= 0 ? '+' : ''}${Math.round(eloDiff)} to ${ctx.home.shortName}`, {
      imputed: ctx.home.rating.matchesPlayed === 0 || ctx.away.rating.matchesPlayed === 0,
    })
    .add('home_elo', ctx.home.rating.elo, 'RATING', `${ctx.home.shortName} Elo ${Math.round(ctx.home.rating.elo)}`)
    .add('away_elo', ctx.away.rating.elo, 'RATING', `${ctx.away.shortName} Elo ${Math.round(ctx.away.rating.elo)}`)
    .add('form_diff', homeForm.weightedPoints - awayForm.weightedPoints, 'FORM',
      `Weighted form ${(homeForm.weightedPoints * 100).toFixed(0)}% v ${(awayForm.weightedPoints * 100).toFixed(0)}%`,
      { imputed: homeForm.sampleSize === 0 || awayForm.sampleSize === 0 })
    .add('home_form', homeForm.weightedPoints, 'FORM', `${ctx.home.shortName} form ${homeForm.results.slice(0, 5).join('-')}`, { imputed: homeForm.sampleSize === 0 })
    .add('away_form', awayForm.weightedPoints, 'FORM', `${ctx.away.shortName} form ${awayForm.results.slice(0, 5).join('-')}`, { imputed: awayForm.sampleSize === 0 })
    .add('offence_diff', homeStrength.attack - awayStrength.attack, 'ATTACK',
      `Scoring ${homeStrength.attack.toFixed(2)} v ${awayStrength.attack.toFixed(2)} (league = 1.00)`,
      { imputed: homeStrength.sampleSize === 0 || awayStrength.sampleSize === 0 })
    .add('home_offence', homeStrength.attack, 'ATTACK', `${ctx.home.shortName} scores ${homeStrength.attack.toFixed(2)}x league`, { imputed: homeStrength.sampleSize === 0 })
    .add('away_offence', awayStrength.attack, 'ATTACK', `${ctx.away.shortName} scores ${awayStrength.attack.toFixed(2)}x league`, { imputed: awayStrength.sampleSize === 0 })
    .add('defence_diff', awayStrength.defence - homeStrength.defence, 'DEFENCE',
      `Points allowed ${homeStrength.defence.toFixed(2)} v ${awayStrength.defence.toFixed(2)} (lower is better)`,
      { imputed: homeStrength.sampleSize === 0 || awayStrength.sampleSize === 0 })
    .add('home_defence', homeStrength.defence, 'DEFENCE', `${ctx.home.shortName} allows ${homeStrength.defence.toFixed(2)}x league`, { imputed: homeStrength.sampleSize === 0 })
    .add('away_defence', awayStrength.defence, 'DEFENCE', `${ctx.away.shortName} allows ${awayStrength.defence.toFixed(2)}x league`, { imputed: awayStrength.sampleSize === 0 })
    .add('home_venue_edge', homeVenue.homeWinRate - ctx.league.homeWinRate, 'HOME_AWAY',
      `${ctx.home.shortName} home record ${(homeVenue.homeWinRate * 100).toFixed(0)}%`, { imputed: homeVenue.homeSample === 0 })
    .add('away_venue_edge', awayVenue.awayWinRate - ctx.league.awayWinRate, 'HOME_AWAY',
      `${ctx.away.shortName} road record ${(awayVenue.awayWinRate * 100).toFixed(0)}%`, { imputed: awayVenue.awaySample === 0 })
    .add('h2h_home_share', h2h.homeShare - 0.5, 'H2H',
      h2h.meetings === 0 ? 'No recent meetings' : `H2H ${h2h.homeWins}-${h2h.awayWins} over ${h2h.meetings} meetings`,
      { imputed: h2h.meetings === 0 })
    .add('h2h_meetings', h2h.meetings, 'H2H', `${h2h.meetings} recorded meetings`, { imputed: h2h.meetings === 0 })
    .add('rest_diff', homeRest.freshness - awayRest.freshness, 'REST',
      `Rest ${homeRest.daysSinceLastMatch === null ? 'n/a' : `${homeRest.daysSinceLastMatch.toFixed(0)}d`} v ${awayRest.daysSinceLastMatch === null ? 'n/a' : `${awayRest.daysSinceLastMatch.toFixed(0)}d`}`,
      { imputed: homeRest.daysSinceLastMatch === null || awayRest.daysSinceLastMatch === null })
    .add('home_freshness', homeRest.freshness, 'REST', `${ctx.home.shortName} ${homeRest.matchesInLast14Days} games in 14 days`, { imputed: homeRest.daysSinceLastMatch === null })
    .add('away_freshness', awayRest.freshness, 'REST', `${ctx.away.shortName} ${awayRest.matchesInLast14Days} games in 14 days`, { imputed: awayRest.daysSinceLastMatch === null })
    .add('availability_diff', awayMissing - homeMissing, 'AVAILABILITY',
      `Absentees: ${ctx.home.shortName} ${(homeMissing * 100).toFixed(0)}% of rotation value, ${ctx.away.shortName} ${(awayMissing * 100).toFixed(0)}%`,
      { imputed: ctx.home.squadImportanceTotal === 0 || ctx.away.squadImportanceTotal === 0 })
    .add('home_missing', homeMissing, 'AVAILABILITY', `${ctx.home.absentees.length} unavailable for ${ctx.home.shortName}`, { imputed: ctx.home.squadImportanceTotal === 0 })
    .add('away_missing', awayMissing, 'AVAILABILITY', `${ctx.away.absentees.length} unavailable for ${ctx.away.shortName}`, { imputed: ctx.away.squadImportanceTotal === 0 })
    .add('neutral_venue', ctx.neutralVenue ? 1 : 0, 'CONTEXT', ctx.neutralVenue ? 'Neutral court' : 'Home court');

  return builder.build(FEATURES_VERSION);
}

export interface PointsExpectation {
  readonly home: number;
  readonly away: number;
  readonly margin: number;
  readonly total: number;
}

/**
 * Expected points for each side.
 *
 * Offensive and defensive ratings combine ADDITIVELY: each contributes a number
 * of points above or below the league mean. Multiplying them instead compounds
 * the two effects, and a plausible +/-7% rating spread then implies 30-point
 * expected margins - roughly triple what any real basketball league produces.
 *
 * On top of the ratings, the margin is shifted for home court, rest and
 * absentees. A full rotation of absentees is capped at ~14 points, which is
 * deliberately conservative.
 */
export function expectedPoints(ctx: MatchContext, features: FeatureVector): PointsExpectation {
  const f = features.byName;
  const leagueAverage = (ctx.league.averageHomeScore + ctx.league.averageAwayScore) / 2;
  const homeCourt = ctx.neutralVenue ? 0 : HOME_COURT_POINTS;

  const rating = (offence: number, opponentDefence: number) =>
    leagueAverage + (offence - 1) * leagueAverage + (opponentDefence - 1) * leagueAverage;

  const rawHome = rating(f.home_offence ?? 1, f.away_defence ?? 1);
  const rawAway = rating(f.away_offence ?? 1, f.home_defence ?? 1);

  const availabilityShift =
    ((f.away_missing ?? 0) - (f.home_missing ?? 0)) * AVAILABILITY_POINTS_SENSITIVITY;
  const restShift = ((f.home_freshness ?? 1) - (f.away_freshness ?? 1)) * REST_POINTS_SENSITIVITY;
  const shift = homeCourt + availabilityShift + restShift;

  const home = clamp(rawHome + shift / 2, 60, 160);
  const away = clamp(rawAway - shift / 2, 60, 160);
  return { home, away, margin: home - away, total: home + away };
}

function twoWayOutcomes(homeProbability: number): OutcomeProbability[] {
  const [home, away] = normalise([homeProbability, 1 - homeProbability]);
  return [
    { market: 'MATCH_WINNER', selection: 'HOME', probability: home },
    { market: 'MATCH_WINNER', selection: 'AWAY', probability: away },
  ];
}

/** Prices moneyline, spread and totals from one normal margin/total model. */
export function basketballMarkets(
  expectation: PointsExpectation,
  totalLines: readonly number[],
): OutcomeProbability[] {
  // P(home wins) = P(margin > 0) under margin ~ N(mu, sigma).
  const homeWin = 1 - normalCdf(0, expectation.margin, MARGIN_STANDARD_DEVIATION);
  const outcomes: OutcomeProbability[] = [...twoWayOutcomes(homeWin)];

  for (const line of BASKETBALL_SPREAD_LINES) {
    // Backing the home team at `line` wins when margin + line > 0.
    const cover = 1 - normalCdf(-line, expectation.margin, MARGIN_STANDARD_DEVIATION);
    outcomes.push({ market: 'POINT_SPREAD', selection: 'HOME', line, probability: cover });
    outcomes.push({ market: 'POINT_SPREAD', selection: 'AWAY', line, probability: 1 - cover });
  }

  for (const line of totalLines) {
    const over = 1 - normalCdf(line, expectation.total, TOTAL_STANDARD_DEVIATION);
    outcomes.push({ market: 'OVER_UNDER', selection: 'OVER', line, probability: over });
    outcomes.push({ market: 'OVER_UNDER', selection: 'UNDER', line, probability: 1 - over });
  }

  return outcomes;
}

/** Totals lines are quoted around the model's own expectation, at half-points. */
export function basketballTotalLines(expectedTotal: number): number[] {
  const centre = Math.round(expectedTotal) + 0.5;
  return [centre - 6, centre - 3, centre, centre + 3, centre + 6];
}

function basketballMarketComponent(ctx: MatchContext): OutcomeProbability[] | null {
  const quotes = ctx.odds.filter(
    (o) => o.market === 'MATCH_WINNER' && o.capturedAt.getTime() <= ctx.asOf.getTime(),
  );
  const latest = new Map<string, { price: number; at: number }>();
  for (const quote of quotes) {
    const seen = latest.get(quote.selection);
    if (!seen || quote.capturedAt.getTime() >= seen.at) {
      latest.set(quote.selection, { price: quote.price, at: quote.capturedAt.getTime() });
    }
  }
  const home = latest.get('HOME');
  const away = latest.get('AWAY');
  if (!home || !away) return null;
  const fair = removeMargin([home.price, away.price], 'shin');
  return [
    { market: 'MATCH_WINNER', selection: 'HOME', probability: fair[0] },
    { market: 'MATCH_WINNER', selection: 'AWAY', probability: fair[1] },
  ];
}

function basketballPredict(
  ctx: MatchContext,
  features: FeatureVector,
  params: ModelParameters,
): { components: ComponentPrediction[]; expectedHomeScore?: number; expectedAwayScore?: number } {
  const weights = params.ensembleWeights;
  const components: ComponentPrediction[] = [];

  const expectation = expectedPoints(ctx, features);
  components.push({
    component: 'normal',
    weight: weights.normal ?? 0,
    outcomes: basketballMarkets(expectation, basketballTotalLines(expectation.total)),
  });

  const eloExpectation = eloExpectedScore(
    ctx.home.rating.elo,
    ctx.away.rating.elo,
    params.elo,
    ctx.neutralVenue,
  );
  components.push({ component: 'elo', weight: weights.elo ?? 0, outcomes: twoWayOutcomes(eloExpectation) });

  const formLogit =
    2.6 * (features.byName.form_diff ?? 0) +
    1.2 * (features.byName.offence_diff ?? 0) +
    1.2 * (features.byName.defence_diff ?? 0) +
    0.8 * (features.byName.availability_diff ?? 0) +
    (ctx.neutralVenue ? 0 : 0.22);
  components.push({ component: 'form', weight: weights.form ?? 0, outcomes: twoWayOutcomes(sigmoid(formLogit)) });

  const mlProbabilities = predictMultinomial(params.ml, features.byName);
  if (mlProbabilities && mlProbabilities.length === 2) {
    components.push({ component: 'ml', weight: weights.ml ?? 0, outcomes: twoWayOutcomes(mlProbabilities[0]) });
  }

  const market = basketballMarketComponent(ctx);
  if (market) components.push({ component: 'market', weight: 0, outcomes: market });

  return {
    components,
    expectedHomeScore: expectation.home,
    expectedAwayScore: expectation.away,
  };
}

export const basketballModule: SportModule = {
  key: 'basketball',
  markets: ['MATCH_WINNER', 'POINT_SPREAD', 'OVER_UNDER'],
  featuresVersion: FEATURES_VERSION,
  defaultParameters: BASKETBALL_DEFAULT_PARAMETERS,
  classes: [...BASKETBALL_CLASSES],
  usesMl: true,
  buildFeatures: buildBasketballFeatures,
  predict: basketballPredict,
  resultClass: (match) => (match.homeScore > match.awayScore ? 'HOME' : 'AWAY'),
};
