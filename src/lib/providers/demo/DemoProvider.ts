/**
 * Demo data provider.
 *
 * Generates a complete, self-consistent world - leagues, squads, a played
 * season, upcoming fixtures, bookmaker prices and team news - entirely from a
 * seed. Nothing here touches the network.
 *
 * Every record it emits is tagged `origin: 'DEMO'`, and the UI renders a DEMO
 * DATA badge wherever that tag appears. Simulated fixtures must never be
 * presented as live sport.
 */

import type { MarketKey, SportKey } from '../../prediction/types';
import type {
  FetchMatchesOptions,
  ProviderAvailability,
  ProviderLeague,
  ProviderMatch,
  ProviderOdds,
  ProviderPlayer,
  ProviderTeam,
  SportsDataProvider,
} from '../types';
import {
  DEMO_BOOKMAKERS,
  DEMO_LEAGUES,
  DEMO_POSITIONS,
  demoPlayerName,
  type DemoLeagueDefinition,
} from './catalogue';
import {
  basketballExpectedPoints,
  buildRoundRobin,
  createRandom,
  footballGoalRates,
  normalSample,
  pick,
  simulateBasketballMatch,
  simulateFootballMatch,
  simulateTennisMatch,
  spreadKickoff,
  tennisServeRates,
  type SimulatedTeam,
} from './simulation';
import {
  bttsProbability,
  buildScoreMatrix,
  outcomeProbabilities,
  overProbability,
} from '../../prediction/math/poisson';
import { normalCdf } from '../../prediction/math/stats';
import { tennisMatchDistribution, totalGamesOver } from '../../prediction/math/tennis';

/** How many days of completed history the demo world contains. */
export const DEMO_HISTORY_DAYS = 210;
/** How many days of upcoming fixtures the demo world contains. */
export const DEMO_FUTURE_DAYS = 10;
const SQUAD_SIZE = 18;

/** Days between fixture rounds, per sport. */
const SPORT_ROUND_CADENCE_DAYS: Record<SportKey, number> = {
  football: 7,
  basketball: 3,
  tennis: 5,
};

export interface DemoProviderOptions {
  /** Anchor date; everything is generated relative to it. Defaults to now. */
  readonly now?: Date;
  readonly seed?: number;
}

interface GeneratedWorld {
  readonly leagues: ProviderLeague[];
  readonly teams: ProviderTeam[];
  readonly players: ProviderPlayer[];
  readonly matches: ProviderMatch[];
  readonly odds: ProviderOdds[];
  readonly availability: ProviderAvailability[];
}

export class DemoProvider implements SportsDataProvider {
  readonly name = 'demo';
  readonly origin = 'DEMO' as const;

  private readonly anchor: Date;
  private readonly seed: number;
  private world: GeneratedWorld | null = null;

  constructor(options: DemoProviderOptions = {}) {
    this.anchor = options.now ?? new Date();
    this.seed = options.seed ?? 424242;
  }

  isConfigured(): boolean {
    return true;
  }

  async fetchLeagues(): Promise<ProviderLeague[]> {
    return this.generate().leagues;
  }

  async fetchTeams(leagueKey: string): Promise<ProviderTeam[]> {
    return this.generate().teams.filter((team) => team.leagueKey === leagueKey);
  }

  async fetchPlayers(teamKey: string): Promise<ProviderPlayer[]> {
    return this.generate().players.filter((player) => player.teamKey === teamKey);
  }

  async fetchMatches(options: FetchMatchesOptions): Promise<ProviderMatch[]> {
    return this.generate().matches.filter((match) => {
      if (options.sportKey && match.sportKey !== options.sportKey) return false;
      if (options.leagueKey && match.leagueKey !== options.leagueKey) return false;
      if (options.from && match.kickoff < options.from) return false;
      if (options.to && match.kickoff > options.to) return false;
      return true;
    });
  }

  async fetchOdds(matchExternalIds: readonly string[]): Promise<ProviderOdds[]> {
    const wanted = new Set(matchExternalIds);
    return this.generate().odds.filter((quote) => wanted.has(quote.matchExternalId));
  }

  async fetchAvailability(matchExternalIds: readonly string[]): Promise<ProviderAvailability[]> {
    const wanted = new Set(matchExternalIds);
    return this.generate().availability.filter((entry) => wanted.has(entry.matchExternalId));
  }

  /** Builds (and memoises) the whole simulated world. */
  private generate(): GeneratedWorld {
    if (this.world) return this.world;

    const leagues: ProviderLeague[] = [];
    const teams: ProviderTeam[] = [];
    const players: ProviderPlayer[] = [];
    const matches: ProviderMatch[] = [];
    const odds: ProviderOdds[] = [];
    const availability: ProviderAvailability[] = [];

    for (const definition of DEMO_LEAGUES) {
      leagues.push({
        key: definition.key,
        name: definition.name,
        country: definition.country ?? null,
        sportKey: definition.sportKey,
        tier: definition.tier,
        strength: definition.strength,
        externalId: `demo-league-${definition.key}`,
      });

      const random = createRandom(this.seed + definition.seed);
      const simulated = this.buildCompetitors(definition, random);

      for (const team of simulated) {
        teams.push({
          key: team.key,
          name: team.name,
          shortName: team.shortName,
          leagueKey: definition.key,
          sportKey: definition.sportKey,
          country: definition.country ?? null,
          externalId: `demo-team-${team.key}`,
        });
        // Tennis competitors are individuals, so they have no squad.
        if (definition.sportKey !== 'tennis') {
          players.push(...this.buildSquad(team, random));
        }
      }

      const played = this.buildSeason(definition, simulated, random);
      matches.push(...played.matches);
      odds.push(...played.odds);
      availability.push(...played.availability);
    }

    this.world = { leagues, teams, players, matches, odds, availability };
    return this.world;
  }

  private buildCompetitors(
    definition: DemoLeagueDefinition,
    random: () => number,
  ): SimulatedTeam[] {
    return definition.competitors.map((competitor) => {
      // Quality 0..1 maps onto attack/defence multipliers around 1.0 with a
      // little noise, so the ranking is not perfectly recoverable - the models
      // have to work for it.
      const centred = competitor.quality - 0.5;
      // Noise is scaled to the league's own spread so a narrow-spread sport does
      // not have its rating structure swamped by jitter.
      const noise = normalSample(random, 0, definition.attackSpread * 0.07);
      return {
        key: competitor.key,
        name: competitor.name,
        shortName: competitor.shortName,
        city: competitor.city,
        attack: Number(Math.max(0.45, 1 + centred * definition.attackSpread + noise).toFixed(4)),
        defence: Number(Math.max(0.45, 1 - centred * definition.defenceSpread + noise).toFixed(4)),
        strength: Math.round(1500 + centred * 640 + noise * 100),
      };
    });
  }

  private buildSquad(team: SimulatedTeam, random: () => number): ProviderPlayer[] {
    const squad: ProviderPlayer[] = [];
    // Importance decays down the squad list: starters matter more than the
    // bench, which is what makes an injury to a key player move the model.
    let importanceTotal = 0;
    const raw: number[] = [];
    for (let i = 0; i < SQUAD_SIZE; i += 1) {
      const value = Math.exp(-i / 6) * (0.8 + random() * 0.4);
      raw.push(value);
      importanceTotal += value;
    }

    for (let i = 0; i < SQUAD_SIZE; i += 1) {
      const nameIndex = Math.floor(random() * 600);
      squad.push({
        key: `${team.key}-p${i + 1}`,
        name: demoPlayerName(nameIndex),
        teamKey: team.key,
        position: DEMO_POSITIONS[i % DEMO_POSITIONS.length],
        importance: Number((raw[i] / importanceTotal).toFixed(4)),
        externalId: `demo-player-${team.key}-${i + 1}`,
      });
    }
    return squad;
  }

  /** Plays out the season and generates the associated market and team news. */
  private buildSeason(
    definition: DemoLeagueDefinition,
    competitors: SimulatedTeam[],
    random: () => number,
  ): { matches: ProviderMatch[]; odds: ProviderOdds[]; availability: ProviderAvailability[] } {
    const matches: ProviderMatch[] = [];
    const odds: ProviderOdds[] = [];
    const availability: ProviderAvailability[] = [];
    const byKey = new Map(competitors.map((team) => [team.key, team]));

    const seasonStart = new Date(this.anchor.getTime() - DEMO_HISTORY_DAYS * 86_400_000);
    // Cadence per sport, so each calendar looks like the real thing: weekly
    // league football, a dense basketball schedule, a rolling tennis tour.
    const daysBetweenRounds = SPORT_ROUND_CADENCE_DAYS[definition.sportKey];
    const fixtures = buildRoundRobin(
      competitors.map((team) => team.key),
      seasonStart,
      daysBetweenRounds,
      DEMO_HISTORY_DAYS + DEMO_FUTURE_DAYS,
    );

    const season = `${seasonStart.getUTCFullYear()}/${String((seasonStart.getUTCFullYear() + 1) % 100).padStart(2, '0')}`;
    const horizon = new Date(this.anchor.getTime() + DEMO_FUTURE_DAYS * 86_400_000);

    for (const fixture of fixtures) {
      const kickoff = spreadKickoff(random, fixture.kickoff, definition.sportKey);
      if (kickoff > horizon) continue;

      const home = byKey.get(fixture.homeKey);
      const away = byKey.get(fixture.awayKey);
      if (!home || !away) continue;

      const externalId = `demo-${definition.key}-r${fixture.round}-${home.key}-${away.key}`;
      const isFinished = kickoff.getTime() < this.anchor.getTime();

      // Team news is generated for every fixture; absences feed the simulation
      // of finished matches so the effect is genuinely present in the data.
      const homeOut = this.buildAbsences(externalId, home, random, availability);
      const awayOut = this.buildAbsences(externalId, away, random, availability);

      const match = isFinished
        ? this.playMatch(definition, home, away, kickoff, externalId, season, fixture.round, random, homeOut, awayOut)
        : this.scheduleMatch(definition, home, away, kickoff, externalId, season, fixture.round);

      matches.push(match);
      odds.push(...this.buildOdds(definition, home, away, match, random));
    }

    return { matches, odds, availability };
  }

  private buildAbsences(
    matchExternalId: string,
    team: SimulatedTeam,
    random: () => number,
    sink: ProviderAvailability[],
  ): number {
    if (random() > 0.45) return 0;
    const count = random() < 0.75 ? 1 : 2;
    let missingImportance = 0;
    for (let i = 0; i < count; i += 1) {
      const playerIndex = Math.floor(random() * SQUAD_SIZE);
      // Same decay profile as buildSquad, normalised approximately.
      const importance = Math.exp(-playerIndex / 6) / 5.2;
      missingImportance += importance;
      sink.push({
        matchExternalId,
        playerKey: `${team.key}-p${playerIndex + 1}`,
        status: random() < 0.8 ? 'INJURED' : 'SUSPENDED',
        reason: random() < 0.5 ? 'Muscle injury' : 'Late fitness test',
        reportedAt: new Date(),
      });
    }
    return Math.min(missingImportance, 0.5);
  }

  private playMatch(
    definition: DemoLeagueDefinition,
    home: SimulatedTeam,
    away: SimulatedTeam,
    kickoff: Date,
    externalId: string,
    season: string,
    round: number,
    random: () => number,
    missingHome: number,
    missingAway: number,
  ): ProviderMatch {
    const base = {
      externalId,
      sportKey: definition.sportKey,
      leagueKey: definition.key,
      season,
      round,
      homeTeamKey: home.key,
      awayTeamKey: away.key,
      kickoff,
      venue: definition.sportKey === 'tennis' ? 'Centre Court (demo)' : `${home.city} Arena (demo)`,
      neutralVenue: definition.sportKey === 'tennis',
      status: 'FINISHED' as const,
    };

    if (definition.sportKey === 'football') {
      const result = simulateFootballMatch(
        random,
        home,
        away,
        { leagueAverageGoals: definition.averageTotal, homeAdvantage: definition.homeAdvantage },
        missingHome,
        missingAway,
      );
      return {
        ...base,
        homeScore: result.homeScore,
        awayScore: result.awayScore,
        homeStats: {
          xg: result.homeXg,
          shots: result.homeShots,
          shotsOnTarget: result.homeShotsOnTarget,
          possession: result.homePossession,
          corners: result.homeCorners,
        },
        awayStats: {
          xg: result.awayXg,
          shots: result.awayShots,
          shotsOnTarget: result.awayShotsOnTarget,
          possession: Number((100 - result.homePossession).toFixed(1)),
          corners: result.awayCorners,
        },
      };
    }

    if (definition.sportKey === 'basketball') {
      const result = simulateBasketballMatch(
        random,
        home,
        away,
        definition.averageTotal / 2,
        definition.homeAdvantage,
      );
      return {
        ...base,
        homeScore: result.homeScore,
        awayScore: result.awayScore,
        scoreDetail: { quarters: result.quarters, pace: result.homePace },
        homeStats: { extra: { pace: result.homePace } },
        awayStats: { extra: { pace: result.homePace } },
      };
    }

    const result = simulateTennisMatch(random, home, away);
    return {
      ...base,
      homeScore: result.homeScore,
      awayScore: result.awayScore,
      scoreDetail: {
        sets: result.sets,
        homeGames: result.homeGames,
        awayGames: result.awayGames,
      },
    };
  }

  private scheduleMatch(
    definition: DemoLeagueDefinition,
    home: SimulatedTeam,
    away: SimulatedTeam,
    kickoff: Date,
    externalId: string,
    season: string,
    round: number,
  ): ProviderMatch {
    return {
      externalId,
      sportKey: definition.sportKey,
      leagueKey: definition.key,
      season,
      round,
      homeTeamKey: home.key,
      awayTeamKey: away.key,
      kickoff,
      venue: definition.sportKey === 'tennis' ? 'Centre Court (demo)' : `${home.city} Arena (demo)`,
      neutralVenue: definition.sportKey === 'tennis',
      status: 'SCHEDULED',
      homeScore: null,
      awayScore: null,
    };
  }

  /**
   * Generates a bookmaker market.
   *
   * Prices are derived from the SAME generative process that produces the
   * results - the Poisson goal model for football, the normal margin model for
   * basketball, the serve hierarchy for tennis - then blurred and loaded with a
   * margin.
   *
   * Pricing off the true process matters. An earlier version priced from a
   * separate rating formula, which left the book systematically wrong and made
   * the value engine report +400% edges on every mismatch. A real bookmaker is
   * close to efficient, so the demo book must be too: the blur is what leaves
   * small, realistic edges for the model to find.
   */
  private buildOdds(
    definition: DemoLeagueDefinition,
    home: SimulatedTeam,
    away: SimulatedTeam,
    match: ProviderMatch,
    random: () => number,
  ): ProviderOdds[] {
    const quotes: ProviderOdds[] = [];
    const capturedAt = new Date(
      Math.min(match.kickoff.getTime(), this.anchor.getTime()) - 3 * 3_600_000,
    );

    /** Applies the book's view error and margin, then inverts to a price. */
    const priceOf = (probability: number, margin: number, blur: number): number => {
      const blurred = Math.min(0.97, Math.max(0.012, probability * (1 + blur)));
      return Number((1 / (blurred * (1 + margin))).toFixed(2));
    };

    const trueProbabilities = this.trueProbabilities(definition, home, away);

    for (const bookmaker of DEMO_BOOKMAKERS) {
      // Each book carries its own margin and its own small view error.
      const margin = 0.03 + random() * 0.035;
      const blur = normalSample(random, 0, 0.045);

      for (const outcome of trueProbabilities) {
        // Opposite sides of the same market get opposite view errors, which is
        // what makes one side of a book cheap and the other expensive.
        const direction = outcome.blurSign ?? 1;
        quotes.push(
          this.quote(
            match,
            bookmaker,
            outcome.market,
            outcome.selection,
            outcome.line,
            priceOf(outcome.probability, margin, blur * direction),
            capturedAt,
          ),
        );
      }
    }

    return quotes;
  }

  /**
   * The true market probabilities implied by the simulator's own parameters.
   * This is the "correct" answer the bookmaker sees through a blur and the
   * prediction engine has to recover from observed results alone.
   */
  private trueProbabilities(
    definition: DemoLeagueDefinition,
    home: SimulatedTeam,
    away: SimulatedTeam,
  ): Array<{ market: MarketKey; selection: string; line: number | null; probability: number; blurSign?: number }> {
    const outcomes: Array<{ market: MarketKey; selection: string; line: number | null; probability: number; blurSign?: number }> = [];

    if (definition.sportKey === 'football') {
      const rates = footballGoalRates(home, away, {
        leagueAverageGoals: definition.averageTotal,
        homeAdvantage: definition.homeAdvantage,
      });
      // The simulator draws independent Poisson goals, so rho is 0 here: this is
      // the exact distribution the results come from.
      const sm = buildScoreMatrix(rates.home, rates.away, { rho: 0 });
      const result = outcomeProbabilities(sm);
      outcomes.push(
        { market: 'MATCH_WINNER', selection: 'HOME', line: null, probability: result.home, blurSign: 1 },
        { market: 'MATCH_WINNER', selection: 'DRAW', line: null, probability: result.draw, blurSign: -0.5 },
        { market: 'MATCH_WINNER', selection: 'AWAY', line: null, probability: result.away, blurSign: -1 },
      );
      for (const line of [1.5, 2.5, 3.5]) {
        const over = overProbability(sm, line);
        outcomes.push(
          { market: 'OVER_UNDER', selection: 'OVER', line, probability: over, blurSign: 1 },
          { market: 'OVER_UNDER', selection: 'UNDER', line, probability: 1 - over, blurSign: -1 },
        );
      }
      const btts = bttsProbability(sm);
      outcomes.push(
        { market: 'BTTS', selection: 'YES', line: null, probability: btts, blurSign: 1 },
        { market: 'BTTS', selection: 'NO', line: null, probability: 1 - btts, blurSign: -1 },
      );
      return outcomes;
    }

    if (definition.sportKey === 'basketball') {
      const leagueAverage = definition.averageTotal / 2;
      const homePoints = basketballExpectedPoints(leagueAverage, home.attack, away.defence, 1, definition.homeAdvantage);
      const awayPoints = basketballExpectedPoints(leagueAverage, away.attack, home.defence, 1, -definition.homeAdvantage);
      const expectedMargin = homePoints - awayPoints;
      const expectedTotal = homePoints + awayPoints;
      // The simulator draws each side's points with sd 9, so the margin and the
      // total both have sd sqrt(2) * 9.
      const spread = Math.SQRT2 * 9;

      const homeWin = 1 - normalCdf(0, expectedMargin, spread);
      outcomes.push(
        { market: 'MATCH_WINNER', selection: 'HOME', line: null, probability: homeWin, blurSign: 1 },
        { market: 'MATCH_WINNER', selection: 'AWAY', line: null, probability: 1 - homeWin, blurSign: -1 },
      );
      for (const line of [-4.5, 4.5]) {
        const cover = 1 - normalCdf(-line, expectedMargin, spread);
        outcomes.push(
          { market: 'POINT_SPREAD', selection: 'HOME', line, probability: cover, blurSign: 1 },
          { market: 'POINT_SPREAD', selection: 'AWAY', line, probability: 1 - cover, blurSign: -1 },
        );
      }
      const totalLine = Math.round(expectedTotal) + 0.5;
      const over = 1 - normalCdf(totalLine, expectedTotal, spread);
      outcomes.push(
        { market: 'OVER_UNDER', selection: 'OVER', line: totalLine, probability: over, blurSign: 1 },
        { market: 'OVER_UNDER', selection: 'UNDER', line: totalLine, probability: 1 - over, blurSign: -1 },
      );
      return outcomes;
    }

    const serve = tennisServeRates(home, away);
    const distribution = tennisMatchDistribution(serve.home, serve.away, 3);
    outcomes.push(
      { market: 'MATCH_WINNER', selection: 'HOME', line: null, probability: distribution.matchWinA, blurSign: 1 },
      { market: 'MATCH_WINNER', selection: 'AWAY', line: null, probability: 1 - distribution.matchWinA, blurSign: -1 },
    );
    for (const line of [21.5, 22.5]) {
      const over = totalGamesOver(distribution.totalGames, line);
      outcomes.push(
        { market: 'TOTAL_GAMES', selection: 'OVER', line, probability: over, blurSign: 1 },
        { market: 'TOTAL_GAMES', selection: 'UNDER', line, probability: 1 - over, blurSign: -1 },
      );
    }
    return outcomes;
  }

  private quote(
    match: ProviderMatch,
    bookmaker: string,
    market: MarketKey,
    selection: string,
    line: number | null,
    price: number,
    capturedAt: Date,
  ): ProviderOdds {
    return {
      matchExternalId: match.externalId,
      bookmaker,
      market,
      selection,
      line,
      // A price must always be worth more than the stake.
      price: Math.max(1.01, price),
      capturedAt,
    };
  }
}

/** Sports the demo world covers. */
export const DEMO_SPORTS: readonly SportKey[] = ['football', 'basketball', 'tennis'];

/** Exposed so callers can vary the market without reaching into the class. */
export { pick };
