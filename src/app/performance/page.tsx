import { Card, CardHeader, EmptyState, ErrorState, Note, StatTile, Td, Th } from '@/components/ui';
import { CalibrationChart, EquityCurve, type CalibrationPoint } from '@/components/charts';
import { SelectFilter, FilterBar, ResetFilters } from '@/components/filter-bar';
import { prisma } from '@/lib/db/prisma';
import { listSports } from '@/lib/services/queries';
import { decimal, percent, relativeTime, signedPercent, sportLabel } from '@/lib/format';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Model performance' };

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function single(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value === '' ? undefined : value;
}

interface StoredCalibration {
  bins?: CalibrationPoint[];
  expectedCalibrationError?: number;
  baselineLogLoss?: number;
  skillScore?: number;
  betsPlaced?: number;
  marketBaseline?: { logLoss: number; brierScore: number; accuracy: number } | null;
}

export default async function PerformancePage({ searchParams }: PageProps) {
  const params = await searchParams;
  const sport = single(params.sport);

  let body;
  try {
    const [sports, rows, backtests] = await Promise.all([
      listSports(),
      prisma.modelPerformance.findMany({
        where: { ...(sport ? { sportKey: sport } : {}), market: 'MATCH_WINNER' },
        include: { modelVersion: { select: { version: true, trainedAt: true, trainingSampleSize: true } } },
        orderBy: [{ sportKey: 'asc' }, { computedAt: 'desc' }],
      }),
      prisma.backtest.findMany({
        where: sport ? { sportKey: sport } : {},
        include: { modelVersion: { select: { version: true } } },
        orderBy: { createdAt: 'desc' },
        take: 6,
      }),
    ]);

    const overall = rows.filter((row) => row.leagueKey === null && row.confidence === null);
    const byLeague = rows.filter((row) => row.leagueKey !== null);
    const byConfidence = rows.filter((row) => row.confidence !== null);

    const totalPredictions = overall.reduce((sum, row) => sum + row.predictions, 0);
    const weightedLogLoss =
      totalPredictions > 0
        ? overall.reduce((sum, row) => sum + row.logLoss * row.predictions, 0) / totalPredictions
        : 0;
    const weightedBrier =
      totalPredictions > 0
        ? overall.reduce((sum, row) => sum + row.brierScore * row.predictions, 0) / totalPredictions
        : 0;
    const weightedAccuracy =
      totalPredictions > 0
        ? overall.reduce((sum, row) => sum + row.accuracy * row.predictions, 0) / totalPredictions
        : 0;

    // The calibration chart pools every scored prediction across model versions.
    const pooledBins = new Map<string, CalibrationPoint>();
    for (const row of overall) {
      const calibration = (row.calibration ?? {}) as StoredCalibration;
      for (const bin of calibration.bins ?? []) {
        const existing = pooledBins.get(bin.bin);
        if (!existing) {
          pooledBins.set(bin.bin, { ...bin });
        } else {
          const count = existing.count + bin.count;
          pooledBins.set(bin.bin, {
            bin: bin.bin,
            count,
            predicted:
              count === 0 ? 0 : (existing.predicted * existing.count + bin.predicted * bin.count) / count,
            observed:
              count === 0 ? 0 : (existing.observed * existing.count + bin.observed * bin.count) / count,
          });
        }
      }
    }
    const bins = [...pooledBins.values()].sort((a, b) => a.bin.localeCompare(b.bin, undefined, { numeric: true }));

    const latestBacktest = backtests[0];
    const equity = latestBacktest
      ? ((latestBacktest.equityCurve ?? []) as Array<{ date: string; profit: number }>)
      : [];

    if (overall.length === 0) {
      body = (
        <EmptyState
          title="No settled predictions yet"
          description="Model performance is measured only on matches that have finished. Run the seed or wait for fixtures to settle, then re-run scoring."
        />
      );
    } else {
      body = (
        <>
          <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="Scored predictions" value={totalPredictions} detail="settled, out of sample" />
            <StatTile label="Accuracy" value={percent(weightedAccuracy)} detail="top-pick hit rate" />
            <StatTile label="Log loss" value={decimal(weightedLogLoss, 4)} detail="lower is better" />
            <StatTile label="Brier score" value={decimal(weightedBrier, 4)} detail="lower is better" />
          </section>

          <FilterBar>
            <SelectFilter
              name="sport"
              label="Sport"
              placeholder="All sports"
              options={sports.map((entry) => ({ value: entry.key, label: sportLabel(entry.key) }))}
            />
            <ResetFilters href="/performance" />
          </FilterBar>

          <Card>
            <CardHeader
              title="Headline metrics by model version"
              subtitle="Skill compares the model's log loss against simply predicting the observed base rate. Positive skill means the model adds information."
            />
            <div className="table-scroll">
              <table className="w-full min-w-[900px] border-collapse">
                <thead>
                  <tr>
                    <Th>Model version</Th>
                    <Th>Sport</Th>
                    <Th align="right">Predictions</Th>
                    <Th align="right">Accuracy</Th>
                    <Th align="right">Log loss</Th>
                    <Th align="right">Base rate</Th>
                    <Th align="right">Skill</Th>
                    <Th align="right">Brier</Th>
                    <Th align="right">Calib. error</Th>
                    <Th align="right">ROI</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {overall.map((row) => {
                    const calibration = (row.calibration ?? {}) as StoredCalibration;
                    const skill = calibration.skillScore ?? null;
                    return (
                      <tr key={row.id}>
                        <Td>
                          <div className="font-medium">{row.modelVersion.version}</div>
                          <div className="text-[11px] text-ink-muted">
                            trained {relativeTime(row.modelVersion.trainedAt?.toISOString() ?? null)}
                            {row.modelVersion.trainingSampleSize
                              ? ` · ${row.modelVersion.trainingSampleSize} samples`
                              : ''}
                          </div>
                        </Td>
                        <Td className="text-ink-secondary">{sportLabel(row.sportKey)}</Td>
                        <Td align="right" className="tnum">{row.predictions}</Td>
                        <Td align="right" className="tnum">{percent(row.accuracy)}</Td>
                        <Td align="right" className="tnum font-medium">{decimal(row.logLoss, 4)}</Td>
                        <Td align="right" className="tnum text-ink-secondary">
                          {decimal(calibration.baselineLogLoss ?? null, 4)}
                        </Td>
                        <Td
                          align="right"
                          className={`tnum font-semibold ${
                            skill === null ? 'text-ink-muted' : skill > 0 ? 'text-good-text' : 'text-critical'
                          }`}
                        >
                          {skill === null ? '—' : signedPercent(skill)}
                        </Td>
                        <Td align="right" className="tnum">{decimal(row.brierScore, 4)}</Td>
                        <Td align="right" className="tnum">
                          {calibration.expectedCalibrationError === undefined
                            ? '—'
                            : `${(calibration.expectedCalibrationError * 100).toFixed(2)}pp`}
                        </Td>
                        <Td align="right" className="tnum">
                          {row.roi === null ? '—' : signedPercent(row.roi)}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader
                title="Calibration"
                subtitle="Predicted probability against observed frequency. A well-calibrated model sits on the dashed diagonal: when it says 60%, the outcome happens 60% of the time."
              />
              <div className="px-2 py-3">
                <CalibrationChart bins={bins} />
              </div>
              <div className="border-t border-hairline px-4 py-3">
                <Note>
                  Calibration matters more than accuracy for value detection. A model that is
                  accurate but over-confident will report edges that do not exist, because the
                  expected-value calculation multiplies its probability directly by the price.
                </Note>
              </div>
            </Card>

            <Card>
              <CardHeader
                title="Backtest equity curve"
                subtitle={
                  latestBacktest
                    ? `${latestBacktest.label} · flat 1-unit stakes on positive-EV selections`
                    : 'No backtest has been run yet'
                }
              />
              <div className="px-2 py-3">
                <EquityCurve points={equity} />
              </div>
              <div className="border-t border-hairline px-4 py-3">
                <Note>
                  ROI is a diagnostic, never a target. A model optimised for backtest ROI fits the
                  noise in one odds history; one optimised for log loss and calibration generalises.
                </Note>
              </div>
            </Card>
          </div>

          {byConfidence.length > 0 ? (
            <Card>
              <CardHeader
                title="Performance by confidence level"
                subtitle="If the confidence score is meaningful, high-confidence predictions should score better than low-confidence ones."
              />
              <div className="table-scroll">
                <table className="w-full min-w-[720px] border-collapse">
                  <thead>
                    <tr>
                      <Th>Sport</Th>
                      <Th>Confidence</Th>
                      <Th align="right">Predictions</Th>
                      <Th align="right">Accuracy</Th>
                      <Th align="right">Log loss</Th>
                      <Th align="right">Brier</Th>
                      <Th align="right">ROI</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-hairline">
                    {byConfidence.map((row) => (
                      <tr key={row.id}>
                        <Td className="text-ink-secondary">{sportLabel(row.sportKey)}</Td>
                        <Td className="font-medium">{row.confidence}</Td>
                        <Td align="right" className="tnum">{row.predictions}</Td>
                        <Td align="right" className="tnum">{percent(row.accuracy)}</Td>
                        <Td align="right" className="tnum">{decimal(row.logLoss, 4)}</Td>
                        <Td align="right" className="tnum">{decimal(row.brierScore, 4)}</Td>
                        <Td align="right" className="tnum">
                          {row.roi === null ? '—' : signedPercent(row.roi)}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}

          {byLeague.length > 0 ? (
            <Card>
              <CardHeader title="Performance by league" />
              <div className="table-scroll">
                <table className="w-full min-w-[720px] border-collapse">
                  <thead>
                    <tr>
                      <Th>League</Th>
                      <Th>Sport</Th>
                      <Th align="right">Predictions</Th>
                      <Th align="right">Accuracy</Th>
                      <Th align="right">Log loss</Th>
                      <Th align="right">Brier</Th>
                      <Th align="right">ROI</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-hairline">
                    {byLeague.map((row) => (
                      <tr key={row.id}>
                        <Td className="font-medium">{row.leagueKey}</Td>
                        <Td className="text-ink-secondary">{sportLabel(row.sportKey)}</Td>
                        <Td align="right" className="tnum">{row.predictions}</Td>
                        <Td align="right" className="tnum">{percent(row.accuracy)}</Td>
                        <Td align="right" className="tnum">{decimal(row.logLoss, 4)}</Td>
                        <Td align="right" className="tnum">{decimal(row.brierScore, 4)}</Td>
                        <Td align="right" className="tnum">
                          {row.roi === null ? '—' : signedPercent(row.roi)}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}

          {backtests.length > 0 ? (
            <Card>
              <CardHeader
                title="Walk-forward backtests"
                subtitle="Each window trains on matches strictly before it and predicts the matches inside it, so no future information reaches a historical prediction."
              />
              <div className="table-scroll">
                <table className="w-full min-w-[900px] border-collapse">
                  <thead>
                    <tr>
                      <Th>Backtest</Th>
                      <Th align="right">Matches</Th>
                      <Th align="right">Accuracy</Th>
                      <Th align="right">Log loss</Th>
                      <Th align="right">Skill</Th>
                      <Th align="right">Market</Th>
                      <Th align="right">Brier</Th>
                      <Th align="right">Bets</Th>
                      <Th align="right">ROI</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-hairline">
                    {backtests.map((backtest) => {
                      const calibration = (backtest.calibration ?? {}) as StoredCalibration;
                      return (
                        <tr key={backtest.id}>
                          <Td>
                            <div className="font-medium">{backtest.label}</div>
                            <div className="text-[11px] text-ink-muted">
                              {backtest.periodStart.toISOString().slice(0, 10)} →{' '}
                              {backtest.periodEnd.toISOString().slice(0, 10)} ·{' '}
                              {backtest.modelVersion.version}
                            </div>
                          </Td>
                          <Td align="right" className="tnum">{backtest.matches}</Td>
                          <Td align="right" className="tnum">{percent(backtest.accuracy)}</Td>
                          <Td align="right" className="tnum font-medium">{decimal(backtest.logLoss, 4)}</Td>
                          <Td
                            align="right"
                            className={`tnum font-semibold ${
                              (calibration.skillScore ?? 0) > 0 ? 'text-good-text' : 'text-critical'
                            }`}
                          >
                            {calibration.skillScore === undefined
                              ? '—'
                              : signedPercent(calibration.skillScore)}
                          </Td>
                          <Td align="right" className="tnum text-ink-secondary">
                            {calibration.marketBaseline
                              ? decimal(calibration.marketBaseline.logLoss, 4)
                              : '—'}
                          </Td>
                          <Td align="right" className="tnum">{decimal(backtest.brierScore, 4)}</Td>
                          <Td align="right" className="tnum">{backtest.betsPlaced}</Td>
                          <Td align="right" className="tnum">{signedPercent(backtest.roi)}</Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="border-t border-hairline px-4 py-3">
                <Note>
                  The <strong>Market</strong> column is the bookmaker&apos;s own margin-free log loss
                  over the same fixtures — the practical ceiling for a model with no private
                  information. A model close to it is doing well; a model far below the base rate is
                  adding noise.
                </Note>
              </div>
            </Card>
          ) : null}
        </>
      );
    }
  } catch (error) {
    body = (
      <ErrorState
        title="Could not load model performance"
        detail={error instanceof Error ? error.message : 'An unexpected error occurred.'}
      />
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-ink">Model performance</h1>
        <p className="mt-1 text-[13px] text-ink-secondary">
          Out-of-sample scoring, calibration and walk-forward backtests. Historical performance does
          not guarantee future results.
        </p>
      </div>
      {body}
    </div>
  );
}
