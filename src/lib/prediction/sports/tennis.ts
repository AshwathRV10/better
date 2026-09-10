/**
 * Tennis sport module.
 *
 * Markets: match winner, set winner, total games, games handicap.
 *
 * Everything is derived from the two players' estimated service-point win
 * probabilities, propagated through the point -> game -> set -> match hierarchy
 * in `math/tennis`. Modelling at the point level is what makes the total-games
 * and handicap markets internally consistent with the match-winner price.
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
  computeVenueRecord,
  contextCutoff,
} from '../features';
import { DEFAULT_ELO_CONFIG, eloExpectedScore } from '../models/elo';
import {
  gamesHandicapProbability,
  tennisMatchDistribution,
  totalGamesOver,
} from '../math/tennis';
import { clamp, normalise, sigmoid } from '../math/stats';
import { predictMultinomial } from '../models/mlModel';
import { removeMargin } from '../../odds';

export const TENNIS_CLASSES = ['HOME', 'AWAY'] as const;

/** Total-games lines quoted on a best-of-three match. */
export const TENNIS_TOTAL_GAMES_LINES = [20.5, 21.5, 22.5, 23.5] as const;
export const TENNIS_GAMES_HANDICAP_LINES = [-4.5, -2.5, 2.5, 4.5] as const;

/**
 * Tour-average share of points won on serve. The two players are placed either
 * side of this baseline according to their rating difference.
 */
const BASELINE_SERVE_POINT_WIN = 0.63;

/**
 * Converts an Elo rating gap into a service-point advantage.
 *
 * Point-level edges are tiny, because the point -> game -> set -> match
 * hierarchy amplifies them enormously: a 1.2 percentage-point gap in service
 * points won already makes a ~64% match favourite.
 *
 * The constant is anchored to the published behaviour of tennis Elo, where a
 * 100-point rating gap corresponds to roughly a 64% win probability. Solving the
 * hierarchy backwards from that anchor gives ~2.85 points of serve per 100 Elo.
 * `tennis.test.ts` asserts the anchor holds, so changing this constant without
 * re-deriving it will fail the suite.
 */
const SERVE_POINTS_PER_ELO = 0.0285 / 100;

/**
 * Cap on the serve adjustment. At 0.13 the favourite sits near 97%, which is
 * about as lopsided as a real professional match ever gets.
 */
const MAX_SERVE_ADJUSTMENT = 0.13;

export const TENNIS_DEFAULT_PARAMETERS: ModelParameters = {
  ensembleWeights: { hierarchical: 0.45, elo: 0.25, form: 0.1, ml: 0.2 },
  calibration: null,
  ml: null,
  // Tennis is played on neutral courts, so there is no home advantage term.
  elo: { ...DEFAULT_ELO_CONFIG, kFactor: 24, homeAdvantage: 0 },
  form: { lookback: 12, halfLifeMatches: 5 },
};

function buildTennisFeatures(ctx: MatchContext, params: ModelParameters): FeatureVector {
  const cutoff = contextCutoff(ctx);
  const homeForm = computeForm(ctx.home, cutoff, params.form);
  const awayForm = computeForm(ctx.away, cutoff, params.form);
  const homeVenue = computeVenueRecord(ctx.home, cutoff, ctx.league, 20);
  const awayVenue = computeVenueRecord(ctx.away, cutoff, ctx.league, 20);
  const h2h = computeHeadToHead(ctx.headToHead, ctx.home.teamId, ctx.away.teamId, cutoff);
  const homeRest = computeRest(ctx.home, cutoff);
  const awayRest = computeRest(ctx.away, cutoff);

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
    .add('home_win_rate', homeVenue.homeWinRate, 'HOME_AWAY', `${ctx.home.shortName} wins ${(homeVenue.homeWinRate * 100).toFixed(0)}% of recent matches`, { imputed: homeVenue.homeSample === 0 })
    .add('away_win_rate', awayVenue.awayWinRate, 'HOME_AWAY', `${ctx.away.shortName} wins ${(awayVenue.awayWinRate * 100).toFixed(0)}% of recent matches`, { imputed: awayVenue.awaySample === 0 })
    .add('h2h_home_share', h2h.homeShare - 0.5, 'H2H',
      h2h.meetings === 0 ? 'No previous meetings' : `H2H ${h2h.homeWins}-${h2h.awayWins} over ${h2h.meetings} meetings`,
      { imputed: h2h.meetings === 0 })
    .add('h2h_meetings', h2h.meetings, 'H2H', `${h2h.meetings} previous meetings`, { imputed: h2h.meetings === 0 })
    .add('rest_diff', homeRest.freshness - awayRest.freshness, 'REST',
      `Rest ${homeRest.daysSinceLastMatch === null ? 'n/a' : `${homeRest.daysSinceLastMatch.toFixed(0)}d`} v ${awayRest.daysSinceLastMatch === null ? 'n/a' : `${awayRest.daysSinceLastMatch.toFixed(0)}d`}`,
      { imputed: homeRest.daysSinceLastMatch === null || awayRest.daysSinceLastMatch === null })
    .add('home_freshness', homeRest.freshness, 'REST', `${ctx.home.shortName} ${homeRest.matchesInLast14Days} matches in 14 days`, { imputed: homeRest.daysSinceLastMatch === null })
    .add('away_freshness', awayRest.freshness, 'REST', `${ctx.away.shortName} ${awayRest.matchesInLast14Days} matches in 14 days`, { imputed: awayRest.daysSinceLastMatch === null })
    .add('neutral_venue', 1, 'CONTEXT', 'Neutral court');

  return builder.build(FEATURES_VERSION);
}

export interface ServeEstimate {
  readonly home: number;
  readonly away: number;
}

/**
 * Estimates both players' service-point win probabilities from the rating gap,
 * recent form and fatigue. The pair is kept centred on the tour baseline so the
 * expected match length stays realistic while the edge shifts.
 */
export function estimateServeProbabilities(features: FeatureVector): ServeEstimate {
  const f = features.byName;
  const ratingComponent = (f.elo_diff ?? 0) * SERVE_POINTS_PER_ELO;
  const formComponent = (f.form_diff ?? 0) * 0.02;
  const restComponent = (f.rest_diff ?? 0) * 0.005;
  const h2hComponent = (f.h2h_home_share ?? 0) * 0.01;
  const adjustment = clamp(
    ratingComponent + formComponent + restComponent + h2hComponent,
    -MAX_SERVE_ADJUSTMENT,
    MAX_SERVE_ADJUSTMENT,
  );
  return {
    home: clamp(BASELINE_SERVE_POINT_WIN + adjustment / 2, 0.45, 0.8),
    away: clamp(BASELINE_SERVE_POINT_WIN - adjustment / 2, 0.45, 0.8),
  };
}

function twoWayOutcomes(homeProbability: number): OutcomeProbability[] {
  const [home, away] = normalise([homeProbability, 1 - homeProbability]);
  return [
    { market: 'MATCH_WINNER', selection: 'HOME', probability: home },
    { market: 'MATCH_WINNER', selection: 'AWAY', probability: away },
  ];
}

/** Builds every tennis market from one hierarchical distribution. */
export function tennisMarkets(serve: ServeEstimate, bestOf: 3 | 5 = 3): {
  outcomes: OutcomeProbability[];
  expectedGames: number;
} {
  const distribution = tennisMatchDistribution(serve.home, serve.away, bestOf);
  const outcomes: OutcomeProbability[] = [...twoWayOutcomes(distribution.matchWinA)];

  outcomes.push(
    { market: 'SET_WINNER', selection: 'HOME', probability: distribution.setWinA },
    { market: 'SET_WINNER', selection: 'AWAY', probability: 1 - distribution.setWinA },
  );

  for (const line of TENNIS_TOTAL_GAMES_LINES) {
    const over = totalGamesOver(distribution.totalGames, line);
    outcomes.push({ market: 'TOTAL_GAMES', selection: 'OVER', line, probability: over });
    outcomes.push({ market: 'TOTAL_GAMES', selection: 'UNDER', line, probability: 1 - over });
  }

  for (const line of TENNIS_GAMES_HANDICAP_LINES) {
    const win = gamesHandicapProbability(distribution.gameMargin, line);
    outcomes.push({ market: 'HANDICAP_GAMES', selection: 'HOME', line, probability: win });
    outcomes.push({ market: 'HANDICAP_GAMES', selection: 'AWAY', line, probability: 1 - win });
  }

  return { outcomes, expectedGames: distribution.expectedTotalGames };
}

function tennisMarketComponent(ctx: MatchContext): OutcomeProbability[] | null {
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

function tennisPredict(
  ctx: MatchContext,
  features: FeatureVector,
  params: ModelParameters,
): { components: ComponentPrediction[]; expectedHomeScore?: number; expectedAwayScore?: number } {
  const weights = params.ensembleWeights;
  const components: ComponentPrediction[] = [];

  const serve = estimateServeProbabilities(features);
  const hierarchical = tennisMarkets(serve, 3);
  components.push({
    component: 'hierarchical',
    weight: weights.hierarchical ?? 0,
    outcomes: hierarchical.outcomes,
  });

  const eloExpectation = eloExpectedScore(ctx.home.rating.elo, ctx.away.rating.elo, params.elo, true);
  components.push({
    component: 'elo',
    weight: weights.elo ?? 0,
    outcomes: twoWayOutcomes(eloExpectation),
  });

  const formLogit = 2.4 * (features.byName.form_diff ?? 0) + 0.8 * (features.byName.rest_diff ?? 0);
  components.push({
    component: 'form',
    weight: weights.form ?? 0,
    outcomes: twoWayOutcomes(sigmoid(formLogit)),
  });

  const mlProbabilities = predictMultinomial(params.ml, features.byName);
  if (mlProbabilities && mlProbabilities.length === 2) {
    components.push({
      component: 'ml',
      weight: weights.ml ?? 0,
      outcomes: twoWayOutcomes(mlProbabilities[0]),
    });
  }

  const market = tennisMarketComponent(ctx);
  if (market) components.push({ component: 'market', weight: 0, outcomes: market });

  // Expected "score" for tennis is expressed as games won by each side.
  const expectedMargin = hierarchical.expectedGames * (2 * hierarchical.outcomes[0].probability - 1) * 0.18;
  return {
    components,
    expectedHomeScore: (hierarchical.expectedGames + expectedMargin) / 2,
    expectedAwayScore: (hierarchical.expectedGames - expectedMargin) / 2,
  };
}

export const tennisModule: SportModule = {
  key: 'tennis',
  markets: ['MATCH_WINNER', 'SET_WINNER', 'TOTAL_GAMES', 'HANDICAP_GAMES'],
  featuresVersion: FEATURES_VERSION,
  defaultParameters: TENNIS_DEFAULT_PARAMETERS,
  classes: [...TENNIS_CLASSES],
  usesMl: true,
  buildFeatures: buildTennisFeatures,
  predict: tennisPredict,
  resultClass: (match) => (match.homeScore > match.awayScore ? 'HOME' : 'AWAY'),
};
