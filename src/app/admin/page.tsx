import { Badge, Card, CardHeader, ErrorState, Note, StatTile, Td, Th } from '@/components/ui';
import { FreshnessIndicator } from '@/components/data-status';
import { prisma } from '@/lib/db/prisma';
import { getDataFreshness } from '@/lib/services/queries';
import { getConfig } from '@/lib/config';
import { decimal, percent, relativeTime, signedPercent, sportLabel } from '@/lib/format';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Admin' };

interface StoredCalibration {
  expectedCalibrationError?: number;
  skillScore?: number;
}

interface StoredParameters {
  ensembleWeights?: Record<string, number>;
  calibration?: { temperature?: number; classBias?: number[]; fittedOn?: number } | null;
  ml?: { trainedOn?: number; featureNames?: string[] } | null;
}

export default async function AdminPage() {
  let body;
  try {
    const startedAt = Date.now();
    let databaseOk = true;
    let databaseError: string | null = null;
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (error) {
      databaseOk = false;
      databaseError = error instanceof Error ? error.message : 'Unknown error';
    }
    const latencyMs = Date.now() - startedAt;

    const [
      freshness,
      runs,
      versions,
      performance,
      counts,
      sportBreakdown,
    ] = await Promise.all([
      getDataFreshness(),
      prisma.ingestionRun.findMany({ orderBy: { startedAt: 'desc' }, take: 10 }),
      prisma.modelVersion.findMany({ orderBy: { createdAt: 'desc' } }),
      prisma.modelPerformance.findMany({
        where: { leagueKey: null, confidence: null, market: 'MATCH_WINNER' },
        orderBy: { computedAt: 'desc' },
      }),
      Promise.all([
        prisma.sport.count(),
        prisma.league.count(),
        prisma.team.count(),
        prisma.player.count(),
        prisma.match.count(),
        prisma.match.count({ where: { status: 'SCHEDULED' } }),
        prisma.odds.count(),
        prisma.prediction.count(),
        prisma.predictionOutcome.count(),
        prisma.bet.count(),
        prisma.backtest.count(),
      ]),
      prisma.match.groupBy({ by: ['sportId'], _count: true }),
    ]);

    const [sports, leagues, teams, players, matches, upcoming, odds, predictions, outcomes, bets, backtests] = counts;
    const sportNames = await prisma.sport.findMany({ select: { id: true, key: true } });
    const sportById = new Map(sportNames.map((sport) => [sport.id, sport.key]));

    const config = getConfig();
    const failedRuns = runs.filter((run) => run.status === 'FAILED');

    body = (
      <>
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label="Database"
            value={databaseOk ? 'Healthy' : 'Unreachable'}
            detail={databaseOk ? `${latencyMs}ms round trip` : (databaseError ?? '')}
            tone={databaseOk ? 'good' : 'critical'}
          />
          <StatTile
            label="Last ingestion"
            value={relativeTime(freshness.lastIngestion)}
            detail={freshness.lastIngestionStatus ?? 'never run'}
            tone={freshness.lastIngestionStatus === 'FAILED' ? 'critical' : 'neutral'}
          />
          <StatTile label="Matches" value={matches} detail={`${upcoming} upcoming`} />
          <StatTile label="Predictions" value={predictions} detail={`${outcomes} priced selections`} />
        </section>

        <Card>
          <CardHeader
            title="Environment"
            subtitle="Secrets are never displayed — only whether they are configured."
          />
          <div className="table-scroll">
            <table className="w-full border-collapse">
              <tbody className="divide-y divide-hairline">
                <tr>
                  <Td className="w-64 text-ink-secondary">Data provider</Td>
                  <Td className="font-medium">{config.DATA_PROVIDER}</Td>
                </tr>
                <tr>
                  <Td className="text-ink-secondary">Sports API key</Td>
                  <Td>
                    {config.SPORTS_API_KEY.length > 0 ? (
                      <Badge tone="good">Configured</Badge>
                    ) : (
                      <Badge tone="neutral">Not set — using demo data</Badge>
                    )}
                  </Td>
                </tr>
                <tr>
                  <Td className="text-ink-secondary">Odds API key</Td>
                  <Td>
                    {config.ODDS_API_KEY.length > 0 ? (
                      <Badge tone="good">Configured</Badge>
                    ) : (
                      <Badge tone="neutral">Not set</Badge>
                    )}
                  </Td>
                </tr>
                <tr>
                  <Td className="text-ink-secondary">API write key</Td>
                  <Td>
                    {config.API_ACCESS_KEY.length > 0 ? (
                      <Badge tone="good">Required on mutating routes</Badge>
                    ) : (
                      <Badge tone="warning">Not set — mutating routes are open</Badge>
                    )}
                  </Td>
                </tr>
                <tr>
                  <Td className="text-ink-secondary">Rate limit</Td>
                  <Td className="tnum">
                    {config.RATE_LIMIT_MAX} requests per {config.RATE_LIMIT_WINDOW_MS / 1000}s per client
                  </Td>
                </tr>
                <tr>
                  <Td className="text-ink-secondary">Data origin</Td>
                  <Td>
                    <Badge tone={freshness.origin === 'LIVE' ? 'good' : 'warning'}>
                      {freshness.origin}
                    </Badge>
                  </Td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="border-t border-hairline px-4 py-3">
            <FreshnessIndicator freshness={freshness} />
          </div>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Record counts" />
            <div className="table-scroll">
              <table className="w-full border-collapse">
                <tbody className="divide-y divide-hairline">
                  {[
                    ['Sports', sports],
                    ['Leagues', leagues],
                    ['Teams', teams],
                    ['Players', players],
                    ['Matches', matches],
                    ['Odds quotes', odds],
                    ['Predictions', predictions],
                    ['Priced selections', outcomes],
                    ['Tracked bets', bets],
                    ['Backtests', backtests],
                  ].map(([label, value]) => (
                    <tr key={String(label)}>
                      <Td className="text-ink-secondary">{label}</Td>
                      <Td align="right" className="tnum font-medium">{Number(value).toLocaleString('en-GB')}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card>
            <CardHeader title="Matches by sport" />
            <div className="table-scroll">
              <table className="w-full border-collapse">
                <tbody className="divide-y divide-hairline">
                  {sportBreakdown.map((entry) => (
                    <tr key={entry.sportId}>
                      <Td className="text-ink-secondary">
                        {sportLabel(sportById.get(entry.sportId) ?? 'unknown')}
                      </Td>
                      <Td align="right" className="tnum font-medium">{entry._count}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>

        <Card>
          <CardHeader
            title="Model versions"
            subtitle="Stored parameters make every historical prediction reproducible."
          />
          <div className="table-scroll">
            <table className="w-full min-w-[900px] border-collapse">
              <thead>
                <tr>
                  <Th>Version</Th>
                  <Th>Sport</Th>
                  <Th>Active</Th>
                  <Th>Trained</Th>
                  <Th align="right">Samples</Th>
                  <Th>Ensemble weights</Th>
                  <Th align="right">Calibration T</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {versions.map((version) => {
                  const parameters = (version.parameters ?? {}) as StoredParameters;
                  const weights = parameters.ensembleWeights ?? {};
                  return (
                    <tr key={version.id}>
                      <Td className="font-medium">{version.version}</Td>
                      <Td className="text-ink-secondary">{sportLabel(version.sportKey)}</Td>
                      <Td>
                        {version.active ? <Badge tone="good">Active</Badge> : <Badge tone="neutral">Retired</Badge>}
                      </Td>
                      <Td className="text-ink-secondary">
                        {relativeTime(version.trainedAt?.toISOString() ?? null)}
                      </Td>
                      <Td align="right" className="tnum">{version.trainingSampleSize ?? '—'}</Td>
                      <Td className="text-[12px]">
                        {Object.entries(weights)
                          .filter(([, weight]) => weight > 0)
                          .sort((a, b) => b[1] - a[1])
                          .map(([name, weight]) => `${name} ${(weight * 100).toFixed(0)}%`)
                          .join(' · ') || '—'}
                      </Td>
                      <Td align="right" className="tnum">
                        {parameters.calibration?.temperature === undefined
                          ? '—'
                          : decimal(parameters.calibration.temperature, 2)}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>

        <Card>
          <CardHeader title="Measured accuracy" subtitle="Out-of-sample, on settled matches only." />
          <div className="table-scroll">
            <table className="w-full min-w-[720px] border-collapse">
              <thead>
                <tr>
                  <Th>Sport</Th>
                  <Th align="right">Scored</Th>
                  <Th align="right">Accuracy</Th>
                  <Th align="right">Log loss</Th>
                  <Th align="right">Brier</Th>
                  <Th align="right">Skill</Th>
                  <Th align="right">Calibration error</Th>
                  <Th>Computed</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {performance.length === 0 ? (
                  <tr>
                    <Td colSpan={8} className="text-ink-muted">
                      No settled predictions have been scored yet.
                    </Td>
                  </tr>
                ) : (
                  performance.map((row) => {
                    const calibration = (row.calibration ?? {}) as StoredCalibration;
                    return (
                      <tr key={row.id}>
                        <Td className="font-medium">{sportLabel(row.sportKey)}</Td>
                        <Td align="right" className="tnum">{row.predictions}</Td>
                        <Td align="right" className="tnum">{percent(row.accuracy)}</Td>
                        <Td align="right" className="tnum">{decimal(row.logLoss, 4)}</Td>
                        <Td align="right" className="tnum">{decimal(row.brierScore, 4)}</Td>
                        <Td
                          align="right"
                          className={`tnum font-medium ${
                            (calibration.skillScore ?? 0) > 0 ? 'text-good-text' : 'text-critical'
                          }`}
                        >
                          {calibration.skillScore === undefined ? '—' : signedPercent(calibration.skillScore)}
                        </Td>
                        <Td align="right" className="tnum">
                          {calibration.expectedCalibrationError === undefined
                            ? '—'
                            : `${(calibration.expectedCalibrationError * 100).toFixed(2)}pp`}
                        </Td>
                        <Td className="text-ink-secondary">{relativeTime(row.computedAt.toISOString())}</Td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </Card>

        <Card className={failedRuns.length > 0 ? 'border-critical/40' : undefined}>
          <CardHeader
            title="Ingestion history"
            subtitle={
              failedRuns.length > 0
                ? `${failedRuns.length} of the last ${runs.length} runs failed`
                : 'Every recorded run and its outcome'
            }
          />
          <div className="table-scroll">
            <table className="w-full min-w-[760px] border-collapse">
              <thead>
                <tr>
                  <Th>Started</Th>
                  <Th>Provider</Th>
                  <Th>Status</Th>
                  <Th align="right">Matches</Th>
                  <Th align="right">Odds</Th>
                  <Th align="right">Duration</Th>
                  <Th>Error</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {runs.length === 0 ? (
                  <tr>
                    <Td colSpan={7} className="text-ink-muted">No ingestion runs recorded.</Td>
                  </tr>
                ) : (
                  runs.map((run) => (
                    <tr key={run.id}>
                      <Td className="text-ink-secondary">{relativeTime(run.startedAt.toISOString())}</Td>
                      <Td>{run.provider}</Td>
                      <Td>
                        <Badge
                          tone={
                            run.status === 'SUCCESS' ? 'good' : run.status === 'FAILED' ? 'critical' : 'neutral'
                          }
                        >
                          {run.status}
                        </Badge>
                      </Td>
                      <Td align="right" className="tnum">{run.matchesUpserted}</Td>
                      <Td align="right" className="tnum">{run.oddsUpserted}</Td>
                      <Td align="right" className="tnum">
                        {run.finishedAt
                          ? `${((run.finishedAt.getTime() - run.startedAt.getTime()) / 1000).toFixed(1)}s`
                          : '—'}
                      </Td>
                      <Td className="text-[12px] text-critical">{run.error ?? ''}</Td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>

        <Note>
          Operational commands: <code>npm run db:seed</code> ingests and trains,{' '}
          <code>npm run models:train</code> retrains in place, <code>npm run backtest -- --save</code>{' '}
          runs walk-forward validation and stores the result. Health is also available as JSON at{' '}
          <code>/api/health</code> for monitoring.
        </Note>
      </>
    );
  } catch (error) {
    body = (
      <ErrorState
        title="Could not load admin diagnostics"
        detail={error instanceof Error ? error.message : 'An unexpected error occurred.'}
      />
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-ink">Admin</h1>
        <p className="mt-1 text-[13px] text-ink-secondary">
          Data pipeline status, model registry and measured accuracy.
        </p>
      </div>
      {body}
    </div>
  );
}
