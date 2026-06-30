import { homedir } from 'node:os';
import type { ReactElement } from 'react';
import { Box, Text } from 'ink';
import { SLASH_COMMANDS, type SlashCommand } from '../commands/registry.js';
import { RUN_MODE_SHORTCUT, truncate } from '@zleap/agent';
import { readCliVersion } from '../util/version.js';
import { BRAND_GOLD, GOLD_MUTED, TEXT_MUTED, TEXT_PRIMARY } from './theme.js';

type LogoProps = {
  model: string;
  modelSource?: string;
  configPath?: string;
  continueSession?: boolean;
  restoredCount?: number;
};

/** Same solid block wordmark as `packages/web/components/Wordmark.tsx`. */
const SOLID_WORDMARK = String.raw`███████╗ ██╗      ███████╗  █████╗  ██████╗
╚══███╔╝ ██║      ██╔════╝ ██╔══██╗ ██╔══██╗
  ███╔╝  ██║      █████╗   ███████║ ██████╔╝
 ███╔╝   ██║      ██╔══╝   ██╔══██║ ██╔═══╝
███████╗ ███████╗ ███████╗ ██║  ██║ ██║
╚══════╝ ╚══════╝ ╚══════╝ ╚═╝  ╚═╝ ╚═╝`
  .split('\n')
  .map((line) => line.replace(/\s+$/, ''));

const GROUP_ORDER: NonNullable<SlashCommand['group']>[] = ['chat', 'config', 'serve', 'im'];
const GROUP_LABEL: Record<NonNullable<SlashCommand['group']>, string> = {
  chat: '对话',
  config: '配置',
  serve: '服务',
  im: 'IM',
};

function shortenPath(path: string, max: number): string {
  const home = homedir();
  const rel = path.startsWith(home) ? `~${path.slice(home.length)}` : path;
  return truncate(rel, max);
}

function groupCommandLine(group: NonNullable<SlashCommand['group']>, maxNames: number): string {
  return SLASH_COMMANDS.filter((command) => command.group === group)
    .slice(0, maxNames)
    .map((command) => command.name)
    .join(' ');
}

/** Launch banner — first static row; scrolls away with conversation history. */
export function Logo({
  model,
  modelSource,
  configPath,
  continueSession,
  restoredCount,
}: LogoProps): ReactElement {
  const columns = process.stdout.columns ?? 80;
  const wide = columns >= 78;
  const version = readCliVersion();
  const dir = shortenPath(process.cwd(), wide ? 40 : Math.max(20, columns - 18));
  const config = configPath ? shortenPath(configPath, wide ? 36 : Math.max(16, columns - 12)) : null;
  const sessionLabel =
    continueSession && restoredCount && restoredCount > 0
      ? `Session · ${restoredCount} msgs`
      : continueSession
        ? 'Session · resumed'
        : 'Session · new';

  const metaBlock = (
    <Box flexDirection="column">
      <Text color={BRAND_GOLD} wrap="truncate">
        {truncate(model, wide ? 36 : Math.max(14, columns - 24))}
        {modelSource ? <Text color={GOLD_MUTED}>{` · ${modelSource}`}</Text> : null}
      </Text>
      <Text color={TEXT_MUTED} wrap="truncate">
        {dir}
      </Text>
      {config ? (
        <Text color={GOLD_MUTED} wrap="truncate">
          {config}
        </Text>
      ) : null}
      <Text color={GOLD_MUTED}>{sessionLabel}</Text>
    </Box>
  );

  const commandsBlock = (
    <Box flexDirection="column" marginTop={wide ? 1 : 0}>
      {GROUP_ORDER.map((group) => {
        const line = groupCommandLine(group, wide ? 6 : 4);
        if (!line) return null;
        return (
          <Box key={group}>
            <Text color={GOLD_MUTED}>{`${GROUP_LABEL[group].padEnd(4)}`}</Text>
            <Text color={TEXT_PRIMARY} wrap="truncate">
              {line}
            </Text>
          </Box>
        );
      })}
    </Box>
  );

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box borderStyle="round" borderColor={BRAND_GOLD} flexDirection="column" paddingX={1}>
        <Box justifyContent="space-between" marginBottom={0}>
          <Text color={BRAND_GOLD} bold>
            Zleap Agent
          </Text>
          <Text color={GOLD_MUTED}>v{version}</Text>
        </Box>

        <Box flexDirection={wide ? 'row' : 'column'} marginTop={0}>
          <Box flexDirection="column" marginRight={wide ? 2 : 0} flexShrink={0}>
            {SOLID_WORDMARK.map((line, index) => (
              <Text key={index} color={BRAND_GOLD} bold>
                {line}
              </Text>
            ))}
          </Box>

          <Box flexDirection="column" flexGrow={wide ? 1 : 0} minWidth={wide ? 30 : 0}>
            {metaBlock}
            {commandsBlock}
          </Box>
        </Box>

        <Box marginTop={1}>
          <Text color={GOLD_MUTED}>
            {SLASH_COMMANDS.length} commands · /help · {RUN_MODE_SHORTCUT} 模式
          </Text>
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text color={TEXT_MUTED}>输入消息或 /help 查看命令。</Text>
      </Box>
    </Box>
  );
}
