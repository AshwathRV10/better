'use client';

import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark' | 'system';
const STORAGE_KEY = 'better-theme';

/**
 * Theme toggle.
 *
 * Writes an explicit [data-theme] stamp on the root so the choice beats the OS
 * setting in both directions; "system" removes the stamp and lets the media
 * query decide. Storage access is wrapped because a private window can throw.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('system');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'light' || stored === 'dark') setTheme(stored);
    } catch {
      // Storage unavailable; the system setting is a perfectly good default.
    }
  }, []);

  useEffect(() => {
    if (!mounted) return;
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    try {
      if (theme === 'system') localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Ignore: the stamp is already applied for this session.
    }
  }, [theme, mounted]);

  const next: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
  const label: Record<Theme, string> = { system: 'System', light: 'Light', dark: 'Dark' };
  const icon: Record<Theme, string> = { system: '◐', light: '☀', dark: '☾' };

  return (
    <button
      type="button"
      onClick={() => setTheme(next[theme])}
      className="inline-flex items-center gap-1.5 rounded-md border border-hairline-strong px-2.5 py-1.5 text-[12px] font-medium text-ink-secondary transition-colors hover:bg-ink/[0.04] hover:text-ink"
      aria-label={`Theme: ${label[theme]}. Click to change.`}
      suppressHydrationWarning
    >
      <span aria-hidden="true">{mounted ? icon[theme] : '◐'}</span>
      <span className="hidden sm:inline">{mounted ? label[theme] : 'Theme'}</span>
    </button>
  );
}

/**
 * Applies the stored theme before first paint.
 *
 * Without this the page renders in the OS theme and then snaps to the stored
 * one, which is a visible flash on every navigation.
 */
export function ThemeScript() {
  const script = `(function(){try{var t=localStorage.getItem('${STORAGE_KEY}');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`;
  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}
