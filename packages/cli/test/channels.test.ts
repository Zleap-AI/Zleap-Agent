import { describe, expect, it } from 'vitest';
import { ConnectionsService } from '@zleap/agent/conversation';
import { formatChannelsStatusFromService, isKnownChannel } from '../src/cli/channels.js';

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

describe('channels helpers', () => {
  it('validates known channel names', () => {
    expect(isKnownChannel('wechat')).toBe(true);
    expect(isKnownChannel('telegram')).toBe(false);
  });

  it('formats channel status lines from a service', async () => {
    const service = new ConnectionsService(new MemStore());
    await service.publishState({
      channel: 'wechat',
      enabled: true,
      phase: 'connected',
      account: 'alice',
      updatedAt: new Date().toISOString(),
    });
    const summary = await formatChannelsStatusFromService(service);
    expect(summary).toContain('IM 频道：');
    expect(summary).toContain('wechat');
    expect(summary).toContain('已连接');
    expect(summary).toContain('alice');
  });
});
