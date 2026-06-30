import type { SessionEntryRecord } from '@zleap/core';
import { describe, expect, it } from 'vitest';
import { toPublicChatTraceEntry, toPublicChatTraceEntryData } from '../lib/server/chatTraceProjection';

describe('chat trace public projection', () => {
  it('keeps trace metadata while redacting raw content and payload fields', () => {
    const entry: SessionEntryRecord = {
      id: 'entry-1',
      sessionId: 'session-1',
      parentEntryId: 'parent-1',
      type: 'tool_result',
      role: 'tool',
      runId: 'run-1',
      toolCallId: 'call-1',
      artifactId: 'artifact-1',
      tokenCount: 42,
      content: 'raw content with sensitive result',
      data: {
        projectionKind: 'tool_execution_record',
        source: 'tool_execution_end',
        sourceRefs: [
          { table: 'artifacts', ids: ['artifact-1', 123] },
          { table: '', ids: ['ignored'] },
          { table: 'runs', ids: [] },
          { nope: true },
        ],
        artifactId: 'artifact-1',
        toolName: 'bash',
        isError: false,
        input: { command: 'print-secret' },
        result: 'sensitive result',
        artifact: { payload: 'sensitive artifact payload' },
      },
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
    };

    const publicEntry = toPublicChatTraceEntry(entry);

    expect(publicEntry).toMatchObject({
      id: 'entry-1',
      sessionId: 'session-1',
      parentEntryId: 'parent-1',
      type: 'tool_result',
      role: 'tool',
      runId: 'run-1',
      toolCallId: 'call-1',
      artifactId: 'artifact-1',
      tokenCount: 42,
      hasContent: true,
      contentLength: 33,
      createdAt: '2026-01-02T03:04:05.000Z',
      data: {
        projectionKind: 'tool_execution_record',
        source: 'tool_execution_end',
        sourceRefs: [{ table: 'artifacts', ids: ['artifact-1'] }],
        artifactId: 'artifact-1',
        toolName: 'bash',
        isError: false,
      },
    });
    expect(publicEntry).not.toHaveProperty('content');
    expect(publicEntry.data).not.toHaveProperty('input');
    expect(publicEntry.data).not.toHaveProperty('result');
    expect(publicEntry.data).not.toHaveProperty('artifact');
    expect(JSON.stringify(publicEntry)).not.toContain('print-secret');
    expect(JSON.stringify(publicEntry)).not.toContain('sensitive result');
    expect(JSON.stringify(publicEntry)).not.toContain('sensitive artifact payload');
  });

  it('omits data when no public fields are present', () => {
    expect(toPublicChatTraceEntryData({ input: { hidden: true }, result: 'hidden' })).toBeUndefined();
    expect(toPublicChatTraceEntryData(['projectionKind'])).toBeUndefined();
  });
});
