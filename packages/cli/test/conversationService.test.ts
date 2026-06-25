import { localDevActorContext, type ActorContext, type InboundMessage } from '@zleap/core';
import { describe, expect, it } from 'vitest';
import { defaultConversationActor } from '@zleap/agent/conversation';

function inbound(input: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channel: 'wechat',
    conversationId: 'chat-1',
    kind: 'im',
    text: 'hello',
    ...input,
  };
}

describe('ConversationService identity mapping', () => {
  it('maps IM gateway messages without an actor to the WebUI local user', () => {
    const actor = defaultConversationActor(inbound({
      metadata: { openId: 'wechat-open-id', unionId: 'wechat-union-id' },
    }));

    expect(actor).toEqual(localDevActorContext());
  });

  it('keeps an explicit runtime actor over platform ids', () => {
    const explicit: ActorContext = { userId: 'web-user', role: 'user' };

    expect(defaultConversationActor(inbound({ actor: explicit, metadata: { openId: 'wechat-open-id' } }))).toBe(explicit);
  });

  it('does not invent an actor for non-IM inbound messages', () => {
    expect(defaultConversationActor(inbound({ channel: 'cli', kind: 'user' }))).toBeUndefined();
  });
});
