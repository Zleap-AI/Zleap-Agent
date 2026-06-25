import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WeChatConfig } from '../src/config.js';
import { FileDedupStore } from '../src/dedup.js';
import { WeChatAdapter } from '../src/platforms/wechat/index.js';
import type { ILinkClient, SendMessageInput, SendTypingInput, WeixinMessage } from '../src/platforms/wechat/ilink.js';
import type { PlatformMessageEvent } from '../src/types.js';

const baseConfig: WeChatConfig = {
  enabled: true,
  baseUrl: 'https://example.test',
  botType: 3,
  channelVersion: '1.0.2',
  groupPolicy: 'open',
  allowedUsers: [],
  permissionMode: 'request_approval',
};

/** Records outbound calls; the inbound path is driven directly via onMessage. */
class FakeClient {
  readonly sent: SendMessageInput[] = [];
  readonly typing: SendTypingInput[] = [];

  setBotToken(): void {}
  setBaseUrl(): void {}
  hasToken(): boolean {
    return true;
  }
  async getConfig(): Promise<{ typingTicket?: string }> {
    return { typingTicket: 'ticket_test' };
  }
  async sendMessage(input: SendMessageInput): Promise<{ messageId?: string }> {
    this.sent.push(input);
    return { messageId: 'wx_out_1' };
  }
  async sendTyping(input: SendTypingInput): Promise<void> {
    this.typing.push(input);
  }
}

function makeAdapter(config: Partial<WeChatConfig> = {}, options: { client?: FakeClient; dedup?: FileDedupStore } = {}) {
  const client = options.client ?? new FakeClient();
  const adapter = new WeChatAdapter(
    { ...baseConfig, ...config },
    { client: client as unknown as ILinkClient, ...(options.dedup ? { dedup: options.dedup } : {}) },
  );
  const events: PlatformMessageEvent[] = [];
  adapter.setMessageHandler(async (event) => {
    events.push(event);
  });
  return { adapter, client, events };
}

function inbound(overrides: Partial<WeixinMessage> = {}): WeixinMessage {
  return {
    from_user_id: 'o_user@im.wechat',
    message_type: 1,
    context_token: 'ctx_abc',
    msg_id: 'm_default',
    item_list: [{ type: 1, text_item: { text: 'hello' } }],
    ...overrides,
  };
}

async function feed(adapter: WeChatAdapter, message: WeixinMessage): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (adapter as any).onMessage(message);
}

describe('WeChatAdapter inbound normalization', () => {
  it('dispatches a 1:1 text message scoped to the sender', async () => {
    const { adapter, events } = makeAdapter();
    await feed(adapter, inbound({ item_list: [{ type: 1, text_item: { text: 'hi there' } }] }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      channel: 'wechat',
      conversationId: 'o_user@im.wechat',
      chatType: 'p2p',
      text: 'hi there',
      userId: 'o_user@im.wechat',
    });
  });

  it('joins multiple text items and ignores non-text items', async () => {
    const { adapter, events } = makeAdapter();
    await feed(
      adapter,
      inbound({
        item_list: [
          { type: 1, text_item: { text: 'line 1' } },
          { type: 2 },
          { type: 1, text_item: { text: 'line 2' } },
        ],
      }),
    );
    expect(events[0]?.text).toBe('line 1\nline 2');
  });

  it('maps group_id to a group conversation', async () => {
    const { adapter, events } = makeAdapter();
    await feed(adapter, inbound({ group_id: 'g_room_1' }));
    expect(events[0]).toMatchObject({
      conversationId: 'g_room_1',
      chatType: 'group',
      userId: 'o_user@im.wechat',
      mentionsBot: true,
    });
  });

  it('skips bot/system message types', async () => {
    const { adapter, events } = makeAdapter();
    await feed(adapter, inbound({ message_type: 2 }));
    expect(events).toHaveLength(0);
  });

  it('drops empty content', async () => {
    const { adapter, events } = makeAdapter();
    await feed(adapter, inbound({ item_list: [{ type: 1, text_item: { text: '   ' } }] }));
    expect(events).toHaveLength(0);
  });
});

describe('WeChatAdapter group gating', () => {
  it('blocks all group traffic when policy is disabled', async () => {
    const { adapter, events } = makeAdapter({ groupPolicy: 'disabled' });
    await feed(adapter, inbound({ group_id: 'g1' }));
    expect(events).toHaveLength(0);
  });

  it('enforces allowlist on group senders', async () => {
    const allowed = makeAdapter({ groupPolicy: 'allowlist', allowedUsers: ['o_user@im.wechat'] });
    await feed(allowed.adapter, inbound({ group_id: 'g1' }));
    expect(allowed.events).toHaveLength(1);

    const blocked = makeAdapter({ groupPolicy: 'allowlist', allowedUsers: ['o_other@im.wechat'] });
    await feed(blocked.adapter, inbound({ group_id: 'g1' }));
    expect(blocked.events).toHaveLength(0);
  });
});

describe('WeChatAdapter dedup', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'zleap-wechat-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('drops a redelivered message id', async () => {
    const dedup = new FileDedupStore(join(dir, 'seen.json'));
    const { adapter, events } = makeAdapter({}, { dedup });
    await feed(adapter, inbound({ msg_id: 'm1' }));
    await feed(adapter, inbound({ msg_id: 'm1' }));
    expect(events).toHaveLength(1);
  });
});

describe('WeChatAdapter outbound', () => {
  it('replies with the cached context_token and sender id', async () => {
    const { adapter, client } = makeAdapter();
    await feed(adapter, inbound({ from_user_id: 'o_user@im.wechat', context_token: 'ctx_xyz', msg_id: 'm_reply' }));
    const result = await adapter.send({ channel: 'wechat', conversationId: 'o_user@im.wechat', replyTo: 'm_reply' }, 'reply text');
    expect(result.ok).toBe(true);
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]).toMatchObject({
      toUserId: 'o_user@im.wechat',
      text: 'reply text',
      contextToken: 'ctx_xyz',
    });
  });

  it('routes group replies with group_id', async () => {
    const { adapter, client } = makeAdapter();
    await feed(adapter, inbound({ group_id: 'g_room', from_user_id: 'o_a@im.wechat', context_token: 'ctx_g', msg_id: 'm_group' }));
    await adapter.send({ channel: 'wechat', conversationId: 'g_room', replyTo: 'm_group' }, 'group reply');
    expect(client.sent[0]).toMatchObject({ groupId: 'g_room', contextToken: 'ctx_g' });
  });

  it('acks via a best-effort typing indicator', async () => {
    const { adapter, client } = makeAdapter();
    const message = inbound({ from_user_id: 'o_user@im.wechat', context_token: 'ctx_ack', msg_id: 'm_ack' });
    await feed(adapter, message);
    await adapter.ack({
      channel: 'wechat',
      conversationId: 'o_user@im.wechat',
      chatType: 'p2p',
      text: 'hello',
      userId: 'o_user@im.wechat',
      messageId: 'm_ack',
    });
    expect(client.typing).toHaveLength(1);
    expect(client.typing[0]).toMatchObject({ ilinkUserId: 'o_user@im.wechat', typingTicket: 'ticket_test', status: 1 });
  });
});
