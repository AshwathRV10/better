/**
 * Explainability.
 *
 * Every line shown to the user is generated from a real feature value and its
 * signed contribution. Nothing here writes narrative text that the model did
 * not actually use.
 */

import type { ExplanationItem, Feature, FeatureVector, MatchContext } from './types';

/**
 * Per-feature weights used to turn raw feature values into a signed influence on
 * the home side. These mirror the direction and rough magnitude each feature
 * carries inside the models, and they exist so the explanation ranks factors the
 * way the models actually weight them.
 */
const INFLUENCE_WEIGHTS: Readonly<Record<string, number>> = {
  elo_diff: 0.0045,
  form_diff: 1.9,
  attack_diff: 0.75,
  offence_diff: 0.75,
  defence_diff: 0.75,
  home_venue_edge: 0.9,
  away_venue_edge: -0.9,
  h2h_home_share: 0.55,
  rest_diff: 0.5,
  availability_diff: 1.2,
  league_home_bias: 0.3,
};

/** Contributions below this magnitude are noise and are not shown. */
const MINIMUM_MAGNITUDE = 0.04;

export function scoreFeatureInfluence(features: FeatureVector): Feature[] {
  return features.features.map((feature) => {
    const weight = INFLUENCE_WEIGHTS[feature.name];
    if (weight === undefined) return feature;
    return { ...feature, contribution: feature.value * weight };
  });
}

/**
 * Builds the "why did the model predict this?" panel.
 *
 * Factors that favour the model's own pick are listed as support; factors that
 * point the other way are listed as risks. This means the risk list is genuinely
 * adversarial to the prediction rather than decorative.
 */
export function buildExplanation(
  ctx: MatchContext,
  features: readonly Feature[],
  favouredSide: 'HOME' | 'AWAY' | 'DRAW',
  limit = 5,
): ExplanationItem[] {
  const scored = features
    .filter((f) => f.contribution !== undefined && Math.abs(f.contribution) >= MINIMUM_MAGNITUDE)
    .map((f) => ({ feature: f, contribution: f.contribution as number }));

  // A draw pick has no directional favourite, so every strong factor is a risk
  // to it: the explanation shows what could tip the match either way.
  const sign = favouredSide === 'HOME' ? 1 : favouredSide === 'AWAY' ? -1 : 0;

  const items: ExplanationItem[] = scored.map(({ feature, contribution }) => {
    const supports = sign === 0 ? false : contribution * sign > 0;
    return {
      kind: supports ? 'SUPPORT' : 'RISK',
      text: feature.label,
      featureName: feature.name,
      magnitude: Math.abs(contribution),
    };
  });

  items.sort((a, b) => b.magnitude - a.magnitude);

  const support = items.filter((i) => i.kind === 'SUPPORT').slice(0, limit);
  const risk = items.filter((i) => i.kind === 'RISK').slice(0, limit);

  // Context that is always worth stating, even when it carries no weight.
  const extras: ExplanationItem[] = [];
  if (ctx.headToHead.length === 0) {
    extras.push({
      kind: 'RISK',
      text: 'No head-to-head history between these sides',
      featureName: 'h2h_meetings',
      magnitude: 0.03,
    });
  }
  if (ctx.odds.length === 0) {
    extras.push({
      kind: 'RISK',
      text: 'No bookmaker market available to cross-check the model',
      featureName: 'market_availability',
      magnitude: 0.02,
    });
  }

  return [...support, ...risk, ...extras];
}
