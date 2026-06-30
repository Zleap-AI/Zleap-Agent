import { ConnectionsService, type ConnectionCommandType } from '@zleap/agent/conversation';
import { createSharedStore } from '@zleap/agent/conversation';
import {
  buildConnectionView,
  connectionErrorView,
  phaseLabel,
  probeGatewayRecent,
  runChannelConnectLoop,
  type ConnectionView,
} from './connectFlow.js';

export const KNOWN_CHANNELS = ['feishu', 'wechat', 'feishu-cli'] as const;
export type KnownChannel = (typeof KNOWN_CHANNELS)[number];

export async function runChannelsCommand(argv: string[]): Promise<void> {
  const [sub, channelArg, ...rest] = argv;
  if (!sub || sub === 'help' || sub === '--help') {
    printChannelsHelp();
    return;
  }

  const store = await createSharedStore({ onWarn: (message) => process.stderr.write(`[warn] ${message}\n`) });
  if (!store) {
    process.stderr.write('未配置数据库（请设置 ZLEAP_DATABASE_URL）。CLI 与 gateway 须共用同一数据库。\n');
    process.exitCode = 1;
    return;
  }

  const service = new ConnectionsService(store.integrations);
  try {
    if (sub === 'list') {
      await runChannelsList(service);
      return;
    }
    if (sub === 'status') {
      await runChannelsStatus(service, channelArg);
      return;
    }

    const action = resolveAction(sub, rest);
    if (!action) {
      process.stderr.write(`未知子命令：channels ${sub}\n`);
      printChannelsHelp();
      process.exitCode = 1;
      return;
    }

    const channel = channelArg;
    if (!channel || !isKnownChannel(channel)) {
      process.stderr.write(`用法：zleap channels ${sub} <${KNOWN_CHANNELS.join('|')}>\n`);
      process.exitCode = 1;
      return;
    }

    await probeGatewayOrWarn(service);
    process.stdout.write(`已请求 ${action}：${channel}\n`);
    const exitCode = await runChannelConnectLoop(service, channel, action, (view) => renderViewToStdout(view));
    if (exitCode) {
      process.exitCode = exitCode;
    }
  } finally {
    await store.close().catch(() => undefined);
  }
}

/** Legacy entry: `zleap connect <channel> [--refresh|--logout]`. */
export async function runConnectLegacy(argv: string[]): Promise<void> {
  const channel = argv.find((arg) => !arg.startsWith('--'));
  const flags: string[] = [];
  if (argv.includes('--logout')) flags.push('logout');
  else if (argv.includes('--refresh')) flags.push('refresh');
  else flags.push('connect');
  await runChannelsCommand([flags[0]!, channel ?? ''].filter(Boolean));
}

export function isKnownChannel(value: string): value is KnownChannel {
  return (KNOWN_CHANNELS as readonly string[]).includes(value);
}

/** One-line-per-channel summary for `/status` and doctor-style displays. */
export function formatChannelsStatusFromService(service: ConnectionsService): Promise<string> {
  return (async () => {
    const lines = ['IM 频道：'];
    for (const channel of KNOWN_CHANNELS) {
      const state = await service.getState(channel);
      const account = state.account ? ` · ${state.account}` : '';
      lines.push(`  ${channel.padEnd(12)} ${phaseLabel(state.phase)}${account}`);
    }
    return lines.join('\n');
  })();
}

export async function formatChannelsStatusSummary(): Promise<string | null> {
  const store = await createSharedStore({ onWarn: () => undefined });
  if (!store) {
    return null;
  }
  const service = new ConnectionsService(store.integrations);
  try {
    return await formatChannelsStatusFromService(service);
  } finally {
    await store.close().catch(() => undefined);
  }
}

export type ChannelsConnectionSummary = {
  connected: number;
  total: number;
};

/** Compact IM counts for the TUI status bar. */
export async function summarizeChannelsConnection(): Promise<ChannelsConnectionSummary | null> {
  const store = await createSharedStore({ onWarn: () => undefined });
  if (!store) {
    return null;
  }
  const service = new ConnectionsService(store.integrations);
  try {
    let connected = 0;
    for (const channel of KNOWN_CHANNELS) {
      const state = await service.getState(channel);
      if (state.phase === 'connected') {
        connected += 1;
      }
    }
    return { connected, total: KNOWN_CHANNELS.length };
  } finally {
    await store.close().catch(() => undefined);
  }
}

export function channelsBadge(summary: ChannelsConnectionSummary | null): string {
  if (!summary) {
    return 'IM—';
  }
  if (summary.connected === 0) {
    return `IM0/${summary.total}`;
  }
  return `IM${summary.connected}/${summary.total}✓`;
}

export type ChannelAmbient = {
  connected: number;
  total: number;
  label: string;
};

/** Compact IM hint for status bar (e.g. `IM 2/3`). */
export async function summarizeConnectedChannels(): Promise<ChannelAmbient | null> {
  const store = await createSharedStore({ onWarn: () => undefined });
  if (!store) {
    return null;
  }
  const service = new ConnectionsService(store.integrations);
  try {
    let connected = 0;
    for (const channel of KNOWN_CHANNELS) {
      const state = await service.getState(channel);
      if (state.phase === 'connected') {
        connected += 1;
      }
    }
    const total = KNOWN_CHANNELS.length;
    const label = connected > 0 ? `IM ${connected}/${total}` : 'IM—';
    return { connected, total, label };
  } finally {
    await store.close().catch(() => undefined);
  }
}

/** Start IM connect flow from TUI (/connect). Returns null when DB is unavailable. */
export async function startTuiChannelConnect(
  channel: KnownChannel,
  options: {
    signal: AbortSignal;
    onView: (view: ConnectionView) => void;
  },
): Promise<'connected' | 'error' | 'timeout' | 'aborted' | 'no_db' | 'bad_channel'> {
  if (!isKnownChannel(channel)) {
    return 'bad_channel';
  }
  const store = await createSharedStore({ onWarn: () => undefined }).catch((error) => {
    options.onView(connectionErrorView(channel, '无法打开共享数据库', error));
    return null;
  });
  if (!store) {
    return 'no_db';
  }
  const service = new ConnectionsService(store.integrations);
  try {
    const gatewayOk = await probeGatewayRecent(service, KNOWN_CHANNELS).catch(() => false);
    if (!gatewayOk) {
      options.onView({
        channel,
        phase: 'connecting',
        title: `[${channel}] 连接中`,
        lines: ['未检测到 gateway 心跳，请先运行：zleap serve --gateway'],
      });
    }
    const command = await service.requestCommand(channel, 'connect');
    const { pollChannelConnection } = await import('./connectFlow.js');
    return await pollChannelConnection(service, channel, {
      signal: options.signal,
      onState: options.onView,
      freshAfter: command.at,
    });
  } catch (error) {
    options.onView(connectionErrorView(channel, '无法发起 IM 连接', error));
    return 'error';
  } finally {
    await store.close().catch(() => undefined);
  }
}

function resolveAction(sub: string, rest: string[]): ConnectionCommandType | null {
  if (sub === 'connect' || sub === 'refresh' || sub === 'logout') {
    return sub;
  }
  if (rest.includes('--logout')) return 'logout';
  if (rest.includes('--refresh')) return 'refresh';
  return null;
}

async function runChannelsList(service: ConnectionsService): Promise<void> {
  process.stdout.write('频道           阶段           账号\n');
  for (const channel of KNOWN_CHANNELS) {
    const state = await service.getState(channel);
    const account = state.account ?? '—';
    process.stdout.write(`${channel.padEnd(14)} ${state.phase.padEnd(14)} ${account}\n`);
  }
}

async function runChannelsStatus(service: ConnectionsService, channel?: string): Promise<void> {
  const targets = channel ? [channel] : [...KNOWN_CHANNELS];
  for (const name of targets) {
    if (!isKnownChannel(name)) {
      process.stderr.write(`未知频道：${name}\n`);
      process.exitCode = 1;
      continue;
    }
    const view = await buildConnectionView(await service.getState(name));
    renderViewToStdout(view);
  }
}

async function probeGatewayOrWarn(service: ConnectionsService): Promise<void> {
  const ok = await probeGatewayRecent(service, KNOWN_CHANNELS);
  if (!ok) {
    process.stderr.write(
      '[warn] 30s 内未检测到 gateway 状态更新。请先运行：zleap serve --gateway\n',
    );
  }
}

function renderViewToStdout(view: ConnectionView): void {
  process.stdout.write(`\n${view.title}\n`);
  for (const line of view.lines) {
    process.stdout.write(`  ${line}\n`);
  }
  if (view.qrAscii) {
    process.stdout.write(`\n${view.qrAscii}\n`);
  }
}

function printChannelsHelp(): void {
  process.stdout.write(`用法：zleap channels <子命令>

子命令：
  list                         列出所有 IM 频道连接状态
  status [channel]             查看单个或全部频道状态
  connect <channel>            发起连接（轮询 QR/授权链接）
  refresh <channel>            刷新 QR / 授权链接
  logout <channel>             退出登录

频道：${KNOWN_CHANNELS.join(' | ')}
`);
}
