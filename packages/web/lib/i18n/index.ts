'use client';

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { resources, type AppLanguage } from './resources';

export const LANG_STORAGE_KEY = 'zleap-lang';
export const SUPPORTED_LANGUAGES: AppLanguage[] = ['zh', 'en'];

/**
 * Single i18next instance. We init with a fixed `zh` so the server render and
 * the first client paint agree (no hydration mismatch); the stored preference
 * is applied after mount by the provider via `changeLanguage`.
 */
if (!i18n.isInitialized) {
  void i18n.use(initReactI18next).init({
    resources,
    lng: 'zh',
    fallbackLng: 'zh',
    supportedLngs: SUPPORTED_LANGUAGES,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
}

export default i18n;
