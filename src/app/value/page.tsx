import Link from 'next/link';
import {
  Badge,
  Card,
  CardHeader,
  ConfidenceBadge,
  EmptyState,
  ErrorState,
  Note,
  StatTile,
  Td,
  Th,
} from '@/components/ui';
import { DateFilter, FilterBar, ResetFilters, SelectFilter, ThresholdFilter } from '@/components/filter-bar';
import {
  getDataFreshness,
  listLeagues,
  listSports,
  listValueOpportunities,
  type ValueOpportunityDto,
} from '@/lib/services/queries';
import {
  loadReliabilityModels,
  reliabilityExplanation,
  type EdgeReliability,
} from '@/lib/services/reliability';
import {
  decimal,
  kickoffFull,
  marketLabel,
  percent,
  selectionLabel,
  signedPercent,
  sportLabel,
} from '@/lib/format';
import type { ConfidenceLevel } from '@/lib/prediction/types';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Value' };

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function single(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value === '' ? undefined : value;
}

const EV_OPTIONS = [
  { value: '0.02', label: 'EV >= +2%' },
  { value: '0.05', label: 'EV >= +5%' },
  { value: '0.1', label: 'EV >= +10%' },
  { value: '0.2', label: 'EV >= +20%' },
];

const EDGE_OPTIONS = [
  { value: '0', label: 'Any edge' },
  { value: '0.02', label: 'Edge >= 2pp' },
  { value: '0.05', label: 'Edge >= 5pp' },
  { value: '0.1', label: 'Edge >= 10pp' },
];

const PROBABILITY_OPTIONS = [
  { value: '0', label: 'Any' },
  { value: '0.3', label: '>= 30%' },
  { value: '0.5', label: '>= 50%' },
  { value: '0.65', label: '>= 65%' },
];

const RELIABILITY_OPTIONS = [
  { value: '', label: 'Show all, flagged' },
  { value: 'supported', label: 'Only model-supported' },
];

function ReliabilityBadge({ reliability }: { reliability: EdgeReliability }) {
  if (reliability === 'SUPPORTED') return <Badge tone="good">Supported</Badge>;
  if (reliability === 'UNVERIFIED') return <Badge tone="serious">Beyond model accuracy</Badge>;
  return <Badge tone="neutral">Unmeasured</Badge>;
}

export default async function ValuePage({ searchParams }: PageProps) {
  const params = await searchParams;
  const sport = single(params.sport);
  const league = single(params.league);
  const market = single(params.market);
  const confidence = single(params.confidence) as ConfidenceLevel | undefined;
  const dateParam = single(params.date);
  const minEv = Number(single(params.minEv) ?? '0.02');
  const minEdge = Number(single(params.minEdge) ?? '0');
  const minProbability = Number(single(params.minProbability) ?? '0');
  const onlySupported = single(params.reliability) === 'supported';

  let body;
  try {
    const [sports, leagues, opportunities, reliabilityModels, freshness] = await Promise.all([
      listSports(),
      listLeagues(sport),
      listValueOpportunities({
        sportKey: sport,
        leagueKey: league,
        market,
        date: dateParam ? new Date(dateParam) : undefined,
        minEv: Number.isFinite(minEv) ? minEv : 0.02,
        minEdge: Number.isFinite(minEdge) ? minEdge : 0,
        minProbability: Number.isFinite(minProbability) ? minProbability : 0,
        confidence,
        onlySupported,
        limit: 100,
      }),
      loadReliabilityModels(),
      // Distinguishes "the market is efficiently priced" from "there is no
      // market": an empty board means very different things in the two cases.
      getDataFreshness(),
    ]);
    const oddsAvailable = freshness.newestOdds !== null;

    const supported = opportunities.filter((entry) => entry.reliability === 'SUPPORTED');
    const flagged = opportunities.filter((entry) => entry.reliability === 'UNVERIFIED');
    const totalKelly = supported.reduce((sum, entry) => sum + (entry.kellyStake ?? 0), 0);

    const renderRow = (opportunity: ValueOpportunityDto) => (
      <tr
        key={`${opportunity.matchId}-${opportunity.market}-${opportunity.selection}-${opportunity.line ?? ''}`}
        className="hover:bg-ink/[0.02]"
      >
        <Td>
          <Link href={`/matches/${opportunity.matchId}`} className="font-medium hover:underline">
            {opportunity.homeTeam} <span className="text-ink-muted">v</span> {opportunity.awayTeam}
          </Link>
          <div className="text-[11px] text-ink-muted">
            {opportunity.leagueName} · {kickoffFull(opportunity.kickoff)}
          </div>
        </Td>
        <Td>
          <div className="text-ink">{marketLabel(opportunity.market)}</div>
          <div className="text-[11px] text-ink-muted">
            {selectionLabel(opportunity.selection, opportunity.line)}
          </div>
        </Td>
        <Td align="right" className="tnum font-semibold">{percent(opportunity.probability)}</Td>
        <Td align="right" className="tnum">
          {decimal(opportunity.bookmakerOdds)}
          {opportunity.bookmaker ? (
            <div className="text-[11px] text-ink-muted">{opportunity.bookmaker}</div>
          ) : null}
        </Td>
        <Td align="right" className="tnum text-ink-secondary">{percent(opportunity.impliedProbability)}</Td>
        <Td align="right" className="tnum">{signedPercent(opportunity.edge)}</Td>
        <Td
          align="right"
          className={`tnum font-semibold ${opportunity.expectedValue > 0 ? 'text-good-text' : 'text-ink'}`}
        >
          {signedPercent(opportunity.expectedValue)}
        </Td>
        <Td align="right" className="tnum text-ink-secondary">
          {opportunity.kellyStake === null ? '—' : percent(opportunity.kellyStake, 2)}
        </Td>
        <Td><ConfidenceBadge level={opportunity.confidence} score={opportunity.confidenceScore} /></Td>
        <Td>
          <span
            title={reliabilityExplanation(
              opportunity.reliability,
              reliabilityModels.get(opportunity.modelVersion),
            )}
          >
            <ReliabilityBadge reliability={opportunity.reliability} />
          </span>
        </Td>
      </tr>
    );

    body = (
      <>
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="Opportunities" value={opportunities.length} detail="matching the filters" />
          <StatTile
            label="Model-supported"
            value={supported.length}
            detail="edge within measured accuracy"
            tone={supported.length > 0 ? 'good' : 'neutral'}
          />
          <StatTile
            label="Beyond model accuracy"
            value={flagged.length}
            detail="larger than the model has demonstrated"
          />
          <StatTile
            label="Total quarter-Kelly"
            value={percent(totalKelly, 1)}
            detail="of bankroll, supported edges only"
          />
        </section>

        <FilterBar>
          <SelectFilter
            name="sport"
            label="Sport"
            placeholder="All sports"
            options={sports.map((entry) => ({ value: entry.key, label: sportLabel(entry.key) }))}
          />
          <SelectFilter
            name="league"
            label="League"
            placeholder="All leagues"
            options={leagues.map((entry) => ({ value: entry.key, label: entry.name }))}
          />
          <SelectFilter
            name="market"
            label="Market"
            placeholder="All markets"
            options={[
              'MATCH_WINNER', 'OVER_UNDER', 'BTTS', 'ASIAN_HANDICAP',
              'POINT_SPREAD', 'TOTAL_GAMES', 'HANDICAP_GAMES', 'SET_WINNER', 'CORRECT_SCORE',
            ].map((value) => ({ value, label: marketLabel(value) }))}
          />
          <ThresholdFilter name="minEv" label="Min EV" options={EV_OPTIONS} />
          <ThresholdFilter name="minEdge" label="Min edge" options={EDGE_OPTIONS} />
          <ThresholdFilter name="minProbability" label="Min probability" options={PROBABILITY_OPTIONS} />
          <SelectFilter
            name="confidence"
            label="Confidence"
            placeholder="Any"
            options={[
              { value: 'HIGH', label: 'High' },
              { value: 'MEDIUM', label: 'Medium' },
              { value: 'LOW', label: 'Low' },
            ]}
          />
          <ThresholdFilter name="reliability" label="Reliability" options={RELIABILITY_OPTIONS} />
          <DateFilter name="date" label="Date" />
          <ResetFilters href="/value" />
        </FilterBar>

        <Card>
          <CardHeader
            title="Value opportunities"
            subtitle="Ranked by model-estimated expected value. Bookmaker probabilities have the overround removed, so the edge is not inflated by the margin."
          />
          {opportunities.length === 0 ? (
            <EmptyState
              title={
                oddsAvailable
                  ? 'No opportunities match these filters'
                  : 'No bookmaker odds are configured'
              }
              description={
                oddsAvailable
                  ? 'Lower the minimum EV or edge, widen the date range, or allow flagged edges. An empty board is a normal outcome when the market is efficiently priced.'
                  : 'Value requires a price to compare the model against. The active data source supplies fixtures and results but no odds, so there is nothing to compute an edge from. Predictions themselves are unaffected — see the dashboard.'
              }
            />
          ) : (
            <div className="table-scroll">
              <table className="w-full min-w-[1100px] border-collapse">
                <thead>
                  <tr>
                    <Th>Match</Th>
                    <Th>Market</Th>
                    <Th align="right">Model</Th>
                    <Th align="right">Odds</Th>
                    <Th align="right">Implied</Th>
                    <Th align="right">Edge</Th>
                    <Th align="right">Model EV</Th>
                    <Th align="right">1/4 Kelly</Th>
                    <Th>Confidence</Th>
                    <Th>Reliability</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">{opportunities.map(renderRow)}</tbody>
              </table>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="How to read the reliability column" />
          <div className="space-y-3 px-4 py-4">
            <div className="flex flex-wrap items-start gap-3">
              <Badge tone="good">Supported</Badge>
              <p className="max-w-3xl flex-1 text-[13px] text-ink-secondary">
                The edge is within three times this model version&apos;s measured expected calibration
                error on settled matches — the size of disagreement the model has actually
                demonstrated it can find.
              </p>
            </div>
            <div className="flex flex-wrap items-start gap-3">
              <Badge tone="serious">Beyond model accuracy</Badge>
              <p className="max-w-3xl flex-1 text-[13px] text-ink-secondary">
                The arithmetic is correct, but it assumes the model probability is right. A gap this
                large against a priced market is more often a model error than a market error, so
                these are shown for transparency rather than presented as opportunities.
              </p>
            </div>
            <div className="flex flex-wrap items-start gap-3">
              <Badge tone="neutral">Unmeasured</Badge>
              <p className="max-w-3xl flex-1 text-[13px] text-ink-secondary">
                This model version has fewer than 30 settled predictions, so there is no basis yet
                for judging whether an edge of this size is credible.
              </p>
            </div>
          </div>
        </Card>

        <Note>
          Expected value is <strong>model-estimated</strong>: EV = (model probability × decimal odds)
          − 1. It is only as good as the probability behind it, which is why the measured
          out-of-sample calibration on the performance page matters more than any single number here.
          The quarter-Kelly column is a conservative sizing reference capped at 2% of bankroll, not advice.
        </Note>
      </>
    );
  } catch (error) {
    body = (
      <ErrorState
        title="Could not load value opportunities"
        detail={error instanceof Error ? error.message : 'An unexpected error occurred.'}
      />
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-ink">Value</h1>
        <p className="mt-1 text-[13px] text-ink-secondary">
          Where the model&apos;s probability disagrees with the market — and whether that
          disagreement is large enough to be believable.
        </p>
      </div>
      {body}
    </div>
  );
}
