import { useCallback, useEffect, useMemo, useState } from 'react';
import { filterSlashCommands, isSlashPaletteOpen, type SlashCommand } from '../commands/registry.js';

type PaletteState = {
  open: boolean;
  commands: SlashCommand[];
  index: number;
  selected: SlashCommand | undefined;
  move: (delta: number) => void;
  reset: () => void;
};

export function useCommandPalette(draft: string, enabled: boolean, running = false): PaletteState {
  const commands = useMemo(() => {
    if (!enabled || !isSlashPaletteOpen(draft)) {
      return [];
    }
    return filterSlashCommands(draft, { running });
  }, [draft, enabled, running]);

  const [index, setIndex] = useState(0);

  useEffect(() => {
    setIndex(0);
  }, [commands.map((command) => command.name).join('\0')]);

  const move = useCallback(
    (delta: number) => {
      if (commands.length === 0) {
        return;
      }
      setIndex((current) => (current + delta + commands.length) % commands.length);
    },
    [commands.length],
  );

  const reset = useCallback(() => {
    setIndex(0);
  }, []);

  return {
    open: commands.length > 0,
    commands,
    index,
    selected: commands[index],
    move,
    reset,
  };
}
