'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import type { FormEvent, ReactNode } from 'react';

export interface FilterOption {
  readonly value: string;
  readonly label: string;
}

/**
 * URL-backed filter controls, implemented as a plain GET form.
 *
 * Filter state lives in the query string so a filtered view is shareable and
 * survives a reload, and so the server re-renders with genuinely filtered data
 * rather than the client hiding rows it already fetched.
 *
 * A GET form rather than a client-side router push, because it degrades
 * perfectly: with JavaScript disabled the controls still filter via the Apply
 * button, and with JavaScript enabled a change submits immediately.
 */
export function FilterBar({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  /**
   * Empty controls are disabled just before submission so they are omitted from
   * the query string; otherwise every filter would leave `?sport=&league=`
   * behind and the URL would stop being readable.
   */
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    for (const element of Array.from(event.currentTarget.elements)) {
      const field = element as HTMLInputElement | HTMLSelectElement;
      if (field.name && field.value === '') field.disabled = true;
    }
  };

  return (
    <form
      method="GET"
      action={pathname}
      onSubmit={handleSubmit}
      className="flex flex-wrap items-end gap-3 rounded-lg border border-hairline bg-surface px-4 py-3"
    >
      {children}
      {/* Submits the form when scripting is unavailable; hidden otherwise. */}
      <noscript>
        <button
          type="submit"
          className="rounded-md border border-hairline-strong px-3 py-1.5 text-[13px] text-ink-secondary"
        >
          Apply
        </button>
      </noscript>
    </form>
  );
}

/** Submits the enclosing form, so a change takes effect immediately. */
function submitOwnForm(element: HTMLElement) {
  const form = element.closest('form');
  if (form) form.requestSubmit();
}

function fieldClasses(extra = ''): string {
  return `rounded-md border border-hairline-strong bg-surface-raised px-2.5 py-1.5 text-[13px] text-ink ${extra}`;
}

function Label({ children, text }: { children: ReactNode; text: string }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wider text-ink-muted">{text}</span>
      {children}
    </label>
  );
}

export function SelectFilter({
  name,
  label,
  options,
  placeholder = 'All',
}: {
  name: string;
  label: string;
  options: readonly FilterOption[];
  placeholder?: string;
}) {
  const searchParams = useSearchParams();
  return (
    <Label text={label}>
      <select
        name={name}
        defaultValue={searchParams.get(name) ?? ''}
        onChange={(event) => submitOwnForm(event.currentTarget)}
        className={fieldClasses('min-w-[9rem]')}
      >
        <option value="">{placeholder}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Label>
  );
}

export function DateFilter({ name, label }: { name: string; label: string }) {
  const searchParams = useSearchParams();
  return (
    <Label text={label}>
      <input
        type="date"
        name={name}
        defaultValue={searchParams.get(name) ?? ''}
        onChange={(event) => submitOwnForm(event.currentTarget)}
        className={fieldClasses()}
      />
    </Label>
  );
}

/** Numeric threshold, presented to the user as a set of named cut-offs. */
export function ThresholdFilter({
  name,
  label,
  options,
}: {
  name: string;
  label: string;
  options: readonly FilterOption[];
}) {
  const searchParams = useSearchParams();
  return (
    <Label text={label}>
      <select
        name={name}
        defaultValue={searchParams.get(name) ?? options[0]?.value ?? ''}
        onChange={(event) => submitOwnForm(event.currentTarget)}
        className={fieldClasses('min-w-[7rem]')}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Label>
  );
}

/** Clears every filter. A link, so it works without scripting too. */
export function ResetFilters({ href }: { href: string }) {
  return (
    <a
      href={href}
      className="rounded-md border border-hairline-strong px-3 py-1.5 text-[13px] text-ink-secondary transition-colors hover:bg-ink/[0.04] hover:text-ink"
    >
      Reset
    </a>
  );
}
