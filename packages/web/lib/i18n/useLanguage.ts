'use client';

import { useTranslation } from 'react-i18next';
import { LANG_STORAGE_KEY } from './index';
import type { AppLanguage } from './resources';

/** Read/set the active UI language, persisted to localStorage. */
export function useLanguage(): { lang: AppLanguage; setLang: (next: AppLanguage) => void; toggle: () => void } {
  const { i18n } = useTranslation();
  const lang = ((i18n.resolvedLanguage ?? i18n.language ?? 'zh') as AppLanguage) === 'en' ? 'en' : 'zh';

  const setLang = (next: AppLanguage) => {
    void i18n.changeLanguage(next);
    try {
      localStorage.setItem(LANG_STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
  };

  return { lang, setLang, toggle: () => setLang(lang === 'zh' ? 'en' : 'zh') };
}
