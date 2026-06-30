import type { ReactElement, ReactNode } from 'react';
import { Box, Text } from 'ink';
import { BRAND_GOLD } from './mascotMood.js';

const MAX_BODY_LINES = 200;

function renderInline(text: string, baseColor?: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      parts.push(
        <Text key={key++} color={baseColor}>
          {text.slice(last, match.index)}
        </Text>,
      );
    }
    parts.push(
      <Text key={key++} bold color={baseColor ?? 'whiteBright'}>
        {match[1]}
      </Text>,
    );
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    parts.push(
      <Text key={key++} color={baseColor}>
        {text.slice(last)}
      </Text>,
    );
  }
  return parts.length > 0 ? parts : [<Text key={0}>{text}</Text>];
}

function isTableSeparator(line: string): boolean {
  return /^\|?[\s\-:|]+\|?$/.test(line.trim()) && line.includes('-');
}

/** Lightweight terminal markdown — headers, bullets, tables, bold. No full GFM. */
export function MarkdownBody({
  text,
  dimColor = false,
  prefix = '',
}: {
  text: string;
  dimColor?: boolean;
  prefix?: string;
}): ReactElement {
  const rawLines = text.split('\n');
  const lines = rawLines.slice(0, MAX_BODY_LINES);
  const overflow = rawLines.length - lines.length;
  const base = dimColor ? undefined : undefined;

  return (
    <Box flexDirection="column">
      {lines.map((line, index) => {
        const trimmed = line.trimEnd();
        if (trimmed === '' || trimmed === '---' || /^-{3,}$/.test(trimmed)) {
          return null;
        }
        if (isTableSeparator(trimmed)) {
          return null;
        }
        const linePrefix = index === 0 ? prefix : prefix ? '  ' : '';
        const header = trimmed.match(/^#{1,6}\s+(.*)$/);
        if (header) {
          return (
            <Box key={index} marginTop={index > 0 ? 1 : 0}>
              {linePrefix ? <Text color={index === 0 ? 'whiteBright' : undefined} dimColor={index > 0}>{linePrefix}</Text> : null}
              <Text bold color={BRAND_GOLD}>
                {renderInline(header[1] ?? '', 'whiteBright')}
              </Text>
            </Box>
          );
        }
        const bullet = trimmed.match(/^[-*•]\s+(.*)$/);
        if (bullet) {
          return (
            <Box key={index}>
              {linePrefix ? <Text dimColor>{linePrefix}</Text> : null}
              <Text dimColor={dimColor}>
                {'  • '}
                {renderInline(bullet[1] ?? '', base)}
              </Text>
            </Box>
          );
        }
        if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
          const cells = trimmed
            .slice(1, -1)
            .split('|')
            .map((c) => c.trim())
            .filter(Boolean);
          if (cells.length === 0) {
            return null;
          }
          return (
            <Box key={index}>
              {linePrefix ? <Text dimColor>{linePrefix}</Text> : null}
              <Text dimColor wrap="wrap">
                {'  '}
                {cells.join(' · ')}
              </Text>
            </Box>
          );
        }
        return (
          <Box key={index}>
            {linePrefix ? (
              <Text color={index === 0 && prefix.includes('•') ? 'whiteBright' : undefined} dimColor={!(index === 0 && prefix.includes('•'))}>
                {linePrefix}
              </Text>
            ) : null}
            <Text dimColor={dimColor} wrap="wrap">
              {renderInline(trimmed, base)}
            </Text>
          </Box>
        );
      })}
      {overflow > 0 ? (
        <Text dimColor>{`${prefix}  …还有 ${overflow} 行`}</Text>
      ) : null}
    </Box>
  );
}

export function collapseSpaceSummary(summary: string, maxLines = 4): { text: string; hidden: number } {
  const lines = summary.split('\n').filter((line) => line.trim().length > 0 && line.trim() !== '---');
  if (lines.length <= maxLines) {
    return { text: lines.join('\n'), hidden: 0 };
  }
  return { text: [...lines.slice(0, maxLines), `…共 ${lines.length} 行摘要`].join('\n'), hidden: lines.length - maxLines };
}
