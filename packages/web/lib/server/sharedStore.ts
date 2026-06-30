import { createSharedStore } from '@zleap/agent/conversation';
import type { ZleapStore } from '@zleap/store';

/**
 * Process-level shared store. The chat route's L2 ConversationService injects
 * this single store into every engine, so all chat requests reuse ONE PG pool
 * instead of each request opening its own persistence pool that never closes.
 *
 * Embedding config is data-first (DB default embedding row → env) and the
 * default avatar is seeded once, both handled by the shared `createSharedStore`
 * factory so web, gateway, and tasks stay consistent.
 *
 * Cached as a promise so concurrent first-callers share the same connect; reset
 * to null on failure so a transient DB outage can be retried on the next call.
 */
let storePromise: Promise<ZleapStore | null> | null = null;

export function getSharedStore(): Promise<ZleapStore | null> {
  if (!storePromise) {
    storePromise = createSharedStore({
      onWarn: (message) => console.warn(`[shared-store] ${message}`),
    }).then((store) => {
      if (!store) {
        storePromise = null;
      }
      return store;
    });
  }
  return storePromise;
}
