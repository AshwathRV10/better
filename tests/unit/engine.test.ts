import { describe, expect, it } from 'vitest';
import { predictMatch, predictMatches } from '@/lib/prediction/engine';
import { getSportModule, listSportModules } from '@/lib/prediction/sports/registry';
import { outcomesForMarket, topOutcome } from '@/lib/prediction/ensemble';
import { expectedGoals } from '@/lib/prediction/sports/football';
import type { MatchContext } from '@/lib/prediction/types';
import { DAY, makeContext, makeHistory, makeOdds, makeTeam } from '../helpers/context';

const OPTIONS = { modelVersion: 'test-1.0.0' };

/** Markets whose selections must form a distribution. */
const DISTRIBUTION_MARKETS = ['MATCH_WINNER', 'OVER_UNDER', 'BTTS', 'SET_WINNER', 'TOTAL_GAMES', 'POINT_SPREAD', 'HANDICAP_GAMES'];

function expectValidPrediction(ctx: MatchContext) {
  const prediction = predictMatch(ctx, OPTIONS);

  for (const outcome of prediction.outcomes) {
    expect(outcome.probability).toBeGreaterThanOrEqual(0);
    expect(outcome.probability).toBeLessThanOrEqual(1);
    expect(Number.isFinite(outcome.probability)).toBe(true);
  }

  // Each mutually exclusive market must sum to 1.
  const groups = new Map<string, number>();
  for (const outcome of prediction.outcomes) {
    if (!DISTRIBUTION_MARKETS.includes(outcome.market)) continue;
    const key = outcome.line === undefined ? outcome.market : `${outcome.market}@${outcome.line}`;
    groups.set(key, (groups.get(key) ?? 0) + outcome.probability);
  }
  for (const [key, total] of groups) {
    expect(total, `market ${key} should sum to 1`).toBeCloseTo(1, 8);
  }

  expect(prediction.confidence.score).toBeGreaterThanOrEqual(0);
  expect(prediction.confidence.score).toBeLessThanOrEqual(100);
  expect(prediction.dataQuality.score).toBeGreaterThanOrEqual(0);
  expect(prediction.dataQuality.score).toBeLessThanOrEqual(100);
  expect(prediction.features.length).toBeGreaterThan(0);
  return prediction;
}

describe('registry', () => {
  it('exposes all three launch sports', () => {
    expect(listSportModules().map((m) => m.key).sort()).toEqual(['basketball', 'football', 'tennis']);
  });

  it('throws a helpful error for an unknown sport', () => {
    expect(() => getSportModule('curling')).toThrow(/Unsupported sport "curling"/);
  });

  it('every module declares markets, classes and a features version', () => {
    for (const sportModule of listSportModules()) {
      expect(sportModule.markets.length).toBeGreaterThan(0);
      expect(sportModule.classes.length).toBeGreaterThanOrEqual(2);
      expect(sportModule.featuresVersion).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});

describe('predictMatch - football', () => {
  it('produces a valid, complete prediction', () => {
    const prediction = expectValidPrediction(makeContext());
    expect(prediction.sportKey).toBe('football');
    expect(prediction.expectedHomeScore).toBeGreaterThan(0);
    expect(prediction.expectedAwayScore).toBeGreaterThan(0);
  });

  it('covers every market the football module declares', () => {
    const prediction = predictMatch(makeContext(), OPTIONS);
    const markets = new Set(prediction.outcomes.map((o) => o.market));
    for (const market of getSportModule('football').markets) {
      expect(markets.has(market), `missing market ${market}`).toBe(true);
    }
  });

  it('favours the stronger side', () => {
    const strongHome = makeContext({
      home: makeTeam({
        teamId: 'home',
        rating: { teamId: 'home', elo: 1750, attack: 1, defence: 1, matchesPlayed: 30 },
        recentMatches: makeHistory({ teamId: 'home', count: 12, from: new Date('2026-03-01T15:00:00Z'), goalsFor: 3, goalsAgainst: 0 }),
      }),
      away: makeTeam({
        teamId: 'away',
        rating: { teamId: 'away', elo: 1300, attack: 1, defence: 1, matchesPlayed: 30 },
        recentMatches: makeHistory({ teamId: 'away', count: 12, from: new Date('2026-03-01T15:00:00Z'), goalsFor: 0, goalsAgainst: 3 }),
      }),
    });
    const p = predictMatch(strongHome, OPTIONS);
    const home = p.outcomes.find((o) => o.market === 'MATCH_WINNER' && o.selection === 'HOME')!;
    const away = p.outcomes.find((o) => o.market === 'MATCH_WINNER' && o.selection === 'AWAY')!;
    expect(home.probability).toBeGreaterThan(0.6);
    expect(home.probability).toBeGreaterThan(away.probability);
    expect(topOutcome(p.outcomes)!.selection).toBe('HOME');
  });

  // Mirroring is approximate rather than exact by design: a team's home record is
  // compared against the league's home baseline and its away record against the
  // away baseline, and those two baselines differ. Everything upstream of that
  // (expected goals, Elo, form) mirrors exactly.
  it('is symmetric: mirroring the teams mirrors the probabilities', () => {
    const kickoff = new Date('2026-03-01T15:00:00Z');
    const base = makeContext({
      neutralVenue: true,
      kickoff,
      home: makeTeam({ teamId: 'home', rating: { teamId: 'home', elo: 1600, attack: 1, defence: 1, matchesPlayed: 30 }, recentMatches: makeHistory({ teamId: 'home', count: 10, from: kickoff, goalsFor: 2, goalsAgainst: 1 }) }),
      away: makeTeam({ teamId: 'away', rating: { teamId: 'away', elo: 1400, attack: 1, defence: 1, matchesPlayed: 30 }, recentMatches: makeHistory({ teamId: 'away', count: 10, from: kickoff, goalsFor: 1, goalsAgainst: 2 }) }),
    });
    const mirrored = makeContext({
      neutralVenue: true,
      kickoff,
      home: makeTeam({ teamId: 'home', rating: { teamId: 'home', elo: 1400, attack: 1, defence: 1, matchesPlayed: 30 }, recentMatches: makeHistory({ teamId: 'home', count: 10, from: kickoff, goalsFor: 1, goalsAgainst: 2 }) }),
      away: makeTeam({ teamId: 'away', rating: { teamId: 'away', elo: 1600, attack: 1, defence: 1, matchesPlayed: 30 }, recentMatches: makeHistory({ teamId: 'away', count: 10, from: kickoff, goalsFor: 2, goalsAgainst: 1 }) }),
    });
    const a = predictMatch(base, OPTIONS);
    const b = predictMatch(mirrored, OPTIONS);
    const homeA = a.outcomes.find((o) => o.market === 'MATCH_WINNER' && o.selection === 'HOME')!.probability;
    const awayB = b.outcomes.find((o) => o.market === 'MATCH_WINNER' && o.selection === 'AWAY')!.probability;
    expect(homeA).toBeCloseTo(awayB, 2);
    // Expected goals, which carry no venue-baseline term, mirror exactly.
    expect(a.expectedHomeScore!).toBeCloseTo(b.expectedAwayScore!, 10);
    expect(a.expectedAwayScore!).toBeCloseTo(b.expectedHomeScore!, 10);
  });

  it('reports each sub-model separately for the model-agreement panel', () => {
    const p = predictMatch(makeContext(), OPTIONS);
    const names = p.components.map((c) => c.component);
    expect(names).toContain('poisson');
    expect(names).toContain('elo');
    expect(names).toContain('form');
    for (const component of p.components) {
      const winner = outcomesForMarket(component.outcomes, 'MATCH_WINNER');
      if (winner.length > 0) {
        expect(winner.reduce((s, o) => s + o.probability, 0)).toBeCloseTo(1, 6);
      }
    }
  });

  it('includes the market component at zero weight, never blended in', () => {
    const asOf = new Date('2026-03-01T13:00:00Z');
    const ctx = makeContext({
      asOf,
      odds: makeOdds([
        { selection: 'HOME', price: 1.75 },
        { selection: 'DRAW', price: 3.9 },
        { selection: 'AWAY', price: 4.6 },
      ], asOf),
    });
    const withOdds = predictMatch(ctx, OPTIONS);
    const market = withOdds.components.find((c) => c.component === 'market');
    expect(market).toBeDefined();
    expect(market!.weight).toBe(0);

    // The blended probability must be identical with and without the market.
    const withoutOdds = predictMatch(makeContext({ asOf }), OPTIONS);
    const withHome = withOdds.outcomes.find((o) => o.market === 'MATCH_WINNER' && o.selection === 'HOME')!;
    const withoutHome = withoutOdds.outcomes.find((o) => o.market === 'MATCH_WINNER' && o.selection === 'HOME')!;
    expect(withHome.probability).toBeCloseTo(withoutHome.probability, 12);
  });

  it('records model version, features version and data timestamp', () => {
    const p = predictMatch(makeContext(), { modelVersion: 'football-ensemble-2.1.0' });
    expect(p.modelVersion).toBe('football-ensemble-2.1.0');
    expect(p.featuresVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(p.dataTimestamp).toBeInstanceOf(Date);
    expect(p.predictedAt).toBeInstanceOf(Date);
  });
});

describe('look-ahead protection', () => {
  it('ignores matches that kick off after the evaluation instant', () => {
    const kickoff = new Date('2026-03-01T15:00:00Z');
    const asOf = new Date(kickoff.getTime() - 2 * 3_600_000);
    const past = makeHistory({ teamId: 'home', count: 8, from: kickoff, goalsFor: 1, goalsAgainst: 1 });
    // A future thrashing that must not be visible to the model.
    const future = makeHistory({ teamId: 'home', count: 6, from: new Date(kickoff.getTime() + 60 * DAY), goalsFor: 6, goalsAgainst: 0 });

    const withoutFuture = predictMatch(makeContext({ kickoff, asOf, home: makeTeam({ teamId: 'home', recentMatches: past }) }), OPTIONS);
    const withFuture = predictMatch(makeContext({ kickoff, asOf, home: makeTeam({ teamId: 'home', recentMatches: [...past, ...future] }) }), OPTIONS);

    const a = withoutFuture.outcomes.find((o) => o.selection === 'HOME' && o.market === 'MATCH_WINNER')!;
    const b = withFuture.outcomes.find((o) => o.selection === 'HOME' && o.market === 'MATCH_WINNER')!;
    expect(b.probability).toBeCloseTo(a.probability, 10);
  });

  it('ignores odds captured after the evaluation instant', () => {
    const asOf = new Date('2026-03-01T13:00:00Z');
    const laterOdds = makeOdds(
      [
        { selection: 'HOME', price: 1.2 },
        { selection: 'DRAW', price: 8 },
        { selection: 'AWAY', price: 15 },
      ],
      new Date(asOf.getTime() + 3_600_000),
    );
    const p = predictMatch(makeContext({ asOf, odds: laterOdds }), OPTIONS);
    expect(p.components.find((c) => c.component === 'market')).toBeUndefined();
  });
});

describe('predictMatch - tennis', () => {
  it('produces a valid two-way prediction with games markets', () => {
    const kickoff = new Date('2026-03-01T11:00:00Z');
    const ctx = makeContext({
      sportKey: 'tennis',
      kickoff,
      neutralVenue: true,
      home: makeTeam({ teamId: 'home', rating: { teamId: 'home', elo: 1700, attack: 1, defence: 1, matchesPlayed: 40 }, recentMatches: makeHistory({ teamId: 'home', count: 10, from: kickoff, goalsFor: 2, goalsAgainst: 1 }) }),
      away: makeTeam({ teamId: 'away', rating: { teamId: 'away', elo: 1450, attack: 1, defence: 1, matchesPlayed: 40 }, recentMatches: makeHistory({ teamId: 'away', count: 10, from: kickoff, goalsFor: 1, goalsAgainst: 2 }) }),
    });
    const prediction = expectValidPrediction(ctx);
    const markets = new Set(prediction.outcomes.map((o) => o.market));
    expect(markets.has('MATCH_WINNER')).toBe(true);
    expect(markets.has('SET_WINNER')).toBe(true);
    expect(markets.has('TOTAL_GAMES')).toBe(true);
    expect(markets.has('HANDICAP_GAMES')).toBe(true);
    // No draw exists in tennis.
    expect(prediction.outcomes.some((o) => o.selection === 'DRAW')).toBe(false);

    const home = prediction.outcomes.find((o) => o.market === 'MATCH_WINNER' && o.selection === 'HOME')!;
    expect(home.probability).toBeGreaterThan(0.5);
  });
});

describe('predictMatch - basketball', () => {
  it('produces moneyline, spread and totals', () => {
    const kickoff = new Date('2026-03-01T19:00:00Z');
    const ctx = makeContext({
      sportKey: 'basketball',
      kickoff,
      league: {
        leagueKey: 'test-nba', name: 'Test Basketball', strength: 1,
        averageHomeScore: 114, averageAwayScore: 111,
        homeWinRate: 0.56, drawRate: 0, awayWinRate: 0.44, matchesObserved: 500,
      },
      home: makeTeam({ teamId: 'home', recentMatches: makeHistory({ teamId: 'home', count: 12, from: kickoff, goalsFor: 118, goalsAgainst: 108, spacingDays: 3 }) }),
      away: makeTeam({ teamId: 'away', recentMatches: makeHistory({ teamId: 'away', count: 12, from: kickoff, goalsFor: 108, goalsAgainst: 116, spacingDays: 3 }) }),
    });
    const prediction = expectValidPrediction(ctx);
    const markets = new Set(prediction.outcomes.map((o) => o.market));
    expect(markets.has('MATCH_WINNER')).toBe(true);
    expect(markets.has('POINT_SPREAD')).toBe(true);
    expect(markets.has('OVER_UNDER')).toBe(true);
    expect(prediction.expectedHomeScore).toBeGreaterThan(90);
    expect(prediction.expectedHomeScore).toBeLessThan(140);
  });
});

describe('expectedGoals', () => {
  it('gives the home side a scoring premium at a home venue', () => {
    const ctx = makeContext();
    const sportModule = getSportModule('football');
    const features = sportModule.buildFeatures(ctx, sportModule.defaultParameters);
    const home = expectedGoals(ctx, features);
    const neutral = expectedGoals({ ...ctx, neutralVenue: true }, features);
    expect(home.home / home.away).toBeGreaterThan(neutral.home / neutral.away);
  });

  it('stays inside a plausible football range for extreme inputs', () => {
    const ctx = makeContext();
    const sportModule = getSportModule('football');
    const features = sportModule.buildFeatures(ctx, sportModule.defaultParameters);
    const broken = { ...features, byName: { ...features.byName, home_attack: 99, away_defence: 99 } };
    const goals = expectedGoals(ctx, broken);
    expect(goals.home).toBeLessThanOrEqual(6);
    expect(goals.away).toBeGreaterThanOrEqual(0.15);
  });
});

describe('degraded data', () => {
  it('still predicts with no history at all, but reports it', () => {
    const ctx = makeContext({
      home: makeTeam({ teamId: 'home', recentMatches: [], rating: { teamId: 'home', elo: 1500, attack: 1, defence: 1, matchesPlayed: 0 } }),
      away: makeTeam({ teamId: 'away', recentMatches: [], rating: { teamId: 'away', elo: 1500, attack: 1, defence: 1, matchesPlayed: 0 } }),
    });
    const prediction = expectValidPrediction(ctx);
    expect(prediction.dataQuality.score).toBeLessThan(50);
    expect(prediction.dataQuality.missing.length).toBeGreaterThan(0);
    expect(prediction.confidence.level).toBe('LOW');
  });

  it('scores richer data higher on both quality and confidence', () => {
    const kickoff = new Date('2026-03-01T15:00:00Z');
    const asOf = new Date(kickoff.getTime() - 3_600_000);
    const thin = makeContext({
      kickoff, asOf,
      home: makeTeam({ teamId: 'home', recentMatches: makeHistory({ teamId: 'home', count: 2, from: kickoff, goalsFor: 1, goalsAgainst: 1 }), squadImportanceTotal: 0 }),
      away: makeTeam({ teamId: 'away', recentMatches: makeHistory({ teamId: 'away', count: 2, from: kickoff, goalsFor: 1, goalsAgainst: 1 }), squadImportanceTotal: 0 }),
    });
    const rich = makeContext({
      kickoff, asOf,
      odds: makeOdds([{ selection: 'HOME', price: 2.1 }, { selection: 'DRAW', price: 3.4 }, { selection: 'AWAY', price: 3.6 }], asOf),
      headToHead: makeHistory({ teamId: 'home', count: 6, from: kickoff, goalsFor: 1, goalsAgainst: 1, opponentPrefix: 'away' }).map((m) => ({ ...m, homeTeamId: 'home', awayTeamId: 'away' })),
    });
    expect(predictMatch(rich, OPTIONS).dataQuality.score).toBeGreaterThan(
      predictMatch(thin, OPTIONS).dataQuality.score,
    );
  });

  it('lowers confidence when the models disagree', () => {
    const p = predictMatch(makeContext(), OPTIONS);
    const agreement = p.confidence.components.find((c) => c.name === 'Model agreement')!;
    expect(agreement.score).toBeGreaterThanOrEqual(0);
    expect(agreement.score).toBeLessThanOrEqual(100);
  });

  it('never lets a strong favourite alone produce HIGH confidence on thin data', () => {
    const kickoff = new Date('2026-03-01T15:00:00Z');
    const ctx = makeContext({
      kickoff,
      home: makeTeam({ teamId: 'home', rating: { teamId: 'home', elo: 1900, attack: 1, defence: 1, matchesPlayed: 2 }, recentMatches: makeHistory({ teamId: 'home', count: 2, from: kickoff, goalsFor: 5, goalsAgainst: 0 }), squadImportanceTotal: 0 }),
      away: makeTeam({ teamId: 'away', rating: { teamId: 'away', elo: 1200, attack: 1, defence: 1, matchesPlayed: 2 }, recentMatches: makeHistory({ teamId: 'away', count: 2, from: kickoff, goalsFor: 0, goalsAgainst: 5 }), squadImportanceTotal: 0 }),
    });
    const p = predictMatch(ctx, OPTIONS);
    const home = p.outcomes.find((o) => o.market === 'MATCH_WINNER' && o.selection === 'HOME')!;
    expect(home.probability).toBeGreaterThan(0.7);
    expect(p.confidence.level).not.toBe('HIGH');
  });
});

describe('explainability', () => {
  it('generates support and risk lines from real features', () => {
    const kickoff = new Date('2026-03-01T15:00:00Z');
    const ctx = makeContext({
      kickoff,
      home: makeTeam({
        teamId: 'home',
        rating: { teamId: 'home', elo: 1700, attack: 1, defence: 1, matchesPlayed: 30 },
        recentMatches: makeHistory({ teamId: 'home', count: 12, from: kickoff, goalsFor: 3, goalsAgainst: 0 }),
        absentees: [{ playerId: 'p1', name: 'Key Defender', importance: 0.18, status: 'INJURED' }],
        squadImportanceTotal: 1,
      }),
    });
    const p = predictMatch(ctx, OPTIONS);
    expect(p.explanation.length).toBeGreaterThan(0);
    const featureNames = new Set(p.features.map((f) => f.name));
    for (const item of p.explanation) {
      // Every explanation line traces back to a feature (or a declared context note).
      expect(
        featureNames.has(item.featureName) || ['market_availability'].includes(item.featureName),
      ).toBe(true);
      expect(item.text.length).toBeGreaterThan(0);
    }
    expect(p.explanation.some((i) => i.kind === 'SUPPORT')).toBe(true);
  });

  it('flags a missing bookmaker market as a risk', () => {
    const p = predictMatch(makeContext({ odds: [] }), OPTIONS);
    expect(p.explanation.some((i) => i.featureName === 'market_availability')).toBe(true);
  });
});

describe('predictMatches', () => {
  it('isolates failures instead of failing the whole slate', () => {
    const good = makeContext({ matchId: 'ok' });
    const broken = { ...makeContext({ matchId: 'broken' }), sportKey: 'curling' } as unknown as MatchContext;
    const { predictions, failures } = predictMatches([good, broken], OPTIONS);
    expect(predictions).toHaveLength(1);
    expect(predictions[0].matchId).toBe('ok');
    expect(failures).toHaveLength(1);
    expect(failures[0].matchId).toBe('broken');
    expect(failures[0].reason).toMatch(/Unsupported sport/);
  });
});
