import { describe, expect, it } from 'vitest';
import { applyConversationContextPatch, type Conversation } from '../lib/useConversations';

describe('conversation list state', () => {
  it('does not touch updatedAt when only refreshing conversation context', () => {
    const existing: Conversation = {
      id: 'conversation-1',
      title: '帮我深度搜索302.AI，然后帮我制作一个介绍的ppt',
      agentId: 'persona',
      updatedAt: Date.parse('2026-06-20T08:00:00.000Z'),
      workspaceRoot: '/old/workspace',
      workspaceKind: 'artifact',
    };

    const next = applyConversationContextPatch(existing, {
      projectId: 'project-1',
      workspaceRoot: '/new/workspace',
      workspaceKind: 'artifact',
    });

    expect(next).toMatchObject({
      projectId: 'project-1',
      workspaceRoot: '/new/workspace',
      workspaceKind: 'artifact',
    });
    expect(next.updatedAt).toBe(existing.updatedAt);
  });
});
