/** Parse tool args/results for the dispatch console — pretty JSON + compact summaries. */
import { sanitizeDisplayText } from './messageText';

export type PayloadViewKind = 'json' | 'markdown' | 'text';

export type ClassifiedPayload = {
  kind: PayloadViewKind;
  /** Primary body to render (markdown source, plain text, or unused when kind=json). */
  body: string;
  /** Pretty-printed JSON when kind is json. */
  json?: string;
};

export function tryParseJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed || !(trimmed.startsWith('{') || trimmed.startsWith('['))) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

/** Unwrap MCP-style payloads where JSON is nested inside string fields. */
export function unwrapNestedJson(value: unknown, depth = 0): unknown {
  if (depth > 5) return value;
  if (typeof value === 'string') {
    const inner = tryParseJson(value);
    return inner !== null ? unwrapNestedJson(inner, depth + 1) : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => unwrapNestedJson(item, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = unwrapNestedJson(child, depth + 1);
    }
    return out;
  }
  return value;
}

export function looksLikeMarkdown(text: string): boolean {
  const sample = text.trim();
  if (!sample) return false;
  return (
    /^#{1,6}\s/m.test(sample) ||
    /^\|.+\|/m.test(sample) ||
    /^>\s/m.test(sample) ||
    /^\s*[-*+]\s+/m.test(sample) ||
    /^\s*\d+\.\s+/m.test(sample) ||
    sample.includes('```') ||
    /\*\*[^*]+\*\*/.test(sample)
  );
}

function extractMcpTextBlocks(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const content = (value as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const block = item as { type?: unknown; text?: unknown };
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      texts.push(block.text);
    }
  }
  return texts;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function summarizeText(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > 120 ? `${normalized.slice(0, 119)}…` : normalized;
}

/** Plain-text preview for collapsed console cards. */
export function markdownPreview(text: string, maxLen = 120): string {
  const plain = text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\|/g, ' ')
    .replace(/`+/g, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) return '';
  return plain.length > maxLen ? `${plain.slice(0, maxLen - 1)}…` : plain;
}

export function formatToolPayload(value: string): { formatted: string; isJson: boolean } {
  const parsed = tryParseJson(value);
  if (parsed === null) {
    return { formatted: value, isJson: false };
  }
  return { formatted: JSON.stringify(unwrapNestedJson(parsed), null, 2), isJson: true };
}

export type ResolvedConsolePayload = {
  kind: PayloadViewKind;
  body: string;
  rawJson?: string;
  incomplete: boolean;
};

/** Pick the best primary view for tool args/results in the dispatch console. */
export function resolveConsolePayload(value: string): ResolvedConsolePayload {
  const trimmed = value.trim();
  if (!trimmed) {
    return { kind: 'text', body: '', incomplete: false };
  }

  const parsed = tryParseJson(trimmed);
  if (parsed !== null) {
    const classified = classifyToolPayload(trimmed);
    const rawJson = classified.json ?? JSON.stringify(unwrapNestedJson(parsed), null, 2);
    if (classified.kind === 'markdown') {
      return { kind: 'markdown', body: classified.body, rawJson, incomplete: false };
    }
    if (classified.kind === 'text' && classified.body && classified.body !== trimmed) {
      return { kind: 'text', body: classified.body, rawJson, incomplete: false };
    }
    if (classified.kind === 'json' && classified.json) {
      return { kind: 'json', body: classified.json, rawJson, incomplete: false };
    }
    return { kind: 'json', body: rawJson, rawJson, incomplete: false };
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return {
      kind: 'json',
      body: formatBrokenJsonForDisplay(trimmed),
      incomplete: isLikelyTruncatedJson(trimmed),
    };
  }

  const displayText = sanitizeDisplayText(trimmed, 'Output is not displayable text.');
  const classified = classifyToolPayload(displayText);
  return {
    kind: classified.kind,
    body: classified.body,
    rawJson: classified.json,
    incomplete: false,
  };
}

export function extractArtifactRefs(value: string): Array<{ kind?: string; ref?: string; description?: string }> {
  const parsed = tryParseJson(value);
  if (!parsed || typeof parsed !== 'object' || parsed === null) return [];
  const artifacts = (parsed as Record<string, unknown>).artifacts;
  if (!Array.isArray(artifacts)) return [];
  return artifacts
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      kind: typeof item.kind === 'string' ? item.kind : undefined,
      ref: typeof item.ref === 'string' ? item.ref : undefined,
      description: typeof item.description === 'string' ? item.description : undefined,
    }));
}

function isLikelyTruncatedJson(text: string): boolean {
  const sample = text.trim();
  if (sample.endsWith('...') || sample.includes('…') || sample.includes('[truncated')) {
    return true;
  }
  if ((sample.startsWith('{') || sample.startsWith('[')) && tryParseJson(sample) === null) {
    return true;
  }
  return false;
}

function formatBrokenJsonForDisplay(text: string): string {
  const sample = text.trim().replace(/\.{3}$/, '').trimEnd();
  for (const suffix of ['}', '"]}', '"}', '"}]}', '"}]}]']) {
    try {
      return `${JSON.stringify(JSON.parse(sample + suffix), null, 2)}\n…[数据不完整，可能已被截断]`;
    } catch {
      /* try next suffix */
    }
  }
  return `${text.replace(/,(?=\s*")/g, ',\n').replace(/,(?=\s*[\[{])/g, ',\n')}\n…[无法完整解析 JSON]`;
}

export function classifyToolPayload(value: string): ClassifiedPayload {
  const trimmed = value.trim();
  if (!trimmed) {
    return { kind: 'text', body: '' };
  }

  const parsed = tryParseJson(trimmed);
  if (parsed !== null && typeof parsed === 'object' && parsed !== null) {
    const record = parsed as Record<string, unknown>;
    const unwrapped = unwrapNestedJson(parsed);

    const errorMessage = firstString(record, ['message', 'error']);
    if (typeof record.code === 'string' && errorMessage) {
      return { kind: 'text', body: errorMessage, json: JSON.stringify(unwrapped, null, 2) };
    }

    if (Array.isArray(record.artifacts) || typeof record.status === 'string') {
      return { kind: 'json', body: trimmed, json: JSON.stringify(unwrapped, null, 2) };
    }

    const summary = firstString(record, ['summary']);
    if (summary && looksLikeMarkdown(summary)) {
      return { kind: 'markdown', body: summary, json: JSON.stringify(unwrapped, null, 2) };
    }
    if (summary) {
      return { kind: 'text', body: summary, json: JSON.stringify(unwrapped, null, 2) };
    }

    const mcpTexts = extractMcpTextBlocks(unwrapped);
    if (mcpTexts.length) {
      const joined = mcpTexts.join('\n\n');
      if (looksLikeMarkdown(joined)) {
        return { kind: 'markdown', body: joined, json: JSON.stringify(unwrapped, null, 2) };
      }
      if (mcpTexts.every((block) => tryParseJson(block) !== null)) {
        const formatted = mcpTexts.map((block) => JSON.stringify(unwrapNestedJson(JSON.parse(block)), null, 2)).join('\n\n');
        return { kind: 'json', body: joined, json: formatted };
      }
      return { kind: 'text', body: joined, json: JSON.stringify(unwrapped, null, 2) };
    }

    // Structured tool / MCP payloads without prose blocks → pretty JSON.
    if (
      Array.isArray(record.content) ||
      typeof record.query === 'string' ||
      typeof record.code === 'string'
    ) {
      return { kind: 'json', body: trimmed, json: JSON.stringify(unwrapped, null, 2) };
    }

    return { kind: 'json', body: trimmed, json: JSON.stringify(unwrapped, null, 2) };
  }

  const displayText = sanitizeDisplayText(trimmed, 'Output is not displayable text.');
  if (looksLikeMarkdown(displayText)) {
    return { kind: 'markdown', body: displayText };
  }
  return { kind: 'text', body: displayText };
}

export function truncateLines(text: string, maxLines: number): { text: string; overflow: number } {
  const lines = text.split('\n');
  if (lines.length <= maxLines) {
    return { text, overflow: 0 };
  }
  return { text: lines.slice(0, maxLines).join('\n'), overflow: lines.length - maxLines };
}

function summarizeExitWorkspaceArtifacts(record: Record<string, unknown>): string | undefined {
  const artifacts = record.artifacts;
  if (!Array.isArray(artifacts) || !artifacts.length) return undefined;
  const first = artifacts[0];
  if (!first || typeof first !== 'object') return undefined;
  const item = first as Record<string, unknown>;
  const description = typeof item.description === 'string' ? item.description.trim() : undefined;
  const ref = typeof item.ref === 'string' ? item.ref : undefined;
  if (description) return description;
  if (ref) return ref.split(/[\\/]/).filter(Boolean).at(-1);
  return undefined;
}

/** One-line summary for tool headers and space chips. */
export function summarizeToolPayload(value: string): string {
  const parsed = tryParseJson(value);
  if (parsed !== null && typeof parsed === 'object' && parsed !== null) {
    const fromArtifacts = summarizeExitWorkspaceArtifacts(parsed as Record<string, unknown>);
    if (fromArtifacts) return summarizeText(fromArtifacts);
  }

  const classified = classifyToolPayload(value);
  if (classified.kind === 'markdown' || classified.kind === 'text') {
    return summarizeText(markdownPreview(classified.body) || classified.body);
  }

  if (parsed === null || typeof parsed !== 'object' || parsed === null) {
    return summarizeText(value);
  }
  const record = parsed as Record<string, unknown>;
  const mcpTexts = extractMcpTextBlocks(unwrapNestedJson(parsed));
  if (mcpTexts.length) {
    const preview = markdownPreview(mcpTexts[0]!);
    if (preview) return summarizeText(preview);
  }
  const readable =
    firstString(record, ['summary', 'message', 'error', 'path', 'file', 'command', 'query', 'pattern', 'status']) ??
    summarizeExitWorkspaceArtifacts(record) ??
    Object.entries(record)
      .slice(0, 2)
      .map(([key, entry]) => {
        if (typeof entry === 'string') return `${key}: ${entry}`;
        if (typeof entry === 'number' || typeof entry === 'boolean') return `${key}: ${String(entry)}`;
        return key;
      })
      .join(', ');
  return summarizeText(readable);
}
