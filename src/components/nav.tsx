'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { clsx } from 'clsx';
import { ThemeToggle } from './theme-toggle';
import { OriginBadge } from './data-status';

const LINKS = [
  { href: '/', label: 'Dashboard' },
  { href: '/value', label: 'Value' },
  { href: '/performance', label: 'Performance' },
  { href: '/tracker', label: 'Tracker' },
  { href: '/admin', label: 'Admin' },
] as const;

export function Nav({ origin, provider }: { origin: string; provider: string | null }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname.startsWith(href);

  return (
    <header className="sticky top-0 z-20 border-b border-hairline bg-page/95 backdrop-blur">
      <div className="mx-auto flex max-w-[1400px] items-center gap-4 px-4 py-3">
        <Link href="/" className="flex items-baseline gap-2">
          <span className="text-[17px] font-bold tracking-tight text-ink">better</span>
          <span className="hidden text-[11px] uppercase tracking-widest text-ink-muted sm:inline">
            prediction analytics
          </span>
        </Link>

        <nav className="ml-auto hidden items-center gap-1 md:flex" aria-label="Main">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={isActive(link.href) ? 'page' : undefined}
              className={clsx(
                'rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors',
                isActive(link.href)
                  ? 'bg-ink/[0.07] text-ink'
                  : 'text-ink-secondary hover:bg-ink/[0.04] hover:text-ink',
              )}
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2 md:ml-0">
          <OriginBadge origin={origin} provider={provider} />
          <ThemeToggle />
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="rounded-md border border-hairline-strong px-2.5 py-1.5 text-[12px] font-medium text-ink-secondary md:hidden"
            aria-expanded={open}
            aria-controls="mobile-nav"
          >
            Menu
          </button>
        </div>
      </div>

      {open ? (
        <nav id="mobile-nav" className="border-t border-hairline px-4 py-2 md:hidden" aria-label="Main">
          <ul className="flex flex-col">
            {LINKS.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  onClick={() => setOpen(false)}
                  aria-current={isActive(link.href) ? 'page' : undefined}
                  className={clsx(
                    'block rounded-md px-3 py-2 text-[14px]',
                    isActive(link.href) ? 'bg-ink/[0.07] font-medium text-ink' : 'text-ink-secondary',
                  )}
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
    </header>
  );
}
