import type { ReactElement } from 'react';
import { Box, Text } from 'ink';
import { BRAND_GOLD } from './mascotMood.js';

export type PickerItem = {
  id: string;
  label: string;
  detail?: string;
};

type PickerListProps = {
  title: string;
  items: PickerItem[];
  selectedIndex: number;
  hint?: string;
};

/** Structured ↑↓ picker (sessions, models, channels). */
export function PickerList({ title, items, selectedIndex, hint }: PickerListProps): ReactElement {
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={BRAND_GOLD} paddingX={1}>
      <Text bold>{title}</Text>
      {items.map((item, index) => {
        const active = index === selectedIndex;
        return (
          <Box key={item.id}>
            <Text color={active ? BRAND_GOLD : undefined} dimColor={!active}>
              {active ? '> ' : '  '}
              {`${index + 1}. `.padEnd(4)}
              {item.label}
              {item.detail ? ` · ${item.detail}` : ''}
            </Text>
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text dimColor>{hint ?? '输入编号 · ↑↓ 选择 · Enter 确认 · Esc 取消'}</Text>
      </Box>
    </Box>
  );
}
