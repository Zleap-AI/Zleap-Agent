import { describe, expect, it } from 'vitest';
import { collapseSpaceSummary } from '../src/ui/markdown.js';
import { buildProviderHistory } from '../src/hooks/useChat.js';
import type { DisplayMessage } from '../src/state/types.js';

describe('collapseSpaceSummary', () => {
  it('keeps short summaries intact', () => {
    const summary = 'line one\nline two';
    expect(collapseSpaceSummary(summary, 4).text).toBe(summary);
  });

  it('truncates long summaries with a line count hint', () => {
    const summary = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
    const collapsed = collapseSpaceSummary(summary, 3);
    expect(collapsed.text).toContain('line 1');
    expect(collapsed.text).toContain('共 10 行');
    expect(collapsed.hidden).toBeGreaterThan(0);
  });
});

describe('sub-space transcript compaction', () => {
  it('does not include discarded sub-space prose in provider history', () => {
    const messages: DisplayMessage[] = [
      { id: 1, role: 'user', text: 'search' },
      { id: 2, role: 'space', space: { id: 'web', label: 'Web Search' } },
      { id: 3, role: 'tool', tool: { name: 'web_search', args: '{}', result: '{}', status: 'done' } },
      { id: 4, role: 'space_result', nested: true, result: { id: 'web', status: 'success', summary: 'done' } },
      { id: 5, role: 'assistant', text: 'final answer' },
    ];
    const history = buildProviderHistory(messages);
    expect(history).toEqual([
      { role: 'user', content: 'search' },
      { role: 'assistant', content: [{ type: 'text', text: 'final answer' }] },
    ]);
  });
});
