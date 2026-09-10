import Link from 'next/link';
import { Badge, ConfidenceBadge } from './ui';
import { ProbabilityBar, type ProbabilitySegment } from './probability-bar';
import {
  decimal,
  kickoffTime,
  percent,
  selectionLabel,
  signedPercent,
} from '@/lib/format';
import type { MatchDto, OutcomeDto } from '@/lib/services/queries';

const ROLE_BY_SELECTION: Record<string, ProbabilitySegment['role']> = {
  HOME: 'home',
  DRAW: 'draw',
  AWAY: 'away',
};

/** Orders the match-winner selections home, draw, away for display. */
export function matchWinnerOutcomes(outcomes: readonly OutcomeDto[]): OutcomeDto[] {
  const order = ['HOME', 'DRAW', 'AWAY'];
  return outcomes
    .filter((outcome) => outcome.market === 'MATCH_WINNER')
    .sort((a, b) => order.indexOf(a.selection) - order.indexOf(b.selection));
}

/**
 * Reusable prediction card.
 *
 * Shows the model's call, its probability, the price, the implied probability,
 * the edge, the estimated EV and the confidence - so the model and the market
 * are always visible side by side rather than the model alone.
 */
export function PredictionCard({ match }: { match: MatchDto }) {
  const prediction = match.prediction;
  if (!prediction) return null;

  const winner = matchWinnerOutcomes(prediction.outcomes);
  const best = [...winner].sort((a, b) => b.probability - a.probability)[0];
  if (!best) return null;

  const segments: ProbabilitySegment[] = winner.map((outcome) => ({
    label:
      outcome.selection === 'HOME'
        ? match.homeTeam.shortName
        : outcome.selection === 'AWAY'
          ? match.awayTeam.shortName
          : 'Draw',
    probability: outcome.probability,
    role: ROLE_BY_SELECTION[outcome.selection] ?? 'draw',
  }));

  const pickLabel =
    best.selection === 'HOME'
      ? match.homeTeam.name
      : best.selection === 'AWAY'
        ? match.awayTeam.name
        : 'Draw';

  return (
    <article className="flex flex-col rounded-lg border border-hairline bg-surface">
      <div className="flex items-center justify-between gap-2 border-b border-hairline px-4 py-2">
        <span className="truncate text-[12px] text-ink-muted">{match.leagueName}</span>
        <span className="tnum shrink-0 text-[12px] text-ink-muted">{kickoffTime(match.kickoff)}</span>
      </div>

      <div className="px-4 py-3">
        <h3 className="text-[15px] font-semibold leading-snug text-ink">
          {match.homeTeam.name} <span className="text-ink-muted">v</span> {match.awayTeam.name}
        </h3>

        <div className="mt-3">
          <ProbabilityBar segments={segments} />
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-[12px]">
          <div>
            <dt className="text-ink-muted">Model</dt>
            <dd className="truncate font-semibold text-ink">{pickLabel}</dd>
          </div>
          <div>
            <dt className="text-ink-muted">Probability</dt>
            <dd className="tnum font-semibold text-ink">{percent(best.probability)}</dd>
          </div>
          <div>
            <dt className="text-ink-muted">Odds</dt>
            <dd className="tnum text-ink">
              {best.bookmakerOdds === null ? (
                <span className="text-ink-muted">No market</span>
              ) : (
                <>
                  {decimal(best.bookmakerOdds)}
                  {best.bookmaker ? (
                    <span className="ml-1 text-[11px] text-ink-muted">{best.bookmaker}</span>
                  ) : null}
                </>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-ink-muted">Implied</dt>
            <dd className="tnum text-ink">{percent(best.impliedProbability)}</dd>
          </div>
          <div>
            <dt className="text-ink-muted">Edge</dt>
            <dd className="tnum text-ink">{signedPercent(best.edge)}</dd>
          </div>
          <div>
            <dt className="text-ink-muted">Model EV</dt>
            <dd
              className={`tnum font-semibold ${
                (best.expectedValue ?? 0) > 0 ? 'text-good-text' : 'text-ink'
              }`}
            >
              {signedPercent(best.expectedValue)}
            </dd>
          </div>
        </dl>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <ConfidenceBadge level={prediction.confidence} score={prediction.confidenceScore} />
          <Badge tone="neutral" title="Data-quality score out of 100">
            Data {prediction.dataQuality}
          </Badge>
          {match.origin === 'DEMO' ? <Badge tone="warning">Demo</Badge> : null}
        </div>
      </div>

      <div className="mt-auto border-t border-hairline px-4 py-2.5">
        <Link
          href={`/matches/${match.id}`}
          className="text-[13px] font-medium text-home hover:underline"
        >
          View full analysis →
        </Link>
      </div>
    </article>
  );
}

/** Compact table row used by the dashboard's table view. */
export function selectionShortLabel(
  outcome: OutcomeDto,
  match: Pick<MatchDto, 'homeTeam' | 'awayTeam'>,
): string {
  if (outcome.market !== 'MATCH_WINNER') return selectionLabel(outcome.selection, outcome.line);
  if (outcome.selection === 'HOME') return match.homeTeam.shortName;
  if (outcome.selection === 'AWAY') return match.awayTeam.shortName;
  return 'Draw';
}
