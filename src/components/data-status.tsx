import { Badge } from './ui';
import { isStale, relativeTime } from '@/lib/format';
import type { DataFreshnessDto } from '@/lib/services/queries';

/**
 * Demo-data banner.
 *
 * Simulated fixtures must never be mistakable for live sport, so this sits above
 * the page content on every screen while any demo data is present.
 */
export function DemoBanner({ origin, provider }: { origin: string; provider: string | null }) {
  if (origin === 'LIVE') return null;
  return (
    <div className="border-b border-warning/40 bg-warning/15">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-[12px]">
        <Badge tone="warning">Demo data</Badge>
        <span className="text-ink">
          {origin === 'MIXED'
            ? 'This view mixes simulated and live records.'
            : 'Every fixture, price and result below is simulated.'}{' '}
          Teams and players are fictional. Nothing here is a real sporting event.
        </span>
        {provider ? (
          <span className="text-ink-secondary">Provider: {provider}</span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Always-visible origin badge.
 *
 * The demo banner below shouts when data is simulated. This is its counterpart:
 * a quiet, permanent statement of where the numbers came from, so "live" is
 * something the interface asserts rather than something the reader assumes from
 * the absence of a warning.
 */
export function OriginBadge({ origin, provider }: { origin: string; provider: string | null }) {
  const tone = origin === 'LIVE' ? 'good' : origin === 'DEMO' || origin === 'MIXED' ? 'warning' : 'neutral';
  const label = origin === 'LIVE' ? 'Live data' : origin === 'DEMO' ? 'Demo data' : origin === 'MIXED' ? 'Mixed data' : 'Unknown source';
  return (
    <span
      className="flex items-center gap-1.5"
      title={
        origin === 'LIVE'
          ? `Real fixtures and results from ${provider ?? 'the configured provider'}. No simulated records are shown.`
          : origin === 'UNKNOWN'
            ? 'The database could not be reached, so the origin of any cached view is unverified.'
            : 'Some or all records below are simulated.'
      }
    >
      <Badge tone={tone}>{label}</Badge>
      {provider && origin === 'LIVE' ? (
        <span className="hidden text-[11px] text-ink-muted lg:inline">{provider}</span>
      ) : null}
    </span>
  );
}

/** Data-freshness line. Stale data is labelled rather than left looking live. */
export function FreshnessIndicator({ freshness }: { freshness: DataFreshnessDto }) {
  // A source with no odds at all is not "stale odds" — saying so would imply a
  // feed exists and has gone quiet.
  const hasOdds = freshness.newestOdds !== null;
  const stale = hasOdds && isStale(freshness.newestOdds);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-muted">
      <span>
        Data ingested{' '}
        <span className="text-ink-secondary">{relativeTime(freshness.lastIngestion)}</span>
      </span>
      {hasOdds ? (
        <span>
          Odds captured{' '}
          <span className={stale ? 'font-medium text-ink' : 'text-ink-secondary'}>
            {relativeTime(freshness.newestOdds)}
          </span>
        </span>
      ) : (
        <span>No odds feed configured</span>
      )}
      {stale ? <Badge tone="warning">⚠ Data may be outdated</Badge> : null}
    </div>
  );
}

/** Standing disclaimer. Present on every page that shows a probability. */
export function ResponsibleUseNote() {
  return (
    <p className="text-[12px] leading-relaxed text-ink-muted">
      Predictions are probabilistic estimates, not guarantees. Sports outcomes are uncertain, and
      historical model performance does not guarantee future results. Expected value shown is
      model-estimated, computed from the model&apos;s own probabilities — it is not guaranteed profit.
    </p>
  );
}
