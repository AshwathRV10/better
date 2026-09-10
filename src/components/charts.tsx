'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { ReactNode } from 'react';

const AXIS_STYLE = { fontSize: 11, fill: 'var(--text-muted)' } as const;

function TooltipShell({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-hairline bg-surface-raised px-2.5 py-2 text-[12px] shadow-sm">
      {children}
    </div>
  );
}

export interface CalibrationPoint {
  readonly bin: string;
  readonly predicted: number;
  readonly observed: number;
  readonly count: number;
}

/**
 * Reliability diagram.
 *
 * Predicted probability against observed frequency, with the diagonal marking
 * perfect calibration. Bins with no observations are dropped rather than plotted
 * at zero, which would invent a data point.
 */
export function CalibrationChart({ bins }: { bins: readonly CalibrationPoint[] }) {
  const data = bins
    .filter((bin) => bin.count > 0)
    .map((bin) => ({
      predicted: Number((bin.predicted * 100).toFixed(1)),
      observed: Number((bin.observed * 100).toFixed(1)),
      count: bin.count,
      bin: bin.bin,
    }));

  if (data.length === 0) {
    return (
      <p className="px-4 py-10 text-center text-[13px] text-ink-muted">
        No settled predictions yet, so calibration cannot be measured.
      </p>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={data} margin={{ top: 8, right: 16, bottom: 24, left: 4 }}>
        <CartesianGrid stroke="var(--grid)" vertical={false} />
        <XAxis
          type="number"
          dataKey="predicted"
          domain={[0, 100]}
          ticks={[0, 25, 50, 75, 100]}
          tick={AXIS_STYLE}
          stroke="var(--axis)"
          tickLine={false}
          label={{ value: 'Predicted probability (%)', position: 'insideBottom', offset: -14, style: AXIS_STYLE }}
        />
        <YAxis
          type="number"
          domain={[0, 100]}
          ticks={[0, 25, 50, 75, 100]}
          tick={AXIS_STYLE}
          stroke="var(--axis)"
          tickLine={false}
          width={38}
          label={{ value: 'Observed (%)', angle: -90, position: 'insideLeft', style: AXIS_STYLE }}
        />
        {/* Perfect calibration. Recessive, because it is a reference not a series. */}
        <ReferenceLine
          segment={[{ x: 0, y: 0 }, { x: 100, y: 100 }]}
          stroke="var(--axis)"
          strokeDasharray="4 4"
        />
        <Tooltip
          cursor={{ stroke: 'var(--axis)' }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const point = payload[0].payload as (typeof data)[number];
            return (
              <TooltipShell>
                <div className="font-semibold text-ink">Band {point.bin}</div>
                <div className="tnum mt-1 text-ink-secondary">Predicted {point.predicted}%</div>
                <div className="tnum text-ink-secondary">Observed {point.observed}%</div>
                <div className="tnum text-ink-muted">{point.count} observations</div>
              </TooltipShell>
            );
          }}
        />
        <Line
          type="monotone"
          dataKey="observed"
          stroke="var(--series-home)"
          strokeWidth={2}
          dot={{ r: 4, fill: 'var(--series-home)', stroke: 'var(--surface)', strokeWidth: 2 }}
          activeDot={{ r: 6 }}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

export interface EquityPoint {
  readonly date: string;
  readonly profit: number;
}

/** Cumulative profit or loss over time, in units staked. */
export function EquityCurve({ points }: { points: readonly EquityPoint[] }) {
  if (points.length < 2) {
    return (
      <p className="px-4 py-10 text-center text-[13px] text-ink-muted">
        Not enough settled bets to plot a curve yet.
      </p>
    );
  }
  // Long histories are thinned so the line stays readable.
  const step = Math.max(1, Math.floor(points.length / 300));
  const data = points.filter((_, i) => i % step === 0 || i === points.length - 1);

  return (
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 4 }}>
        <CartesianGrid stroke="var(--grid)" vertical={false} />
        <XAxis dataKey="date" tick={AXIS_STYLE} stroke="var(--axis)" tickLine={false} minTickGap={40} />
        <YAxis tick={AXIS_STYLE} stroke="var(--axis)" tickLine={false} width={46} />
        <ReferenceLine y={0} stroke="var(--axis)" />
        <Tooltip
          cursor={{ stroke: 'var(--axis)' }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const point = payload[0].payload as EquityPoint;
            return (
              <TooltipShell>
                <div className="font-semibold text-ink">{point.date}</div>
                <div className="tnum mt-1 text-ink-secondary">
                  {point.profit >= 0 ? '+' : '−'}
                  {Math.abs(point.profit).toFixed(2)} units
                </div>
              </TooltipShell>
            );
          }}
        />
        <Line
          type="monotone"
          dataKey="profit"
          stroke="var(--series-home)"
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

export interface ScoreProbability {
  readonly label: string;
  readonly probability: number;
  readonly favours: 'home' | 'draw' | 'away';
}

/**
 * Most likely exact scores. Bars are coloured by which side the score favours,
 * and every bar carries its own value label.
 */
export function CorrectScoreChart({ scores }: { scores: readonly ScoreProbability[] }) {
  if (scores.length === 0) return null;
  const data = scores.map((score) => ({
    label: score.label,
    value: Number((score.probability * 100).toFixed(1)),
    favours: score.favours,
  }));

  const fill = (favours: ScoreProbability['favours']) =>
    favours === 'home'
      ? 'var(--series-home)'
      : favours === 'away'
        ? 'var(--series-away)'
        : 'var(--series-draw)';

  return (
    <ResponsiveContainer width="100%" height={Math.max(200, data.length * 28)}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 44, bottom: 4, left: 8 }}>
        <CartesianGrid stroke="var(--grid)" horizontal={false} />
        <XAxis type="number" tick={AXIS_STYLE} stroke="var(--axis)" tickLine={false} unit="%" />
        <YAxis
          type="category"
          dataKey="label"
          tick={AXIS_STYLE}
          stroke="var(--axis)"
          tickLine={false}
          width={48}
        />
        <Tooltip
          cursor={{ fill: 'var(--grid)' }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const point = payload[0].payload as (typeof data)[number];
            return (
              <TooltipShell>
                <div className="font-semibold text-ink">{point.label}</div>
                <div className="tnum mt-1 text-ink-secondary">{point.value}%</div>
              </TooltipShell>
            );
          }}
        />
        <Bar dataKey="value" radius={[0, 4, 4, 0]} isAnimationActive={false} barSize={14}>
          {data.map((point) => (
            <Cell key={point.label} fill={fill(point.favours)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
