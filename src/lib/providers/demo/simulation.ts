/**
 * Deterministic sports simulation used to generate demo data.
 *
 * This is NOT a prediction model and must never be confused with one. It is a
 * data *generator*: it invents a league of teams with latent strengths, plays
 * out a full season fixture by fixture, and records the results the way a real
 * provider would. The prediction engine then has to recover those latent
 * strengths from the observable results, exactly as it would with live data.
 *
 * Everything is seeded, so the same seed always produces the same league,
 * the same fixtures and the same results. That makes tests and screenshots
 * reproducible.
 *
 * All output is tagged DEMO and is surfaced as such throughout the UI.
 */

/** Mulberry32: small, fast, fully deterministic PRNG. */
export function createRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller transform: standard normal from two uniforms. */
export function normalSample(random: () => number, mean = 0, sd = 1): number {
  const u1 = Math.max(random(), 1e-12);
  const u2 = random();
  return mean + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Draws from a Poisson distribution using Knuth's algorithm. */
export function poissonSample(random: () => number, lambda: number): number {
  if (lambda <= 0) return 0;
  // Knuth's method is exact and fast enough for the goal rates football uses.
  const limit = Math.exp(-lambda);
  let k = 0;
  let product = random();
  while (product > limit && k < 30) {
    k += 1;
    product *= random();
  }
  return k;
}

export function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length) % items.length];
}

/** A competitor with latent, unobservable qualities the models must infer. */
export interface SimulatedTeam {
  readonly key: string;
  readonly name: string;
  readonly shortName: string;
  readonly city: string;
  /** Latent attacking quality, centred on 1.0. */
  attack: number;
  /** Latent defensive quality, centred on 1.0 (lower is better). */
  defence: number;
  /** Latent overall strength on an Elo-like scale, used for tennis/basketball. */
  strength: number;
}

export interface SimulatedFixture {
  readonly round: number;
  readonly homeKey: string;
  readonly awayKey: string;
  readonly kickoff: Date;
}

/**
 * Builds one round-robin cycle (circle method): every competitor meets every
 * other exactly once, spread across N-1 rounds.
 */
function roundRobinCycle(teamKeys: readonly string[]): Array<Array<{ home: string; away: string }>> {
  const keys = [...teamKeys];
  // The circle method needs an even count; a bye competitor sits out each round.
  if (keys.length % 2 === 1) keys.push('__BYE__');
  const half = keys.length / 2;
  const rotation = keys.slice(1);
  const rounds: Array<Array<{ home: string; away: string }>> = [];

  for (let round = 0; round < keys.length - 1; round += 1) {
    const ordered = [keys[0], ...rotation];
    const pairings: Array<{ home: string; away: string }> = [];
    for (let i = 0; i < half; i += 1) {
      const a = ordered[i];
      const b = ordered[ordered.length - 1 - i];
      if (a === '__BYE__' || b === '__BYE__') continue;
      // Alternate venue by round so each side gets a balanced home schedule.
      const swap = round % 2 === 1;
      pairings.push({ home: swap ? b : a, away: swap ? a : b });
    }
    rounds.push(pairings);
    rotation.unshift(rotation.pop() as string);
  }
  return rounds;
}

/**
 * Builds a fixture calendar that spans the requested window at the sport's own
 * cadence.
 *
 * The round-robin cycle is repeated as many times as needed to fill the window,
 * with venues reversed on alternate cycles. Filling the window matters: the
 * calendar has to run past "now" so the demo world contains upcoming fixtures to
 * predict, not just a completed season.
 */
export function buildRoundRobin(
  teamKeys: readonly string[],
  seasonStart: Date,
  daysBetweenRounds: number,
  spanDays?: number,
): SimulatedFixture[] {
  const cycle = roundRobinCycle(teamKeys);
  if (cycle.length === 0) return [];

  const roundsNeeded =
    spanDays === undefined
      ? cycle.length * 2
      : Math.max(cycle.length, Math.ceil(spanDays / daysBetweenRounds));

  const fixtures: SimulatedFixture[] = [];
  for (let round = 0; round < roundsNeeded; round += 1) {
    const cycleIndex = Math.floor(round / cycle.length);
    const pairings = cycle[round % cycle.length];
    const kickoff = new Date(seasonStart.getTime() + round * daysBetweenRounds * 86_400_000);
    for (const pairing of pairings) {
      // Reverse the venue on every second pass through the cycle.
      const reversed = cycleIndex % 2 === 1;
      fixtures.push({
        round: round + 1,
        homeKey: reversed ? pairing.away : pairing.home,
        awayKey: reversed ? pairing.home : pairing.away,
        kickoff,
      });
    }
  }
  return fixtures;
}

/** Spreads kick-offs across a matchday so a slate looks like a real schedule. */
export function spreadKickoff(random: () => number, base: Date, sportKey: string): Date {
  const dayOffset = Math.floor(random() * 3); // Fri/Sat/Sun style spread
  const hours = sportKey === 'basketball' ? [19, 20, 21] : sportKey === 'tennis' ? [11, 13, 15, 17] : [12, 14, 17, 19];
  const hour = pick(random, hours);
  const minute = pick(random, [0, 15, 30, 45]);
  const kickoff = new Date(base.getTime() + dayOffset * 86_400_000);
  kickoff.setUTCHours(hour, minute, 0, 0);
  return kickoff;
}

export interface FootballResult {
  readonly homeScore: number;
  readonly awayScore: number;
  readonly homeXg: number;
  readonly awayXg: number;
  readonly homeShots: number;
  readonly awayShots: number;
  readonly homeShotsOnTarget: number;
  readonly awayShotsOnTarget: number;
  readonly homePossession: number;
  readonly homeCorners: number;
  readonly awayCorners: number;
}

export interface FootballSimulationConfig {
  readonly leagueAverageGoals: number;
  readonly homeAdvantage: number;
}

/**
 * Plays one football match.
 *
 * Goals are Poisson draws around a rate built from the two sides' latent
 * qualities, and xG is a noisy observation of that same underlying rate. Shot
 * counts are derived from xG so the recorded statistics stay mutually
 * consistent - a team with 0.4 xG never shows 25 shots on target.
 */
/** Expected goals for each side, used by both the simulator and the demo book. */
export function footballGoalRates(
  home: SimulatedTeam,
  away: SimulatedTeam,
  config: FootballSimulationConfig,
  missingHome = 0,
  missingAway = 0,
): { home: number; away: number } {
  const base = config.leagueAverageGoals / 2;
  return {
    home: Math.max(0.15, base * home.attack * away.defence * config.homeAdvantage * (1 - missingHome * 0.4)),
    away: Math.max(0.15, (base * away.attack * home.defence * (1 - missingAway * 0.4)) / config.homeAdvantage),
  };
}

/**
 * Service-point win probabilities used by both the simulator and the demo book.
 *
 * The divisor is chosen so that even the widest matchup in the demo field lands
 * near 93% rather than at a certainty. Real professional tennis has no 100%
 * favourites, and a simulated world that contains them would let the value
 * engine report edges that could never exist.
 */
export function tennisServeRates(home: SimulatedTeam, away: SimulatedTeam): { home: number; away: number } {
  const edge = (home.strength - away.strength) / 5500;
  return {
    home: Math.min(0.76, Math.max(0.52, 0.63 + edge)),
    away: Math.min(0.76, Math.max(0.52, 0.63 - edge)),
  };
}

export function simulateFootballMatch(
  random: () => number,
  home: SimulatedTeam,
  away: SimulatedTeam,
  config: FootballSimulationConfig,
  missingHome = 0,
  missingAway = 0,
): FootballResult {
  const rates = footballGoalRates(home, away, config, missingHome, missingAway);
  const homeRate = rates.home;
  const awayRate = rates.away;

  const homeScore = poissonSample(random, homeRate);
  const awayScore = poissonSample(random, awayRate);

  // xG is the true rate observed with noise; it is not the realised score.
  const homeXg = Math.max(0.05, homeRate + normalSample(random, 0, 0.35));
  const awayXg = Math.max(0.05, awayRate + normalSample(random, 0, 0.35));

  // Roughly 9-10 shots per expected goal, and ~35% of shots are on target.
  const shotsPerXg = 8 + random() * 4;
  const homeShots = Math.round(homeXg * shotsPerXg);
  const awayShots = Math.round(awayXg * shotsPerXg);

  return {
    homeScore,
    awayScore,
    homeXg: Number(homeXg.toFixed(2)),
    awayXg: Number(awayXg.toFixed(2)),
    homeShots,
    awayShots,
    homeShotsOnTarget: Math.max(homeScore, Math.round(homeShots * (0.3 + random() * 0.15))),
    awayShotsOnTarget: Math.max(awayScore, Math.round(awayShots * (0.3 + random() * 0.15))),
    homePossession: Number((50 + normalSample(random, 0, 8)).toFixed(1)),
    homeCorners: Math.round(3 + homeXg * 2 + random() * 3),
    awayCorners: Math.round(3 + awayXg * 2 + random() * 3),
  };
}

export interface BasketballResult {
  readonly homeScore: number;
  readonly awayScore: number;
  readonly homePace: number;
  readonly quarters: Array<{ home: number; away: number }>;
}

/**
 * Expected points for one side of a basketball game.
 *
 * Ratings combine ADDITIVELY, not multiplicatively. Multiplying an offensive
 * and a defensive multiplier compounds them, and even a modest +/-7% spread then
 * produces 30-point expected margins and 130-point blowouts. Real basketball
 * margins have a standard deviation of about 12 points, which the additive form
 * reproduces: each rating contributes a fixed number of points above or below
 * the league mean.
 */
export function basketballExpectedPoints(
  leagueAveragePoints: number,
  attack: number,
  opponentDefence: number,
  pace: number,
  homeCourtPoints: number,
): number {
  const offence = (attack - 1) * leagueAveragePoints;
  const defence = (opponentDefence - 1) * leagueAveragePoints;
  return (leagueAveragePoints + offence + defence) * pace + homeCourtPoints / 2;
}

/**
 * Plays one basketball game. Points are normal around a pace-and-efficiency
 * expectation, which matches how basketball scores actually distribute.
 */
export function simulateBasketballMatch(
  random: () => number,
  home: SimulatedTeam,
  away: SimulatedTeam,
  leagueAveragePoints: number,
  homeCourtPoints: number,
): BasketballResult {
  const pace = 1 + normalSample(random, 0, 0.04);
  const homeExpectation = basketballExpectedPoints(leagueAveragePoints, home.attack, away.defence, pace, homeCourtPoints);
  const awayExpectation = basketballExpectedPoints(leagueAveragePoints, away.attack, home.defence, pace, -homeCourtPoints);

  let homeScore = Math.round(normalSample(random, homeExpectation, 9));
  let awayScore = Math.round(normalSample(random, awayExpectation, 9));
  // Basketball has no draws: overtime resolves a tie.
  if (homeScore === awayScore) {
    if (random() < 0.5) homeScore += Math.max(1, Math.round(Math.abs(normalSample(random, 4, 3))));
    else awayScore += Math.max(1, Math.round(Math.abs(normalSample(random, 4, 3))));
  }

  const quarters: Array<{ home: number; away: number }> = [];
  let homeRemaining = homeScore;
  let awayRemaining = awayScore;
  for (let q = 0; q < 3; q += 1) {
    const homeQuarter = Math.max(10, Math.round(homeScore / 4 + normalSample(random, 0, 4)));
    const awayQuarter = Math.max(10, Math.round(awayScore / 4 + normalSample(random, 0, 4)));
    quarters.push({ home: homeQuarter, away: awayQuarter });
    homeRemaining -= homeQuarter;
    awayRemaining -= awayQuarter;
  }
  quarters.push({ home: homeRemaining, away: awayRemaining });

  return { homeScore, awayScore, homePace: Number(pace.toFixed(3)), quarters };
}

export interface TennisResult {
  readonly homeScore: number; // sets won
  readonly awayScore: number;
  readonly sets: Array<{ home: number; away: number }>;
  readonly homeGames: number;
  readonly awayGames: number;
}

/**
 * Plays one best-of-three tennis match game by game, so the recorded set scores
 * are internally consistent with the games totals.
 */
export function simulateTennisMatch(
  random: () => number,
  home: SimulatedTeam,
  away: SimulatedTeam,
): TennisResult {
  // Latent strength maps onto a service-point edge, mirroring the real model.
  const serveRates = tennisServeRates(home, away);
  const serveHome = serveRates.home;
  const serveAway = serveRates.away;

  const holdProbability = (pointWin: number) => {
    const p = pointWin;
    const q = 1 - p;
    return p ** 4 + 4 * p ** 4 * q + 10 * p ** 4 * q ** 2 + (20 * p ** 3 * q ** 3 * p ** 2) / (p ** 2 + q ** 2);
  };
  const holdHome = holdProbability(serveHome);
  const holdAway = holdProbability(serveAway);

  const sets: Array<{ home: number; away: number }> = [];
  let homeSets = 0;
  let awaySets = 0;
  let homeGames = 0;
  let awayGames = 0;
  let homeServesFirst = random() < 0.5;

  while (homeSets < 2 && awaySets < 2) {
    let h = 0;
    let a = 0;
    let serverIsHome = homeServesFirst;
    while (!((h >= 6 || a >= 6) && Math.abs(h - a) >= 2) && !(h === 7 || a === 7)) {
      if (h === 6 && a === 6) {
        // Tiebreak: a single weighted draw decides the set.
        if (random() < 0.5 + (serveHome - serveAway) * 2) h += 1;
        else a += 1;
        break;
      }
      const holds = serverIsHome ? holdHome : holdAway;
      const serverWins = random() < holds;
      if (serverIsHome === serverWins) h += 1;
      else a += 1;
      serverIsHome = !serverIsHome;
    }
    sets.push({ home: h, away: a });
    homeGames += h;
    awayGames += a;
    if (h > a) homeSets += 1;
    else awaySets += 1;
    // Serve carries over between sets.
    if ((h + a) % 2 === 1) homeServesFirst = !homeServesFirst;
  }

  return { homeScore: homeSets, awayScore: awaySets, sets, homeGames, awayGames };
}
