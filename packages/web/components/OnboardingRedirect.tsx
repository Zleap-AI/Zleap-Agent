'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { webApiFetch } from '../lib/api';
import { isConfiguredLlmModel } from '../lib/models';
import { clearOnboardingSkipped, hasSkippedOnboarding } from '../lib/onboarding';

/** Redirect first-time users to onboarding when no LLM is configured. */
export function OnboardingRedirect() {
  const router = useRouter();

  useEffect(() => {
    void (async () => {
      if (hasSkippedOnboarding()) {
        return;
      }
      try {
        const res = await webApiFetch('/api/models');
        if (!res.ok) {
          return;
        }
        const data = (await res.json()) as {
          models?: Array<{ config?: { hasApiKey?: boolean }; model?: string; purpose?: string }>;
        };
        const configured = data.models?.some(isConfiguredLlmModel);
        if (configured) {
          clearOnboardingSkipped();
          return;
        }
        if (!configured) {
          router.replace('/onboarding');
        }
      } catch {
        // ignore — main UI still usable offline / during bootstrap
      }
    })();
  }, [router]);

  return null;
}
