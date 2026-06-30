import { describe, expect, it } from 'vitest';
import { describeConnectionState, pollChannelConnection, type ConnectionView } from '../src/cli/connectFlow.js';
import { ConnectionsService } from '@zleap/agent/conversation';
import type { ChannelConnectionState } from '@zleap/agent/conversation';

describe('describeConnectionState', () => {
  it('formats url prompt for feishu-cli', () => {
    const state: ChannelConnectionState = {
      channel: 'feishu-cli',
      enabled: true,
      phase: 'awaiting_user',
      prompt: { kind: 'url', url: 'https://example.com/auth', userCode: 'ABCD-1234' },
      updatedAt: new Date().toISOString(),
    };
    const view = describeConnectionState(state);
    expect(view.title).toContain('等待扫码/授权');
    expect(view.lines.some((line) => line.includes('ABCD-1234'))).toBe(true);
  });

  it('shows connecting hint', () => {
    const state: ChannelConnectionState = {
      channel: 'wechat',
      enabled: true,
      phase: 'connecting',
      updatedAt: new Date().toISOString(),
    };
    const view = describeConnectionState(state);
    expect(view.lines.some((line) => line.includes('gateway'))).toBe(true);
  });

  it('turns store read failures into an error view instead of throwing', async () => {
    const service = new ConnectionsService({
      async getIntegration() {
        throw new Error('timeout exceeded when trying to connect');
      },
      async saveIntegration() {},
      async deleteIntegration() {},
    });
    const views: ConnectionView[] = [];

    const result = await pollChannelConnection(service, 'feishu-cli', {
      signal: new AbortController().signal,
      onState: (view) => views.push(view),
    });

    expect(result).toBe('error');
    expect(views[0]?.phase).toBe('error');
    expect(views[0]?.lines.join('\n')).toContain('timeout exceeded when trying to connect');
  });

  it('waits for a fresh state after a reconnect command instead of accepting stale connected', async () => {
    const commandAt = new Date('2026-06-22T07:00:00.000Z').toISOString();
    let reads = 0;
    const service = new ConnectionsService({
      async getIntegration() {
        reads += 1;
        return {
          config: {
            enabled: true,
            phase: 'connected',
            updatedAt:
              reads === 1
                ? new Date('2026-06-22T06:59:59.000Z').toISOString()
                : new Date('2026-06-22T07:00:01.000Z').toISOString(),
          },
        };
      },
      async saveIntegration() {},
      async deleteIntegration() {},
    });
    const views: ConnectionView[] = [];

    const result = await pollChannelConnection(service, 'feishu-cli', {
      signal: new AbortController().signal,
      onState: (view) => views.push(view),
      freshAfter: commandAt,
      pollMs: 1,
    });

    expect(result).toBe('connected');
    expect(views[0]?.title).toContain('重新连接中');
    expect(views.at(-1)?.phase).toBe('connected');
    expect(reads).toBe(2);
  });
});
