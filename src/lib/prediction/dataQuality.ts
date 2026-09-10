/**
 * Data-quality scoring.
 *
 * A prediction built on two matches of history is not the same product as one
 * built on a full season, and the interface must say so. This produces a 0-100
 * score from observable properties of the context - never a guess - and lists
 * exactly what is missing.
 */

import type { DataQualityReport, FeatureVector, MatchContext } from './types';
import { clamp } from './math/stats';

/** Matches of history at which the sample-size component saturates. */
const SUFFICIENT_HISTORY = 10;
/** Hours after which odds are treated as fully stale. */
const ODDS_STALE_HOURS = 48;

export function assessDataQuality(ctx: MatchContext, features: FeatureVector): DataQualityReport {
  const missing: string[] = [];

  const homeHistory = ctx.home.recentMatches.filter(
    (m) => m.kickoff.getTime() < ctx.asOf.getTime(),
  ).length;
  const awayHistory = ctx.away.recentMatches.filter(
    (m) => m.kickoff.getTime() < ctx.asOf.getTime(),
  ).length;
  const historyScore =
    (clamp(homeHistory / SUFFICIENT_HISTORY, 0, 1) + clamp(awayHistory / SUFFICIENT_HISTORY, 0, 1)) / 2;
  if (homeHistory < 3) missing.push(`Only ${homeHistory} recent matches for ${ctx.home.shortName}`);
  if (awayHistory < 3) missing.push(`Only ${awayHistory} recent matches for ${ctx.away.shortName}`);

  const usableOdds = ctx.odds.filter((o) => o.capturedAt.getTime() <= ctx.asOf.getTime());
  let oddsScore = 0;
  if (usableOdds.length === 0) {
    missing.push('No bookmaker odds available');
  } else {
    const newest = Math.max(...usableOdds.map((o) => o.capturedAt.getTime()));
    const ageHours = (ctx.asOf.getTime() - newest) / 3_600_000;
    const freshness = clamp(1 - ageHours / ODDS_STALE_HOURS, 0, 1);
    const coverage = clamp(new Set(usableOdds.map((o) => o.market)).size / 3, 0, 1);
    oddsScore = 0.6 * freshness + 0.4 * coverage;
    if (ageHours > ODDS_STALE_HOURS) missing.push('Bookmaker odds are stale');
  }

  const availabilityReported =
    ctx.home.squadImportanceTotal > 0 && ctx.away.squadImportanceTotal > 0;
  if (!availabilityReported) missing.push('No team-news / availability feed');

  const statsCoverage = (() => {
    const withXg = [...ctx.home.recentMatches, ...ctx.away.recentMatches].filter(
      (m) => m.homeXg !== undefined && m.awayXg !== undefined,
    ).length;
    const total = ctx.home.recentMatches.length + ctx.away.recentMatches.length;
    return total === 0 ? 0 : withXg / total;
  })();
  if (statsCoverage === 0 && ctx.sportKey === 'football') {
    missing.push('No expected-goals data for recent matches');
  }

  const h2hScore = clamp(ctx.headToHead.length / 4, 0, 1);
  if (ctx.headToHead.length === 0) missing.push('No head-to-head history');

  const components = [
    {
      name: 'Match history',
      score: historyScore,
      weight: 0.34,
      detail: `${homeHistory} and ${awayHistory} recent matches available`,
    },
    {
      name: 'Feature completeness',
      score: features.completeness,
      weight: 0.22,
      detail: `${Math.round(features.completeness * 100)}% of features from observed data`,
    },
    {
      name: 'Market availability',
      score: oddsScore,
      weight: 0.2,
      detail: usableOdds.length === 0 ? 'No odds' : `${usableOdds.length} quotes across ${new Set(usableOdds.map((o) => o.market)).size} markets`,
    },
    {
      name: 'Team news',
      score: availabilityReported ? 1 : 0,
      weight: 0.12,
      detail: availabilityReported
        ? `${ctx.home.absentees.length + ctx.away.absentees.length} absentees reported`
        : 'Not reported',
    },
    {
      name: 'Detailed statistics',
      score: statsCoverage,
      weight: 0.06,
      detail: `${Math.round(statsCoverage * 100)}% of matches carry shot/xG detail`,
    },
    {
      name: 'Head-to-head',
      score: h2hScore,
      weight: 0.06,
      detail: `${ctx.headToHead.length} previous meetings`,
    },
  ];

  const score = components.reduce((sum, c) => sum + c.score * c.weight, 0);
  return {
    score: Math.round(clamp(score, 0, 1) * 100),
    components: components.map((c) => ({ ...c, score: Math.round(c.score * 100) })),
    missing,
  };
}
