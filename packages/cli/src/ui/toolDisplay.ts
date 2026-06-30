import { truncate } from '@zleap/agent';

const PRIMARY_ARG_KEYS = [
  'command',
  'path',
  'q',
  'url',
  'pattern',
  'query',
  'summary',
  'old_string',
  'content',
] as const;

const DISPLAY_VERBS: Record<string, string> = {
  web_search: 'Web搜索',
  read_webpage: 'Read网页',
  exitWorkspace: '交还结果',
};

/** Friendly verb for the tool card (overrides TOOL_VERBS when set). */
export function displayToolVerb(name: string, fallback: string): string {
  return DISPLAY_VERBS[name] ?? fallback;
}

/** Pull the most telling argument out of serialized tool args. */
export function primaryToolArg(args: string): string {
  const raw = args?.trim();
  if (!raw || raw === '()') {
    return '';
  }
  const parsed = tryParseJsonRecord(raw);
  if (parsed) {
    for (const key of PRIMARY_ARG_KEYS) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim()) {
        return value;
      }
    }
    const firstString = Object.entries(parsed).find(
      ([key, value]) => key !== 'reason' && typeof value === 'string' && value.trim(),
    )?.[1];
    return typeof firstString === 'string' ? firstString : '';
  }
  const match = raw.match(/:\s*"([^"]+)"/);
  if (match?.[1]) {
    return match[1];
  }
  const stripped = raw.replace(/^\{|\}$/g, '').trim();
  return stripped.length > 1 ? stripped : '';
}

/** Short, human-readable tool failure for the card footer. */
export function formatToolErrorMessage(result: string): string {
  const trimmed = result.trim();
  if (!trimmed || trimmed === '{' || trimmed === '{}') {
    return '工具执行失败';
  }
  if (trimmed.includes('web_search_api_key_required')) {
    return '未配置网页搜索 API Key（ZLEAP_302_API_KEY 或 Web 通用配置）';
  }
  if (trimmed.startsWith('302_api_failed:')) {
    const rest = trimmed.slice('302_api_failed:'.length).trim();
    const statusMatch = rest.match(/^(\d+)/);
    return statusMatch ? `搜索 API 失败 HTTP ${statusMatch[1]}` : '搜索 API 失败';
  }
  if (trimmed.includes('requires a non-empty reason') || trimmed.includes('tool_reason_required')) {
    return '缺少 reason 参数，需重试并说明调用原因';
  }
  const parsed = tryParseJsonRecord(trimmed);
  if (parsed) {
    for (const key of ['message', 'error', 'detail', 'text']) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim()) {
        return truncate(value.trim(), 96);
      }
    }
  }
  const line = trimmed.split('\n', 1)[0]?.trim() ?? '';
  if (line && line !== '{' && line !== '{}') {
    return truncate(line, 96);
  }
  return '工具执行失败';
}

/** One-line success hint for search/read tools (shown in green on the card). */
export function formatToolSuccessHint(name: string, result: string): string | undefined {
  if (name === 'web_search') {
    return formatWebSearchHint(result);
  }
  if (name === 'read_webpage') {
    const data = tryParseJsonRecord(result);
    const title = typeof data?.title === 'string' ? data.title.trim() : '';
    return title ? truncate(title, 56) : undefined;
  }
  if (name === 'exitWorkspace') {
    const data = tryParseJsonRecord(result);
    const status = typeof data?.status === 'string' ? data.status : '';
    return status ? status : undefined;
  }
  return undefined;
}

function formatWebSearchHint(result: string): string | undefined {
  const data = tryParseJsonRecord(result);
  if (!data) {
    return undefined;
  }
  const results = Array.isArray(data.results) ? data.results : [];
  const total = typeof data.total === 'number' ? data.total : undefined;
  if (results.length === 0) {
    return '0 条结果';
  }
  const first = results[0];
  const row = first && typeof first === 'object' ? (first as Record<string, unknown>) : null;
  const title = typeof row?.title === 'string' ? row.title.trim() : '';
  const countLabel = total != null && total > results.length ? `${results.length}/${total} 条` : `${results.length} 条`;
  return title ? `${countLabel} · ${truncate(title, 48)}` : countLabel;
}

function tryParseJsonRecord(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const WEB_RESULT_TOOL_IDS = new Set(['web_search', 'read_webpage']);
