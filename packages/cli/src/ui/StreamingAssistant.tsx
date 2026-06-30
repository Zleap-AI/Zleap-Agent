import type { ReactElement } from 'react';
import { Box, Text } from 'ink';
import { BRAND_GOLD } from './mascotMood.js';

/** Max visible rows while streaming — avoids unbounded live-region height jumps. */
const STREAM_MAX_LINES = 28;

/**
 * Plain-text streaming block (no markdown parse). Markdown is applied only after
 * the message commits to <Static>, so the live region stays one stable layout.
 */
export function StreamingAssistant({ text }: { text: string }): ReactElement {
  const lines = text.split('\n');
  const hidden = Math.max(0, lines.length - STREAM_MAX_LINES);
  const visible = hidden > 0 ? lines.slice(-STREAM_MAX_LINES).join('\n') : text;

  return (
    <Box flexDirection="column" marginTop={1}>
      {hidden > 0 ? <Text dimColor>{`• …上方还有 ${hidden} 行（输出中）`}</Text> : null}
      <Text wrap="wrap">
        {hidden === 0 ? <Text color="whiteBright">• </Text> : null}
        {visible}
        <Text color={BRAND_GOLD}>▋</Text>
      </Text>
    </Box>
  );
}
