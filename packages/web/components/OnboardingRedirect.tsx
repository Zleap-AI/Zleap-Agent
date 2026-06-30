'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { fetchModels } from '@/lib/services';
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
        const models = await fetchModels();
        const configured = models.some(isConfiguredLlmModel);
        if (configured) {
          clearOnboardingSkipped();
          return;
        }
        router.replace('/onboarding');
      } catch {
        // ignore — main UI still usable offline / during bootstrap
      }
    })();
  }, [router]);

  return null;
}
