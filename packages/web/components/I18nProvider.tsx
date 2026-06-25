'use client';

import { useEffect } from 'react';
import { I18nextProvider } from 'react-i18next';
import i18n, { LANG_STORAGE_KEY, SUPPORTED_LANGUAGES } from '../lib/i18n';
import type { AppLanguage } from '../lib/i18n/resources';

/** Applies the stored language after mount (kept out of init to avoid SSR/CSR
 *  hydration mismatch), then provides the i18n instance to the tree. */
export function I18nProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(LANG_STORAGE_KEY);
    } catch {
      /* ignore */
    }
    const next = (stored ?? navigator.language.slice(0, 2)) as AppLanguage;
    if (SUPPORTED_LANGUAGES.includes(next) && next !== i18n.resolvedLanguage) {
      void i18n.changeLanguage(next);
    }
  }, []);

  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}
