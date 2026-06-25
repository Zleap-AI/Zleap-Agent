import type { ReactElement } from 'react';
import { Box, Text } from 'ink';
import type { SlashCommand } from '../commands/registry.js';
import { BRAND_GOLD } from './mascotMood.js';
import { truncate } from '@zleap/agent';

type CommandPaletteProps = {
  commands: SlashCommand[];
  selectedIndex: number;
  columns: number;
};

export function CommandPalette({ commands, selectedIndex, columns }: CommandPaletteProps): ReactElement {
  const longestName = Math.max(0, ...commands.map((command) => command.name.length));
  const nameWidth = Math.min(Math.max(8, longestName), Math.max(8, Math.floor(columns * 0.36)));
  const descWidth = Math.max(10, columns - nameWidth - 6);

  return (
    <Box flexDirection="column" marginBottom={1}>
      {commands.map((command, index) => {
        const active = index === selectedIndex;
        const description = truncate(command.description, descWidth);
        const name = truncate(command.name, nameWidth).padEnd(nameWidth);
        const prefix = active ? '> ' : '  ';
        return (
          <Box key={command.name}>
            <Text color={active ? BRAND_GOLD : undefined} dimColor={!active}>
              {prefix}
              <Text bold={active}>{name}</Text>
              {' '}
              {description}
            </Text>
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text dimColor>Enter 确认 · Esc 返回</Text>
      </Box>
    </Box>
  );
}
