import type { ReactElement } from 'react';
import { Box, Text } from 'ink';
import type { DisplayRole, SpaceResultView, SpaceView, ToolCallView } from '../state/types.js';
import { ErrorCard } from './ErrorCard.js';
import { collapseSpaceSummary, MarkdownBody } from './markdown.js';
import { StreamingAssistant } from './StreamingAssistant.js';
import { SystemMessage } from './SystemMessage.js';
import { ToolCard } from './ToolCard.js';
import { BRAND_GOLD } from './mascotMood.js';
import { truncate } from '@zleap/agent';

type MessageProps = {
  role: DisplayRole;
  text?: string;
  tool?: ToolCallView;
  space?: SpaceView;
  result?: SpaceResultView;
  nested?: boolean;
  tone?: 'notify' | 'error';
  streaming?: boolean;
};

const NESTED_PREFIX = '  │ ';

export function Message({
  role,
  text = '',
  tool,
  space,
  result,
  nested = false,
  tone,
  streaming = false,
}: MessageProps): ReactElement {
  if (role === 'error' || tone === 'error') {
    return <ErrorCard message={text} />;
  }

  if (role === 'tool' && tool) {
    return <ToolCard tool={tool} nested={nested} />;
  }

  if (role === 'space' && space) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text color={BRAND_GOLD}>▸ </Text>
          <Text bold color={BRAND_GOLD}>
            {space.label}
          </Text>
        </Box>
        {space.goal ? (
          <Box>
            <Text color={BRAND_GOLD} dimColor>
              {'  ⤷ '}
            </Text>
            <Text dimColor>{truncate(space.goal, 120)}</Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  if (role === 'space_result' && result) {
    const ok = result.status === 'success';
    const collapsed = collapseSpaceSummary(result.summary, 3);
    const mark = nested ? `${NESTED_PREFIX}${ok ? '✓ ' : '✗ '}` : ok ? '  ✓ ' : '  ✗ ';
    return (
      <Box flexDirection="column" marginTop={nested ? 0 : 1}>
        <MarkdownBody text={collapsed.text} dimColor={!ok} prefix={mark} />
      </Box>
    );
  }

  if (role === 'space_message') {
    return (
      <Box flexDirection="column" marginTop={0}>
        <Text dimColor wrap="wrap">
          {NESTED_PREFIX}
          {truncate(text.replace(/\s+/g, ' ').trim(), 160)}
          {streaming ? <Text color={BRAND_GOLD}>▋</Text> : null}
        </Text>
      </Box>
    );
  }

  if (role === 'space_status') {
    return (
      <Box>
        <Text dimColor>
          {NESTED_PREFIX}
          {truncate(text, 96)}
        </Text>
      </Box>
    );
  }

  if (role === 'user') {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="whiteBright">
          <Text bold color={BRAND_GOLD}>{'> '}</Text>
          {text}
        </Text>
      </Box>
    );
  }

  if (role === 'assistant') {
    if (streaming) {
      return <StreamingAssistant text={text} />;
    }
    return (
      <Box flexDirection="column" marginTop={1}>
        <MarkdownBody text={text} prefix="• " />
      </Box>
    );
  }

  if (role === 'system' || tone === 'notify') {
    return <SystemMessage text={text} />;
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="whiteBright" wrap="wrap">
        {'· '}
        {text}
      </Text>
    </Box>
  );
}
