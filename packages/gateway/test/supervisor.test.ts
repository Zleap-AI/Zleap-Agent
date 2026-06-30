import { ConnectionsService } from '@zleap/agent/conversation';
import { describe, expect, it } from 'vitest';
import { ChannelSupervisor, type ChannelDescriptor } from '../src/supervisor.js';
import type { GatewayRunner } from '../src/runner.js';
import type { PlatformAdapter } from '../src/types.js';

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

/** A fake adapter recording lifecycle/command calls. */
class FakeAdapter implements PlatformAdapter {
  reauthCalls = 0;
  logoutCalls = 0;
  connected = false;
  constructor(readonly channel: string) {}
  setMessageHandler(): void {}
  async connect(): Promise<void> {
    this.connected = true;
  }
  async disconnect(): Promise<void> {
    this.connected = false;
  }
  async send(): Promise<{ ok: true }> {
    return { ok: true };
  }
  async reauth(): Promise<void> {
    this.reauthCalls += 1;
  }
  async logout(): Promise<void> {
    this.logoutCalls += 1;
  }
}

/** A runner stub tracking attach/detach/permission. */
class StubRunner {
  readonly attached: PlatformAdapter[] = [];
  readonly detached: PlatformAdapter[] = [];
  readonly permissions = new Map<string, string>();
  async attach(adapter: PlatformAdapter): Promise<void> {
    this.attached.push(adapter);
    await adapter.connect();
  }
  async detach(adapter: PlatformAdapter): Promise<void> {
    this.detached.push(adapter);
    await adapter.disconnect();
  }
  setPermission(channel: string, mode: string): void {
    this.permissions.set(channel, mode);
  }
}

type TestConfig = { enabled: true; permissionMode: 'request_approval' | 'full_access'; rev: number };

function makeDescriptor(state: { config: TestConfig | undefined; built: FakeAdapter[] }): ChannelDescriptor<TestConfig> {
  return {
    channel: 'wechat',
    resolve: async () => state.config,
    hash: (config) => JSON.stringify(config),
    permissionMode: (config) => config.permissionMode,
    build: (config) => {
      const adapter = new FakeAdapter('wechat');
      state.built.push(adapter);
      void config;
      return adapter;
    },
  };
}

function makeSupervisor(runner: StubRunner, connections: ConnectionsService, descriptor: ChannelDescriptor<TestConfig>) {
  return new ChannelSupervisor({
    runner: runner as unknown as GatewayRunner,
    connections,
    descriptors: [descriptor as unknown as ChannelDescriptor],
    intervalMs: 1_000_000,
  });
}

describe('ChannelSupervisor reconcile', () => {
  it('attaches when enabled and is idempotent on no change', async () => {
    const runner = new StubRunner();
    const connections = new ConnectionsService(new MemStore());
    const state = { config: { enabled: true, permissionMode: 'request_approval', rev: 1 } as TestConfig, built: [] as FakeAdapter[] };
    const sup = makeSupervisor(runner, connections, makeDescriptor(state));

    await sup.reconcile();
    expect(runner.attached).toHaveLength(1);
    expect(runner.attached[0]?.connected).toBe(true);
    expect(runner.permissions.get('wechat')).toBe('request_approval');

    await sup.reconcile();
    expect(runner.attached).toHaveLength(1); // no re-attach
  });

  it('detaches and publishes disabled when desired becomes undefined', async () => {
    const runner = new StubRunner();
    const connections = new ConnectionsService(new MemStore());
    const state = { config: { enabled: true, permissionMode: 'request_approval', rev: 1 } as TestConfig, built: [] as FakeAdapter[] };
    const sup = makeSupervisor(runner, connections, makeDescriptor(state));

    await sup.reconcile();
    state.config = undefined;
    await sup.reconcile();

    expect(runner.detached).toHaveLength(1);
    expect((await connections.getState('wechat')).phase).toBe('disabled');
  });

  it('restarts the adapter when the config hash changes', async () => {
    const runner = new StubRunner();
    const connections = new ConnectionsService(new MemStore());
    const state = { config: { enabled: true, permissionMode: 'request_approval', rev: 1 } as TestConfig, built: [] as FakeAdapter[] };
    const sup = makeSupervisor(runner, connections, makeDescriptor(state));

    await sup.reconcile();
    state.config = { enabled: true, permissionMode: 'full_access', rev: 2 };
    await sup.reconcile();

    expect(runner.detached).toHaveLength(1);
    expect(runner.attached).toHaveLength(2);
    expect(runner.permissions.get('wechat')).toBe('full_access');
  });

  it('treats connect as idempotent and dispatches refresh once per nonce, then logout', async () => {
    const runner = new StubRunner();
    const connections = new ConnectionsService(new MemStore());
    const state = { config: { enabled: true, permissionMode: 'request_approval', rev: 1 } as TestConfig, built: [] as FakeAdapter[] };
    const sup = makeSupervisor(runner, connections, makeDescriptor(state));

    await sup.reconcile();
    const adapter = state.built[0]!;

    await connections.requestConnect('wechat');
    await sup.reconcile();
    expect(adapter.reauthCalls).toBe(0);
    expect(await connections.readCommand('wechat')).toBeUndefined();

    await connections.requestRefresh('wechat');
    await sup.reconcile();
    await sup.reconcile(); // same nonce, no re-dispatch
    expect(adapter.reauthCalls).toBe(1);
    expect(await connections.readCommand('wechat')).toBeUndefined();

    await connections.requestLogout('wechat');
    await sup.reconcile();
    expect(adapter.logoutCalls).toBe(1);
  });
});
