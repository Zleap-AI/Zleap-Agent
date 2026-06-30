import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FeishuCliConfig } from '../src/config.js';
import { FileDedupStore } from '../src/dedup.js';
import { FeishuCliAdapter } from '../src/platforms/feishucli/index.js';
import { LarkCliClient, type SendInput } from '../src/platforms/feishucli/cli.js';
import type { PlatformMessageEvent } from '../src/types.js';

const baseConfig: FeishuCliConfig = {
  enabled: true,
  identity: 'user',
  domain: 'feishu',
  eventKey: 'im.message.receive_v1',
  groupPolicy: 'open',
  allowedUsers: [],
  permissionMode: 'request_approval',
  cliBin: 'lark-cli',
};

/** Captures outbound sends; the inbound path is driven directly via onLine. */
class FakeClient {
  readonly sent: SendInput[] = [];
  async sendMessage(input: SendInput): Promise<{ messageId?: string }> {
    this.sent.push(input);
    return { messageId: 'om_out_1' };
  }
}

function makeAdapter(config: Partial<FeishuCliConfig> = {}, options: { client?: FakeClient; dedup?: FileDedupStore } = {}) {
  const client = options.client ?? new FakeClient();
  const adapter = new FeishuCliAdapter(
    { ...baseConfig, ...config },
    { client: client as unknown as LarkCliClient, ...(options.dedup ? { dedup: options.dedup } : {}) },
  );
  const events: PlatformMessageEvent[] = [];
  adapter.setMessageHandler(async (event) => {
    events.push(event);
  });
  return { adapter, client, events };
}

type EventOverrides = {
  chatId?: string;
  chatType?: 'p2p' | 'group';
  text?: string;
  openId?: string;
  senderType?: string;
  eventId?: string;
  messageId?: string;
  mentions?: unknown[];
  /** Choose how the envelope nests the event (the CLI shape is best-effort). */
  envelope?: 'v2' | 'flat';
};

/** Build an NDJSON line mimicking a `lark-cli event +subscribe` emission. */
function line(overrides: EventOverrides = {}): string {
  const chatType = overrides.chatType ?? 'p2p';
  const message = {
    chat_id: overrides.chatId ?? 'oc_chat_1',
    chat_type: chatType,
    message_type: 'text',
    message_id: overrides.messageId ?? 'om_1',
    content: JSON.stringify({ text: overrides.text ?? 'hello' }),
    ...(overrides.mentions ? { mentions: overrides.mentions } : {}),
  };
  const sender = {
    sender_id: { open_id: overrides.openId ?? 'ou_user_1' },
    sender_type: overrides.senderType ?? 'user',
  };
  const header = { event_id: overrides.eventId ?? 'evt_1', tenant_key: 'tenant_1' };
  if (overrides.envelope === 'flat') {
    return JSON.stringify({ header, message, sender });
  }
  return JSON.stringify({ schema: '2.0', header, event: { message, sender } });
}

async function feed(adapter: FeishuCliAdapter, raw: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (adapter as any).onLine(raw);
}

describe('FeishuCliAdapter inbound normalization', () => {
  it('dispatches a 1:1 text message (v2 envelope)', async () => {
    const { adapter, events } = makeAdapter();
    await feed(adapter, line({ text: 'hi there' }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      channel: 'feishu-cli',
      conversationId: 'oc_chat_1',
      chatType: 'p2p',
      text: 'hi there',
      userId: 'ou_user_1',
      tenantId: 'tenant_1',
    });
  });

  it('unwraps a flat envelope shape', async () => {
    const { adapter, events } = makeAdapter();
    await feed(adapter, line({ envelope: 'flat', text: 'flat hi' }));
    expect(events[0]?.text).toBe('flat hi');
  });

  it('marks group messages with @mention and maps the group conversation', async () => {
    const { adapter, events } = makeAdapter();
    await feed(adapter, line({ chatType: 'group', chatId: 'oc_group_1', mentions: [{ id: { open_id: 'ou_bot' }, name: 'Bot' }] }));
    expect(events[0]).toMatchObject({ conversationId: 'oc_group_1', chatType: 'group', mentionsBot: true });
  });

  it('skips messages sent by a bot/system sender', async () => {
    const { adapter, events } = makeAdapter();
    await feed(adapter, line({ senderType: 'app' }));
    expect(events).toHaveLength(0);
  });

  it('drops empty/unsupported content', async () => {
    const { adapter, events } = makeAdapter();
    await feed(adapter, line({ text: '   ' }));
    expect(events).toHaveLength(0);
  });

  it('ignores non-JSON informational lines', async () => {
    const { adapter, events } = makeAdapter();
    await feed(adapter, 'subscribed to im.message.receive_v1');
    expect(events).toHaveLength(0);
  });
});

describe('FeishuCliAdapter group gating', () => {
  it('blocks all group traffic when policy is disabled', async () => {
    const { adapter, events } = makeAdapter({ groupPolicy: 'disabled' });
    await feed(adapter, line({ chatType: 'group', mentions: [{ id: { open_id: 'ou_bot' } }] }));
    expect(events).toHaveLength(0);
  });

  it('enforces an allowlist on group senders', async () => {
    const allowed = makeAdapter({ groupPolicy: 'allowlist', allowedUsers: ['ou_user_1'] });
    await feed(allowed.adapter, line({ chatType: 'group', openId: 'ou_user_1', mentions: [{ id: { open_id: 'ou_bot' } }] }));
    expect(allowed.events).toHaveLength(1);

    const blocked = makeAdapter({ groupPolicy: 'allowlist', allowedUsers: ['ou_other'] });
    await feed(blocked.adapter, line({ chatType: 'group', openId: 'ou_user_1', mentions: [{ id: { open_id: 'ou_bot' } }] }));
    expect(blocked.events).toHaveLength(0);
  });
});

describe('FeishuCliAdapter dedup', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'zleap-feishucli-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('drops a redelivered event id', async () => {
    const dedup = new FileDedupStore(join(dir, 'seen.json'));
    const { adapter, events } = makeAdapter({}, { dedup });
    await feed(adapter, line({ eventId: 'evt_dup' }));
    await feed(adapter, line({ eventId: 'evt_dup' }));
    expect(events).toHaveLength(1);
  });
});

describe('FeishuCliAdapter resilience', () => {
  it('does not throw from connect when the CLI is unavailable', async () => {
    class BrokenClient {
      async configStatus(): Promise<never> {
        throw new Error('spawn lark-cli ENOENT');
      }
    }
    const adapter = new FeishuCliAdapter(baseConfig, {
      client: new BrokenClient() as unknown as LarkCliClient,
    });
    await expect(adapter.connect()).resolves.toBeUndefined();
  });
});

function fakeStream() {
  const stream = new EventEmitter() as EventEmitter & { setEncoding: (encoding: string) => void };
  stream.setEncoding = () => {};
  return stream;
}

function fakeChild() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const child: any = new EventEmitter();
  child.stdout = fakeStream();
  child.stderr = fakeStream();
  child.kill = () => {};
  return child;
}

describe('LarkCliClient event subscription', () => {
  it('uses the official `event +subscribe --event-types` command (no --force)', () => {
    let captured: string[] = [];
    const client = new LarkCliClient({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spawnImpl: ((_bin: string, args: string[]) => {
        captured = args;
        return fakeChild();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    });
    const handle = client.subscribe('im.message.receive_v1', { onLine: () => {} });
    expect(captured).toEqual(['event', '+subscribe', '--event-types', 'im.message.receive_v1', '--quiet']);
    handle.stop();
  });
});

describe('FeishuCliAdapter bot identity', () => {
  it('skips the device flow and subscribes once config init is done', async () => {
    let deviceLoginCalls = 0;
    let subscribedKey: string | undefined;
    const client = {
      async configStatus() {
        return { configured: true, raw: {} };
      },
      async beginDeviceLogin() {
        deviceLoginCalls += 1;
        return { raw: {} };
      },
      subscribe(eventKey: string) {
        subscribedKey = eventKey;
        return { stop() {} };
      },
    };
    const adapter = new FeishuCliAdapter(
      { ...baseConfig, identity: 'bot' },
      { client: client as unknown as LarkCliClient },
    );
    await adapter.connect();
    // connect() backgrounds the handshake; let the resolved awaits settle.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(deviceLoginCalls).toBe(0);
    expect(subscribedKey).toBe('im.message.receive_v1');
    await adapter.disconnect();
  });
});

describe('FeishuCliAdapter outbound', () => {
  it('sends plain text with the configured identity and chat id', async () => {
    const { adapter, client } = makeAdapter({ identity: 'bot' });
    const result = await adapter.send({ channel: 'feishu-cli', conversationId: 'oc_chat_9' }, 'reply text');
    expect(result.ok).toBe(true);
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]).toMatchObject({
      chatId: 'oc_chat_9',
      text: 'reply text',
      identity: 'bot',
      markdown: false,
    });
  });

  it('flags markdown-looking content for post rendering', async () => {
    const { adapter, client } = makeAdapter();
    await adapter.send({ channel: 'feishu-cli', conversationId: 'oc_chat_9' }, '## Title\n- item');
    expect(client.sent[0]).toMatchObject({ markdown: true, identity: 'user' });
  });

  it('no-ops on empty content', async () => {
    const { adapter, client } = makeAdapter();
    const result = await adapter.send({ channel: 'feishu-cli', conversationId: 'oc_chat_9' }, '   ');
    expect(result.ok).toBe(true);
    expect(client.sent).toHaveLength(0);
  });
});
