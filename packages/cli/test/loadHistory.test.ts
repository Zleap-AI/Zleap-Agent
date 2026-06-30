import { describe, expect, it } from 'vitest';
import { buildConversationFromEntries, type SessionEntryRecord } from '@zleap/core';
import type { ZleapStore } from '@zleap/store';
import { loadHistory } from '@zleap/agent/conversation';

function entry(partial: Partial<SessionEntryRecord> & Pick<SessionEntryRecord, 'id' | 'type'>): SessionEntryRecord {
  return {
    sessionId: 'feishu:conv-1:main',
    createdAt: new Date(),
    ...partial,
  } as SessionEntryRecord;
}

/** Minimal store double exposing the two reads loadHistory uses. */
function storeWith(entries: SessionEntryRecord[]): ZleapStore {
  return {
    sessions: {
      listEntries: async () => entries,
      buildConversation: async () => buildConversationFromEntries(entries),
    },
  } as unknown as ZleapStore;
}

const TURN: SessionEntryRecord[] = [
  entry({ id: '1', type: 'message', role: 'user', content: 'search the news' }),
  entry({
    id: '2',
    type: 'tool_call',
    role: 'assistant',
    content: '{"items":["a","b"]}',
    toolCallId: 'call-1',
    data: { toolId: 'web_search', input: { query: 'news' }, result: { items: ['a', 'b'] } },
  }),
  entry({
    id: '3',
    type: 'tool_result',
    role: 'tool',
    content: 'search result',
    toolCallId: 'call-1',
    data: { toolId: 'web_search', input: { query: 'news' }, isError: false },
  }),
  entry({ id: '4', type: 'message', role: 'assistant', content: 'here is the summary' }),
  entry({ id: '5', type: 'message', role: 'user', content: 'thanks' }),
];

describe('loadHistory tool traces', () => {
  it('rebuilds tool traces as structured tool-call and shortened tool-result messages', async () => {
    const longResult = `${'result detail '.repeat(120)}END`;
    const messages = await loadHistory(storeWith([
      entry({ id: '1', type: 'message', role: 'user', content: 'search the news' }),
      entry({
        id: '2',
        type: 'tool_call',
        role: 'assistant',
        content: '{"query":"news"}',
        toolCallId: 'call-1',
        data: { toolName: 'web_search', input: { query: 'news' } },
      }),
      entry({
        id: '3',
        type: 'tool_result',
        role: 'tool',
        content: longResult,
        toolCallId: 'call-1',
        data: { toolName: 'web_search', input: { query: 'news' }, isError: false },
      }),
      entry({ id: '4', type: 'message', role: 'assistant', content: 'here is the summary' }),
    ]), { channel: 'feishu', conversationId: 'conv-1' });

    expect(messages).toHaveLength(4);
    expect(messages[0]).toEqual({ role: 'user', content: 'search the news' });
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call-1', name: 'web_search', arguments: { query: 'news' } }],
    });
    expect(messages[2]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'web_search',
      isError: false,
    });
    const payload = JSON.parse(messages[2]!.role === 'toolResult' ? messages[2]!.content : '{}');
    expect(payload).toMatchObject({
      id: '3',
      type: 'historical_tool_result',
      toolName: 'web_search',
      toolCallId: 'call-1',
      isError: false,
      truncated: true,
    });
    expect(payload.preview).toContain('result detail');
    expect(payload.preview).not.toContain('END');
    expect(payload.recovery).toBe('Use readMessage with this id to recover the full historical entry.');
    expect(messages[3]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'here is the summary' }] });
  });

  it('omits tool traces when includeTools is false', async () => {
    const messages = await loadHistory(storeWith(TURN), {
      channel: 'feishu',
      conversationId: 'conv-1',
      includeTools: false,
    });
    expect(JSON.stringify(messages)).not.toContain('web_search');
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('omits soft-deleted entries from model history even when the store double returns them', async () => {
    const messages = await loadHistory(storeWith([
      entry({ id: '1', type: 'message', role: 'user', content: 'keep this question' }),
      entry({
        id: '2',
        type: 'message',
        role: 'assistant',
        content: 'deleted answer must not be replayed',
        deletedAt: new Date('2026-01-03T00:00:00.000Z'),
      }),
      entry({ id: '3', type: 'message', role: 'assistant', content: 'keep this answer' }),
    ]), { channel: 'feishu', conversationId: 'conv-1' });

    const serialized = JSON.stringify(messages);
    expect(serialized).toContain('keep this question');
    expect(serialized).toContain('keep this answer');
    expect(serialized).not.toContain('deleted answer must not be replayed');
  });

  it('omits soft-deleted entries from text-only history', async () => {
    const messages = await loadHistory(storeWith([
      entry({ id: '1', type: 'message', role: 'user', content: 'keep this user text' }),
      entry({
        id: '2',
        type: 'message',
        role: 'assistant',
        content: 'deleted text-only answer',
        deletedAt: new Date('2026-01-03T00:00:00.000Z'),
      }),
      entry({ id: '3', type: 'message', role: 'assistant', content: 'keep this text-only answer' }),
    ]), {
      channel: 'feishu',
      conversationId: 'conv-1',
      includeTools: false,
    });

    const serialized = JSON.stringify(messages);
    expect(serialized).toContain('keep this user text');
    expect(serialized).toContain('keep this text-only answer');
    expect(serialized).not.toContain('deleted text-only answer');
  });

  it('marks only real failed tool results as errors', async () => {
    const messages = await loadHistory(storeWith([
      entry({ id: '1', type: 'message', role: 'user', content: 'run tools' }),
      entry({
        id: '2',
        type: 'tool_result',
        role: 'tool',
        content: 'success result',
        toolCallId: 'call-1',
        data: { toolName: 'readCache', input: { id: 'cache_1' }, isError: false },
      }),
      entry({
        id: '3',
        type: 'tool_result',
        role: 'tool',
        content: 'failed result',
        toolCallId: 'call-2',
        data: { toolName: 'write', input: { path: 'a.txt' }, isError: true },
      }),
    ]), { channel: 'feishu', conversationId: 'conv-1' });

    const text = JSON.stringify(messages);
    expect(text).toContain('"toolName":"readCache"');
    expect(text).toContain('"isError":false');
    expect(text).toContain('"toolName":"write"');
    expect(text).toContain('"isError":true');
  });
});
