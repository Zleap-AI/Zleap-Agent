import { getJson } from '@/lib/api';
import type { RuntimeContextView } from './types';

/** Fetch the active runtime context (returns null when unavailable/non-local). */
export async function fetchRuntimeContext(signal?: AbortSignal): Promise<RuntimeContextView | null> {
  try {
    const context = await getJson<RuntimeContextView>('/api/runtime/context', { signal });
    return context?.mode === 'local' ? context : null;
  } catch {
    return null;
  }
}
