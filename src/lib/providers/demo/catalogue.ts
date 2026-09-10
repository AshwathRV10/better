/**
 * Demo league and competitor catalogue.
 *
 * These are deliberately fictional names. Using invented clubs and players
 * makes it structurally impossible for simulated results to be mistaken for
 * real fixtures involving real teams.
 */

import type { SportKey } from '../../prediction/types';

export interface DemoLeagueDefinition {
  readonly key: string;
  readonly name: string;
  readonly country: string;
  readonly sportKey: SportKey;
  readonly tier: number;
  readonly strength: number;
  /** Mean goals/points per match across the whole competition. */
  readonly averageTotal: number;
  /** Multiplicative (football) or additive (basketball) home advantage. */
  readonly homeAdvantage: number;
  /**
   * How far team quality spreads attack and defence around 1.0.
   *
   * Football tolerates a wide spread because goals are low-count and noisy.
   * Basketball needs a narrow one: NBA offensive ratings span only about +/-6%
   * of the league mean, and a wider spread produces impossible scorelines.
   */
  readonly attackSpread: number;
  readonly defenceSpread: number;
  readonly seed: number;
  readonly competitors: readonly DemoCompetitor[];
}

export interface DemoCompetitor {
  readonly key: string;
  readonly name: string;
  readonly shortName: string;
  readonly city: string;
  /** Latent quality on a 0..1 scale; drives attack, defence and strength. */
  readonly quality: number;
}

const PREMIER_DIVISION: DemoCompetitor[] = [
  { key: 'northgate-united', name: 'Northgate United', shortName: 'NGU', city: 'Northgate', quality: 0.93 },
  { key: 'riverside-city', name: 'Riverside City', shortName: 'RVC', city: 'Riverside', quality: 0.9 },
  { key: 'kingsbridge-fc', name: 'Kingsbridge FC', shortName: 'KGB', city: 'Kingsbridge', quality: 0.85 },
  { key: 'ashford-rovers', name: 'Ashford Rovers', shortName: 'ASH', city: 'Ashford', quality: 0.78 },
  { key: 'westport-albion', name: 'Westport Albion', shortName: 'WPA', city: 'Westport', quality: 0.72 },
  { key: 'stonefield-town', name: 'Stonefield Town', shortName: 'STF', city: 'Stonefield', quality: 0.66 },
  { key: 'granville-athletic', name: 'Granville Athletic', shortName: 'GRA', city: 'Granville', quality: 0.6 },
  { key: 'oakhaven-fc', name: 'Oakhaven FC', shortName: 'OAK', city: 'Oakhaven', quality: 0.55 },
  { key: 'marlow-county', name: 'Marlow County', shortName: 'MLC', city: 'Marlow', quality: 0.5 },
  { key: 'eastvale-wanderers', name: 'Eastvale Wanderers', shortName: 'EVW', city: 'Eastvale', quality: 0.45 },
  { key: 'brackenhill', name: 'Brackenhill', shortName: 'BRK', city: 'Brackenhill', quality: 0.4 },
  { key: 'silverbrook-fc', name: 'Silverbrook FC', shortName: 'SLV', city: 'Silverbrook', quality: 0.35 },
  { key: 'thornbury-rangers', name: 'Thornbury Rangers', shortName: 'THR', city: 'Thornbury', quality: 0.3 },
  { key: 'clearwater-fc', name: 'Clearwater FC', shortName: 'CLW', city: 'Clearwater', quality: 0.24 },
  { key: 'harrowgate-city', name: 'Harrowgate City', shortName: 'HGC', city: 'Harrowgate', quality: 0.18 },
  { key: 'penbury-united', name: 'Penbury United', shortName: 'PNB', city: 'Penbury', quality: 0.12 },
];

const CONTINENTAL_LIGA: DemoCompetitor[] = [
  { key: 'atletico-verano', name: 'Atlético Verano', shortName: 'AVR', city: 'Verano', quality: 0.95 },
  { key: 'real-montara', name: 'Real Montara', shortName: 'RMT', city: 'Montara', quality: 0.91 },
  { key: 'cd-solano', name: 'CD Solano', shortName: 'SOL', city: 'Solano', quality: 0.82 },
  { key: 'union-caldera', name: 'Unión Caldera', shortName: 'UCL', city: 'Caldera', quality: 0.74 },
  { key: 'sporting-brava', name: 'Sporting Brava', shortName: 'SBR', city: 'Brava', quality: 0.68 },
  { key: 'racing-mirador', name: 'Racing Mirador', shortName: 'RMI', city: 'Mirador', quality: 0.58 },
  { key: 'deportivo-alba', name: 'Deportivo Alba', shortName: 'DAL', city: 'Alba', quality: 0.5 },
  { key: 'cf-navarro', name: 'CF Navarro', shortName: 'NAV', city: 'Navarro', quality: 0.43 },
  { key: 'club-estrella', name: 'Club Estrella', shortName: 'EST', city: 'Estrella', quality: 0.36 },
  { key: 'ud-puerto', name: 'UD Puerto', shortName: 'PUE', city: 'Puerto', quality: 0.28 },
  { key: 'atletico-lomas', name: 'Atlético Lomas', shortName: 'ALO', city: 'Lomas', quality: 0.2 },
  { key: 'cd-ribera', name: 'CD Ribera', shortName: 'RIB', city: 'Ribera', quality: 0.13 },
];

const HOOPS_CONFERENCE: DemoCompetitor[] = [
  { key: 'summit-peaks', name: 'Summit Peaks', shortName: 'SUM', city: 'Summit', quality: 0.94 },
  { key: 'lakeside-current', name: 'Lakeside Current', shortName: 'LAK', city: 'Lakeside', quality: 0.88 },
  { key: 'ironworks-forge', name: 'Ironworks Forge', shortName: 'IRN', city: 'Ironworks', quality: 0.8 },
  { key: 'capital-sentinels', name: 'Capital Sentinels', shortName: 'CAP', city: 'Capital', quality: 0.73 },
  { key: 'harbor-tide', name: 'Harbor Tide', shortName: 'HAR', city: 'Harbor', quality: 0.65 },
  { key: 'desert-vipers', name: 'Desert Vipers', shortName: 'DSV', city: 'Mesa Verde', quality: 0.57 },
  { key: 'pinecrest-timber', name: 'Pinecrest Timber', shortName: 'PIN', city: 'Pinecrest', quality: 0.48 },
  { key: 'foundry-anvils', name: 'Foundry Anvils', shortName: 'FDY', city: 'Foundry', quality: 0.4 },
  { key: 'northwind-gales', name: 'Northwind Gales', shortName: 'NWG', city: 'Northwind', quality: 0.32 },
  { key: 'crescent-comets', name: 'Crescent Comets', shortName: 'CRC', city: 'Crescent', quality: 0.22 },
];

const TENNIS_FIELD: DemoCompetitor[] = [
  { key: 'l-fontaine', name: 'L. Fontaine', shortName: 'FON', city: 'Lyon', quality: 0.96 },
  { key: 'm-okafor', name: 'M. Okafor', shortName: 'OKA', city: 'Lagos', quality: 0.92 },
  { key: 'd-sorensen', name: 'D. Sorensen', shortName: 'SOR', city: 'Aarhus', quality: 0.87 },
  { key: 'r-castellano', name: 'R. Castellano', shortName: 'CAS', city: 'Bologna', quality: 0.82 },
  { key: 'k-navarro', name: 'K. Navarro', shortName: 'NVR', city: 'Valencia', quality: 0.76 },
  { key: 'j-lindqvist', name: 'J. Lindqvist', shortName: 'LIN', city: 'Uppsala', quality: 0.7 },
  { key: 't-brennan', name: 'T. Brennan', shortName: 'BRN', city: 'Cork', quality: 0.63 },
  { key: 'a-kovacs', name: 'A. Kovács', shortName: 'KOV', city: 'Debrecen', quality: 0.57 },
  { key: 's-yamamoto', name: 'S. Yamamoto', shortName: 'YAM', city: 'Sendai', quality: 0.5 },
  { key: 'p-almeida', name: 'P. Almeida', shortName: 'ALM', city: 'Porto', quality: 0.43 },
  { key: 'n-petrov', name: 'N. Petrov', shortName: 'PET', city: 'Plovdiv', quality: 0.36 },
  { key: 'c-dubois', name: 'C. Dubois', shortName: 'DUB', city: 'Nantes', quality: 0.3 },
  { key: 'h-mueller', name: 'H. Müller', shortName: 'MUE', city: 'Freiburg', quality: 0.24 },
  { key: 'w-adeyemi', name: 'W. Adeyemi', shortName: 'ADE', city: 'Abuja', quality: 0.17 },
  { key: 'g-rossi', name: 'G. Rossi', shortName: 'ROS', city: 'Bari', quality: 0.11 },
  { key: 'v-hasanov', name: 'V. Hasanov', shortName: 'HAS', city: 'Baku', quality: 0.06 },
];

export const DEMO_LEAGUES: readonly DemoLeagueDefinition[] = [
  {
    key: 'premier-division',
    name: 'Premier Division',
    country: 'Demoland',
    sportKey: 'football',
    tier: 1,
    strength: 1.0,
    averageTotal: 2.72,
    homeAdvantage: 1.16,
    seed: 20260101,
    attackSpread: 0.75,
    defenceSpread: 0.65,
    competitors: PREMIER_DIVISION,
  },
  {
    key: 'continental-liga',
    name: 'Continental Liga',
    country: 'Iberia Nova',
    sportKey: 'football',
    tier: 1,
    strength: 0.96,
    averageTotal: 2.58,
    homeAdvantage: 1.19,
    seed: 20260202,
    attackSpread: 0.75,
    defenceSpread: 0.65,
    competitors: CONTINENTAL_LIGA,
  },
  {
    key: 'hoops-conference',
    name: 'Hoops Conference',
    country: 'Demoland',
    sportKey: 'basketball',
    tier: 1,
    strength: 1.0,
    averageTotal: 226,
    homeAdvantage: 2.6,
    seed: 20260303,
    attackSpread: 0.07,
    defenceSpread: 0.07,
    competitors: HOOPS_CONFERENCE,
  },
  {
    key: 'open-tour',
    name: 'International Open Tour',
    country: null as unknown as string,
    sportKey: 'tennis',
    tier: 1,
    strength: 1.0,
    averageTotal: 22,
    homeAdvantage: 1.0,
    seed: 20260404,
    attackSpread: 0.5,
    defenceSpread: 0.5,
    competitors: TENNIS_FIELD,
  },
];

/** Fictional bookmakers. Prices are simulated, not scraped from anywhere. */
export const DEMO_BOOKMAKERS = ['DemoBook', 'SimBet', 'MockOdds'] as const;

export const DEMO_POSITIONS = ['GK', 'DF', 'DF', 'DF', 'DF', 'MF', 'MF', 'MF', 'FW', 'FW', 'FW'] as const;

const FIRST_NAMES = [
  'Adam', 'Bruno', 'Caleb', 'Diego', 'Elias', 'Felix', 'Gabriel', 'Hugo', 'Idris', 'Jonas',
  'Kai', 'Lucas', 'Mateo', 'Noah', 'Omar', 'Pierre', 'Quinn', 'Rafael', 'Samuel', 'Tomas',
  'Viktor', 'Wesley', 'Xavier', 'Yusuf', 'Zane',
];

const LAST_NAMES = [
  'Almeida', 'Berg', 'Costa', 'Delgado', 'Eriksen', 'Ferreira', 'Grant', 'Hoffman', 'Ivanov',
  'Jansen', 'Keller', 'Larsen', 'Moreau', 'Novak', 'Ortiz', 'Pereira', 'Quintero', 'Rossi',
  'Silva', 'Tanaka', 'Ustinov', 'Vargas', 'Weber', 'Yilmaz', 'Zimmer',
];

/** Deterministic player name from a numeric index. */
export function demoPlayerName(index: number): string {
  const first = FIRST_NAMES[index % FIRST_NAMES.length];
  const last = LAST_NAMES[Math.floor(index / FIRST_NAMES.length) % LAST_NAMES.length];
  return `${first} ${last}`;
}
