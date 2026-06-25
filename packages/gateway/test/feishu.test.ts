import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FeishuConfig } from '../src/config.js';
import { FileDedupStore } from '../src/dedup.js';
import { FeishuAdapter } from '../src/platforms/feishu.js';
import type { PlatformMessageEvent } from '../src/types.js';

const baseConfig: FeishuConfig = {
  appId: 'cli_x',
  appSecret: 'secret',
  domain: 'feishu',
  groupPolicy: 'open',
  allowedUsers: [],
};

/* eslint-disable @typescript-eslint/no-explicit-any */
function larkData(overrides: Record<string, any> = {}): any {
  const {
    chatId = 'oc_chat',
    messageId = 'om_1',
    chatType = 'p2p',
    text = 'hello',
    openId = 'ou_user',
    senderType = 'user',
    mentions = [],
    messageType = 'text',
    content,
    eventId,
  } = overrides;
  return {
    ...(eventId ? { event_id: eventId } : {}),
    sender: { sender_id: { open_id: openId }, sender_type: senderType },
    message: {
      chat_id: chatId,
      message_id: messageId,
      chat_type: chatType,
      message_type: messageType,
      content: content ?? JSON.stringify({ text }),
      mentions,
    },
  };
}

function collector(adapter: FeishuAdapter): PlatformMessageEvent[] {
  const events: PlatformMessageEvent[] = [];
  adapter.setMessageHandler(async (event) => {
    events.push(event);
  });
  return events;
}

async function feed(adapter: FeishuAdapter, data: any): Promise<void> {
  await (adapter as any).onMessage(data);
}

describe('FeishuAdapter inbound normalization', () => {
  it('dispatches a p2p text message with extracted text', async () => {
    const adapter = new FeishuAdapter(baseConfig);
    const events = collector(adapter);
    await feed(adapter, larkData({ text: 'hi there' }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      channel: 'feishu',
      conversationId: 'oc_chat',
      chatType: 'p2p',
      text: 'hi there',
      userId: 'ou_user',
    });
  });

  it('strips @mention placeholders from text', async () => {
    const adapter = new FeishuAdapter(baseConfig);
    const events = collector(adapter);
    await feed(adapter, larkData({ text: '@_user_1 help me please' }));
    expect(events[0]?.text).toBe('help me please');
  });

  it('drops messages sent by a bot/app sender', async () => {
    const adapter = new FeishuAdapter(baseConfig);
    const events = collector(adapter);
    await feed(adapter, larkData({ senderType: 'app' }));
    expect(events).toHaveLength(0);
  });

  it('ignores empty text', async () => {
    const adapter = new FeishuAdapter(baseConfig);
    const events = collector(adapter);
    await feed(adapter, larkData({ text: '   ' }));
    expect(events).toHaveLength(0);
  });
});

describe('FeishuAdapter group gating', () => {
  it('rejects group messages without a bot mention (botOpenId set)', async () => {
    const adapter = new FeishuAdapter({ ...baseConfig, botOpenId: 'ou_bot' });
    const events = collector(adapter);
    await feed(adapter, larkData({ chatType: 'group', mentions: [{ id: { open_id: 'ou_other' } }] }));
    expect(events).toHaveLength(0);
  });

  it('accepts group messages mentioning the bot', async () => {
    const adapter = new FeishuAdapter({ ...baseConfig, botOpenId: 'ou_bot' });
    const events = collector(adapter);
    await feed(adapter, larkData({ chatType: 'group', mentions: [{ id: { open_id: 'ou_bot' } }] }));
    expect(events).toHaveLength(1);
    expect(events[0]?.mentionsBot).toBe(true);
  });

  it('enforces allowlist policy on group senders', async () => {
    const allowed = new FeishuAdapter({ ...baseConfig, groupPolicy: 'allowlist', allowedUsers: ['ou_user'] });
    const events = collector(allowed);
    await feed(allowed, larkData({ chatType: 'group', mentions: [{ id: { open_id: 'ou_bot' } }] }));
    expect(events).toHaveLength(1);

    const blocked = new FeishuAdapter({ ...baseConfig, groupPolicy: 'allowlist', allowedUsers: ['ou_someone'] });
    const blockedEvents = collector(blocked);
    await feed(blocked, larkData({ chatType: 'group', mentions: [{ id: { open_id: 'ou_bot' } }] }));
    expect(blockedEvents).toHaveLength(0);
  });

  it('blocks all group traffic when policy is disabled', async () => {
    const adapter = new FeishuAdapter({ ...baseConfig, groupPolicy: 'disabled' });
    const events = collector(adapter);
    await feed(adapter, larkData({ chatType: 'group', mentions: [{ id: { open_id: 'ou_bot' } }] }));
    expect(events).toHaveLength(0);
  });
});

describe('FeishuAdapter dedup', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'zleap-feishu-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('drops a redelivered event id', async () => {
    const dedup = new FileDedupStore(join(dir, 'seen.json'));
    const adapter = new FeishuAdapter(baseConfig, { dedup });
    const events = collector(adapter);
    await feed(adapter, larkData({ eventId: 'evt_dup', messageId: 'om_a' }));
    await feed(adapter, larkData({ eventId: 'evt_dup', messageId: 'om_b' }));
    expect(events).toHaveLength(1);
  });
});
