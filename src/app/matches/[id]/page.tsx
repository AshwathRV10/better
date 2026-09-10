import { notFound } from 'next/navigation';
import Link from 'next/link';
import {
  Badge,
  Card,
  CardHeader,
  ConfidenceBadge,
  ErrorState,
  Note,
  StatTile,
  Td,
  Th,
} from '@/components/ui';
import { ProbabilityBar, ModelVersusMarket, type ProbabilitySegment } from '@/components/probability-bar';
import { CorrectScoreChart } from '@/components/charts';
import { getMatchAnalysis, type MatchAnalysisDto } from '@/lib/services/analysis';
import { loadReliabilityModels, reliabilityExplanation, classifyEdge } from '@/lib/services/reliability';
import {
  componentLabel,
  decimal,
  kickoffFull,
  marketLabel,
  percent,
  relativeTime,
  selectionLabel,
  signedPercent,
  sportLabel,
} from '@/lib/format';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { id } = await params;
  try {
    const analysis = await getMatchAnalysis(id);
    if (!analysis) return { title: 'Match not found' };
    return { title: `${analysis.homeTeam.name} v ${analysis.awayTeam.name}` };
  } catch {
    return { title: 'Match analysis' };
  }
}

const ROLE_BY_SELECTION: Record<string, ProbabilitySegment['role']> = {
  HOME: 'home',
  DRAW: 'draw',
  AWAY: 'away',
};

function sideLabel(analysis: MatchAnalysisDto, selection: string): string {
  if (selection === 'HOME') return analysis.homeTeam.name;
  if (selection === 'AWAY') return analysis.awayTeam.name;
  return 'Draw';
}

function shortLabel(analysis: MatchAnalysisDto, selection: string): string {
  if (selection === 'HOME') return analysis.homeTeam.shortName;
  if (selection === 'AWAY') return analysis.awayTeam.shortName;
  return 'Draw';
}

/** Recent-form strip, e.g. W W D L W, newest first. */
function FormStrip({ results }: { results: readonly string[] }) {
  if (results.length === 0) {
    return <span className="text-[12px] text-ink-muted">No recent matches</span>;
  }
  return (
    <span className="flex gap-1" aria-label={`Recent form, newest first: ${results.slice(0, 5).join(', ')}`}>
      {results.slice(0, 5).map((result, index) => (
        <span
          key={index}
          className={`inline-flex h-5 w-5 items-center justify-center rounded text-[11px] font-bold ${
            result === 'W'
              ? 'bg-good/20 text-good-text'
              : result === 'D'
                ? 'bg-ink/[0.08] text-ink-secondary'
                : 'bg-critical/15 text-critical'
          }`}
        >
          {result}
        </span>
      ))}
    </span>
  );
}

const CATEGORY_ORDER = ['RATING', 'FORM', 'ATTACK', 'DEFENCE', 'HOME_AWAY', 'H2H', 'REST', 'AVAILABILITY', 'CONTEXT'];
const CATEGORY_LABELS: Record<string, string> = {
  RATING: 'Ratings',
  FORM: 'Form',
  ATTACK: 'Attack',
  DEFENCE: 'Defence',
  HOME_AWAY: 'Home / away',
  H2H: 'Head-to-head',
  REST: 'Rest & congestion',
  AVAILABILITY: 'Availability',
  CONTEXT: 'Context',
};

export default async function MatchPage({ params }: PageProps) {
  const { id } = await params;

  let analysis: MatchAnalysisDto | null;
  try {
    analysis = await getMatchAnalysis(id);
  } catch (error) {
    return (
      <ErrorState
        title="Could not produce an analysis for this match"
        detail={
          error instanceof Error
            ? error.message
            : 'An unexpected error occurred while building the prediction.'
        }
      />
    );
  }
  if (!analysis) notFound();

  const reliabilityModels = await loadReliabilityModels();
  const reliabilityModel = reliabilityModels.get(analysis.modelVersion);

  const winner = analysis.outcomes
    .filter((outcome) => outcome.market === 'MATCH_WINNER')
    .sort((a, b) => ['HOME', 'DRAW', 'AWAY'].indexOf(a.selection) - ['HOME', 'DRAW', 'AWAY'].indexOf(b.selection));
  const best = [...winner].sort((a, b) => b.probability - a.probability)[0];

  const segments: ProbabilitySegment[] = winner.map((outcome) => ({
    label: shortLabel(analysis!, outcome.selection),
    probability: outcome.probability,
    role: ROLE_BY_SELECTION[outcome.selection] ?? 'draw',
  }));

  const correctScores = analysis.outcomes
    .filter((outcome) => outcome.market === 'CORRECT_SCORE')
    .sort((a, b) => b.probability - a.probability)
    .slice(0, 10)
    .map((outcome) => {
      const [home, away] = outcome.selection.split('-').map(Number);
      return {
        label: outcome.selection,
        probability: outcome.probability,
        favours: (home > away ? 'home' : home < away ? 'away' : 'draw') as 'home' | 'away' | 'draw',
      };
    });

  // Group the remaining markets for the market table.
  const otherMarkets = analysis.outcomes.filter(
    (outcome) => outcome.market !== 'MATCH_WINNER' && outcome.market !== 'CORRECT_SCORE',
  );
  const marketGroups = new Map<string, typeof otherMarkets>();
  for (const outcome of otherMarkets) {
    const key = outcome.line === null ? outcome.market : `${outcome.market}|${outcome.line}`;
    marketGroups.set(key, [...(marketGroups.get(key) ?? []), outcome]);
  }

  const featureGroups = new Map<string, typeof analysis.features>();
  for (const feature of analysis.features) {
    featureGroups.set(feature.category, [...(featureGroups.get(feature.category) ?? []), feature]);
  }

  const support = analysis.explanation.filter((item) => item.kind === 'SUPPORT');
  const risks = analysis.explanation.filter((item) => item.kind === 'RISK');

  const bestEdge = best?.edge ?? null;
  const edgeClass = bestEdge === null ? null : classifyEdge(bestEdge, reliabilityModel);

  // Odds are a secondary input: the configured data source may not carry any.
  // Where it does not, the market columns are dropped rather than filled with
  // dashes, and the prediction stands on its own.
  const hasMarket = analysis.outcomes.some((outcome) => outcome.bookmakerOdds !== null);

  return (
    <div className="flex flex-col gap-5">
      {/* Header */}
      <div>
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-muted">
          <Link href="/" className="hover:underline">Dashboard</Link>
          <span aria-hidden="true">/</span>
          <span>{sportLabel(analysis.sportKey)}</span>
          <span aria-hidden="true">/</span>
          <span>{analysis.leagueName}</span>
        </div>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-ink">
          {analysis.homeTeam.name} <span className="text-ink-muted">v</span> {analysis.awayTeam.name}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-ink-secondary">
          <span>{kickoffFull(analysis.kickoff)}</span>
          {analysis.venue ? <span>{analysis.venue}</span> : null}
          {analysis.neutralVenue ? <Badge tone="neutral">Neutral venue</Badge> : null}
          <Badge tone={analysis.status === 'FINISHED' ? 'neutral' : 'info'}>{analysis.status}</Badge>
          {analysis.origin === 'DEMO' ? <Badge tone="warning">Demo data</Badge> : null}
          {analysis.status === 'FINISHED' && analysis.homeScore !== null ? (
            <span className="tnum font-semibold text-ink">
              Final {analysis.homeScore}–{analysis.awayScore}
            </span>
          ) : null}
        </div>
      </div>

      {/* Prediction summary */}
      <Card>
        <CardHeader
          title="Prediction summary"
          subtitle={`Model ${analysis.modelVersion} · features ${analysis.featuresVersion} · predicted ${relativeTime(analysis.predictedAt)} · newest data ${relativeTime(analysis.dataTimestamp)}`}
          action={<ConfidenceBadge level={analysis.confidence} score={analysis.confidenceScore} />}
        />
        <div className="grid gap-6 px-4 py-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <div>
            {best ? (
              <>
                <div className="text-[12px] uppercase tracking-wider text-ink-muted">Predicted outcome</div>
                <div className="mt-1 flex flex-wrap items-baseline gap-3">
                  <span className="text-2xl font-bold tracking-tight text-ink">
                    {sideLabel(analysis, best.selection)}
                  </span>
                  <span className="tnum text-2xl font-bold tracking-tight text-home">
                    {percent(best.probability)}
                  </span>
                </div>
              </>
            ) : null}

            <div className="mt-4">
              <ProbabilityBar segments={segments} height="lg" />
            </div>

            {analysis.expectedHomeScore !== null && analysis.expectedAwayScore !== null ? (
              <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div>
                  <dt className="text-[11px] uppercase tracking-wider text-ink-muted">
                    Expected {analysis.sportKey === 'football' ? 'goals' : analysis.sportKey === 'tennis' ? 'games' : 'points'}
                  </dt>
                  <dd className="tnum mt-0.5 text-[15px] font-semibold text-ink">
                    {decimal(analysis.expectedHomeScore, analysis.sportKey === 'basketball' ? 1 : 2)} –{' '}
                    {decimal(analysis.expectedAwayScore, analysis.sportKey === 'basketball' ? 1 : 2)}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] uppercase tracking-wider text-ink-muted">Data quality</dt>
                  <dd className="tnum mt-0.5 text-[15px] font-semibold text-ink">
                    {analysis.dataQuality}/100
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] uppercase tracking-wider text-ink-muted">Confidence</dt>
                  <dd className="tnum mt-0.5 text-[15px] font-semibold text-ink">
                    {analysis.confidenceScore}/100
                  </dd>
                </div>
                {hasMarket ? (
                  <div>
                    <dt className="text-[11px] uppercase tracking-wider text-ink-muted">Best edge</dt>
                    <dd className="tnum mt-0.5 text-[15px] font-semibold text-ink">
                      {signedPercent(bestEdge)}
                    </dd>
                  </div>
                ) : (
                  <div>
                    <dt className="text-[11px] uppercase tracking-wider text-ink-muted">Matches used</dt>
                    <dd className="tnum mt-0.5 text-[15px] font-semibold text-ink">
                      {analysis.homeForm.matchesPlayed + analysis.awayForm.matchesPlayed}
                    </dd>
                  </div>
                )}
              </dl>
            ) : null}
          </div>

          {/* Model versus market */}
          <div>
            <div className="text-[12px] uppercase tracking-wider text-ink-muted">
              {hasMarket ? 'Model versus market' : 'Fair odds'}
            </div>
            {hasMarket ? (
              <>
                <p className="mt-1 text-[12px] text-ink-muted">
                  Bar is the model probability; the vertical tick is the bookmaker&apos;s
                  margin-adjusted implied probability. The gap between them is the edge.
                </p>
                <div className="mt-3 flex flex-col gap-2.5">
                  {winner.map((outcome) => (
                    <ModelVersusMarket
                      key={outcome.selection}
                      label={shortLabel(analysis!, outcome.selection)}
                      modelProbability={outcome.probability}
                      impliedProbability={outcome.impliedProbability}
                      role={ROLE_BY_SELECTION[outcome.selection] ?? 'draw'}
                    />
                  ))}
                </div>
                {edgeClass && edgeClass.reliability === 'UNVERIFIED' ? (
                  <p className="mt-3 rounded-md border border-serious/40 bg-serious/10 px-3 py-2 text-[12px] text-ink">
                    <strong>Treat this edge with caution.</strong>{' '}
                    {reliabilityExplanation('UNVERIFIED', reliabilityModel)}
                  </p>
                ) : null}
              </>
            ) : (
              <>
                <p className="mt-1 text-[12px] text-ink-muted">
                  The configured data source carries no bookmaker prices for this fixture, so there
                  is no edge or expected value to report. These are the model&apos;s own break-even
                  odds — the price at which a bet would be a coin flip on its numbers.
                </p>
                <dl className="mt-3 flex flex-col gap-2">
                  {winner.map((outcome) => (
                    <div
                      key={outcome.selection}
                      className="flex items-baseline justify-between gap-3 border-b border-hairline pb-1.5 text-[13px] last:border-0"
                    >
                      <dt className="text-ink-secondary">{sideLabel(analysis!, outcome.selection)}</dt>
                      <dd className="tnum font-semibold text-ink">
                        {decimal(outcome.fairOdds)}
                        <span className="ml-2 font-normal text-ink-muted">
                          {percent(outcome.probability)}
                        </span>
                      </dd>
                    </div>
                  ))}
                </dl>
              </>
            )}
          </div>
        </div>
      </Card>

      {/* Why */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title={`Why ${best ? sideLabel(analysis, best.selection) : 'this prediction'}?`}
            subtitle="Generated from the feature values the model actually used, ranked by their weighted influence."
          />
          <div className="px-4 py-4">
            {support.length === 0 && risks.length === 0 ? (
              <p className="text-[13px] text-ink-muted">
                No factor moved the prediction far enough from the league baseline to report.
              </p>
            ) : (
              <>
                {support.length > 0 ? (
                  <ul className="flex flex-col gap-1.5">
                    {support.map((item) => (
                      <li key={item.featureName} className="flex gap-2 text-[13px]">
                        <span className="text-good-text" aria-hidden="true">+</span>
                        <span className="text-ink">{item.text}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {risks.length > 0 ? (
                  <>
                    <div className="mt-4 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                      Risk factors
                    </div>
                    <ul className="mt-1.5 flex flex-col gap-1.5">
                      {risks.map((item) => (
                        <li key={item.featureName} className="flex gap-2 text-[13px]">
                          <span className="text-critical" aria-hidden="true">−</span>
                          <span className="text-ink">{item.text}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Model agreement"
            subtitle="Each sub-model's own view of the match winner, with the ensemble weight it carries."
          />
          <div className="table-scroll">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th>Model</Th>
                  <Th align="right">Weight</Th>
                  {winner.map((outcome) => (
                    <Th key={outcome.selection} align="right">
                      {shortLabel(analysis!, outcome.selection)}
                    </Th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {analysis.components
                  .slice()
                  .sort((a, b) => b.weight - a.weight)
                  .map((component) => (
                    <tr key={component.component}>
                      <Td>
                        {componentLabel(component.component)}
                        {component.weight === 0 ? (
                          <span
                            className="ml-1.5 text-[11px] text-ink-muted"
                            title="Shown for comparison only. Bookmaker prices are never blended into the model probability, which would make the reported edge circular."
                          >
                            (reference)
                          </span>
                        ) : null}
                      </Td>
                      <Td align="right" className="tnum text-ink-secondary">
                        {component.weight === 0 ? '—' : percent(component.weight, 0)}
                      </Td>
                      {winner.map((outcome) => {
                        const value = component.outcomes.find(
                          (entry) => entry.selection === outcome.selection,
                        );
                        return (
                          <Td key={outcome.selection} align="right" className="tnum">
                            {value ? percent(value.probability) : '—'}
                          </Td>
                        );
                      })}
                    </tr>
                  ))}
                <tr className="bg-ink/[0.03]">
                  <Td className="font-semibold">Ensemble (calibrated)</Td>
                  <Td align="right" className="tnum text-ink-secondary">100%</Td>
                  {winner.map((outcome) => (
                    <Td key={outcome.selection} align="right" className="tnum font-semibold">
                      {percent(outcome.probability)}
                    </Td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {/* Team analysis */}
      <div className="grid gap-4 lg:grid-cols-2">
        {[analysis.homeForm, analysis.awayForm].map((team, index) => (
          <Card key={team.teamKey}>
            <CardHeader
              title={team.name}
              subtitle={index === 0 ? 'Home' : 'Away'}
              action={<FormStrip results={team.results} />}
            />
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-4 py-4 sm:grid-cols-3">
              <div>
                <dt className="text-[11px] uppercase tracking-wider text-ink-muted">Elo</dt>
                <dd className="tnum text-[15px] font-semibold text-ink">{Math.round(team.elo)}</dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase tracking-wider text-ink-muted">Weighted form</dt>
                <dd className="tnum text-[15px] font-semibold text-ink">{percent(team.weightedPoints, 0)}</dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase tracking-wider text-ink-muted">Matches</dt>
                <dd className="tnum text-[15px] font-semibold text-ink">{team.matchesPlayed}</dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase tracking-wider text-ink-muted">Scored / match</dt>
                <dd className="tnum text-[15px] font-semibold text-ink">{decimal(team.goalsForPerMatch)}</dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase tracking-wider text-ink-muted">Conceded / match</dt>
                <dd className="tnum text-[15px] font-semibold text-ink">{decimal(team.goalsAgainstPerMatch)}</dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase tracking-wider text-ink-muted">Rest</dt>
                <dd className="tnum text-[15px] font-semibold text-ink">
                  {team.daysSinceLastMatch === null ? '—' : `${Math.round(team.daysSinceLastMatch)}d`}
                  <span className="ml-1 text-[11px] font-normal text-ink-muted">
                    {team.matchesInLast14Days} in 14d
                  </span>
                </dd>
              </div>
            </dl>
            <div className="border-t border-hairline px-4 py-3">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                Record by venue
              </div>
              <p className="mt-0.5 text-[11px] text-ink-muted">
                Every completed match on record before this kick-off, neutral venues excluded. The
                form figures above use a shorter, recency-weighted window, so the two counts differ.
              </p>
              <table className="mt-1.5 w-full border-collapse text-[13px]">
                <thead>
                  <tr>
                    <th className="w-16 pb-1 text-left text-[11px] font-medium uppercase tracking-wider text-ink-muted">
                      Venue
                    </th>
                    <th className="pb-1 text-right text-[11px] font-medium uppercase tracking-wider text-ink-muted">
                      P
                    </th>
                    <th className="pb-1 text-right text-[11px] font-medium uppercase tracking-wider text-ink-muted">
                      W
                    </th>
                    <th className="pb-1 text-right text-[11px] font-medium uppercase tracking-wider text-ink-muted">
                      D
                    </th>
                    <th className="pb-1 text-right text-[11px] font-medium uppercase tracking-wider text-ink-muted">
                      L
                    </th>
                    <th className="pb-1 text-right text-[11px] font-medium uppercase tracking-wider text-ink-muted">
                      GF
                    </th>
                    <th className="pb-1 text-right text-[11px] font-medium uppercase tracking-wider text-ink-muted">
                      GA
                    </th>
                    <th className="pb-1 text-right text-[11px] font-medium uppercase tracking-wider text-ink-muted">
                      Pts/m
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(
                    [
                      ['Home', team.homeRecord],
                      ['Away', team.awayRecord],
                    ] as const
                  ).map(([label, record]) => (
                    <tr key={label} className="border-t border-hairline">
                      <td className="py-1 text-ink-secondary">{label}</td>
                      <td className="tnum py-1 text-right">{record.played}</td>
                      <td className="tnum py-1 text-right">{record.won}</td>
                      <td className="tnum py-1 text-right">{record.drawn}</td>
                      <td className="tnum py-1 text-right">{record.lost}</td>
                      <td className="tnum py-1 text-right">{decimal(record.goalsForPerMatch)}</td>
                      <td className="tnum py-1 text-right">{decimal(record.goalsAgainstPerMatch)}</td>
                      <td className="tnum py-1 text-right font-medium">
                        {decimal(record.pointsPerMatch)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="border-t border-hairline px-4 py-3">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                Unavailable
              </div>
              {team.absentees.length === 0 ? (
                <p className="mt-1 text-[13px] text-ink-muted">
                  {team.availabilityReported
                    ? 'None reported'
                    : 'Not known — the configured data source has no team-news feed, so injuries and suspensions are not factored into this prediction.'}
                </p>
              ) : (
                <ul className="mt-1.5 flex flex-col gap-1">
                  {team.absentees.map((player) => (
                    <li key={player.name} className="flex flex-wrap items-center gap-2 text-[13px]">
                      <span className="text-ink">{player.name}</span>
                      {player.position ? (
                        <span className="text-[11px] text-ink-muted">{player.position}</span>
                      ) : null}
                      <Badge tone={player.status === 'SUSPENDED' ? 'critical' : 'serious'}>
                        {player.status}
                      </Badge>
                      <span className="tnum text-[11px] text-ink-muted">
                        {percent(player.importance, 1)} of squad value
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>
        ))}
      </div>

      {/* Markets */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader
            title="All markets"
            subtitle="Every market is derived from the same underlying distribution, so the prices are mutually consistent."
          />
          <div className="table-scroll">
            <table className={`w-full border-collapse ${hasMarket ? 'min-w-[620px]' : 'min-w-[360px]'}`}>
              <thead>
                <tr>
                  <Th>Market</Th>
                  <Th>Selection</Th>
                  <Th align="right">Model</Th>
                  <Th align="right">Fair odds</Th>
                  {hasMarket ? (
                    <>
                      <Th align="right">Best price</Th>
                      <Th align="right">Edge</Th>
                      <Th align="right">Model EV</Th>
                    </>
                  ) : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {[...marketGroups.entries()].map(([key, outcomes]) =>
                  outcomes.map((outcome, index) => (
                    <tr key={`${key}-${outcome.selection}`} className="hover:bg-ink/[0.02]">
                      <Td className="text-ink-secondary">
                        {index === 0 ? (
                          <>
                            {marketLabel(outcome.market)}
                            {outcome.line === null ? null : (
                              <span className="tnum ml-1 text-ink-muted">{outcome.line}</span>
                            )}
                          </>
                        ) : null}
                      </Td>
                      <Td>{selectionLabel(outcome.selection)}</Td>
                      <Td align="right" className="tnum font-medium">{percent(outcome.probability)}</Td>
                      <Td align="right" className="tnum text-ink-secondary">{decimal(outcome.fairOdds)}</Td>
                      {hasMarket ? (
                        <>
                          <Td align="right" className="tnum">
                            {outcome.bookmakerOdds === null ? (
                              <span className="text-ink-muted">No market</span>
                            ) : (
                              decimal(outcome.bookmakerOdds)
                            )}
                          </Td>
                          <Td align="right" className="tnum">{signedPercent(outcome.edge)}</Td>
                          <Td
                            align="right"
                            className={`tnum ${(outcome.expectedValue ?? 0) > 0 ? 'font-semibold text-good-text' : 'text-ink-secondary'}`}
                          >
                            {signedPercent(outcome.expectedValue)}
                          </Td>
                        </>
                      ) : null}
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        </Card>

        {correctScores.length > 0 ? (
          <Card>
            <CardHeader title="Most likely scores" subtitle="From the same joint score distribution." />
            <div className="px-2 py-3">
              <CorrectScoreChart scores={correctScores} />
            </div>
          </Card>
        ) : null}
      </div>

      {/* Head to head */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Head-to-head"
            subtitle="Weighted by recency, so an old rivalry informs the model without dominating it."
          />
          {analysis.headToHead.meetings === 0 ? (
            <p className="px-4 py-6 text-[13px] text-ink-muted">
              These sides have no recorded previous meetings, which lowers the data-quality score.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-3 px-4 py-4">
                <StatTile label={analysis.homeTeam.shortName} value={analysis.headToHead.homeWins} />
                <StatTile label="Draws" value={analysis.headToHead.draws} />
                <StatTile label={analysis.awayTeam.shortName} value={analysis.headToHead.awayWins} />
              </div>
              <div className="table-scroll border-t border-hairline">
                <table className="w-full border-collapse">
                  <thead>
                    <tr>
                      <Th>Date</Th>
                      <Th>Fixture</Th>
                      <Th align="right">Score</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-hairline">
                    {analysis.headToHead.recent.map((meeting) => (
                      <tr key={meeting.date}>
                        <Td className="tnum text-ink-secondary">{meeting.date.slice(0, 10)}</Td>
                        <Td>{meeting.homeTeam} v {meeting.awayTeam}</Td>
                        <Td align="right" className="tnum font-medium">
                          {meeting.homeScore}–{meeting.awayScore}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Confidence and data quality"
            subtitle="Every component that fed the two scores, so neither is a black box."
          />
          <div className="table-scroll">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th>Component</Th>
                  <Th align="right">Score</Th>
                  <Th align="right">Weight</Th>
                  <Th>Detail</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {analysis.confidenceComponents.map((component) => (
                  <tr key={`c-${component.name}`}>
                    <Td>{component.name}</Td>
                    <Td align="right" className="tnum">{component.score}</Td>
                    <Td align="right" className="tnum text-ink-secondary">{percent(component.weight, 0)}</Td>
                    <Td className="text-[12px] text-ink-muted">{component.detail}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {analysis.missingData.length > 0 ? (
            <div className="border-t border-hairline px-4 py-3">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                Missing data
              </div>
              <ul className="mt-1.5 flex flex-col gap-1">
                {analysis.missingData.map((item) => (
                  <li key={item} className="text-[13px] text-ink-secondary">• {item}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>
      </div>

      {/* Features */}
      <Card>
        <CardHeader
          title="Model inputs"
          subtitle="Every feature the model computed for this fixture, with its value and its signed influence toward the home side."
        />
        <div className="grid gap-x-8 gap-y-5 px-4 py-4 md:grid-cols-2 xl:grid-cols-3">
          {CATEGORY_ORDER.filter((category) => featureGroups.has(category)).map((category) => (
            <div key={category}>
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                {CATEGORY_LABELS[category] ?? category}
              </h3>
              <ul className="mt-2 flex flex-col gap-1.5">
                {featureGroups.get(category)!.map((feature) => (
                  <li key={feature.name} className="flex items-baseline justify-between gap-3 text-[13px]">
                    <span className="min-w-0 flex-1 text-ink-secondary">{feature.label}</span>
                    <span className="tnum shrink-0 font-medium text-ink">
                      {Math.abs(feature.value) >= 100
                        ? Math.round(feature.value)
                        : feature.value.toFixed(2)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Card>

      <Note>
        This prediction was produced by model version <strong>{analysis.modelVersion}</strong> using
        feature set <strong>{analysis.featuresVersion}</strong>, from data no newer than{' '}
        {kickoffFull(analysis.dataTimestamp)}. Recording the versions and timestamps is what makes a
        past prediction reproducible. Probabilities are estimates; they are not guarantees.
      </Note>
    </div>
  );
}
