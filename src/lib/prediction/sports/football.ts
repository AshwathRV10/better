/**
 * Football (soccer) sport module.
 *
 * Markets: match winner (1X2), over/under goals, both teams to score, correct
 * score and Asian handicap.
 *
 * The goal model is the backbone: a Dixon-Coles bivariate Poisson gives a full
 * joint distribution over exact scores, and every other market is derived from
 * that same distribution. This keeps the markets mutually consistent - the 1X2
 * probabilities and the correct-score probabilities can never contradict each
 * other, which is what happens when each market is modelled separately.
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
  computeAvailability,
  computeForm,
  computeHeadToHead,
  computeRest,
  computeStrength,
  computeVenueRecord,
  contextCutoff,
} from '../features';
import {
  DEFAULT_ELO_CONFIG,
  eloExpectedScore,
  eloOutcomeProbabilities,
} from '../models/elo';
import {
  asianHandicapProbabilities,
  bttsProbability,
  buildScoreMatrix,
  outcomeProbabilities,
  overProbability,
  topCorrectScores,
} from '../math/poisson';
import { clamp, normalise, sigmoid } from '../math/stats';
import { impliedProbability, removeMargin } from '../../odds';

export const FOOTBALL_CLASSES = ['HOME', 'DRAW', 'AWAY'] as const;

/** Goal lines quoted by every mainstream book. */
export const FOOTBALL_TOTAL_LINES = [1.5, 2.5, 3.5] as const;
export const FOOTBALL_HANDICAP_LINES = [-1.5, -0.5, 0.5, 1.5] as const;

/**
 * Dixon-Coles low-score dependence parameter. Negative values move mass into
 * 0-0 and 1-1 and out of 1-0 and 0-1, matching observed football scorelines.
 */
const DIXON_COLES_RHO = -0.04;

/** How strongly the availability feature scales a side's expected goals. */
const AVAILABILITY_ATTACK_SENSITIVITY = 0.45;
/** How strongly fatigue scales expected goals. */
const REST_SENSITIVITY = 0.08;
/** Weight of the head-to-head signal in the goal model, before decay. */
const H2H_SENSITIVITY = 0.12;

/**
 * Ensemble weights.
 *
 * Three interpretable components, no learned model. The Dixon-Coles goal model
 * leads because it is the only one that produces a full score distribution;
 * Elo carries opponent-adjusted strength; weighted form supplies recency.
 */
export const FOOTBALL_DEFAULT_PARAMETERS: ModelParameters = {
  ensembleWeights: { poisson: 0.45, elo: 0.35, form: 0.2 },
  calibration: null,
  ml: null,
  elo: { ...DEFAULT_ELO_CONFIG, kFactor: 20, homeAdvantage: 65 },
  form: { lookback: 10, halfLifeMatches: 4 },
};

/** Feature names consumed by the ML component, in a fixed order. */
export const FOOTBALL_ML_FEATURES = [
  'elo_diff',
  'form_diff',
  'attack_diff',
  'defence_diff',
  'home_venue_edge',
  'away_venue_edge',
  'h2h_home_share',
  'rest_diff',
  'availability_diff',
  'league_home_bias',
] as const;

function buildFootballFeatures(ctx: MatchContext, params: ModelParameters): FeatureVector {
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
  const homeAvailability = computeAvailability(ctx.home);
  const awayAvailability = computeAvailability(ctx.away);

  const builder = new FeatureBuilder();
  const eloDiff = ctx.home.rating.elo - ctx.away.rating.elo;

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
    .add('attack_diff', homeStrength.attack - awayStrength.attack, 'ATTACK',
      `Attack strength ${homeStrength.attack.toFixed(2)} v ${awayStrength.attack.toFixed(2)}`,
      { imputed: homeStrength.sampleSize === 0 || awayStrength.sampleSize === 0 })
    .add('home_attack', homeStrength.attack, 'ATTACK', `${ctx.home.shortName} attack ${homeStrength.attack.toFixed(2)}x league`, { imputed: homeStrength.sampleSize === 0 })
    .add('away_attack', awayStrength.attack, 'ATTACK', `${ctx.away.shortName} attack ${awayStrength.attack.toFixed(2)}x league`, { imputed: awayStrength.sampleSize === 0 })
    // Lower defence value = fewer goals conceded, so the difference is inverted.
    .add('defence_diff', awayStrength.defence - homeStrength.defence, 'DEFENCE',
      `Defence ${homeStrength.defence.toFixed(2)} v ${awayStrength.defence.toFixed(2)} (lower is better)`,
      { imputed: homeStrength.sampleSize === 0 || awayStrength.sampleSize === 0 })
    .add('home_defence', homeStrength.defence, 'DEFENCE', `${ctx.home.shortName} concedes ${homeStrength.defence.toFixed(2)}x league`, { imputed: homeStrength.sampleSize === 0 })
    .add('away_defence', awayStrength.defence, 'DEFENCE', `${ctx.away.shortName} concedes ${awayStrength.defence.toFixed(2)}x league`, { imputed: awayStrength.sampleSize === 0 })
    .add('home_xg_attack', homeStrength.xgAttack ?? homeStrength.goalsAttack, 'ATTACK',
      homeStrength.xgAttack === null
        ? `${ctx.home.shortName} xG unavailable, using goals`
        : `${ctx.home.shortName} xG ${homeStrength.xgAttack.toFixed(2)}x league`,
      { imputed: homeStrength.xgAttack === null })
    .add('away_xg_attack', awayStrength.xgAttack ?? awayStrength.goalsAttack, 'ATTACK',
      awayStrength.xgAttack === null
        ? `${ctx.away.shortName} xG unavailable, using goals`
        : `${ctx.away.shortName} xG ${awayStrength.xgAttack.toFixed(2)}x league`,
      { imputed: awayStrength.xgAttack === null })
    .add('home_xg_defence', homeStrength.xgDefence ?? homeStrength.goalsDefence, 'DEFENCE',
      homeStrength.xgDefence === null
        ? `${ctx.home.shortName} xGA unavailable, using goals conceded`
        : `${ctx.home.shortName} xGA ${homeStrength.xgDefence.toFixed(2)}x league`,
      { imputed: homeStrength.xgDefence === null })
    .add('away_xg_defence', awayStrength.xgDefence ?? awayStrength.goalsDefence, 'DEFENCE',
      awayStrength.xgDefence === null
        ? `${ctx.away.shortName} xGA unavailable, using goals conceded`
        : `${ctx.away.shortName} xGA ${awayStrength.xgDefence.toFixed(2)}x league`,
      { imputed: awayStrength.xgDefence === null })
    .add('home_goals_attack', homeStrength.goalsAttack, 'ATTACK', `${ctx.home.shortName} goals ${homeStrength.goalsAttack.toFixed(2)}x league`, { imputed: homeStrength.sampleSize === 0 })
    .add('away_goals_attack', awayStrength.goalsAttack, 'ATTACK', `${ctx.away.shortName} goals ${awayStrength.goalsAttack.toFixed(2)}x league`, { imputed: awayStrength.sampleSize === 0 })
    .add('home_clean_sheet_rate', homeStrength.cleanSheetRate, 'DEFENCE', `${ctx.home.shortName} clean sheets ${(homeStrength.cleanSheetRate * 100).toFixed(0)}%`, { imputed: homeStrength.sampleSize === 0 })
    .add('away_clean_sheet_rate', awayStrength.cleanSheetRate, 'DEFENCE', `${ctx.away.shortName} clean sheets ${(awayStrength.cleanSheetRate * 100).toFixed(0)}%`, { imputed: awayStrength.sampleSize === 0 })
    .add('home_venue_edge', homeVenue.homeWinRate - ctx.league.homeWinRate, 'HOME_AWAY',
      `${ctx.home.shortName} home wins ${(homeVenue.homeWinRate * 100).toFixed(0)}% v league ${(ctx.league.homeWinRate * 100).toFixed(0)}%`,
      { imputed: homeVenue.homeSample === 0 })
    .add('away_venue_edge', awayVenue.awayWinRate - ctx.league.awayWinRate, 'HOME_AWAY',
      `${ctx.away.shortName} away wins ${(awayVenue.awayWinRate * 100).toFixed(0)}% v league ${(ctx.league.awayWinRate * 100).toFixed(0)}%`,
      { imputed: awayVenue.awaySample === 0 })
    .add('home_goals_at_home', homeVenue.homeGoalsPerMatch, 'HOME_AWAY', `${ctx.home.shortName} scores ${homeVenue.homeGoalsPerMatch.toFixed(2)} at home`, { imputed: homeVenue.homeSample === 0 })
    .add('away_goals_away', awayVenue.awayGoalsPerMatch, 'HOME_AWAY', `${ctx.away.shortName} scores ${awayVenue.awayGoalsPerMatch.toFixed(2)} away`, { imputed: awayVenue.awaySample === 0 })
    .add('h2h_home_share', h2h.homeShare - 0.5, 'H2H',
      h2h.meetings === 0
        ? 'No recent head-to-head meetings'
        : `H2H ${h2h.homeWins}W-${h2h.draws}D-${h2h.awayWins}L over ${h2h.meetings} meetings`,
      { imputed: h2h.meetings === 0 })
    .add('h2h_meetings', h2h.meetings, 'H2H', `${h2h.meetings} recorded meetings`, { imputed: h2h.meetings === 0 })
    .add('rest_diff', homeRest.freshness - awayRest.freshness, 'REST',
      `Rest ${homeRest.daysSinceLastMatch === null ? 'n/a' : `${homeRest.daysSinceLastMatch.toFixed(0)}d`} v ${awayRest.daysSinceLastMatch === null ? 'n/a' : `${awayRest.daysSinceLastMatch.toFixed(0)}d`}`,
      { imputed: homeRest.daysSinceLastMatch === null || awayRest.daysSinceLastMatch === null })
    .add('home_freshness', homeRest.freshness, 'REST', `${ctx.home.shortName} ${homeRest.matchesInLast14Days} matches in 14 days`, { imputed: homeRest.daysSinceLastMatch === null })
    .add('away_freshness', awayRest.freshness, 'REST', `${ctx.away.shortName} ${awayRest.matchesInLast14Days} matches in 14 days`, { imputed: awayRest.daysSinceLastMatch === null })
    .add('availability_diff', awayAvailability.missingImportance - homeAvailability.missingImportance, 'AVAILABILITY',
      `Absentees: ${ctx.home.shortName} ${(homeAvailability.missingImportance * 100).toFixed(0)}% of squad value, ${ctx.away.shortName} ${(awayAvailability.missingImportance * 100).toFixed(0)}%`,
      { imputed: !homeAvailability.reported || !awayAvailability.reported })
    .add('home_missing', homeAvailability.missingImportance, 'AVAILABILITY', `${ctx.home.absentees.length} unavailable for ${ctx.home.shortName}`, { imputed: !homeAvailability.reported })
    .add('away_missing', awayAvailability.missingImportance, 'AVAILABILITY', `${ctx.away.absentees.length} unavailable for ${ctx.away.shortName}`, { imputed: !awayAvailability.reported })
    .add('league_home_bias', ctx.league.homeWinRate - ctx.league.awayWinRate, 'CONTEXT',
      `League home win rate ${(ctx.league.homeWinRate * 100).toFixed(0)}%`,
      { imputed: ctx.league.matchesObserved < 20 })
    .add('neutral_venue', ctx.neutralVenue ? 1 : 0, 'CONTEXT', ctx.neutralVenue ? 'Neutral venue' : 'Home venue');

  return builder.build(FEATURES_VERSION);
}

export interface GoalExpectation {
  readonly home: number;
  readonly away: number;
}

/**
 * Expected goals for each side.
 *
 * Starts from the league's home/away scoring baselines, multiplies by the two
 * sides' attack and defence strengths, then applies small multiplicative
 * adjustments for availability, fatigue and head-to-head. Multiplicative form
 * keeps the rates strictly positive and keeps each adjustment interpretable as
 * a percentage change.
 */
export function expectedGoals(ctx: MatchContext, features: FeatureVector): GoalExpectation {
  const f = features.byName;
  const baseHome = ctx.neutralVenue
    ? (ctx.league.averageHomeScore + ctx.league.averageAwayScore) / 2
    : ctx.league.averageHomeScore;
  const baseAway = ctx.neutralVenue
    ? (ctx.league.averageHomeScore + ctx.league.averageAwayScore) / 2
    : ctx.league.averageAwayScore;

  const availabilityHome = 1 - (f.home_missing ?? 0) * AVAILABILITY_ATTACK_SENSITIVITY;
  const availabilityAway = 1 - (f.away_missing ?? 0) * AVAILABILITY_ATTACK_SENSITIVITY;
  const restHome = 1 - (1 - (f.home_freshness ?? 1)) * REST_SENSITIVITY;
  const restAway = 1 - (1 - (f.away_freshness ?? 1)) * REST_SENSITIVITY;
  // H2H nudges the goal split without being allowed to dominate it.
  const h2hHome = 1 + (f.h2h_home_share ?? 0) * H2H_SENSITIVITY;
  const h2hAway = 1 - (f.h2h_home_share ?? 0) * H2H_SENSITIVITY;

  const home =
    baseHome *
    (f.home_attack ?? 1) *
    (f.away_defence ?? 1) *
    availabilityHome *
    restHome *
    h2hHome;
  const away =
    baseAway *
    (f.away_attack ?? 1) *
    (f.home_defence ?? 1) *
    availabilityAway *
    restAway *
    h2hAway;

  // Clamp to a plausible football range so a broken input can never produce an
  // absurd scoreline distribution.
  return { home: clamp(home, 0.15, 6), away: clamp(away, 0.15, 6) };
}

function outcomeList(
  probabilities: { home: number; draw: number; away: number },
): OutcomeProbability[] {
  const [home, draw, away] = normalise([probabilities.home, probabilities.draw, probabilities.away]);
  return [
    { market: 'MATCH_WINNER', selection: 'HOME', probability: home },
    { market: 'MATCH_WINNER', selection: 'DRAW', probability: draw },
    { market: 'MATCH_WINNER', selection: 'AWAY', probability: away },
  ];
}

/** Derives every football market from one score matrix. */
export function marketsFromScoreMatrix(lambdaHome: number, lambdaAway: number): OutcomeProbability[] {
  const sm = buildScoreMatrix(lambdaHome, lambdaAway, { rho: DIXON_COLES_RHO });
  const outcomes: OutcomeProbability[] = [...outcomeList(outcomeProbabilities(sm))];

  for (const line of FOOTBALL_TOTAL_LINES) {
    const over = overProbability(sm, line);
    outcomes.push({ market: 'OVER_UNDER', selection: 'OVER', line, probability: over });
    outcomes.push({ market: 'OVER_UNDER', selection: 'UNDER', line, probability: 1 - over });
  }

  const btts = bttsProbability(sm);
  outcomes.push({ market: 'BTTS', selection: 'YES', probability: btts });
  outcomes.push({ market: 'BTTS', selection: 'NO', probability: 1 - btts });

  for (const score of topCorrectScores(sm, 10)) {
    outcomes.push({
      market: 'CORRECT_SCORE',
      selection: `${score.home}-${score.away}`,
      probability: score.probability,
    });
  }

  for (const line of FOOTBALL_HANDICAP_LINES) {
    const { win, loss } = asianHandicapProbabilities(sm, line);
    outcomes.push({ market: 'ASIAN_HANDICAP', selection: 'HOME', line, probability: win });
    outcomes.push({ market: 'ASIAN_HANDICAP', selection: 'AWAY', line, probability: loss });
  }

  return outcomes;
}

/** Logistic form model: a transparent weighted sum of recency-sensitive signals. */
function formComponentProbabilities(
  features: FeatureVector,
  league: MatchContext['league'],
): { home: number; draw: number; away: number } {
  const f = features.byName;
  // Coefficients chosen so each term moves the log-odds by an interpretable
  // amount; they are fixed and documented rather than fitted, which is what
  // makes this component a genuine independent view rather than a second ML fit.
  const logit =
    2.2 * (f.form_diff ?? 0) +
    0.55 * (f.attack_diff ?? 0) +
    0.55 * (f.defence_diff ?? 0) +
    0.9 * (f.home_venue_edge ?? 0) -
    0.9 * (f.away_venue_edge ?? 0) +
    0.6 * (f.rest_diff ?? 0) +
    1.1 * (f.availability_diff ?? 0) +
    (features.byName.neutral_venue === 1 ? 0 : 0.25);

  const homeVsAway = sigmoid(logit);
  return eloOutcomeProbabilities(homeVsAway, league.drawRate);
}

/** Market-derived probabilities, kept as a clearly separated optional component. */
export function marketComponent(ctx: MatchContext): OutcomeProbability[] | null {
  const quotes = ctx.odds.filter(
    (o) => o.market === 'MATCH_WINNER' && o.capturedAt.getTime() <= ctx.asOf.getTime(),
  );
  if (quotes.length < 2) return null;

  // Use the most recent quote per selection from a single bookmaker so the
  // margin removal operates on a coherent book.
  const byBookmaker = new Map<string, typeof quotes>();
  for (const quote of quotes) {
    const list = byBookmaker.get(quote.bookmaker) ?? [];
    list.push(quote);
    byBookmaker.set(quote.bookmaker, list);
  }

  let bestBook: typeof quotes | null = null;
  for (const list of byBookmaker.values()) {
    const selections = new Set(list.map((q) => q.selection));
    if (selections.size >= 3 && (bestBook === null || list.length > bestBook.length)) {
      bestBook = list;
    }
  }
  if (!bestBook) return null;

  const latest = new Map<string, number>();
  const capturedAt = new Map<string, number>();
  for (const quote of bestBook) {
    const seen = capturedAt.get(quote.selection) ?? 0;
    if (quote.capturedAt.getTime() >= seen) {
      capturedAt.set(quote.selection, quote.capturedAt.getTime());
      latest.set(quote.selection, quote.price);
    }
  }

  const order = ['HOME', 'DRAW', 'AWAY'];
  const prices = order.map((selection) => latest.get(selection));
  if (prices.some((p) => p === undefined)) return null;

  const fair = removeMargin(prices as number[], 'shin');
  return order.map((selection, i) => ({
    market: 'MATCH_WINNER' as const,
    selection,
    probability: fair[i],
  }));
}

function footballPredict(
  ctx: MatchContext,
  features: FeatureVector,
  params: ModelParameters,
): {
  components: ComponentPrediction[];
  expectedHomeScore?: number;
  expectedAwayScore?: number;
} {
  const weights = params.ensembleWeights;
  const components: ComponentPrediction[] = [];

  const goals = expectedGoals(ctx, features);
  components.push({
    component: 'poisson',
    weight: weights.poisson ?? 0,
    outcomes: marketsFromScoreMatrix(goals.home, goals.away),
  });

  const eloExpectation = eloExpectedScore(
    ctx.home.rating.elo,
    ctx.away.rating.elo,
    params.elo,
    ctx.neutralVenue,
  );
  components.push({
    component: 'elo',
    weight: weights.elo ?? 0,
    outcomes: outcomeList(eloOutcomeProbabilities(eloExpectation, ctx.league.drawRate)),
  });

  components.push({
    component: 'form',
    weight: weights.form ?? 0,
    outcomes: outcomeList(formComponentProbabilities(features, ctx.league)),
  });

  const market = marketComponent(ctx);
  if (market) {
    // Weight 0: shown for comparison in the UI, never blended into the model
    // probability. Treating the book as ground truth would make every "edge"
    // circular.
    components.push({ component: 'market', weight: 0, outcomes: market });
  }

  return {
    components,
    expectedHomeScore: goals.home,
    expectedAwayScore: goals.away,
  };
}

export const footballModule: SportModule = {
  key: 'football',
  markets: ['MATCH_WINNER', 'OVER_UNDER', 'BTTS', 'CORRECT_SCORE', 'ASIAN_HANDICAP'],
  featuresVersion: FEATURES_VERSION,
  defaultParameters: FOOTBALL_DEFAULT_PARAMETERS,
  classes: [...FOOTBALL_CLASSES],
  usesMl: false,
  buildFeatures: buildFootballFeatures,
  predict: footballPredict,
  resultClass: (match) => {
    if (match.homeScore > match.awayScore) return 'HOME';
    if (match.homeScore === match.awayScore) return 'DRAW';
    return 'AWAY';
  },
};

/** Exposed for tests and for the odds panel. */
export { impliedProbability };
