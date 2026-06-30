import type { ReactElement } from 'react';
import { Box, Text } from 'ink';
import type { SlashCommand } from '../commands/registry.js';
import { CommandPalette } from './CommandPalette.js';
import { ContextBar, type ContextBarProps } from './ContextBar.js';
import { LineInput } from './LineInput.js';
import { Mascot } from './Mascot.js';
import { BRAND_GOLD, MASCOT_DISPLAY_WIDTH, type MascotMood } from './mascotMood.js';
import { GOLD_MUTED } from './theme.js';

type PromptProps = {
  value: string;
  focus: boolean;
  contextBar: ContextBarProps;
  mood: MascotMood;
  mask?: string;
  palette?: {
    open: boolean;
    commands: SlashCommand[];
    selectedIndex: number;
    onMove: (delta: number) => void;
  };
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
};

/** Input row with Hermes-style context strip and optional slash menu. */
export function Prompt({
  value,
  focus,
  contextBar,
  mood,
  mask,
  palette,
  onChange,
  onSubmit,
}: PromptProps): ReactElement {
  const columns = process.stdout.columns ?? 80;
  const width = Math.max(20, columns - 6 - MASCOT_DISPLAY_WIDTH);
  const paletteOpen = palette?.open === true && palette.commands.length > 0;

  return (
    <Box flexDirection="column" marginTop={1}>
      {paletteOpen && palette ? (
        <CommandPalette
          commands={palette.commands}
          selectedIndex={palette.selectedIndex}
          columns={columns}
        />
      ) : null}
      <ContextBar {...contextBar} />
      <Box
        marginTop={0}
        borderStyle="round"
        borderColor={focus ? BRAND_GOLD : GOLD_MUTED}
        borderLeft={false}
        borderRight={false}
        paddingX={0}
      >
        <Box minWidth={MASCOT_DISPLAY_WIDTH} marginRight={1}>
          <Mascot mood={mood} />
        </Box>
        <Text color={BRAND_GOLD}>{'> '}</Text>
        <LineInput
          value={value}
          focus={focus}
          width={width}
          mask={mask}
          placeholder="message or /command"
          captureVerticalArrows={paletteOpen}
          onVerticalArrow={palette?.onMove}
          onChange={onChange}
          onSubmit={onSubmit}
        />
      </Box>
    </Box>
  );
}
