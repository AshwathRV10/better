import Link from 'next/link';
import { Badge, Card, CardHeader, EmptyState, ErrorState, Note, StatTile, Td, Th } from '@/components/ui';
import { EquityCurve } from '@/components/charts';
import { BetForm } from '@/components/bet-form';
import { getTrackerSummary, listBets, settleFinishedBets } from '@/lib/services/bets';
import { listValueOpportunities } from '@/lib/services/queries';
import {
  decimal,
  kickoffFull,
  marketLabel,
  money,
  percent,
  selectionLabel,
  signedPercent,
} from '@/lib/format';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Tracker' };

const RESULT_TONE: Record<string, 'good' | 'critical' | 'neutral'> = {
  WON: 'good',
  LOST: 'critical',
  PUSH: 'neutral',
  VOID: 'neutral',
  PENDING: 'neutral',
};

export default async function TrackerPage() {
  let body;
  try {
    // Settle anything whose match has finished before reporting the ledger.
    await settleFinishedBets();
    const [bets, summary, opportunities] = await Promise.all([
      listBets({ limit: 200 }),
      getTrackerSummary(),
      listValueOpportunities({ minEv: -1, minEdge: -1, limit: 60 }),
    ]);

    body = (
      <>
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <StatTile label="Predictions logged" value={summary.totalBets} detail={`${summary.pending} pending`} />
          <StatTile
            label="Win rate"
            value={percent(summary.winRate)}
            detail={`${summary.wins}W / ${summary.losses}L${summary.pushes > 0 ? ` / ${summary.pushes}P` : ''}`}
          />
          <StatTile label="Total staked" value={money(summary.totalStaked)} detail="units" />
          <StatTile
            label="Profit / loss"
            value={money(summary.profitLoss)}
            detail="units, settled only"
            tone={summary.profitLoss > 0 ? 'good' : summary.profitLoss < 0 ? 'critical' : 'neutral'}
          />
          <StatTile
            label="ROI"
            value={signedPercent(summary.roi)}
            detail="return on turnover"
            tone={summary.roi > 0 ? 'good' : summary.roi < 0 ? 'critical' : 'neutral'}
          />
        </section>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <Card>
            <CardHeader
              title="Record a prediction"
              subtitle="Logs the model's probability, the price and the edge as they stand now, so the model can be evaluated later against what actually happened."
            />
            <BetForm opportunities={opportunities} />
          </Card>

          <Card>
            <CardHeader
              title="Bankroll"
              subtitle={`Starting bankroll 1000 units · average odds ${decimal(summary.averageOdds)} · average model edge ${signedPercent(summary.averageEdge)}`}
            />
            <div className="px-2 py-3">
              <EquityCurve points={summary.equityCurve} />
            </div>
          </Card>
        </div>

        <Card>
          <CardHeader
            title="Ledger"
            subtitle="Settled automatically once the match finishes, for markets whose rules the final score decides unambiguously."
          />
          {bets.length === 0 ? (
            <EmptyState
              title="Nothing logged yet"
              description="Record a prediction above to start tracking whether the model's estimated edge shows up in results."
            />
          ) : (
            <div className="table-scroll">
              <table className="w-full min-w-[1000px] border-collapse">
                <thead>
                  <tr>
                    <Th>Match</Th>
                    <Th>Market</Th>
                    <Th align="right">Odds</Th>
                    <Th align="right">Stake</Th>
                    <Th align="right">Model</Th>
                    <Th align="right">Implied</Th>
                    <Th align="right">Edge</Th>
                    <Th align="right">EV</Th>
                    <Th>Result</Th>
                    <Th align="right">P / L</Th>
                    <Th>Model version</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {bets.map((bet) => (
                    <tr key={bet.id} className="hover:bg-ink/[0.02]">
                      <Td>
                        <Link href={`/matches/${bet.matchId}`} className="font-medium hover:underline">
                          {bet.homeTeam} <span className="text-ink-muted">v</span> {bet.awayTeam}
                        </Link>
                        <div className="text-[11px] text-ink-muted">
                          {bet.leagueName} · {kickoffFull(bet.kickoff)}
                        </div>
                      </Td>
                      <Td>
                        <div className="text-ink">{marketLabel(bet.market)}</div>
                        <div className="text-[11px] text-ink-muted">
                          {selectionLabel(bet.selection, bet.line)}
                        </div>
                      </Td>
                      <Td align="right" className="tnum">{decimal(bet.odds)}</Td>
                      <Td align="right" className="tnum">{money(bet.stake)}</Td>
                      <Td align="right" className="tnum">{percent(bet.modelProbability)}</Td>
                      <Td align="right" className="tnum text-ink-secondary">
                        {percent(bet.impliedProbability)}
                      </Td>
                      <Td align="right" className="tnum">{signedPercent(bet.edge)}</Td>
                      <Td align="right" className="tnum">{signedPercent(bet.expectedValue)}</Td>
                      <Td>
                        <Badge tone={RESULT_TONE[bet.result] ?? 'neutral'}>{bet.result}</Badge>
                      </Td>
                      <Td
                        align="right"
                        className={`tnum font-medium ${
                          (bet.profitLoss ?? 0) > 0
                            ? 'text-good-text'
                            : (bet.profitLoss ?? 0) < 0
                              ? 'text-critical'
                              : 'text-ink-secondary'
                        }`}
                      >
                        {bet.profitLoss === null ? '—' : money(bet.profitLoss)}
                      </Td>
                      <Td className="text-[11px] text-ink-muted">{bet.modelVersion}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Note>
          This is an analytics ledger, not a betting product. Its purpose is to check whether the
          model&apos;s estimated edge actually materialises — the honest test of a probability model
          is whether its claimed advantage survives contact with results. Staking references use
          quarter-Kelly capped at 2% of bankroll; full Kelly is far too aggressive when
          probabilities are estimated rather than known.
        </Note>
      </>
    );
  } catch (error) {
    body = (
      <ErrorState
        title="Could not load the tracker"
        detail={error instanceof Error ? error.message : 'An unexpected error occurred.'}
      />
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-ink">Tracker</h1>
        <p className="mt-1 text-[13px] text-ink-secondary">
          A ledger of recorded predictions, their model edge at the time, and what actually happened.
        </p>
      </div>
      {body}
    </div>
  );
}
