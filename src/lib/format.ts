/** Presentation helpers. Formatting lives here so every view agrees. */

export function percent(value: number | null | undefined, decimals = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(decimals)}%`;
}

/** Percentage-point figures carry an explicit sign; edges are signed quantities. */
export function signedPercent(value: number | null | undefined, decimals = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const formatted = (value * 100).toFixed(decimals);
  return `${value > 0 ? '+' : ''}${formatted}%`;
}

export function decimal(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toFixed(decimals);
}

export function integer(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return Math.round(value).toLocaleString('en-GB');
}

export function money(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value < 0 ? '−' : ''}${Math.abs(value).toFixed(decimals)}`;
}

export function kickoffTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });
}

export function kickoffDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

export function kickoffFull(iso: string): string {
  return `${kickoffDate(iso)} ${kickoffTime(iso)} UTC`;
}

export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Relative age, e.g. "2 minutes ago". Used by the freshness indicators, which
 * must make stale data obvious rather than letting it look live.
 */
export function relativeTime(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never';
  const elapsed = now - new Date(iso).getTime();
  if (elapsed < 0) return 'in the future';
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** Hours after which the interface warns that data may be outdated. */
export const STALE_AFTER_HOURS = 12;

export function isStale(iso: string | null, now = Date.now()): boolean {
  if (!iso) return true;
  return now - new Date(iso).getTime() > STALE_AFTER_HOURS * 3_600_000;
}

const SELECTION_LABELS: Record<string, string> = {
  HOME: 'Home', DRAW: 'Draw', AWAY: 'Away',
  OVER: 'Over', UNDER: 'Under', YES: 'Yes', NO: 'No',
};

export function selectionLabel(selection: string, line?: number | null): string {
  const base = SELECTION_LABELS[selection] ?? selection;
  return line === null || line === undefined ? base : `${base} ${line}`;
}

const MARKET_LABELS: Record<string, string> = {
  MATCH_WINNER: 'Match winner',
  OVER_UNDER: 'Over / under',
  BTTS: 'Both teams to score',
  CORRECT_SCORE: 'Correct score',
  ASIAN_HANDICAP: 'Asian handicap',
  POINT_SPREAD: 'Point spread',
  SET_WINNER: 'Set winner',
  TOTAL_GAMES: 'Total games',
  HANDICAP_GAMES: 'Games handicap',
};

export function marketLabel(market: string): string {
  return MARKET_LABELS[market] ?? market;
}

const COMPONENT_LABELS: Record<string, string> = {
  poisson: 'Poisson goals',
  hierarchical: 'Serve hierarchy',
  normal: 'Points model',
  elo: 'Elo rating',
  form: 'Weighted form',
  ml: 'ML baseline',
  market: 'Bookmaker market',
};

export function componentLabel(component: string): string {
  return COMPONENT_LABELS[component] ?? component;
}

export function sportLabel(sportKey: string): string {
  return sportKey.charAt(0).toUpperCase() + sportKey.slice(1);
}
