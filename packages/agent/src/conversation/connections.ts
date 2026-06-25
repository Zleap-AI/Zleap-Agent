import { randomUUID } from 'node:crypto';

/**
 * Standard channel-connection contract shared by every entry point (web now, CLI
 * later) and the gateway control plane. The goal is that web/CLI never speak a
 * channel's native login protocol: they only read a uniform {@link
 * ChannelConnectionState} and issue uniform {@link ConnectionCommand}s
 * (connect/refresh/logout). Each gateway adapter maps its native handshake
 * (WeChat QR scan, Feishu CLI OAuth device flow, Feishu node-sdk WS) onto this
 * shape and publishes it back.
 *
 * Transport is the shared `gateway_integrations` table (no extra inbound port):
 * - state row   `connections:<channel>`          — adapter writes, entries read
 * - command row `connections:<channel>:command`  — entries write, gateway reads
 *
 * Splitting state and command into two rows avoids read-modify-write clobbering
 * between the publisher (adapter) and the requester (web/CLI).
 */

/** Lifecycle phase, channel-agnostic. */
export type ChannelPhase = 'disabled' | 'connecting' | 'awaiting_user' | 'connected' | 'error';

/**
 * What the user must look at to finish an interactive login. `qr` carries a
 * displayable image (data URL / content / login url); `url` carries a
 * verification URL plus an optional device/user code (OAuth device flow); `none`
 * means the channel connects without any interactive step (e.g. app-credential
 * bots).
 */
export type ConnectionPrompt =
  | { kind: 'qr'; image: string; caption?: string }
  | { kind: 'url'; url: string; userCode?: string }
  | { kind: 'none' };

/** Uniform connection snapshot rendered by every entry point. */
export type ChannelConnectionState = {
  channel: string;
  enabled: boolean;
  phase: ChannelPhase;
  /** Present while `phase === 'awaiting_user'`. */
  prompt?: ConnectionPrompt;
  /** Authorized account label, for display once connected. */
  account?: string;
  /** Human-readable error when `phase === 'error'`. */
  error?: string;
  /** ISO timestamp of the last publish. */
  updatedAt: string;
};

export type ConnectionCommandType = 'connect' | 'refresh' | 'logout';

/** A control command issued by an entry point; the gateway dispatches by nonce. */
export type ConnectionCommand = {
  type: ConnectionCommandType;
  /** Unique per issue; the gateway dispatches a command at most once per nonce. */
  nonce: string;
  /** ISO timestamp of the request. */
  at: string;
};

/** Structural slice of the store's integration table this service needs. */
export type ConnectionIntegrationStore = {
  getIntegration(channel: string): Promise<{ config: Record<string, unknown> } | undefined>;
  saveIntegration(record: { channel: string; config: Record<string, unknown>; updatedAt: Date }): Promise<void>;
  deleteIntegration(channel: string): Promise<void>;
};

const STATE_PREFIX = 'connections:';

export function connectionStateChannel(channel: string): string {
  return `${STATE_PREFIX}${channel}`;
}

export function connectionCommandChannel(channel: string): string {
  return `${STATE_PREFIX}${channel}:command`;
}

function disconnectedState(channel: string): ChannelConnectionState {
  return { channel, enabled: false, phase: 'disabled', updatedAt: new Date(0).toISOString() };
}

function isPhase(value: unknown): value is ChannelPhase {
  return (
    value === 'disabled' ||
    value === 'connecting' ||
    value === 'awaiting_user' ||
    value === 'connected' ||
    value === 'error'
  );
}

function parsePrompt(value: unknown): ConnectionPrompt | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const prompt = value as Record<string, unknown>;
  if (prompt.kind === 'qr' && typeof prompt.image === 'string') {
    return { kind: 'qr', image: prompt.image, ...(typeof prompt.caption === 'string' ? { caption: prompt.caption } : {}) };
  }
  if (prompt.kind === 'url' && typeof prompt.url === 'string') {
    return {
      kind: 'url',
      url: prompt.url,
      ...(typeof prompt.userCode === 'string' ? { userCode: prompt.userCode } : {}),
    };
  }
  if (prompt.kind === 'none') {
    return { kind: 'none' };
  }
  return undefined;
}

function parseState(channel: string, config: Record<string, unknown>): ChannelConnectionState {
  const prompt = parsePrompt(config.prompt);
  return {
    channel,
    enabled: config.enabled === true,
    phase: isPhase(config.phase) ? config.phase : 'disabled',
    ...(prompt ? { prompt } : {}),
    ...(typeof config.account === 'string' && config.account.trim() ? { account: config.account.trim() } : {}),
    ...(typeof config.error === 'string' && config.error.trim() ? { error: config.error.trim() } : {}),
    updatedAt: typeof config.updatedAt === 'string' ? config.updatedAt : new Date(0).toISOString(),
  };
}

function parseCommand(config: Record<string, unknown>): ConnectionCommand | undefined {
  const type = config.type;
  const nonce = config.nonce;
  if ((type !== 'connect' && type !== 'refresh' && type !== 'logout') || typeof nonce !== 'string' || !nonce) {
    return undefined;
  }
  return { type, nonce, at: typeof config.at === 'string' ? config.at : new Date().toISOString() };
}

/**
 * Reads/writes the uniform connection state and control commands over the shared
 * integration store. Entry points (web/CLI) use the request/getState methods; the
 * gateway control plane uses publishState/readCommand/clearCommand.
 */
export class ConnectionsService {
  constructor(private readonly store: ConnectionIntegrationStore) {}

  /** Current uniform state for a channel (defaults to disabled). */
  async getState(channel: string): Promise<ChannelConnectionState> {
    const record = await this.store.getIntegration(connectionStateChannel(channel));
    return record ? parseState(channel, record.config) : disconnectedState(channel);
  }

  /** Publish the uniform state (gateway adapter side). */
  async publishState(state: ChannelConnectionState): Promise<void> {
    const config: Record<string, unknown> = {
      enabled: state.enabled,
      phase: state.phase,
      updatedAt: state.updatedAt,
      ...(state.prompt ? { prompt: state.prompt } : {}),
      ...(state.account ? { account: state.account } : {}),
      ...(state.error ? { error: state.error } : {}),
    };
    await this.store.saveIntegration({
      channel: connectionStateChannel(state.channel),
      config,
      updatedAt: new Date(),
    });
  }

  /** Issue a connect/refresh/logout command (entry-point side). */
  async requestCommand(channel: string, type: ConnectionCommandType): Promise<ConnectionCommand> {
    const command: ConnectionCommand = { type, nonce: randomUUID(), at: new Date().toISOString() };
    await this.store.saveIntegration({
      channel: connectionCommandChannel(channel),
      config: { ...command },
      updatedAt: new Date(),
    });
    return command;
  }

  requestConnect(channel: string): Promise<ConnectionCommand> {
    return this.requestCommand(channel, 'connect');
  }

  requestRefresh(channel: string): Promise<ConnectionCommand> {
    return this.requestCommand(channel, 'refresh');
  }

  requestLogout(channel: string): Promise<ConnectionCommand> {
    return this.requestCommand(channel, 'logout');
  }

  /** Read a pending command (gateway side); undefined when none. */
  async readCommand(channel: string): Promise<ConnectionCommand | undefined> {
    const record = await this.store.getIntegration(connectionCommandChannel(channel));
    return record ? parseCommand(record.config) : undefined;
  }

  /** Clear a dispatched command so it is not re-applied (gateway side). */
  async clearCommand(channel: string): Promise<void> {
    await this.store.deleteIntegration(connectionCommandChannel(channel));
  }
}

/** Phase/prompt patch an adapter publishes; channel/enabled/updatedAt are filled in. */
export type ChannelStatePatch = {
  phase: ChannelPhase;
  prompt?: ConnectionPrompt;
  account?: string;
  error?: string;
};

/** A channel-bound publisher handed to an adapter so it never repeats boilerplate. */
export type ChannelStatePublisher = (patch: ChannelStatePatch) => Promise<void>;

/** Bind a {@link ConnectionsService} to one channel for adapter state publishing. */
export function makeChannelPublisher(service: ConnectionsService, channel: string): ChannelStatePublisher {
  return (patch) =>
    service.publishState({
      channel,
      enabled: true,
      phase: patch.phase,
      ...(patch.prompt ? { prompt: patch.prompt } : {}),
      ...(patch.account ? { account: patch.account } : {}),
      ...(patch.error ? { error: patch.error } : {}),
      updatedAt: new Date().toISOString(),
    });
}
