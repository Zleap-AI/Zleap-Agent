import { beforeEach, describe, expect, it, vi } from 'vitest';

const storeMock = vi.hoisted(() => {
  const state = {
    closed: false,
    rows: new Map<string, Record<string, unknown>>(),
    events: [] as string[],
  };

  return {
    state,
    reset() {
      state.closed = false;
      state.rows.clear();
      state.events.length = 0;
      const now = new Date().toISOString();
      for (const channel of ['feishu', 'wechat', 'feishu-cli']) {
        state.rows.set(`connections:${channel}`, {
          enabled: true,
          phase: 'connected',
          updatedAt: now,
        });
      }
    },
    makeStore() {
      return {
        integrations: {
          async getIntegration(channel: string) {
            state.events.push(`get:${channel}:${state.closed ? 'closed' : 'open'}`);
            if (state.closed) {
              throw new Error('store closed before poll completed');
            }
            const config = state.rows.get(channel);
            return config ? { config } : undefined;
          },
          async saveIntegration(record: { channel: string; config: Record<string, unknown> }) {
            state.events.push(`save:${record.channel}:${state.closed ? 'closed' : 'open'}`);
            if (state.closed) {
              throw new Error('store closed before save');
            }
            state.rows.set(record.channel, record.config);
            if (record.channel === 'connections:feishu-cli:command') {
              const at = typeof record.config.at === 'string' ? Date.parse(record.config.at) : Date.now();
              state.rows.set('connections:feishu-cli', {
                enabled: true,
                phase: 'connected',
                updatedAt: new Date(at + 1).toISOString(),
              });
            }
          },
          async deleteIntegration(channel: string) {
            state.events.push(`delete:${channel}:${state.closed ? 'closed' : 'open'}`);
            if (state.closed) {
              throw new Error('store closed before delete');
            }
            state.rows.delete(channel);
          },
        },
        async close() {
          state.events.push('close');
          state.closed = true;
        },
      };
    },
  };
});

vi.mock('@zleap/agent/conversation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@zleap/agent/conversation')>()),
  createSharedStore: vi.fn(async () => storeMock.makeStore()),
}));

describe('startTuiChannelConnect', () => {
  beforeEach(() => {
    storeMock.reset();
  });

  it('keeps the shared store open until polling observes the connected state', async () => {
    const { startTuiChannelConnect } = await import('../src/cli/channels.js');
    const views: Array<{ phase: string }> = [];

    const result = await startTuiChannelConnect('feishu-cli', {
      signal: new AbortController().signal,
      onView: (view) => views.push(view),
    });

    const lastPollRead = storeMock.state.events.lastIndexOf('get:connections:feishu-cli:open');
    const close = storeMock.state.events.lastIndexOf('close');
    expect(result).toBe('connected');
    expect(views.at(-1)?.phase).toBe('connected');
    expect(close).toBeGreaterThan(lastPollRead);
    expect(storeMock.state.events).not.toContain('get:connections:feishu-cli:closed');
  });
});
