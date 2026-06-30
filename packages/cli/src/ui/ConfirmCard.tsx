import type { ReactElement } from 'react';
import { Box, Text } from 'ink';
import type { ToolApprovalRequest } from '../state/types.js';
import { BRAND_GOLD, GOLD_MUTED, TEXT_ERROR, TEXT_MUTED } from './theme.js';

function PreviewRow({ row }: { row: string }): ReactElement {
  const marker = row[0];
  if (marker === '+') {
    return <Text color={BRAND_GOLD}>{`  ${row}`}</Text>;
  }
  if (marker === '-') {
    return <Text color={TEXT_ERROR}>{`  ${row}`}</Text>;
  }
  return <Text color={TEXT_MUTED}>{`  ${row}`}</Text>;
}

/** HITL prompt shown in the live region while a high-risk tool waits for y/n. */
export function ConfirmCard({ request }: { request: ToolApprovalRequest }): ReactElement {
  const showArgs = !request.preview && Boolean(request.args) && request.args !== '()';
  const [header, ...rows] = request.preview ? request.preview.split('\n') : [];
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={BRAND_GOLD} paddingX={1}>
      <Text>
        <Text bold color={BRAND_GOLD}>
          ⚠ 需要确认
        </Text>
        <Text>{'  '}</Text>
        <Text bold color={BRAND_GOLD}>
          {request.name}
        </Text>
        {showArgs ? <Text color={TEXT_MUTED}>{`  ${request.args}`}</Text> : null}
      </Text>
      {header ? <Text bold>{`  ${header}`}</Text> : null}
      {rows.map((row, index) => (
        <PreviewRow key={index} row={row} />
      ))}
      <Text color={TEXT_MUTED}>
        此工具可能修改你的环境 —{' '}
        <Text color={BRAND_GOLD}>y</Text>
        {' 允许 · '}
        <Text color={BRAND_GOLD}>a</Text>
        {' 始终允许 · '}
        <Text color={TEXT_ERROR}>n</Text>
        {' 拒绝（Esc 拒绝）'}
      </Text>
    </Box>
  );
}
