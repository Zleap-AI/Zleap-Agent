import { LOCAL_DEV_ACTOR_TENANT_ID, LOCAL_DEV_ACTOR_USER_ID, type ActorContext } from '@zleap/core';
import { describe, expect, it } from 'vitest';
import { toInbound } from '../src/runner.js';
import type { PlatformMessageEvent } from '../src/types.js';

function event(overrides: Partial<PlatformMessageEvent> = {}): PlatformMessageEvent {
  return {
    channel: 'feishu',
    conversationId: 'oc_chat',
    chatType: 'p2p',
    text: 'hello',
    userId: 'ou_user',
    messageId: 'om_1',
    eventId: 'evt_1',
    mentionsBot: false,
    ...overrides,
  };
}

describe('toInbound', () => {
  it('maps a platform event into the L2 inbound contract', () => {
    const inbound = toInbound(event());
    expect(inbound).toMatchObject({
      channel: 'feishu',
      conversationId: 'oc_chat',
      kind: 'im',
      text: 'hello',
      replyTo: 'om_1',
    });
  });

  it('uses the local WebUI actor for 1:1 gateway traffic', () => {
    const inbound = toInbound(event({ chatType: 'p2p', userId: 'ou_user' }));
    expect(inbound.actor).toEqual({ userId: LOCAL_DEV_ACTOR_USER_ID, role: 'admin', tenantId: LOCAL_DEV_ACTOR_TENANT_ID });
    expect(inbound.metadata).toMatchObject({ senderId: 'feishu:ou_user' });
  });

  it('keeps group chats in the local WebUI owner scope and preserves the sender', () => {
    const inbound = toInbound(event({ chatType: 'group', conversationId: 'oc_group', userId: 'ou_user' }));
    expect(inbound.actor).toEqual({ userId: LOCAL_DEV_ACTOR_USER_ID, role: 'admin', tenantId: LOCAL_DEV_ACTOR_TENANT_ID });
    expect(inbound.metadata).toMatchObject({ senderId: 'feishu:ou_user' });
  });

  it('still has a local actor when the platform sender is absent', () => {
    const inbound = toInbound(event({ chatType: 'p2p', userId: undefined }));
    expect(inbound.actor).toEqual({ userId: LOCAL_DEV_ACTOR_USER_ID, role: 'admin', tenantId: LOCAL_DEV_ACTOR_TENANT_ID });
  });

  it('accepts an explicit owner actor for future authenticated gateway routing', () => {
    const actor: ActorContext = { userId: 'u1', role: 'user', tenantId: 't1' };
    const inbound = toInbound(event({ chatType: 'p2p', userId: 'ou_user' }), actor);
    expect(inbound.actor).toEqual(actor);
  });

  it('carries chat type, mention state, and sender in metadata', () => {
    const inbound = toInbound(event({ chatType: 'group', mentionsBot: true, tenantId: 'tenant_1' }));
    expect(inbound.metadata).toEqual({
      chatType: 'group',
      mentionsBot: true,
      senderId: 'feishu:ou_user',
      platformTenantId: 'feishu:tenant_1',
    });
  });
});
