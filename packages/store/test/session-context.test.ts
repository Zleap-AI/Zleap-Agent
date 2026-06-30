import { describe, expect, it } from 'vitest';
import type { SessionEntryRecord } from '@zleap/core';
import { buildSessionContextFromEntries } from '../src/store.js';

const createdAt = new Date('2026-01-02T03:04:05.000Z');

function entry(record: Omit<SessionEntryRecord, 'sessionId' | 'createdAt'>): SessionEntryRecord {
  return {
    sessionId: 'session-1',
    createdAt,
    ...record,
  };
}

describe('buildSessionContextFromEntries', () => {
  it('keeps legacy message-only conversation shape when no compaction exists', () => {
    const entries = [
      entry({ id: 'e1', type: 'message', role: 'user', content: 'hello' }),
      entry({ id: 'e2', type: 'message', role: 'assistant', content: 'hi', data: { source: 'test' } }),
      entry({ id: 'e3', type: 'tool_result', role: 'tool', content: 'handoff summary' }),
    ];

    expect(buildSessionContextFromEntries(entries)).toEqual([
      { role: 'user', content: 'hello', data: undefined },
      { role: 'assistant', content: 'hi', data: { source: 'test' } },
    ]);
  });

  it('keeps only outcome durable projections in an uncompacted session context', () => {
    const entries = [
      entry({ id: 'e1', type: 'message', role: 'user', content: 'hello' }),
      entry({
        id: 'e2',
        type: 'tool_call',
        role: 'assistant',
        content: 'grep starting',
        data: { projectionKind: 'workspace_tool_preview', toolName: 'grep', phase: 'start' },
      }),
      entry({
        id: 'e3',
        type: 'tool_result',
        role: 'tool',
        content: 'grep found 2 files',
        data: { projectionKind: 'workspace_tool_preview', toolName: 'grep', phase: 'end' },
      }),
      entry({
        id: 'e4',
        type: 'tool_result',
        role: 'tool',
        content: 'approval required',
        data: { projectionKind: 'approval_request', approvalId: 'approval-1' },
      }),
      entry({
        id: 'e5',
        type: 'tool_result',
        role: 'tool',
        content: 'artifact summary',
        data: { projectionKind: 'artifact_handoff', artifactId: 'artifact-1' },
      }),
      entry({
        id: 'e6',
        type: 'tool_result',
        role: 'tool',
        content: 'raw tool output should not be returned',
        data: { projectionKind: 'tool_execution_record' },
      }),
      entry({ id: 'e7', type: 'message', role: 'assistant', content: 'hi' }),
    ];

    expect(buildSessionContextFromEntries(entries)).toEqual([
      { role: 'user', content: 'hello', data: undefined },
      { role: 'tool', content: 'approval required', data: { projectionKind: 'approval_request', approvalId: 'approval-1' } },
      { role: 'tool', content: 'artifact summary', data: { projectionKind: 'artifact_handoff', artifactId: 'artifact-1' } },
      { role: 'assistant', content: 'hi', data: undefined },
    ]);
  });

  it('uses the latest compaction entry as a cut point without injecting a system summary', () => {
    const entries = [
      entry({ id: 'e1', type: 'message', role: 'user', content: 'old user' }),
      entry({ id: 'e2', type: 'message', role: 'assistant', content: 'old assistant' }),
      entry({
        id: 'e3',
        type: 'compaction',
        role: 'system',
        content: 'old work was summarized',
        data: { projectionKind: 'compaction', reason: 'manual_compact' },
      }),
      entry({ id: 'e4', type: 'message', role: 'user', content: 'recent user' }),
      entry({ id: 'e5', type: 'message', role: 'assistant', content: 'recent assistant' }),
    ];

    expect(buildSessionContextFromEntries(entries)).toEqual([
      { role: 'user', content: 'recent user', data: undefined },
      { role: 'assistant', content: 'recent assistant', data: undefined },
    ]);
  });

  it('honors firstKeptEntryId when a compaction preserves pre-entry context', () => {
    const entries = [
      entry({ id: 'e1', type: 'message', role: 'user', content: 'summarized user' }),
      entry({ id: 'e2', type: 'message', role: 'assistant', content: 'kept assistant' }),
      entry({ id: 'e3', type: 'message', role: 'user', content: 'kept user' }),
      entry({
        id: 'e4',
        type: 'compaction',
        role: 'system',
        content: 'older context summary',
        data: { projectionKind: 'compaction', firstKeptEntryId: 'e2' },
      }),
      entry({ id: 'e5', type: 'message', role: 'assistant', content: 'after compaction' }),
    ];

    expect(buildSessionContextFromEntries(entries)).toEqual([
      { role: 'assistant', content: 'kept assistant', data: undefined },
      { role: 'user', content: 'kept user', data: undefined },
      { role: 'assistant', content: 'after compaction', data: undefined },
    ]);
  });

  it('rewinds firstKeptEntryId to keep matching tool_call and tool_result entries together', () => {
    const entries = [
      entry({ id: 'e1', type: 'message', role: 'user', content: 'summarized user' }),
      entry({
        id: 'e2',
        type: 'tool_call',
        role: 'assistant',
        content: 'read src/index.ts',
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
      { role: 'assistant', content: 'read src/index.ts', data: { projectionKind: 'tool_execution_record' } },
      { role: 'tool', content: 'file content', data: { projectionKind: 'tool_execution_record' } },
      { role: 'assistant', content: 'after compaction', data: undefined },
    ]);
  });

  it('omits soft-deleted entries from active session context', () => {
    const entries = [
      entry({ id: 'e1', type: 'message', role: 'user', content: 'keep user' }),
      entry({
        id: 'e2',
        type: 'message',
        role: 'assistant',
        content: 'deleted assistant',
        deletedAt: new Date('2026-01-03T00:00:00.000Z'),
      }),
      entry({ id: 'e3', type: 'message', role: 'assistant', content: 'keep assistant' }),
    ];

    expect(buildSessionContextFromEntries(entries)).toEqual([
      { role: 'user', content: 'keep user', data: undefined },
      { role: 'assistant', content: 'keep assistant', data: undefined },
    ]);
    expect(buildSessionContextFromEntries(entries, 'audit')).toEqual([
      { role: 'user', content: 'keep user', data: undefined },
      { role: 'assistant', content: 'deleted assistant', data: undefined },
      { role: 'assistant', content: 'keep assistant', data: undefined },
    ]);
  });
});
