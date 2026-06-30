import { DEFAULT_AVATAR_ID } from '@zleap/core';
import { describe, expect, it } from 'vitest';
import { buildWebChatRunInput } from '../src/webChatRun.js';

describe('buildWebChatRunInput', () => {
  it('maps web request state into a normalized avatar run', () => {
    expect(
      buildWebChatRunInput({
        actorId: 'u1',
        conversationId: 'conversation-1',
        prompt: 'hello',
      }),
    ).toEqual({
      channel: 'web',
      avatarId: DEFAULT_AVATAR_ID,
      actorId: 'u1',
      spaceId: 'main',
      conversationId: 'conversation-1',
      prompt: 'hello',
      permissionMode: 'default',
    });
  });

  it('preserves explicit avatar and target space choices', () => {
    expect(
      buildWebChatRunInput({
        avatarId: 'avatar-1',
        actorId: 'u1',
        spaceId: 'research',
        conversationId: 'conversation-1',
        messageId: 'message-1',
        prompt: 'hello',
      }),
    ).toMatchObject({
      avatarId: 'avatar-1',
      spaceId: 'research',
      messageId: 'message-1',
    });
  });
});
