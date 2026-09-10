import Link from 'next/link';
import type { ReactNode } from 'react';
import { clsx } from 'clsx';

export function Card({
  children,
  className,
  as: Tag = 'section',
}: {
  children: ReactNode;
  className?: string;
  as?: 'section' | 'div' | 'article';
}) {
  return (
    <Tag
      className={clsx(
        'rounded-lg border border-hairline bg-surface',
        className,
      )}
    >
      {children}
    </Tag>
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-hairline px-4 py-3">
      <div className="min-w-0">
        <h2 className="text-[13px] font-semibold tracking-wide uppercase text-ink-secondary">
          {title}
        </h2>
        {subtitle ? <p className="mt-1 text-[13px] text-ink-muted">{subtitle}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/**
 * A single headline figure. Used where a number is the answer and a chart would
 * only decorate it.
 */
export function StatTile({
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tone?: 'neutral' | 'good' | 'critical';
}) {
  return (
    <div className="rounded-lg border border-hairline bg-surface px-4 py-3">
      <div className="text-[11px] font-medium uppercase tracking-wider text-ink-muted">{label}</div>
      <div
        className={clsx('tnum mt-1 text-2xl font-semibold tracking-tight', {
          'text-ink': tone === 'neutral',
          'text-good-text': tone === 'good',
          'text-critical': tone === 'critical',
        })}
      >
        {value}
      </div>
      {detail ? <div className="mt-1 text-[12px] text-ink-muted">{detail}</div> : null}
    </div>
  );
}

export type BadgeTone = 'neutral' | 'good' | 'warning' | 'serious' | 'critical' | 'info';

export function Badge({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={clsx(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide',
        {
          'bg-ink/[0.06] text-ink-secondary': tone === 'neutral',
          'bg-good/15 text-good-text': tone === 'good',
          'bg-warning/20 text-ink': tone === 'warning',
          'bg-serious/20 text-ink': tone === 'serious',
          'bg-critical/15 text-critical': tone === 'critical',
          'bg-home/15 text-home': tone === 'info',
        },
      )}
    >
      {children}
    </span>
  );
}

/**
 * Confidence is shown as a word plus its numeric score, never colour alone -
 * the level has to survive being read in greyscale.
 */
export function ConfidenceBadge({ level, score }: { level: string; score?: number }) {
  const tone: BadgeTone = level === 'HIGH' ? 'good' : level === 'MEDIUM' ? 'warning' : 'critical';
  return (
    <Badge tone={tone} title={score === undefined ? undefined : `Confidence score ${score}/100`}>
      {level}
      {score === undefined ? null : <span className="tnum font-normal opacity-80">{score}</span>}
    </Badge>
  );
}

/** Signed value with an arrow, so the direction is not carried by colour alone. */
export function DeltaValue({
  value,
  format,
  className,
}: {
  value: number | null;
  format: (value: number | null) => string;
  className?: string;
}) {
  if (value === null || !Number.isFinite(value)) {
    return <span className={clsx('tnum text-ink-muted', className)}>—</span>;
  }
  const positive = value > 0;
  return (
    <span
      className={clsx(
        'tnum whitespace-nowrap',
        positive ? 'text-good-text' : value < 0 ? 'text-critical' : 'text-ink-secondary',
        className,
      )}
    >
      <span aria-hidden="true">{positive ? '▲' : value < 0 ? '▼' : '·'}</span> {format(value)}
    </span>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <p className="text-[15px] font-semibold text-ink">{title}</p>
      <p className="max-w-md text-[13px] text-ink-secondary">{description}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ title, detail }: { title: string; detail: string }) {
  return (
    <Card className="border-critical/40">
      <div className="flex flex-col gap-1 px-4 py-4">
        <p className="text-[14px] font-semibold text-critical">⚠ {title}</p>
        <p className="text-[13px] text-ink-secondary">{detail}</p>
      </div>
    </Card>
  );
}

/** Skeleton rows shown while a server component streams in. */
export function LoadingRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="divide-y divide-hairline" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 py-3">
          <div className="h-3 w-24 rounded bg-ink/[0.07]" />
          <div className="h-3 flex-1 rounded bg-ink/[0.07]" />
          <div className="h-3 w-16 rounded bg-ink/[0.07]" />
        </div>
      ))}
    </div>
  );
}

export function LinkButton({
  href,
  children,
  variant = 'secondary',
}: {
  href: string;
  children: ReactNode;
  variant?: 'primary' | 'secondary';
}) {
  return (
    <Link
      href={href}
      className={clsx(
        'inline-flex items-center rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors',
        variant === 'primary'
          ? 'bg-home text-white hover:opacity-90'
          : 'border border-hairline-strong text-ink-secondary hover:bg-ink/[0.04] hover:text-ink',
      )}
    >
      {children}
    </Link>
  );
}

export function Th({
  children,
  align = 'left',
  className,
}: {
  children: ReactNode;
  align?: 'left' | 'right' | 'center';
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={clsx(
        'whitespace-nowrap border-b border-hairline px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-ink-muted',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        align === 'left' && 'text-left',
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  align = 'left',
  className,
  colSpan,
}: {
  children: ReactNode;
  align?: 'left' | 'right' | 'center';
  className?: string;
  colSpan?: number;
}) {
  return (
    <td
      colSpan={colSpan}
      className={clsx(
        'px-3 py-2.5 text-[13px] text-ink',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        className,
      )}
    >
      {children}
    </td>
  );
}

/** Section note used for methodology and responsible-use statements. */
export function Note({ children }: { children: ReactNode }) {
  return (
    <p className="text-[12px] leading-relaxed text-ink-muted">{children}</p>
  );
}
