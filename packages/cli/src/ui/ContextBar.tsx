import type { ReactElement } from 'react';
import { Box, Text } from 'ink';
import type { AmbientStatus } from '../hooks/useAmbientStatus.js';
import { permissionModeLabel, RUN_MODE_SHORTCUT, runModeLabel, type PermissionMode, type RunMode } from '@zleap/agent';
import type { ContextUsage } from '../state/types.js';
import {
  BRAND_GOLD,
  GOLD_MUTED,
  formatCompactTokens,
  formatContextPercent,
  renderProgressBar,
  statusTone,
  TEXT_MUTED,
} from './theme.js';

export type ContextBarMode =
  | 'idle'
  | 'running'
  | 'palette'
  | 'wizard'
  | 'picker'
  | 'connect';

export type ContextBarProps = {
  model: string;
  mode: ContextBarMode;
  modeHint?: string;
  runMode: RunMode;
  permissionMode: PermissionMode;
  contextUsage: ContextUsage | null;
  messageCount: number;
  dbReachable: boolean;
  hasDatabase: boolean;
  ambient: AmbientStatus;
  draftLines?: number;
};

function contextRatio(usage: ContextUsage | null, messageCount: number): number {
  if (!usage) return 0;
  if (usage.windowRatio != null && Number.isFinite(usage.windowRatio)) {
    return Math.min(0.99, usage.windowRatio);
  }
  if (usage.triggerMessages > 0) {
    return Math.min(0.99, messageCount / usage.triggerMessages);
  }
  return 0;
}

function tokenLabel(usage: ContextUsage | null): string | null {
  if (!usage?.usedTokens || !usage.contextWindow) return null;
  return `${formatCompactTokens(usage.usedTokens)}/${formatCompactTokens(usage.contextWindow)}`;
}

function stackShort(ambient: AmbientStatus): { label: string; tone: string } {
  if (ambient.stack === 'ok') return { label: '栈✓', tone: statusTone(true) };
  if (ambient.stack === 'partial') return { label: '栈~', tone: statusTone(false, true) };
  if (ambient.stack === 'off') return { label: '栈—', tone: TEXT_MUTED };
  return { label: '栈✗', tone: statusTone(false) };
}

function imShort(ambient: AmbientStatus): { label: string; tone: string } {
  const connected = ambient.im?.connected ?? 0;
  if (connected <= 0) return { label: 'IM—', tone: TEXT_MUTED };
  return { label: `IM${connected}`, tone: statusTone(true) };
}

function modeBadge(runMode: RunMode, permissionMode: PermissionMode): string | null {
  const parts: string[] = [];
  if (runMode !== 'normal') parts.push(runModeLabel(runMode));
  if (permissionMode === 'full_access') parts.push(permissionModeLabel(permissionMode));
  return parts.length ? parts.join(' ') : null;
}

function shortcutLine(props: ContextBarProps): string {
  if (props.mode === 'running') return 'Esc / /abort 中断';
  if (props.mode === 'palette') return '↑↓ 选择 · Enter 执行 · Esc 取消';
  if (props.mode === 'picker' || props.mode === 'wizard' || props.mode === 'connect') {
    return props.modeHint ?? '↑↓ · Enter 确认 · Esc 取消';
  }
  const parts = [`${RUN_MODE_SHORTCUT} 模式`, 'Enter 发送', '↑ 历史', '/ 命令'];
  if (props.runMode === 'plan') parts.splice(1, 0, '执行=/execute');
  if ((props.draftLines ?? 1) > 1) parts.push(`${props.draftLines}行`);
  return parts.join(' · ');
}

/** Hermes-style context strip above the prompt. */
export function ContextBar(props: ContextBarProps): ReactElement {
  const ratio = contextRatio(props.contextUsage, props.messageCount);
  const bar = renderProgressBar(ratio);
  const pct = props.contextUsage ? formatContextPercent(ratio) : '—';
  const tokens = tokenLabel(props.contextUsage);
  const msgCount = props.contextUsage?.snapshotMessageCount ?? props.messageCount;
  const dbLabel = !props.hasDatabase ? '无DB' : props.dbReachable ? 'DB✓' : 'DB✗';
  const dbTone = statusTone(props.hasDatabase ? props.dbReachable : undefined);
  const stack = stackShort(props.ambient);
  const im = imShort(props.ambient);
  const badge = modeBadge(props.runMode, props.permissionMode);

  return (
    <Box flexDirection="column" marginTop={0}>
      <Box flexWrap="wrap">
        <Text color={BRAND_GOLD}>⚡ </Text>
        <Text color={BRAND_GOLD} bold>
          {props.model}
        </Text>
        <Text color={TEXT_MUTED}> │ ctx </Text>
        <Text color={BRAND_GOLD}>{bar.filled}</Text>
        <Text color={TEXT_MUTED}>{bar.empty}</Text>
        <Text color={TEXT_MUTED}> </Text>
        <Text color={BRAND_GOLD}>{pct}</Text>
        {tokens ? (
          <>
            <Text color={TEXT_MUTED}> </Text>
            <Text color={GOLD_MUTED}>{tokens}</Text>
          </>
        ) : null}
        <Text color={TEXT_MUTED}> │ {msgCount} msg</Text>
        {badge ? (
          <>
            <Text color={TEXT_MUTED}> │ </Text>
            <Text color={BRAND_GOLD}>{badge}</Text>
          </>
        ) : null}
        <Text color={TEXT_MUTED}> │ </Text>
        <Text color={dbTone}>{dbLabel}</Text>
        <Text color={TEXT_MUTED}> │ </Text>
        <Text color={stack.tone}>{stack.label}</Text>
        <Text color={TEXT_MUTED}> │ </Text>
        <Text color={im.tone}>{im.label}</Text>
        {props.mode === 'running' ? (
          <>
            <Text color={TEXT_MUTED}> │ </Text>
            <Text color={BRAND_GOLD}>思考中…</Text>
          </>
        ) : null}
      </Box>
      <Text color={TEXT_MUTED}>{shortcutLine(props)}</Text>
    </Box>
  );
}
