import { describe, expect, it } from 'vitest';
import {
  FeatureBuilder,
  computeAvailability,
  computeForm,
  computeHeadToHead,
  computeRest,
  computeStrength,
  computeVenueRecord,
  matchesBefore,
  outcomeFor,
  pointsFor,
} from '@/lib/prediction/features';
import { exponentialWeights, shrink, weightedMean } from '@/lib/prediction/math/stats';
import { DAY, TEST_LEAGUE, makeHistory, makeMatch, makeTeam } from '../helpers/context';

const NOW = new Date('2026-03-01T12:00:00Z');
const FORM_CONFIG = { lookback: 10, halfLifeMatches: 4 };

describe('matchesBefore', () => {
  it('excludes anything at or after the cut-off', () => {
    const matches = [
      makeMatch({ kickoff: new Date(NOW.getTime() - DAY) }),
      makeMatch({ kickoff: NOW }),
      makeMatch({ kickoff: new Date(NOW.getTime() + DAY) }),
    ];
    expect(matchesBefore(matches, NOW)).toHaveLength(1);
  });

  it('returns oldest first and honours the limit by keeping the newest', () => {
    const matches = makeHistory({ teamId: 't', count: 10, from: NOW, goalsFor: 1, goalsAgainst: 0 });
    const limited = matchesBefore(matches, NOW, 3);
    expect(limited).toHaveLength(3);
    expect(limited[0].kickoff.getTime()).toBeLessThan(limited[2].kickoff.getTime());
    expect(limited[2].kickoff.getTime()).toBe(Math.max(...matches.map((m) => m.kickoff.getTime())));
  });
});

describe('outcomeFor / pointsFor', () => {
  const match = makeMatch({ kickoff: NOW, homeTeamId: 'a', awayTeamId: 'b', homeScore: 2, awayScore: 1 });

  it('reads the result from each side', () => {
    expect(outcomeFor(match, 'a')).toBe('W');
    expect(outcomeFor(match, 'b')).toBe('L');
    expect(pointsFor(match, 'a')).toBe(1);
    expect(pointsFor(match, 'b')).toBe(0);
  });

  it('scores a draw as a half point for both', () => {
    const draw = makeMatch({ kickoff: NOW, homeTeamId: 'a', awayTeamId: 'b', homeScore: 1, awayScore: 1 });
    expect(pointsFor(draw, 'a')).toBe(0.5);
    expect(pointsFor(draw, 'b')).toBe(0.5);
  });
});

describe('exponentialWeights', () => {
  it('gives the newest entry the highest weight', () => {
    const weights = exponentialWeights(5, 2);
    expect(weights[4]).toBe(1);
    for (let i = 1; i < weights.length; i += 1) expect(weights[i]).toBeGreaterThan(weights[i - 1]);
  });

  it('halves the weight at exactly one half-life', () => {
    const weights = exponentialWeights(5, 2);
    expect(weights[2]).toBeCloseTo(0.5, 10);
  });

  it('returns an empty array for a zero-length window', () => {
    expect(exponentialWeights(0, 4)).toEqual([]);
  });
});

describe('computeForm', () => {
  it('returns a neutral 0.5 with no history and flags a zero sample', () => {
    const form = computeForm(makeTeam({ teamId: 't' }), NOW, FORM_CONFIG);
    expect(form.weightedPoints).toBe(0.5);
    expect(form.sampleSize).toBe(0);
    expect(form.results).toEqual([]);
  });

  it('weights recent matches above old ones', () => {
    // Five losses then five wins should beat five wins then five losses.
    const improving = [
      ...makeHistory({ teamId: 't', count: 5, from: new Date(NOW.getTime() - 40 * DAY), goalsFor: 0, goalsAgainst: 2 }),
      ...makeHistory({ teamId: 't', count: 5, from: NOW, goalsFor: 2, goalsAgainst: 0 }),
    ];
    const declining = [
      ...makeHistory({ teamId: 't', count: 5, from: new Date(NOW.getTime() - 40 * DAY), goalsFor: 2, goalsAgainst: 0 }),
      ...makeHistory({ teamId: 't', count: 5, from: NOW, goalsFor: 0, goalsAgainst: 2 }),
    ];
    const up = computeForm(makeTeam({ teamId: 't', recentMatches: improving }), NOW, FORM_CONFIG);
    const down = computeForm(makeTeam({ teamId: 't', recentMatches: declining }), NOW, FORM_CONFIG);
    expect(up.weightedPoints).toBeGreaterThan(down.weightedPoints);
    // Their unweighted records are identical, which is the whole point.
    expect(up.unweightedPoints).toBeCloseTo(down.unweightedPoints, 10);
  });

  it('reports results newest-first for display', () => {
    const matches = [
      makeMatch({ kickoff: new Date(NOW.getTime() - 3 * DAY), homeTeamId: 't', awayTeamId: 'x', homeScore: 0, awayScore: 1 }),
      makeMatch({ kickoff: new Date(NOW.getTime() - 1 * DAY), homeTeamId: 't', awayTeamId: 'y', homeScore: 3, awayScore: 0 }),
    ];
    const form = computeForm(makeTeam({ teamId: 't', recentMatches: matches }), NOW, FORM_CONFIG);
    expect(form.results).toEqual(['W', 'L']);
  });

  it('respects the configurable lookback window', () => {
    const matches = makeHistory({ teamId: 't', count: 20, from: NOW, goalsFor: 1, goalsAgainst: 1 });
    expect(computeForm(makeTeam({ teamId: 't', recentMatches: matches }), NOW, { lookback: 5, halfLifeMatches: 4 }).sampleSize).toBe(5);
    expect(computeForm(makeTeam({ teamId: 't', recentMatches: matches }), NOW, { lookback: 15, halfLifeMatches: 4 }).sampleSize).toBe(15);
  });

  it('gives a perfect record exactly 1.0', () => {
    const matches = makeHistory({ teamId: 't', count: 6, from: NOW, goalsFor: 3, goalsAgainst: 0 });
    expect(computeForm(makeTeam({ teamId: 't', recentMatches: matches }), NOW, FORM_CONFIG).weightedPoints).toBeCloseTo(1, 10);
  });
});

describe('shrink', () => {
  it('returns the prior with no observations', () => {
    expect(shrink(5, 0, 1, 6)).toBe(1);
  });

  it('approaches the sample value as observations grow', () => {
    expect(shrink(2, 6, 1, 6)).toBeCloseTo(1.5, 10);
    expect(shrink(2, 100, 1, 6)).toBeGreaterThan(1.9);
  });
});

describe('computeStrength', () => {
  it('shrinks a small sample toward the league average', () => {
    const prolific = makeHistory({ teamId: 't', count: 2, from: NOW, goalsFor: 4, goalsAgainst: 0 });
    const strength = computeStrength(makeTeam({ teamId: 't', recentMatches: prolific }), NOW, TEST_LEAGUE, 20);
    const rawRatio = 4 / ((TEST_LEAGUE.averageHomeScore + TEST_LEAGUE.averageAwayScore) / 2);
    expect(strength.attack).toBeLessThan(rawRatio);
    expect(strength.attack).toBeGreaterThan(1);
  });

  it('converges toward the raw ratio as the sample grows', () => {
    const rawRatio = 2 / ((TEST_LEAGUE.averageHomeScore + TEST_LEAGUE.averageAwayScore) / 2);
    const attackAfter = (count: number) =>
      computeStrength(
        makeTeam({ teamId: 't', recentMatches: makeHistory({ teamId: 't', count, from: NOW, goalsFor: 2, goalsAgainst: 1 }) }),
        NOW,
        TEST_LEAGUE,
        40,
      ).attack;

    const small = attackAfter(3);
    const medium = attackAfter(20);
    const large = attackAfter(40);

    // Monotonically closer to the raw ratio, never past it.
    expect(small).toBeLessThan(medium);
    expect(medium).toBeLessThan(large);
    expect(large).toBeLessThan(rawRatio);

    // The shrinkage is exactly the documented empirical-Bayes formula with a
    // prior weight of 6 observations.
    expect(medium).toBeCloseTo((rawRatio * 20 + 1 * 6) / 26, 10);
  });

  it('returns neutral strength with no history', () => {
    const strength = computeStrength(makeTeam({ teamId: 't' }), NOW, TEST_LEAGUE, 20);
    expect(strength.attack).toBe(1);
    expect(strength.defence).toBe(1);
    expect(strength.sampleSize).toBe(0);
  });

  it('computes the clean-sheet rate', () => {
    const matches = makeHistory({ teamId: 't', count: 4, from: NOW, goalsFor: 2, goalsAgainst: 0 });
    expect(computeStrength(makeTeam({ teamId: 't', recentMatches: matches }), NOW, TEST_LEAGUE, 20).cleanSheetRate).toBe(1);
  });

  it('reports xG strength only when xG data exists', () => {
    const plain = makeHistory({ teamId: 't', count: 6, from: NOW, goalsFor: 2, goalsAgainst: 1 });
    expect(computeStrength(makeTeam({ teamId: 't', recentMatches: plain }), NOW, TEST_LEAGUE, 20).xgAttack).toBeNull();

    const withXg = plain.map((m) => ({ ...m, homeXg: 1.9, awayXg: 1.1 }));
    expect(computeStrength(makeTeam({ teamId: 't', recentMatches: withXg }), NOW, TEST_LEAGUE, 20).xgAttack).not.toBeNull();
  });
});

describe('computeVenueRecord', () => {
  it('splits home and away records', () => {
    const matches = [
      ...Array.from({ length: 6 }, (_, i) => makeMatch({ kickoff: new Date(NOW.getTime() - (i + 1) * DAY), homeTeamId: 't', awayTeamId: `o${i}`, homeScore: 3, awayScore: 0 })),
      ...Array.from({ length: 6 }, (_, i) => makeMatch({ kickoff: new Date(NOW.getTime() - (i + 10) * DAY), homeTeamId: `o${i}`, awayTeamId: 't', homeScore: 3, awayScore: 0 })),
    ];
    const venue = computeVenueRecord(makeTeam({ teamId: 't', recentMatches: matches }), NOW, TEST_LEAGUE, 20);
    expect(venue.homeWinRate).toBeGreaterThan(venue.awayWinRate);
    expect(venue.homeSample).toBe(6);
    expect(venue.awaySample).toBe(6);
  });

  it('falls back to the league baseline with no matches', () => {
    const venue = computeVenueRecord(makeTeam({ teamId: 't' }), NOW, TEST_LEAGUE, 20);
    expect(venue.homeWinRate).toBeCloseTo(TEST_LEAGUE.homeWinRate, 10);
    expect(venue.awayWinRate).toBeCloseTo(TEST_LEAGUE.awayWinRate, 10);
  });
});

describe('computeHeadToHead', () => {
  it('is neutral with no meetings', () => {
    const h2h = computeHeadToHead([], 'a', 'b', NOW);
    expect(h2h.homeShare).toBe(0.5);
    expect(h2h.meetings).toBe(0);
  });

  it('counts wins, draws and losses', () => {
    const meetings = [
      makeMatch({ kickoff: new Date(NOW.getTime() - 30 * DAY), homeTeamId: 'a', awayTeamId: 'b', homeScore: 2, awayScore: 0 }),
      makeMatch({ kickoff: new Date(NOW.getTime() - 60 * DAY), homeTeamId: 'a', awayTeamId: 'b', homeScore: 1, awayScore: 1 }),
      makeMatch({ kickoff: new Date(NOW.getTime() - 90 * DAY), homeTeamId: 'a', awayTeamId: 'b', homeScore: 0, awayScore: 3 }),
    ];
    const h2h = computeHeadToHead(meetings, 'a', 'b', NOW);
    expect(h2h.meetings).toBe(3);
    expect(h2h.homeWins).toBe(1);
    expect(h2h.draws).toBe(1);
    expect(h2h.awayWins).toBe(1);
    expect(h2h.averageTotalGoals).toBeCloseTo((2 + 2 + 3) / 3, 10);
  });

  it('does not let an old meeting dominate a recent one', () => {
    const recentWin = computeHeadToHead(
      [
        makeMatch({ kickoff: new Date(NOW.getTime() - 10 * DAY), homeTeamId: 'a', awayTeamId: 'b', homeScore: 3, awayScore: 0 }),
        makeMatch({ kickoff: new Date(NOW.getTime() - 2000 * DAY), homeTeamId: 'a', awayTeamId: 'b', homeScore: 0, awayScore: 3 }),
      ],
      'a', 'b', NOW,
    );
    // The recent win should dominate the decayed old loss.
    expect(recentWin.homeShare).toBeGreaterThan(0.9);
  });

  it('excludes meetings after the cut-off', () => {
    const h2h = computeHeadToHead(
      [makeMatch({ kickoff: new Date(NOW.getTime() + DAY), homeTeamId: 'a', awayTeamId: 'b', homeScore: 5, awayScore: 0 })],
      'a', 'b', NOW,
    );
    expect(h2h.meetings).toBe(0);
  });
});

describe('computeRest', () => {
  it('reports full freshness with no history', () => {
    const rest = computeRest(makeTeam({ teamId: 't' }), NOW);
    expect(rest.daysSinceLastMatch).toBeNull();
    expect(rest.freshness).toBe(1);
  });

  it('measures days since the last match', () => {
    const rest = computeRest(
      makeTeam({ teamId: 't', recentMatches: [makeMatch({ kickoff: new Date(NOW.getTime() - 3 * DAY), homeTeamId: 't' })] }),
      NOW,
    );
    expect(rest.daysSinceLastMatch).toBeCloseTo(3, 6);
    expect(rest.freshness).toBeCloseTo(0.5, 6);
  });

  it('penalises fixture congestion', () => {
    const congested = Array.from({ length: 5 }, (_, i) =>
      makeMatch({ kickoff: new Date(NOW.getTime() - (i + 1) * 2 * DAY), homeTeamId: 't' }),
    );
    const rest = computeRest(makeTeam({ teamId: 't', recentMatches: congested }), NOW);
    expect(rest.matchesInLast14Days).toBe(5);
    expect(rest.freshness).toBeLessThan(0.4);
  });

  it('saturates freshness after a full rest period', () => {
    const rest = computeRest(
      makeTeam({ teamId: 't', recentMatches: [makeMatch({ kickoff: new Date(NOW.getTime() - 30 * DAY), homeTeamId: 't' })] }),
      NOW,
    );
    expect(rest.freshness).toBe(1);
  });
});

describe('computeAvailability', () => {
  it('reports nothing missing when the squad is intact', () => {
    const availability = computeAvailability(makeTeam({ teamId: 't', squadImportanceTotal: 1 }));
    expect(availability.missingImportance).toBe(0);
    expect(availability.reported).toBe(true);
  });

  it('flags an unreported feed rather than assuming a full squad', () => {
    const availability = computeAvailability(makeTeam({ teamId: 't', squadImportanceTotal: 0 }));
    expect(availability.reported).toBe(false);
  });

  it('sums absentee importance as a share of the squad', () => {
    const availability = computeAvailability(
      makeTeam({
        teamId: 't',
        squadImportanceTotal: 2,
        absentees: [
          { playerId: 'p1', name: 'A', importance: 0.3, status: 'INJURED' },
          { playerId: 'p2', name: 'B', importance: 0.1, status: 'SUSPENDED' },
        ],
      }),
    );
    expect(availability.missingImportance).toBeCloseTo(0.2, 10);
  });
});

describe('FeatureBuilder', () => {
  it('tracks completeness from the imputed flag', () => {
    const vector = new FeatureBuilder()
      .add('a', 1, 'FORM', 'a')
      .add('b', 2, 'FORM', 'b', { imputed: true })
      .build('1.0.0');
    expect(vector.completeness).toBe(0.5);
    expect(vector.byName).toEqual({ a: 1, b: 2 });
    expect(vector.version).toBe('1.0.0');
  });

  it('replaces non-finite values with 0 rather than propagating NaN', () => {
    const vector = new FeatureBuilder().add('x', Number.NaN, 'FORM', 'x').build('1.0.0');
    expect(vector.byName.x).toBe(0);
  });

  it('reports zero completeness for an empty vector', () => {
    expect(new FeatureBuilder().build('1.0.0').completeness).toBe(0);
  });
});

describe('weightedMean', () => {
  it('matches a hand-computed value', () => {
    expect(weightedMean([1, 2, 3], [1, 1, 2])).toBeCloseTo((1 + 2 + 6) / 4, 10);
  });

  it('returns 0 when all weights are 0', () => {
    expect(weightedMean([1, 2], [0, 0])).toBe(0);
  });
});
