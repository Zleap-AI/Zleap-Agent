import { describe, expect, it } from 'vitest';
import { resolveConversationWorkspaceRoot } from '../src/index.js';

describe('conversation workspace roots', () => {
  it('derives a readable date/topic root from the conversation title', () => {
    const root = resolveConversationWorkspaceRoot({
      baseRoot: '/tmp/zleap-history',
      conversationId: 'conversation-1',
      titleSeed: 'Analyze codebase / write report',
      now: new Date('2026-06-14T12:00:00Z'),
    });

    expect(root).toBe('/tmp/zleap-history/2026-06-14/Analyze-codebase-write-report');
    expect(root).toBe(
      resolveConversationWorkspaceRoot({
        baseRoot: '/tmp/zleap-history',
        conversationId: 'conversation-1',
        titleSeed: 'Analyze codebase / write report',
        now: new Date('2026-06-14T12:00:00Z'),
      }),
    );
  });

  it('keeps history folder names ASCII-only without exposing fallback conversation ids', () => {
    const root = resolveConversationWorkspaceRoot({
      baseRoot: '/tmp/zleap-history',
      conversationId: 'conversation-1',
      titleSeed: '分析下这个代码库是干什么的，生成一个md',
      now: new Date('2026-06-14T12:00:00Z'),
    });

    expect(root).toMatch(/^\/tmp\/zleap-history\/2026-06-14\/chat-[a-f0-9]{10}$/);
    expect(root).not.toContain('conversation-1');
    expect(root).toBe(
      resolveConversationWorkspaceRoot({
        baseRoot: '/tmp/zleap-history',
        conversationId: 'conversation-1',
        titleSeed: '分析下这个代码库是干什么的，生成一个md',
        now: new Date('2026-06-14T12:00:00Z'),
      }),
    );
  });

  it('does not expose generated web conversation ids as folder names', () => {
    const timestamp = new Date('2026-06-14T12:00:00Z').getTime().toString(36);
    const conversationId = `web-${timestamp}-c05oms`;
    const root = resolveConversationWorkspaceRoot({
      baseRoot: '/tmp/zleap-history',
      conversationId,
      now: new Date('2026-06-15T12:00:00Z'),
    });

    expect(root).toMatch(/^\/tmp\/zleap-history\/2026-06-14\/chat-[a-f0-9]{10}$/);
    expect(root).not.toContain(conversationId);
  });

  it('uses an explicit outer-layer base root when supplied', () => {
    const root = resolveConversationWorkspaceRoot({
      baseRoot: '/tmp/zleap-env-root',
      conversationId: '../unsafe id',
      titleSeed: '../unsafe id',
      now: new Date('2026-06-14T12:00:00Z'),
    });

    expect(root).toBe('/tmp/zleap-env-root/2026-06-14/unsafe-id');
  });
});
