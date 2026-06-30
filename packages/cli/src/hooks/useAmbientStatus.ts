import { useEffect, useState } from 'react';
import { channelsBadge, summarizeChannelsConnection, type ChannelsConnectionSummary } from '../cli/channels.js';
import { stackHealthBadge, summarizeStackHealth, type StackHealth } from '../cli/tuiServe.js';

export type AmbientStatus = {
  stack: StackHealth;
  im: ChannelsConnectionSummary | null;
  badge: string;
};

const IDLE: AmbientStatus = { stack: 'off', im: null, badge: '' };

/** Poll stack + IM health for the TUI status bar (every 30s). */
export function useAmbientStatus(dbReachable: boolean, refreshKey = 0): AmbientStatus {
  const [status, setStatus] = useState<AmbientStatus>(IDLE);

  useEffect(() => {
    if (!dbReachable) {
      setStatus(IDLE);
      return;
    }

    let cancelled = false;

    const tick = async (): Promise<void> => {
      const [stack, im] = await Promise.all([summarizeStackHealth(), summarizeChannelsConnection()]);
      if (cancelled) {
        return;
      }
      const stackLabel = stackHealthBadge(stack);
      const imLabel = channelsBadge(im);
      setStatus({
        stack,
        im,
        badge: `${stackLabel} · ${imLabel}`,
      });
    };

    void tick();
    const timer = setInterval(() => void tick(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [dbReachable, refreshKey]);

  return status;
}
