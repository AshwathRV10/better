import Link from 'next/link';
import { Suspense } from 'react';
import {
  Badge,
  Card,
  CardHeader,
  ConfidenceBadge,
  EmptyState,
  ErrorState,
  LoadingRows,
  Note,
  StatTile,
  Td,
  Th,
} from '@/components/ui';
import { FreshnessIndicator } from '@/components/data-status';
import { PredictionCard, matchWinnerOutcomes, selectionShortLabel } from '@/components/prediction-card';
import { DateFilter, FilterBar, ResetFilters, SelectFilter } from '@/components/filter-bar';
import {
  getDataFreshness,
  listLeagues,
  listMatches,
  listSports,
  listValueOpportunities,
  type MatchDto,
} from '@/lib/services/queries';
import { decimal, kickoffDate, kickoffTime, percent, signedPercent, sportLabel } from '@/lib/format';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function single(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value === '' ? undefined : value;
}

export default async function DashboardPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const sport = single(params.sport);
  const league = single(params.league);
  const dateParam = single(params.date);

  let content;
  try {
    const date = dateParam ? new Date(dateParam) : undefined;
    const now = new Date();

    const [sports, leagues, freshness, upcoming, value] = await Promise.all([
      listSports(),
      listLeagues(sport),
      getDataFreshness(),
      listMatches({
        sportKey: sport,
        leagueKey: league,
        date,
        from: date ? undefined : now,
        to: date ? undefined : new Date(now.getTime() + 14 * 86_400_000),
        status: 'SCHEDULED',
        limit: 120,
      }),
      // The dashboard leads with edges the model's own measured record supports;
      // the value page shows everything, flagged.
      listValueOpportunities({
        sportKey: sport,
        leagueKey: league,
        minEv: 0.03,
        limit: 5,
        onlySupported: true,
      }),
    ]);

    const matches = upcoming.matches;
    const withPredictions = matches.filter((match) => match.prediction !== null);
    const highConfidence = withPredictions.filter(
      (match) => match.prediction?.confidence === 'HIGH',
    ).length;
    const averageDataQuality =
      withPredictions.length === 0
        ? 0
        : withPredictions.reduce((sum, match) => sum + (match.prediction?.dataQuality ?? 0), 0) /
          withPredictions.length;

    // Group by kickoff day so the table reads like a fixture list.
    const byDay = new Map<string, MatchDto[]>();
    for (const match of matches) {
      const key = match.kickoff.slice(0, 10);
      byDay.set(key, [...(byDay.get(key) ?? []), match]);
    }

    content = (
      <>
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label="Upcoming fixtures"
            value={matches.length}
            detail={dateParam ? 'on the selected date' : 'next 14 days'}
          />
          <StatTile
            label="Predictions ready"
            value={withPredictions.length}
            detail={`${matches.length - withPredictions.length} awaiting data`}
          />
          <StatTile label="High confidence" value={highConfidence} detail="of the predictions shown" />
          <StatTile
            label="Mean data quality"
            value={`${Math.round(averageDataQuality)}`}
            detail="out of 100"
          />
        </section>

        <FilterBar>
          <SelectFilter
            name="sport"
            label="Sport"
            placeholder="All sports"
            options={sports.map((entry) => ({
              value: entry.key,
              label: `${sportLabel(entry.key)} (${entry.upcomingMatches})`,
            }))}
          />
          <SelectFilter
            name="league"
            label="League"
            placeholder="All leagues"
            options={leagues.map((entry) => ({ value: entry.key, label: entry.name }))}
          />
          <DateFilter name="date" label="Date" />
          <ResetFilters href="/" />
          <div className="ml-auto self-center">
            <FreshnessIndicator freshness={freshness} />
          </div>
        </FilterBar>

        {value.length > 0 ? (
          <Card>
            <CardHeader
              title="Largest model-versus-market gaps"
              subtitle="Selections where the model's probability exceeds the margin-adjusted market price by a margin its measured out-of-sample accuracy supports. Estimated EV, not guaranteed profit."
              action={
                <Link href="/value" className="text-[13px] font-medium text-home hover:underline">
                  All value →
                </Link>
              }
            />
            <div className="table-scroll">
              <table className="w-full min-w-[760px] border-collapse">
                <thead>
                  <tr>
                    <Th>Match</Th>
                    <Th>Selection</Th>
                    <Th align="right">Model</Th>
                    <Th align="right">Odds</Th>
                    <Th align="right">Implied</Th>
                    <Th align="right">Edge</Th>
                    <Th align="right">Model EV</Th>
                    <Th>Confidence</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {value.map((row) => (
                    <tr key={`${row.matchId}-${row.market}-${row.selection}-${row.line ?? ''}`}>
                      <Td>
                        <Link href={`/matches/${row.matchId}`} className="hover:underline">
                          {row.homeTeam} v {row.awayTeam}
                        </Link>
                        <div className="text-[11px] text-ink-muted">{row.leagueName}</div>
                      </Td>
                      <Td>
                        <span className="text-ink">{row.selection}</span>
                        {row.line === null ? null : (
                          <span className="tnum ml-1 text-ink-muted">{row.line}</span>
                        )}
                      </Td>
                      <Td align="right" className="tnum font-semibold">
                        {percent(row.probability)}
                      </Td>
                      <Td align="right" className="tnum">
                        {decimal(row.bookmakerOdds)}
                      </Td>
                      <Td align="right" className="tnum">
                        {percent(row.impliedProbability)}
                      </Td>
                      <Td align="right" className="tnum">
                        {signedPercent(row.edge)}
                      </Td>
                      <Td align="right" className="tnum font-semibold text-good-text">
                        {signedPercent(row.expectedValue)}
                      </Td>
                      <Td>
                        <ConfidenceBadge level={row.confidence} score={row.confidenceScore} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ) : null}

        <Card>
          <CardHeader
            title={dateParam ? `Fixtures on ${kickoffDate(`${dateParam}T12:00:00Z`)}` : 'Upcoming fixtures'}
            subtitle={`${matches.length} fixture${matches.length === 1 ? '' : 's'}, ${withPredictions.length} with a published prediction`}
          />
          {matches.length === 0 ? (
            <EmptyState
              title="No fixtures match these filters"
              description="Try a different sport, league or date. If the database was just created, run the seed to load fixtures."
            />
          ) : (
            <div className="table-scroll">
              <table className="w-full min-w-[900px] border-collapse">
                <thead>
                  <tr>
                    <Th>Time</Th>
                    <Th>League</Th>
                    <Th>Match</Th>
                    <Th>Model</Th>
                    <Th align="right">Probability</Th>
                    <Th align="right">Odds</Th>
                    <Th align="right">Implied</Th>
                    <Th align="right">Edge</Th>
                    <Th align="right">Model EV</Th>
                    <Th>Confidence</Th>
                  </tr>
                </thead>
                {[...byDay.entries()].map(([day, dayMatches]) => (
                  <tbody key={day} className="divide-y divide-hairline">
                    <tr>
                      <td
                        colSpan={10}
                        className="border-y border-hairline bg-ink/[0.03] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary"
                      >
                        {kickoffDate(`${day}T12:00:00Z`)}
                      </td>
                    </tr>
                    {dayMatches.map((match) => {
                      const winner = match.prediction
                        ? matchWinnerOutcomes(match.prediction.outcomes)
                        : [];
                      const best = [...winner].sort((a, b) => b.probability - a.probability)[0];
                      return (
                        <tr key={match.id} className="hover:bg-ink/[0.02]">
                          <Td className="tnum text-ink-secondary">{kickoffTime(match.kickoff)}</Td>
                          <Td className="text-ink-secondary">{match.leagueName}</Td>
                          <Td>
                            <Link href={`/matches/${match.id}`} className="font-medium hover:underline">
                              {match.homeTeam.name} <span className="text-ink-muted">v</span>{' '}
                              {match.awayTeam.name}
                            </Link>
                          </Td>
                          {best ? (
                            <>
                              <Td className="font-medium">{selectionShortLabel(best, match)}</Td>
                              <Td align="right" className="tnum font-semibold">
                                {percent(best.probability)}
                              </Td>
                              <Td align="right" className="tnum">
                                {decimal(best.bookmakerOdds)}
                              </Td>
                              <Td align="right" className="tnum text-ink-secondary">
                                {percent(best.impliedProbability)}
                              </Td>
                              <Td align="right" className="tnum">
                                {signedPercent(best.edge)}
                              </Td>
                              <Td
                                align="right"
                                className={`tnum font-medium ${
                                  (best.expectedValue ?? 0) > 0 ? 'text-good-text' : 'text-ink-secondary'
                                }`}
                              >
                                {signedPercent(best.expectedValue)}
                              </Td>
                              <Td>
                                <ConfidenceBadge
                                  level={match.prediction!.confidence}
                                  score={match.prediction!.confidenceScore}
                                />
                              </Td>
                            </>
                          ) : (
                            <Td colSpan={7} className="text-ink-muted">
                              <Badge tone="neutral">No prediction</Badge>{' '}
                              <span className="ml-1 text-[12px]">
                                Insufficient history for both sides
                              </span>
                            </Td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                ))}
              </table>
            </div>
          )}
        </Card>

        {withPredictions.length > 0 ? (
          <section>
            <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-ink-secondary">
              Next up
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {withPredictions.slice(0, 6).map((match) => (
                <PredictionCard key={match.id} match={match} />
              ))}
            </div>
          </section>
        ) : null}

        <Note>
          Model probabilities come from an ensemble of a sport-specific scoring model, an Elo
          rating, a recency-weighted form model and a regularised ML baseline, blended with weights
          fitted out of sample and calibrated on held-out matches. Bookmaker probabilities are shown
          after removing the overround, so the edge is not inflated by the bookmaker&apos;s margin.
        </Note>
      </>
    );
  } catch (error) {
    content = (
      <ErrorState
        title="Could not load the dashboard"
        detail={
          error instanceof Error
            ? `${error.message}. Check that the database is reachable and that the seed has been run.`
            : 'An unexpected error occurred.'
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-ink">Dashboard</h1>
        <p className="mt-1 text-[13px] text-ink-secondary">
          Upcoming fixtures with model probabilities, market comparison and estimated value.
        </p>
      </div>
      <Suspense fallback={<LoadingRows rows={8} />}>{content}</Suspense>
    </div>
  );
}
