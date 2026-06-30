import { describe, expect, it } from 'vitest';
import {
  classifyToolPayload,
  formatToolPayload,
  looksLikeMarkdown,
  markdownPreview,
  resolveConsolePayload,
  summarizeToolPayload,
  unwrapNestedJson,
} from '../lib/toolPayload';

describe('toolPayload', () => {
  it('pretty-prints JSON and unwraps nested JSON strings', () => {
    const raw = JSON.stringify({
      content: [{ type: 'text', text: JSON.stringify({ query: 'hello', hits: 3 }) }],
    });
    const { formatted, isJson } = formatToolPayload(raw);
    expect(isJson).toBe(true);
    expect(formatted).toContain('"query": "hello"');
    expect(formatted).not.toContain('\\"query\\"');
  });

  it('summarizes common tool argument keys', () => {
    expect(summarizeToolPayload('{"query":"Agent memory framework 2025"}')).toBe('Agent memory framework 2025');
  });

  it('classifies markdown prose', () => {
    const md = '# Title\n\n| A | B |\n|---|---|\n| 1 | 2 |';
    expect(classifyToolPayload(md).kind).toBe('markdown');
    expect(looksLikeMarkdown(md)).toBe(true);
  });

  it('classifies exitWorkspace payloads as full JSON', () => {
    const raw = JSON.stringify({
      status: 'completed',
      summary: 'done',
      artifacts: [{ description: 'report', ref: 'file:///tmp/a.md', kind: 'document' }],
    });
    expect(classifyToolPayload(raw).kind).toBe('json');
    expect(summarizeToolPayload(raw)).toBe('report');
  });

  it('classifies MCP webSearch payloads as pretty JSON', () => {
    const raw = JSON.stringify({ query: 'Agent memory lifecycle best practices 2025' });
    expect(classifyToolPayload(raw).kind).toBe('json');
    expect(formatToolPayload(raw).formatted).toContain('\n');
  });

  it('classifies MCP error payloads', () => {
    const classified = classifyToolPayload('{"code":"tool_failed","message":"API key missing"}');
    expect(classified.kind).toBe('text');
    expect(classified.body).toBe('API key missing');
    expect(classified.json).toContain('tool_failed');
  });

  it('prefers MCP inner prose over escaped outer JSON wrapper', () => {
    const raw = JSON.stringify({
      content: [{ type: 'text', text: '## Results\n\n- item one\n- item two' }],
    });
    const resolved = resolveConsolePayload(raw);
    expect(resolved.kind).toBe('markdown');
    expect(resolved.body).toContain('Results');
    expect(resolved.rawJson).toContain('"content"');
  });

  it('pretty-prints broken truncated JSON for legacy sessions', () => {
    const broken = '{"query":"Agent memory","artifacts":[{"ref":"file:///tmp/a.md"';
    const resolved = resolveConsolePayload(broken);
    expect(resolved.kind).toBe('json');
    expect(resolved.incomplete).toBe(true);
    expect(resolved.body).toContain('query');
  });

  it('extracts markdown from MCP text blocks', () => {
    const raw = JSON.stringify({
      content: [{ type: 'text', text: '## Results\n\n- item one\n- item two' }],
    });
    expect(classifyToolPayload(raw).kind).toBe('markdown');
  });

  it('strips markdown for collapsed previews', () => {
    expect(markdownPreview('# Heading\n\nSome **bold** text')).toBe('Heading Some bold text');
  });

  it('leaves plain text unchanged', () => {
    const plain = 'line one\nline two';
    expect(formatToolPayload(plain)).toEqual({ formatted: plain, isJson: false });
  });

  it('sanitizes mojibake plain text payloads', () => {
    const raw = '\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD \uFFFD\uFFFDKK 1 F\uFFFD\uFFFD\n正常结果';
    const resolved = resolveConsolePayload(raw);

    expect(resolved.kind).toBe('text');
    expect(resolved.body).toBe('正常结果');
    expect(summarizeToolPayload('\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD \uFFFD\uFFFDKK 1 F\uFFFD\uFFFD')).toBe(
      'Output is not displayable text.',
    );
  });

  it('unwrapNestedJson handles arrays', () => {
    expect(unwrapNestedJson(['{"a":1}'])).toEqual([{ a: 1 }]);
  });
});
