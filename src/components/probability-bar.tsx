import { clsx } from 'clsx';
import { percent } from '@/lib/format';

export interface ProbabilitySegment {
  readonly label: string;
  readonly probability: number;
  readonly role: 'home' | 'draw' | 'away';
}

const ROLE_FILL: Record<ProbabilitySegment['role'], string> = {
  home: 'bg-home',
  draw: 'bg-draw',
  away: 'bg-away',
};

/**
 * Stacked probability bar for a mutually exclusive market.
 *
 * Segments are separated by a 2px surface gap so adjacent fills never touch, and
 * every segment is labelled in text - the colour is a secondary cue, not the
 * only one.
 */
export function ProbabilityBar({
  segments,
  height = 'md',
  showLabels = true,
}: {
  segments: readonly ProbabilitySegment[];
  height?: 'sm' | 'md' | 'lg';
  showLabels?: boolean;
}) {
  const total = segments.reduce((sum, segment) => sum + segment.probability, 0);
  const safeTotal = total > 0 ? total : 1;

  return (
    <div>
      <div
        className={clsx(
          'flex w-full gap-[2px] overflow-hidden rounded',
          height === 'sm' && 'h-2',
          height === 'md' && 'h-3',
          height === 'lg' && 'h-7',
        )}
        role="img"
        aria-label={segments
          .map((segment) => `${segment.label} ${percent(segment.probability, 0)}`)
          .join(', ')}
      >
        {segments.map((segment) => (
          <div
            key={segment.label}
            className={clsx(ROLE_FILL[segment.role], 'first:rounded-l last:rounded-r')}
            style={{ width: `${(segment.probability / safeTotal) * 100}%` }}
            title={`${segment.label} ${percent(segment.probability)}`}
          />
        ))}
      </div>
      {showLabels ? (
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
          {segments.map((segment) => (
            <span key={segment.label} className="flex items-center gap-1.5 text-[12px]">
              <span
                className={clsx('inline-block h-2 w-2 shrink-0 rounded-[2px]', ROLE_FILL[segment.role])}
                aria-hidden="true"
              />
              <span className="text-ink-secondary">{segment.label}</span>
              <span className="tnum font-semibold text-ink">{percent(segment.probability)}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One selection's model probability against the market's implied probability.
 *
 * Both sit on the same 0-100% axis, so the gap between them *is* the edge. The
 * market is a tick rather than a second bar: two bars would imply two scales.
 */
export function ModelVersusMarket({
  label,
  modelProbability,
  impliedProbability,
  role = 'home',
}: {
  label: string;
  modelProbability: number;
  impliedProbability: number | null;
  role?: ProbabilitySegment['role'];
}) {
  const edge = impliedProbability === null ? null : modelProbability - impliedProbability;
  return (
    <div className="grid grid-cols-[auto_1fr_auto] items-center gap-3">
      <span className="w-16 shrink-0 truncate text-[13px] text-ink-secondary">{label}</span>
      <div className="relative h-5">
        <div className="absolute inset-y-0 left-0 right-0 rounded bg-ink/[0.05]" />
        <div
          className={clsx('absolute inset-y-0 left-0 rounded', ROLE_FILL[role])}
          style={{ width: `${Math.min(100, modelProbability * 100)}%` }}
        />
        {impliedProbability === null ? null : (
          <div
            className="absolute inset-y-[-2px] w-[2px] bg-ink"
            style={{ left: `calc(${Math.min(100, impliedProbability * 100)}% - 1px)` }}
            title={`Bookmaker implied ${percent(impliedProbability)}`}
          />
        )}
      </div>
      <span className="tnum w-28 shrink-0 text-right text-[13px]">
        <span className="font-semibold text-ink">{percent(modelProbability)}</span>
        {edge === null ? null : (
          <span
            className={clsx('ml-1.5 text-[12px]', edge > 0 ? 'text-good-text' : 'text-ink-muted')}
          >
            {edge > 0 ? '+' : ''}
            {(edge * 100).toFixed(1)}
          </span>
        )}
      </span>
    </div>
  );
}
