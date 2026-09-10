import type {
  HistoricalMatch,
  LeagueBaseline,
  MatchContext,
  OddsQuote,
  SportKey,
  TeamContext,
} from '@/lib/prediction/types';

/** Deterministic pseudo-random generator so fixtures never flake. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DAY = 86_400_000;

export function makeMatch(overrides: Partial<HistoricalMatch> & { kickoff: Date }): HistoricalMatch {
  return {
    id: `m-${overrides.kickoff.getTime()}-${overrides.homeTeamId ?? 'h'}`,
    leagueKey: 'test-league',
    homeTeamId: 'home',
    awayTeamId: 'away',
    homeScore: 1,
    awayScore: 1,
    neutralVenue: false,
    ...overrides,
  };
}

/** Builds a run of matches for one team with a fixed goals-for/against profile. */
export function makeHistory(options: {
  teamId: string;
  count: number;
  from: Date;
  goalsFor: number;
  goalsAgainst: number;
  spacingDays?: number;
  opponentPrefix?: string;
  alternateVenue?: boolean;
}): HistoricalMatch[] {
  const spacing = options.spacingDays ?? 7;
  const matches: HistoricalMatch[] = [];
  for (let i = 0; i < options.count; i += 1) {
    const kickoff = new Date(options.from.getTime() - (options.count - i) * spacing * DAY);
    const atHome = options.alternateVenue === false ? true : i % 2 === 0;
    const opponent = `${options.opponentPrefix ?? 'opp'}-${i}`;
    matches.push(
      makeMatch({
        id: `${options.teamId}-h${i}`,
        kickoff,
        homeTeamId: atHome ? options.teamId : opponent,
        awayTeamId: atHome ? opponent : options.teamId,
        homeScore: atHome ? options.goalsFor : options.goalsAgainst,
        awayScore: atHome ? options.goalsAgainst : options.goalsFor,
      }),
    );
  }
  return matches;
}

export function makeTeam(overrides: Partial<TeamContext> & { teamId: string }): TeamContext {
  return {
    name: overrides.teamId,
    shortName: overrides.teamId.toUpperCase().slice(0, 3),
    recentMatches: [],
    rating: { teamId: overrides.teamId, elo: 1500, attack: 1, defence: 1, matchesPlayed: 20 },
    absentees: [],
    squadImportanceTotal: 1,
    ...overrides,
  };
}

export const TEST_LEAGUE: LeagueBaseline = {
  leagueKey: 'test-league',
  name: 'Test League',
  strength: 1,
  averageHomeScore: 1.5,
  averageAwayScore: 1.15,
  homeWinRate: 0.44,
  drawRate: 0.26,
  awayWinRate: 0.3,
  matchesObserved: 380,
};

export function makeContext(
  overrides: Partial<MatchContext> & { sportKey?: SportKey } = {},
): MatchContext {
  const kickoff = overrides.kickoff ?? new Date('2026-03-01T15:00:00Z');
  const asOf = overrides.asOf ?? new Date(kickoff.getTime() - 2 * 3_600_000);
  return {
    matchId: 'match-1',
    sportKey: overrides.sportKey ?? 'football',
    leagueKey: 'test-league',
    kickoff,
    neutralVenue: false,
    home: makeTeam({
      teamId: 'home',
      recentMatches: makeHistory({ teamId: 'home', count: 12, from: kickoff, goalsFor: 2, goalsAgainst: 1 }),
    }),
    away: makeTeam({
      teamId: 'away',
      recentMatches: makeHistory({ teamId: 'away', count: 12, from: kickoff, goalsFor: 1, goalsAgainst: 2 }),
    }),
    headToHead: [],
    league: TEST_LEAGUE,
    odds: [],
    dataTimestamp: asOf,
    asOf,
    ...overrides,
  };
}

export function makeOdds(
  entries: Array<{ selection: string; price: number; market?: string; line?: number }>,
  capturedAt: Date,
  bookmaker = 'DemoBook',
): OddsQuote[] {
  return entries.map((entry) => ({
    bookmaker,
    market: (entry.market ?? 'MATCH_WINNER') as OddsQuote['market'],
    selection: entry.selection,
    line: entry.line,
    price: entry.price,
    capturedAt,
  }));
}
