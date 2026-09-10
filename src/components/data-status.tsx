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

/** Data-freshness line. Stale data is labelled rather than left looking live. */
export function FreshnessIndicator({ freshness }: { freshness: DataFreshnessDto }) {
  const stale = isStale(freshness.newestOdds);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-muted">
      <span>
        Data ingested{' '}
        <span className="text-ink-secondary">{relativeTime(freshness.lastIngestion)}</span>
      </span>
      <span>
        Odds captured{' '}
        <span className={stale ? 'font-medium text-ink' : 'text-ink-secondary'}>
          {relativeTime(freshness.newestOdds)}
        </span>
      </span>
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
