/**
 * openfootball provider — real football fixtures and results.
 *
 * Reads the public-domain `openfootball/football.json` datasets, which publish
 * the full season schedule for Europe's major leagues: real clubs, real
 * kick-off dates, and real scores that fill in as matches are played. A match
 * with a `score` has finished; one without it is still to come, which is
 * exactly the split the predictor needs.
 *
 * The data is dedicated to the public domain by its maintainers ("use as you
 * please with no restrictions whatsoever"), so no key, quota or attribution
 * requirement applies.
 *
 * What it does NOT carry: bookmaker odds, expected goals, shot counts, lineups
 * or injuries. Those are returned empty rather than invented, and the prediction
 * engine already degrades gracefully — the goal model falls back to scored and
 * conceded goals when xG is absent, and the value engine simply reports no
 * market. A prediction is still produced; an edge is not.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SportKey } from '../prediction/types';
import {
  ProviderError,
  type FetchMatchesOptions,
  type ProviderAvailability,
  type ProviderLeague,
  type ProviderMatch,
  type ProviderOdds,
  type ProviderPlayer,
  type ProviderTeam,
  type SportsDataProvider,
} from './types';

const DEFAULT_BASE_URL =
  'https://raw.githubusercontent.com/openfootball/football.json/master';
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * The five leagues this MVP covers. Each is a top-flight competition with a
 * complete openfootball dataset going back several seasons.
 */
export interface OpenFootballLeague {
  /** Path segment in the dataset, e.g. "en.1". */
  readonly code: string;
  readonly key: string;
  readonly name: string;
  readonly country: string;
  /** Relative competition quality, used to compare ratings across leagues. */
  readonly strength: number;
}

export const OPEN_FOOTBALL_LEAGUES: readonly OpenFootballLeague[] = [
  { code: 'en.1', key: 'premier-league', name: 'Premier League', country: 'England', strength: 1.0 },
  { code: 'es.1', key: 'la-liga', name: 'La Liga', country: 'Spain', strength: 0.97 },
  { code: 'it.1', key: 'serie-a', name: 'Serie A', country: 'Italy', strength: 0.95 },
  { code: 'de.1', key: 'bundesliga', name: 'Bundesliga', country: 'Germany', strength: 0.95 },
  { code: 'fr.1', key: 'ligue-1', name: 'Ligue 1', country: 'France', strength: 0.9 },
];

/**
 * Seasons imported by default: two completed seasons plus the current one.
 *
 * Two full seasons is enough for Elo to converge and for attack/defence rates
 * to stabilise, without pulling data the model does not use.
 */
export const DEFAULT_SEASONS = ['2024-25', '2025-26', '2026-27'] as const;

/** Kick-off used when the fixture list has a date but no confirmed time. */
const DEFAULT_KICKOFF_TIME = '15:00';

interface OpenFootballMatch {
  round?: string;
  date: string;
  time?: string;
  team1: string;
  team2: string;
  score?: { ht?: [number, number]; ft?: [number, number] };
}

interface OpenFootballSeason {
  name: string;
  matches: OpenFootballMatch[];
}

/** Stable identifier from a club name, so the same club maps across seasons. */
export function teamKey(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Round label ("Matchday 4") to a number, when one is present. */
function roundNumber(round: string | undefined): number | null {
  if (!round) return null;
  const match = /(\d+)/.exec(round);
  return match ? Number(match[1]) : null;
}

export interface OpenFootballOptions {
  readonly baseUrl?: string;
  readonly seasons?: readonly string[];
  readonly leagues?: readonly OpenFootballLeague[];
  /** Directory for cached season files. Set to null to disable caching. */
  readonly cacheDir?: string | null;
  /** How long a cached season file stays fresh. */
  readonly cacheTtlMs?: number;
  /** Clock used to separate fixtures still to come from unrecorded results. */
  readonly now?: Date;
}

export class OpenFootballProvider implements SportsDataProvider {
  readonly name = 'openfootball';
  readonly origin = 'LIVE' as const;

  private readonly baseUrl: string;
  private readonly seasons: readonly string[];
  private readonly leagues: readonly OpenFootballLeague[];
  private readonly cacheDir: string | null;
  private readonly cacheTtlMs: number;
  private readonly now: Date;
  /** In-process memo so one ingestion run fetches each season file once. */
  private readonly memo = new Map<string, OpenFootballSeason>();

  constructor(options: OpenFootballOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.OPENFOOTBALL_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.seasons =
      options.seasons ??
      (process.env.OPENFOOTBALL_SEASONS
        ? process.env.OPENFOOTBALL_SEASONS.split(',').map((s) => s.trim()).filter(Boolean)
        : DEFAULT_SEASONS);
    this.leagues = options.leagues ?? OPEN_FOOTBALL_LEAGUES;
    this.cacheDir =
      options.cacheDir === null
        ? null
        : (options.cacheDir ?? process.env.OPENFOOTBALL_CACHE_DIR ?? path.join(process.cwd(), '.cache', 'openfootball'));
    // Completed results never change; only the current season gains matches.
    this.cacheTtlMs = options.cacheTtlMs ?? 6 * 3_600_000;
    this.now = options.now ?? new Date();
  }

  /** No key required — the dataset is public domain. */
  isConfigured(): boolean {
    return true;
  }

  async fetchLeagues(): Promise<ProviderLeague[]> {
    return this.leagues.map((league) => ({
      key: league.key,
      name: league.name,
      country: league.country,
      sportKey: 'football' as SportKey,
      tier: 1,
      strength: league.strength,
      externalId: league.code,
    }));
  }

  async fetchTeams(leagueKey: string): Promise<ProviderTeam[]> {
    const league = this.leagues.find((entry) => entry.key === leagueKey);
    if (!league) return [];

    // Clubs are derived from the fixture lists; the dataset has no team index.
    // The current season is listed last, so later seasons overwrite earlier
    // ones and a promoted club is attributed to the league it now plays in.
    const teams = new Map<string, ProviderTeam>();
    for (const season of this.seasons) {
      const data = await this.loadSeason(league, season);
      if (!data) continue;
      for (const match of data.matches) {
        for (const name of [match.team1, match.team2]) {
          const key = teamKey(name);
          teams.set(key, {
            key,
            name,
            shortName: shortNameFor(name),
            leagueKey: league.key,
            sportKey: 'football',
            country: league.country,
            externalId: key,
          });
        }
      }
    }
    return [...teams.values()];
  }

  /** The dataset carries no squads, so none are reported. */
  async fetchPlayers(): Promise<ProviderPlayer[]> {
    return [];
  }

  async fetchMatches(options: FetchMatchesOptions): Promise<ProviderMatch[]> {
    if (options.sportKey && options.sportKey !== 'football') return [];

    const leagues = options.leagueKey
      ? this.leagues.filter((league) => league.key === options.leagueKey)
      : this.leagues;

    const matches: ProviderMatch[] = [];
    for (const league of leagues) {
      for (const season of this.seasons) {
        const data = await this.loadSeason(league, season);
        if (!data) continue;

        for (const entry of data.matches) {
          const kickoff = parseKickoff(entry.date, entry.time);
          if (!kickoff) continue;
          if (options.from && kickoff < options.from) continue;
          if (options.to && kickoff > options.to) continue;

          const fullTime = entry.score?.ft;
          const finished = Array.isArray(fullTime) && fullTime.length === 2;
          const home = teamKey(entry.team1);
          const away = teamKey(entry.team2);

          // A match with no score whose kick-off has passed is not an upcoming
          // fixture — the dataset simply has no result for it (older seasons
          // carry occasional gaps). Reporting it as SCHEDULED would put a
          // months-old fixture at the top of the "next matches" list, so it is
          // marked POSTPONED: excluded from the fixture list and, having no
          // score, from the training set too.
          const status: ProviderMatch['status'] = finished
            ? 'FINISHED'
            : kickoff.getTime() < this.now.getTime()
              ? 'POSTPONED'
              : 'SCHEDULED';

          matches.push({
            externalId: `openfootball:${league.code}:${season}:${entry.date}:${home}:${away}`,
            sportKey: 'football',
            leagueKey: league.key,
            season,
            round: roundNumber(entry.round),
            homeTeamKey: home,
            awayTeamKey: away,
            kickoff,
            venue: null,
            neutralVenue: false,
            status,
            homeScore: finished ? fullTime[0] : null,
            awayScore: finished ? fullTime[1] : null,
            scoreDetail: entry.score?.ht
              ? { halfTime: { home: entry.score.ht[0], away: entry.score.ht[1] } }
              : undefined,
          });
        }
      }
    }
    return matches;
  }

  /** The dataset carries no prices. */
  async fetchOdds(): Promise<ProviderOdds[]> {
    return [];
  }

  /** The dataset carries no team news. */
  async fetchAvailability(): Promise<ProviderAvailability[]> {
    return [];
  }

  /**
   * Loads one season file, preferring a fresh cache entry.
   *
   * A missing season is not an error: a league may not have published the
   * upcoming season yet, and the importer should carry on with what exists.
   */
  private async loadSeason(
    league: OpenFootballLeague,
    season: string,
  ): Promise<OpenFootballSeason | null> {
    const memoKey = `${league.code}:${season}`;
    const memoised = this.memo.get(memoKey);
    if (memoised) return memoised;

    const cached = await this.readCache(memoKey);
    if (cached) {
      this.memo.set(memoKey, cached);
      return cached;
    }

    const url = `${this.baseUrl}/${season}/${league.code}.json`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new ProviderError(
          `openfootball returned HTTP ${response.status} for ${season}/${league.code}`,
          this.name,
          undefined,
          response.status >= 500 || response.status === 429,
        );
      }

      const data = (await response.json()) as OpenFootballSeason;
      if (!Array.isArray(data?.matches)) {
        throw new ProviderError(
          `openfootball payload for ${season}/${league.code} has no match list`,
          this.name,
        );
      }

      await this.writeCache(memoKey, data);
      this.memo.set(memoKey, data);
      return data;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ProviderError(`openfootball request for ${season}/${league.code} timed out`, this.name, error, true);
      }
      throw new ProviderError(
        `openfootball request for ${season}/${league.code} failed`,
        this.name,
        error,
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private cachePath(memoKey: string): string | null {
    if (!this.cacheDir) return null;
    return path.join(this.cacheDir, `${memoKey.replace(/[:/]/g, '_')}.json`);
  }

  private async readCache(memoKey: string): Promise<OpenFootballSeason | null> {
    const file = this.cachePath(memoKey);
    if (!file) return null;
    try {
      const stat = await fs.stat(file);
      if (Date.now() - stat.mtimeMs > this.cacheTtlMs) return null;
      return JSON.parse(await fs.readFile(file, 'utf8')) as OpenFootballSeason;
    } catch {
      // A missing or unreadable cache entry simply means "fetch it".
      return null;
    }
  }

  private async writeCache(memoKey: string, data: OpenFootballSeason): Promise<void> {
    const file = this.cachePath(memoKey);
    if (!file) return;
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(data), 'utf8');
    } catch {
      // Caching is an optimisation; failing to write it must not fail the import.
    }
  }
}

/**
 * Combines the fixture's date and time into a UTC instant.
 *
 * Future fixtures frequently have no confirmed kick-off time (broadcasters set
 * those later), so a mid-afternoon default is used. That only affects display
 * ordering within a day, never which matches count as already played.
 */
export function parseKickoff(date: string, time: string | undefined): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const clock = time && /^\d{1,2}:\d{2}$/.test(time) ? time.padStart(5, '0') : DEFAULT_KICKOFF_TIME;
  const parsed = new Date(`${date}T${clock}:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Three-letter label for tables, derived from the club's name. */
export function shortNameFor(name: string): string {
  const cleaned = name
    .replace(/\b(FC|AFC|CF|AC|SC|SS|SSC|US|UC|AS|RC|CD|UD|VfL|VfB|TSG|SV|BSC|FSV|SpVgg|1\.)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const source = cleaned.length >= 3 ? cleaned : name;
  const words = source.split(/[\s-]+/).filter(Boolean);
  if (words.length >= 3) return words.slice(0, 3).map((w) => w[0]).join('').toUpperCase();
  if (words.length === 2) return (words[0].slice(0, 2) + words[1][0]).toUpperCase();
  return source.replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase();
}
