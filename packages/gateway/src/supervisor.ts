import {
  ConnectionsService,
  makeChannelPublisher,
  type ChannelStatePublisher,
} from '@zleap/agent/conversation';
import type { GatewayPermissionMode } from './config.js';
import type { GatewayRunner } from './runner.js';
import type { GatewayLogger, PlatformAdapter } from './types.js';

/**
 * Declarative description of one known channel for the control plane. `resolve`
 * reads the desired config data-first (DB → env); `hash` detects config changes
 * that warrant a restart; `permissionMode` and `build` produce the runtime.
 */
export type ChannelDescriptor<C = unknown> = {
  channel: string;
  /** Desired config, or undefined when the channel is disabled. */
  resolve(): Promise<C | undefined>;
  /** Stable fingerprint of the config; a change triggers a restart. */
  hash(config: C): string;
  /** Tool-approval policy for runs from this channel. */
  permissionMode(config: C): GatewayPermissionMode;
  /** Build a fresh adapter (state publisher injected so it reports uniformly). */
  build(config: C, publishState: ChannelStatePublisher): PlatformAdapter;
};

export type ChannelSupervisorDeps = {
  runner: GatewayRunner;
  connections: ConnectionsService;
  descriptors: ChannelDescriptor[];
  logger?: GatewayLogger;
  /** Reconcile cadence (ms). Lower = snappier enable/refresh, more DB reads. */
  intervalMs?: number;
};

type RunningChannel = { adapter: PlatformAdapter; hash: string };

const DEFAULT_INTERVAL_MS = 2_500;

/**
 * Control plane for gateway channels. On an interval it reconciles each known
 * channel's running adapter against the desired state in the DB:
 * - enabled & not running        -> attach (adapter auto-connects/auto-logins)
 * - disabled & running           -> detach + publish disabled
 * - config changed (hash)        -> restart
 * - pending connect/refresh/logout command -> dispatch to the adapter
 *
 * This is what lets the web (and later the CLI) enable a channel and have a QR /
 * device URL appear, or hit "refresh", without restarting the gateway process.
 */
export class ChannelSupervisor {
  private readonly runner: GatewayRunner;
  private readonly connections: ConnectionsService;
  private readonly descriptors: ChannelDescriptor[];
  private readonly logger?: GatewayLogger;
  private readonly intervalMs: number;

  private readonly running = new Map<string, RunningChannel>();
  /** Last dispatched command nonce per channel (dispatch each command once). */
  private readonly lastNonce = new Map<string, string>();
  private timer: NodeJS.Timeout | undefined;
  private reconciling = false;
  private stopped = false;

  constructor(deps: ChannelSupervisorDeps) {
    this.runner = deps.runner;
    this.connections = deps.connections;
    this.descriptors = deps.descriptors;
    this.logger = deps.logger;
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.reconcile();
    this.timer = setInterval(() => {
      void this.reconcile();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    for (const [, current] of this.running) {
      await this.runner.detach(current.adapter).catch(() => undefined);
    }
    this.running.clear();
  }

  /** Run one reconcile pass over every known channel. Non-overlapping. */
  async reconcile(): Promise<void> {
    if (this.reconciling || this.stopped) {
      return;
    }
    this.reconciling = true;
    try {
      for (const descriptor of this.descriptors) {
        await this.reconcileChannel(descriptor).catch((error) => {
          this.logger?.warn('channel reconcile failed', { channel: descriptor.channel, error: errorMessage(error) });
        });
      }
    } finally {
      this.reconciling = false;
    }
  }

  private async reconcileChannel(descriptor: ChannelDescriptor): Promise<void> {
    const desired = await descriptor.resolve().catch(() => undefined);
    const current = this.running.get(descriptor.channel);

    if (!desired) {
      if (current) {
        await this.runner.detach(current.adapter);
        this.running.delete(descriptor.channel);
        await this.connections.publishState({
          channel: descriptor.channel,
          enabled: false,
          phase: 'disabled',
          updatedAt: new Date().toISOString(),
        });
      }
      return;
    }

    const hash = descriptor.hash(desired);
    if (!current) {
      await this.attach(descriptor, desired, hash);
    } else if (current.hash !== hash) {
      this.logger?.info('channel config changed, restarting', { channel: descriptor.channel });
      await this.runner.detach(current.adapter);
      this.running.delete(descriptor.channel);
      await this.attach(descriptor, desired, hash);
    } else {
      // Keep permission in sync even when nothing else changed.
      this.runner.setPermission(descriptor.channel, descriptor.permissionMode(desired));
    }

    await this.dispatchCommand(descriptor.channel);
  }

  private async attach(descriptor: ChannelDescriptor, config: unknown, hash: string): Promise<void> {
    const publisher = makeChannelPublisher(this.connections, descriptor.channel);
    const adapter = descriptor.build(config, publisher);
    this.runner.setPermission(descriptor.channel, descriptor.permissionMode(config));
    await this.runner.attach(adapter);
    this.running.set(descriptor.channel, { adapter, hash });
  }

  private async dispatchCommand(channel: string): Promise<void> {
    const command = await this.connections.readCommand(channel);
    if (!command || this.lastNonce.get(channel) === command.nonce) {
      return;
    }
    this.lastNonce.set(channel, command.nonce);
    const adapter = this.running.get(channel)?.adapter;
    if (adapter) {
      this.logger?.info('dispatching channel command', { channel, command: command.type });
      if (command.type === 'logout') {
        await (adapter.logout?.() ?? adapter.reauth?.() ?? Promise.resolve());
      } else if (command.type === 'refresh') {
        await (adapter.reauth?.() ?? Promise.resolve());
      }
    }
    await this.connections.clearCommand(channel);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
