import { useEffect, useState, type ReactElement } from 'react';
import { Box, Text } from 'ink';
import type { ToolCallView, ToolStatus } from '../state/types.js';
import { DIFF_TOOL_IDS, isDiffResult, TOOL_VERBS } from '@zleap/agent';
import {
  displayToolVerb,
  formatToolErrorMessage,
  formatToolSuccessHint,
  primaryToolArg,
  WEB_RESULT_TOOL_IDS,
} from './toolDisplay.js';
import { truncate } from '@zleap/agent';
import { BRAND_GOLD, TEXT_ERROR } from './theme.js';

const FRAMES = ['◐', '◓', '◑', '◒'];
const STATUS_COLOR: Record<ToolStatus, string> = { running: BRAND_GOLD, done: BRAND_GOLD, error: TEXT_ERROR };
const DIFF_MAX_LINES = 28;
const WEB_HINT_MAX_LINES = 4;

function useSpinnerFrame(active: boolean): string {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = setInterval(() => setIndex((value) => (value + 1) % FRAMES.length), 90);
    return () => clearInterval(timer);
  }, [active]);
  return FRAMES[index] ?? FRAMES[0];
}

function DiffRow({ row }: { row: string }): ReactElement {
  const marker = row[0];
  if (marker === '+') {
    return <Text color={BRAND_GOLD}>{`     ${row}`}</Text>;
  }
  if (marker === '-') {
    return <Text color="red">{`     ${row}`}</Text>;
  }
  return <Text dimColor>{`     ${row}`}</Text>;
}

const PREVIEW_TOOLS = new Set(['read', 'bash', 'grep', 'glob', 'list_dir']);

export function ToolCard({ tool, nested = false }: { tool: ToolCallView; nested?: boolean }): ReactElement {
  const frame = useSpinnerFrame(tool.status === 'running');
  const verb = displayToolVerb(tool.name, TOOL_VERBS[tool.name] ?? tool.name);
  const target = primaryToolArg(tool.args);
  const successHint =
    tool.status === 'done' && tool.result ? formatToolSuccessHint(tool.name, tool.result) : undefined;
  const prefix = nested ? '  │ ⎿ ' : '  ⎿ ';

  const line = (
    <Text>
      <Text dimColor>{prefix}</Text>
      {tool.status === 'running' ? <Text color={BRAND_GOLD}>{`${frame} `}</Text> : null}
      <Text color={tool.status === 'error' ? STATUS_COLOR.error : tool.status === 'done' ? STATUS_COLOR.done : undefined}>
        {verb}
      </Text>
      {target ? <Text dimColor>{` ${truncate(target, 72)}`}</Text> : null}
      {tool.status === 'error' && tool.result ? (
        <Text color="redBright">{` — ${formatToolErrorMessage(tool.result)}`}</Text>
      ) : null}
      {successHint ? <Text color={BRAND_GOLD}>{` · ${successHint}`}</Text> : null}
    </Text>
  );

  if (DIFF_TOOL_IDS.has(tool.name) && tool.status === 'done' && tool.result && isDiffResult(tool.result)) {
    const [summary, ...rows] = tool.result.split('\n');
    const shown = rows.slice(0, DIFF_MAX_LINES);
    const overflow = rows.length - shown.length;
    return (
      <Box flexDirection="column">
        {line}
        {summary ? <Text dimColor>{`     ${summary}`}</Text> : null}
        {shown.map((row, index) => (
          <DiffRow key={index} row={row} />
        ))}
        {overflow > 0 ? <Text dimColor>{`     … +${overflow} more lines`}</Text> : null}
      </Box>
    );
  }

  if (PREVIEW_TOOLS.has(tool.name) && tool.status === 'done' && tool.result) {
    const preview = genericResultPreview(tool.result);
    if (preview.lines.length > 0) {
      return (
        <Box flexDirection="column">
          {line}
          {preview.lines.map((row, index) => (
            <Text key={index} dimColor>{`     ${row}`}</Text>
          ))}
          {preview.overflow > 0 ? <Text dimColor>{`     …共 ${preview.total} 行`}</Text> : null}
        </Box>
      );
    }
  }

  if (
    WEB_RESULT_TOOL_IDS.has(tool.name) &&
    tool.status === 'done' &&
    tool.result &&
    !successHint
  ) {
    const preview = webResultPreviewLines(tool.result);
    if (preview.length > 0) {
      return (
        <Box flexDirection="column">
          {line}
          {preview.map((row, index) => (
            <Text key={index} dimColor>{`     ${row}`}</Text>
          ))}
        </Box>
      );
    }
  }

  return line;
}

function webResultPreviewLines(result: string): string[] {
  const data = tryParseJson(result);
  if (!data || !Array.isArray(data.results)) {
    return [];
  }
  return data.results
    .slice(0, WEB_HINT_MAX_LINES)
    .map((item, index) => {
      const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
      const title = typeof row.title === 'string' ? row.title.trim() : `结果 ${index + 1}`;
      const url = typeof row.url === 'string' ? row.url : typeof row.link === 'string' ? row.link : '';
      return url ? `${title} (${truncate(url, 48)})` : title;
    });
}

function genericResultPreview(result: string): { lines: string[]; total: number; overflow: number } {
  const rows = result.split('\n').filter((line) => line.trim().length > 0);
  const max = 3;
  const shown = rows.slice(0, max);
  return { lines: shown, total: rows.length, overflow: Math.max(0, rows.length - max) };
}

function tryParseJson(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
