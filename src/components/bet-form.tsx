'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { ValueOpportunityDto } from '@/lib/services/queries';
import { decimal, percent, signedPercent } from '@/lib/format';

/**
 * Records a prediction in the tracking ledger.
 *
 * Deliberately framed as recording an observation rather than as placing a bet:
 * this exists so the model's claimed edge can be checked against outcomes.
 */
export function BetForm({ opportunities }: { opportunities: readonly ValueOpportunityDto[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState('');
  const [stake, setStake] = useState('10');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmation, setConfirmation] = useState<string | null>(null);

  const opportunity = opportunities.find(
    (entry) => `${entry.matchId}|${entry.market}|${entry.selection}|${entry.line ?? ''}` === selected,
  );

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setConfirmation(null);
    if (!opportunity) {
      setError('Choose a selection first.');
      return;
    }
    const stakeValue = Number(stake);
    if (!Number.isFinite(stakeValue) || stakeValue <= 0) {
      setError('Stake must be a positive number.');
      return;
    }

    setSaving(true);
    try {
      const response = await fetch('/api/bets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          matchId: opportunity.matchId,
          market: opportunity.market,
          selection: opportunity.selection,
          line: opportunity.line ?? undefined,
          odds: opportunity.bookmakerOdds,
          stake: stakeValue,
          stakingMethod: 'FLAT',
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload?.error?.message ?? 'Could not record this prediction.');
        return;
      }
      setConfirmation(
        `Recorded ${opportunity.homeTeam} v ${opportunity.awayTeam} — ${opportunity.selection} at ${opportunity.bookmakerOdds}.`,
      );
      setSelected('');
      startTransition(() => router.refresh());
    } catch {
      setError('Network error while recording the prediction.');
    } finally {
      setSaving(false);
    }
  };

  if (opportunities.length === 0) {
    return (
      <p className="px-4 py-5 text-[13px] text-ink-muted">
        No priced upcoming selections to record right now.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 px-4 py-4">
      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-medium uppercase tracking-wider text-ink-muted">
          Selection
        </span>
        <select
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
          className="rounded-md border border-hairline-strong bg-surface-raised px-2.5 py-1.5 text-[13px] text-ink"
        >
          <option value="">Choose an upcoming selection…</option>
          {opportunities.map((entry) => {
            const key = `${entry.matchId}|${entry.market}|${entry.selection}|${entry.line ?? ''}`;
            return (
              <option key={key} value={key}>
                {entry.homeTeam} v {entry.awayTeam} — {entry.selection}
                {entry.line === null ? '' : ` ${entry.line}`} @ {decimal(entry.bookmakerOdds)}
              </option>
            );
          })}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-medium uppercase tracking-wider text-ink-muted">
          Stake (units)
        </span>
        <input
          type="number"
          min="0.01"
          step="0.01"
          value={stake}
          onChange={(event) => setStake(event.target.value)}
          className="w-32 rounded-md border border-hairline-strong bg-surface-raised px-2.5 py-1.5 text-[13px] text-ink"
        />
      </label>

      {opportunity ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md border border-hairline bg-ink/[0.02] px-3 py-2 text-[12px] sm:grid-cols-4">
          <div>
            <dt className="text-ink-muted">Model</dt>
            <dd className="tnum font-semibold text-ink">{percent(opportunity.probability)}</dd>
          </div>
          <div>
            <dt className="text-ink-muted">Implied</dt>
            <dd className="tnum text-ink">{percent(opportunity.impliedProbability)}</dd>
          </div>
          <div>
            <dt className="text-ink-muted">Edge</dt>
            <dd className="tnum text-ink">{signedPercent(opportunity.edge)}</dd>
          </div>
          <div>
            <dt className="text-ink-muted">Model EV</dt>
            <dd className="tnum font-semibold text-good-text">
              {signedPercent(opportunity.expectedValue)}
            </dd>
          </div>
        </dl>
      ) : null}

      {error ? (
        <p role="alert" className="text-[13px] text-critical">
          {error}
        </p>
      ) : null}

      <p role="status" aria-live="polite" className="text-[13px] text-good-text">
        {confirmation ?? ''}
      </p>

      <div>
        <button
          type="submit"
          disabled={saving || pending || !opportunity}
          className="rounded-md bg-home px-3 py-1.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {saving ? 'Recording…' : 'Record prediction'}
        </button>
      </div>
    </form>
  );
}
