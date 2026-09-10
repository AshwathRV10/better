import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { Nav } from '@/components/nav';
import { ThemeScript } from '@/components/theme-toggle';
import { DemoBanner, ResponsibleUseNote } from '@/components/data-status';
import { getDataFreshness } from '@/lib/services/queries';

export const metadata: Metadata = {
  title: {
    default: 'better — sports prediction analytics',
    template: '%s · better',
  },
  description:
    'Probabilistic sports match predictions with model-versus-market comparison, expected value and out-of-sample calibration tracking.',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // The demo banner has to be correct even if the database is unreachable, so a
  // failure here degrades to "unknown origin" rather than taking down the shell.
  let origin = 'UNKNOWN';
  let provider: string | null = null;
  try {
    const freshness = await getDataFreshness();
    origin = freshness.origin;
    provider = freshness.provider;
  } catch {
    origin = 'UNKNOWN';
  }

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body className="min-h-screen bg-page text-ink antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded focus:bg-surface-raised focus:px-3 focus:py-2 focus:text-[13px]"
        >
          Skip to content
        </a>
        <Nav origin={origin} provider={provider} />
        <DemoBanner origin={origin} provider={provider} />
        <main id="main" className="mx-auto max-w-[1400px] px-4 py-6">
          {children}
        </main>
        <footer className="mx-auto max-w-[1400px] border-t border-hairline px-4 py-6">
          <ResponsibleUseNote />
        </footer>
      </body>
    </html>
  );
}
