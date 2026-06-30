import { describe, expect, it } from 'vitest';
import {
  ConnectionsService,
  connectionCommandChannel,
  connectionStateChannel,
  makeChannelPublisher,
} from '@zleap/agent/conversation';

/** Minimal in-memory integration store matching the structural contract. */
class MemStore {
  readonly rows = new Map<string, Record<string, unknown>>();
  async getIntegration(channel: string): Promise<{ config: Record<string, unknown> } | undefined> {
    const config = this.rows.get(channel);
    return config ? { config } : undefined;
  }
  async saveIntegration(record: { channel: string; config: Record<string, unknown> }): Promise<void> {
    this.rows.set(record.channel, record.config);
  }
  async deleteIntegration(channel: string): Promise<void> {
    this.rows.delete(channel);
  }
}

describe('ConnectionsService', () => {
  it('defaults to a disabled state when nothing is published', async () => {
    const service = new ConnectionsService(new MemStore());
    const state = await service.getState('wechat');
    expect(state).toMatchObject({ channel: 'wechat', enabled: false, phase: 'disabled' });
  });

  it('round-trips a published state (state row separate from command row)', async () => {
    const store = new MemStore();
    const service = new ConnectionsService(store);
    await service.publishState({
      channel: 'wechat',
      enabled: true,
      phase: 'awaiting_user',
      prompt: { kind: 'qr', image: 'data:image/png;base64,AAAA' },
      updatedAt: new Date().toISOString(),
    });
    const state = await service.getState('wechat');
    expect(state.phase).toBe('awaiting_user');
    expect(state.prompt).toEqual({ kind: 'qr', image: 'data:image/png;base64,AAAA' });
    expect(store.rows.has(connectionStateChannel('wechat'))).toBe(true);
    expect(store.rows.has(connectionCommandChannel('wechat'))).toBe(false);
  });

  it('issues a command with a fresh nonce and clears it', async () => {
    const store = new MemStore();
    const service = new ConnectionsService(store);
    const a = await service.requestConnect('feishu-cli');
    const b = await service.requestRefresh('feishu-cli');
    expect(a.type).toBe('connect');
    expect(b.type).toBe('refresh');
    expect(a.nonce).not.toBe(b.nonce);

    const pending = await service.readCommand('feishu-cli');
    expect(pending?.nonce).toBe(b.nonce);
    await service.clearCommand('feishu-cli');
    expect(await service.readCommand('feishu-cli')).toBeUndefined();
  });

  it('makeChannelPublisher fills channel/enabled/updatedAt', async () => {
    const store = new MemStore();
    const service = new ConnectionsService(store);
    const publish = makeChannelPublisher(service, 'feishu');
    await publish({ phase: 'connected', account: 'alice' });
    const state = await service.getState('feishu');
    expect(state).toMatchObject({ channel: 'feishu', enabled: true, phase: 'connected', account: 'alice' });
    expect(typeof state.updatedAt).toBe('string');
  });
});
