import type { ReactElement } from 'react';
import { Text } from 'ink';
import { BRAND_GOLD, GOLD_MUTED, statusTone, TEXT_MUTED } from './theme.js';

function segmentColor(part: string, index: number, total: number): string {
  if (index === 0) {
    return BRAND_GOLD;
  }
  if (/DB✓|栈✓|IM\d|ctx \d+%/.test(part) && !part.includes('✗')) {
    return statusTone(true);
  }
  if (/计划|目标|全权|审批/.test(part)) {
    return GOLD_MUTED;
  }
  if (part.includes('✗') || part.includes('无DB')) {
    return statusTone(false);
  }
  if (/Enter|↑|\/ 命令|Esc|思考中|选择|确认|取消|发送|历史/.test(part)) {
    return TEXT_MUTED;
  }
  if (index >= total - 3) {
    return TEXT_MUTED;
  }
  return BRAND_GOLD;
}

/** Legacy text hint — prefer ContextBar for the prompt chrome. */
export function StatusHint({ text }: { text: string }): ReactElement {
  const parts = text.split(' · ').filter(Boolean);
  if (parts.length <= 1) {
    return <Text color={TEXT_MUTED}>{text}</Text>;
  }
  return (
    <Text wrap="truncate">
      {parts.map((part, index) => (
        <Text key={`${index}-${part}`}>
          {index > 0 ? <Text color={TEXT_MUTED}> · </Text> : null}
          <Text color={segmentColor(part, index, parts.length)}>{part}</Text>
        </Text>
      ))}
    </Text>
  );
}
