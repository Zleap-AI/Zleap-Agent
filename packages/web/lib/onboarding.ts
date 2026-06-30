export const ONBOARDING_SKIPPED_KEY = 'zleap:onboarding-skipped';

export function hasSkippedOnboarding(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(ONBOARDING_SKIPPED_KEY) === '1';
}

export function markOnboardingSkipped(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(ONBOARDING_SKIPPED_KEY, '1');
}

export function clearOnboardingSkipped(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(ONBOARDING_SKIPPED_KEY);
}
