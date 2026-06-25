'use client';

import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'zleap-theme';

/**
 * Light/dark theme with localStorage persistence. SSR renders the default
 * (light); on mount we read the stored preference and toggle the `dark` class
 * on <html>, which flips the shadcn CSS-variable tokens in globals.css.
 */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>('light');

  useEffect(() => {
    const stored = (typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY)) as Theme | null;
    if (stored === 'dark' || stored === 'light') {
      setTheme(stored);
    }
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((current) => {
      const next = current === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // ignore storage failures (private mode, etc.)
      }
      return next;
    });
  }, []);

  return { theme, toggle };
}
