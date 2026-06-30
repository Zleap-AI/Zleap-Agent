import type { ReactElement } from 'react';
import { Box, Text } from 'ink';
import { channelsBadge } from '../cli/channels.js';
import { stackHealthBadge } from '../cli/tuiServe.js';
import type { AmbientStatus } from '../hooks/useAmbientStatus.js';
import type { ContextUsage } from '../state/types.js';
import { statusTone, TEXT_MUTED } from './theme.js';

type StatusBarProps = {
  ambient: AmbientStatus;
  dbReachable: boolean;
  hasDatabase: boolean;
  contextUsage?: ContextUsage | null;
  messageCount?: number;
};

function formatContextPct(usage: ContextUsage, messageCount: number): string {
  const msgRatio = usage.triggerMessages > 0 ? messageCount / usage.triggerMessages : 0;
  const pct = Math.min(99, Math.round(msgRatio * 100));
  return `ctx ${pct}%`;
}

export function StatusBar({
  ambient,
  dbReachable,
  hasDatabase,
  contextUsage,
  messageCount = 0,
}: StatusBarProps): ReactElement | null {
  if (!hasDatabase && ambient.stack === 'off' && !ambient.im && !contextUsage) {
    return null;
  }

  const db = !hasDatabase ? '无DB' : dbReachable ? 'DB✓' : 'DB✗';
  const stackLabel = stackHealthBadge(ambient.stack);
  const imLabel = channelsBadge(ambient.im);
  const stackColor = statusTone(ambient.stack === 'ok', ambient.stack === 'partial');
  const imColor = (ambient.im?.connected ?? 0) > 0 ? statusTone(true) : TEXT_MUTED;
  const ctxLabel = contextUsage ? formatContextPct(contextUsage, messageCount) : null;

  return (
    <Box marginTop={1}>
      <Text dimColor>{db}</Text>
      {ctxLabel ? (
        <>
          <Text dimColor>{' · '}</Text>
          <Text dimColor>{ctxLabel}</Text>
        </>
      ) : null}
      <Text dimColor>{' · '}</Text>
      <Text color={stackColor}>{stackLabel}</Text>
      <Text dimColor>{' · '}</Text>
      <Text color={imColor}>{imLabel}</Text>
      <Text dimColor>{' · /serve /connect /status'}</Text>
    </Box>
  );
}
