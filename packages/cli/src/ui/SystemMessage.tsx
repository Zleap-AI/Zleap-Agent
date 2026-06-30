import type { ReactElement } from 'react';
import { Box, Text } from 'ink';
import { BRAND_GOLD, GOLD_MUTED, statusTone, TEXT_MUTED, TEXT_PRIMARY } from './theme.js';

/** `  模型       qwen3.6-flash` */
const KV_LINE = /^ {2}(\S+)\s{2,}(.+)$/;

function valueColor(value: string): string | undefined {
  const v = value.trim();
  if (/✓|已连接|就绪|已恢复|成功|开$/.test(v)) {
    return statusTone(true);
  }
  if (/✗|不可达|失败|未配置|未运行|未激活|关$/.test(v)) {
    return statusTone(false);
  }
  if (/partial|部分|~/.test(v)) {
    return GOLD_MUTED;
  }
  return TEXT_PRIMARY;
}

function isStructuredBlock(text: string): boolean {
  const lines = text.split('\n');
  if (lines.length <= 1) {
    return false;
  }
  return lines.some((line) => KV_LINE.test(line) || /^[^\s].+[：:]$/.test(line.trim()));
}

/** System / notify lines — gold panel for structured status blocks. */
export function SystemMessage({ text }: { text: string }): ReactElement {
  if (!isStructuredBlock(text)) {
    return (
      <Box marginTop={1}>
        <Text color={GOLD_MUTED}>· </Text>
        <Text color={TEXT_PRIMARY} wrap="wrap">
          {text}
        </Text>
      </Box>
    );
  }

  const lines = text.split('\n');

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={BRAND_GOLD} paddingX={1}>
      {lines.map((line, index) => {
        if (!line.trim()) {
          return null;
        }
        const kv = line.match(KV_LINE);
        if (kv) {
          const key = kv[1] ?? '';
          const value = (kv[2] ?? '').trim();
          return (
            <Box key={index}>
              <Text color={GOLD_MUTED}>{`${key.padEnd(11)} `}</Text>
              <Text color={valueColor(value)} wrap="wrap">
                {value}
              </Text>
            </Box>
          );
        }
        if (!line.startsWith('  ')) {
          return (
            <Box key={index} marginTop={index > 0 ? 1 : 0}>
              <Text bold color={BRAND_GOLD}>
                {line.trim()}
              </Text>
            </Box>
          );
        }
        return (
          <Box key={index}>
            <Text color={TEXT_PRIMARY} wrap="wrap">
              {line.trimStart()}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
