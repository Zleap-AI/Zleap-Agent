import { describe, expect, it } from 'vitest';
import type { SessionEntryRecord } from '../src/records.js';
import {
  buildConversationFromEntries,
  buildSessionContextFromEntries,
  expandRelatedDeletionEntryIds,
  filterSessionEntriesByVisibility,
} from '../src/session-history.js';

const createdAt = new Date('2026-01-02T03:04:05.000Z');

function entry(record: Omit<SessionEntryRecord, 'sessionId' | 'createdAt'>): SessionEntryRecord {
  return {
    sessionId: 'session-1',
    createdAt,
    ...record,
  };
}

describe('session history projection', () => {
  it('filters soft-deleted entries from active history and keeps them in audit history', () => {
    const entries = [
      entry({ id: 'e1', type: 'message', role: 'user', content: 'visible user' }),
      entry({
        id: 'e2',
        type: 'message',
        role: 'assistant',
        content: 'deleted assistant',
        deletedAt: new Date('2026-01-03T00:00:00.000Z'),
      }),
      entry({ id: 'e3', type: 'message', role: 'assistant', content: 'visible assistant' }),
    ];

    expect(filterSessionEntriesByVisibility(entries).map((item) => item.id)).toEqual(['e1', 'e3']);
    expect(filterSessionEntriesByVisibility(entries, 'active').map((item) => item.id)).toEqual(['e1', 'e3']);
    expect(filterSessionEntriesByVisibility(entries, 'audit').map((item) => item.id)).toEqual(['e1', 'e2', 'e3']);
  });

  it('builds conversation messages from active user and assistant text only', () => {
    const entries = [
      entry({ id: 'e1', type: 'message', role: 'user', content: 'hello' }),
      entry({ id: 'e2', type: 'tool_result', role: 'tool', content: 'tool output' }),
      entry({
        id: 'e3',
        type: 'message',
        role: 'assistant',
        content: 'deleted answer',
        deletedAt: new Date('2026-01-03T00:00:00.000Z'),
      }),
      entry({ id: 'e4', type: 'message', role: 'assistant', content: 'kept answer', data: { source: 'test' } }),
    ];

    expect(buildConversationFromEntries(entries)).toEqual([
      { role: 'user', content: 'hello', data: undefined },
      { role: 'assistant', content: 'kept answer', data: { source: 'test' } },
    ]);
    expect(buildConversationFromEntries(entries, 'audit')).toEqual([
      { role: 'user', content: 'hello', data: undefined },
      { role: 'assistant', content: 'deleted answer', data: undefined },
      { role: 'assistant', content: 'kept answer', data: { source: 'test' } },
    ]);
  });

  it('keeps only safe uncompacted projection kinds in session context', () => {
    const entries = [
      entry({ id: 'e1', type: 'message', role: 'user', content: 'build a page' }),
      entry({
        id: 'e2',
        type: 'tool_result',
        role: 'tool',
        content: 'approval required',
        data: { projectionKind: 'approval_request', approvalId: 'approval-1' },
      }),
      entry({
        id: 'e3',
        type: 'tool_result',
        role: 'tool',
        content: 'artifact summary',
        data: { projectionKind: 'artifact_handoff', artifactId: 'artifact-1' },
      }),
      entry({
        id: 'e4',
        type: 'tool_result',
        role: 'tool',
        content: 'raw output',
        data: { projectionKind: 'tool_execution_record' },
      }),
      entry({ id: 'e5', type: 'message', role: 'assistant', content: 'done' }),
    ];

    expect(buildSessionContextFromEntries(entries)).toEqual([
      { role: 'user', content: 'build a page', data: undefined },
      { role: 'tool', content: 'approval required', data: { projectionKind: 'approval_request', approvalId: 'approval-1' } },
      { role: 'tool', content: 'artifact summary', data: { projectionKind: 'artifact_handoff', artifactId: 'artifact-1' } },
      { role: 'assistant', content: 'done', data: undefined },
    ]);
  });

  it('rewinds compaction starts to keep matching tool call and result entries together', () => {
    const entries = [
      entry({ id: 'e1', type: 'message', role: 'user', content: 'old user' }),
      entry({
        id: 'e2',
        type: 'tool_call',
        role: 'assistant',
        content: 'read file',
        toolCallId: 'tool-call-1',
        data: { projectionKind: 'tool_execution_record' },
      }),
      entry({
        id: 'e3',
        type: 'tool_result',
        role: 'tool',
        content: 'file content',
        toolCallId: 'tool-call-1',
        data: { projectionKind: 'tool_execution_record' },
      }),
      entry({
        id: 'e4',
        type: 'compaction',
        role: 'system',
        content: 'older context summary',
        data: { projectionKind: 'compaction', firstKeptEntryId: 'e3' },
      }),
      entry({ id: 'e5', type: 'message', role: 'assistant', content: 'after compaction' }),
    ];

    expect(buildSessionContextFromEntries(entries)).toEqual([
      { role: 'assistant', content: 'read file', data: { projectionKind: 'tool_execution_record' } },
      { role: 'tool', content: 'file content', data: { projectionKind: 'tool_execution_record' } },
      { role: 'assistant', content: 'after compaction', data: undefined },
    ]);
  });

  it('expands assistant deletion to same-turn duplicate assistant text and handoff entries', () => {
    const entries = [
      entry({ id: 'e1', type: 'message', role: 'user', content: 'make page' }),
      entry({
        id: 'e2',
        type: 'tool_result',
        role: 'tool',
        content: 'created index.html',
        data: { projectionKind: 'artifact_handoff', artifactId: 'artifact-1' },
      }),
      entry({ id: 'e3', type: 'message', role: 'assistant', content: 'Created index.html' }),
      entry({ id: 'e4', type: 'message', role: 'assistant', content: '  Created index.html\n' }),
      entry({ id: 'e5', type: 'message', role: 'user', content: 'next turn' }),
      entry({ id: 'e6', type: 'message', role: 'assistant', content: 'Created index.html' }),
    ];

    expect(expandRelatedDeletionEntryIds(entries, ['e3']).sort()).toEqual(['e2', 'e3', 'e4']);
  });
});
