import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import type { ConnectionView } from '../cli/connectFlow.js';
import { BRAND_GOLD, GOLD_MUTED, TEXT_MUTED } from './theme.js';

const PHASE_LABEL: Partial<Record<ConnectionView['phase'], string>> = {
  connecting: '① 连接中',
  awaiting_user: '② 等待扫码/授权',
  connected: '③ 已连接',
  error: '✗ 失败',
  disabled: '已禁用',
};

type ConnectPanelProps = {
  view: ConnectionView;
};

export function ConnectPanel({ view }: ConnectPanelProps): ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={BRAND_GOLD} paddingX={1} marginTop={1}>
      <Text bold color={BRAND_GOLD}>
        {view.title}
      </Text>
      <Text color={GOLD_MUTED}>{PHASE_LABEL[view.phase] ?? view.phase}</Text>
      {view.lines.map((line, index) => (
        <Text key={index} wrap="wrap">
          {line}
        </Text>
      ))}
      {view.qrAscii ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>{view.qrAscii}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color={TEXT_MUTED}>Esc 取消 · 需 gateway 运行（zleap serve --gateway）</Text>
      </Box>
    </Box>
  );
}
