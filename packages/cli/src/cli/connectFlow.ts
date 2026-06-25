import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import QRCode from 'qrcode';
import {
  ConnectionsService,
  type ChannelConnectionState,
  type ConnectionCommandType,
} from '@zleap/agent/conversation';

export const CONNECT_POLL_MS = 2_000;
export const CONNECT_TIMEOUT_MS = 5 * 60_000;
export const GATEWAY_PROBE_MS = 30_000;

export type ConnectionPollResult = 'connected' | 'error' | 'timeout' | 'aborted';

export type ConnectionView = {
  channel: string;
  phase: ChannelConnectionState['phase'];
  title: string;
  lines: string[];
  qrAscii?: string;
};

export async function qrImageToTerminal(image: string): Promise<string | undefined> {
  if (image.startsWith('http://') || image.startsWith('https://')) {
    try {
      return await QRCode.toString(image, { type: 'terminal', small: true });
    } catch {
      return undefined;
    }
  }
  const base64 = image.startsWith('data:') ? image.slice(image.indexOf(',') + 1) : image;
  try {
    const buf = Buffer.from(base64, 'base64');
    const file = join(tmpdir(), `zleap-qr-${Date.now()}.png`);
    writeFileSync(file, buf);
    try {
      return await QRCode.toString(file, { type: 'terminal', small: true });
    } catch {
      return undefined;
    }
  } catch {
    return undefined;
  }
}

export function describeConnectionState(state: ChannelConnectionState): Pick<ConnectionView, 'title' | 'lines'> {
  const title = `[${state.channel}] ${phaseLabel(state.phase)}${state.account ? ` · ${state.account}` : ''}`;
  const lines: string[] = [];
  if (state.error) {
    lines.push(`错误：${state.error}`);
  }
  const prompt = state.prompt;
  if (prompt?.kind === 'url') {
    lines.push(`授权链接：${prompt.url}`);
    if (prompt.userCode) {
      lines.push(`设备码：${prompt.userCode}`);
    }
  } else if (prompt?.kind === 'qr') {
    if (prompt.caption) {
      lines.push(prompt.caption);
    }
    if (prompt.image.startsWith('http://') || prompt.image.startsWith('https://')) {
      lines.push(`扫码链接：${prompt.image}`);
    }
  } else if (state.phase === 'connecting') {
    lines.push('等待 gateway 响应…');
  } else if (state.phase === 'awaiting_user') {
    lines.push('请按下方提示完成授权。');
  }
  return { title, lines };
}

export function phaseLabel(phase: ChannelConnectionState['phase']): string {
  switch (phase) {
    case 'disabled':
      return '未连接';
    case 'connecting':
      return '连接中';
    case 'awaiting_user':
      return '等待扫码/授权';
    case 'connected':
      return '已连接';
    case 'error':
      return '错误';
    default:
      return phase;
  }
}

export async function buildConnectionView(state: ChannelConnectionState): Promise<ConnectionView> {
  const { title, lines } = describeConnectionState(state);
  let qrAscii: string | undefined;
  if (state.prompt?.kind === 'qr') {
    qrAscii = await qrImageToTerminal(state.prompt.image);
  }
  return { channel: state.channel, phase: state.phase, title, lines, qrAscii };
}

export async function pollChannelConnection(
  service: ConnectionsService,
  channel: string,
  options: {
    signal: AbortSignal;
    onState: (view: ConnectionView) => void;
    freshAfter?: string;
    pollMs?: number;
    timeoutMs?: number;
  },
): Promise<ConnectionPollResult> {
  const started = Date.now();
  const freshAfterMs = options.freshAfter ? Date.parse(options.freshAfter) : undefined;
  const minUpdatedAt = Number.isFinite(freshAfterMs) ? freshAfterMs : undefined;
  const pollMs = options.pollMs ?? CONNECT_POLL_MS;
  const timeoutMs = options.timeoutMs ?? CONNECT_TIMEOUT_MS;
  let lastSignature = '';

  while (!options.signal.aborted) {
    let state: ChannelConnectionState;
    try {
      state = await service.getState(channel);
    } catch (error) {
      options.onState(connectionErrorView(channel, '无法读取 IM 连接状态', error));
      return 'error';
    }
    const stateUpdatedAt = Date.parse(state.updatedAt);
    const fresh =
      minUpdatedAt === undefined ||
      (Number.isFinite(stateUpdatedAt) && stateUpdatedAt >= minUpdatedAt);
    if (!fresh) {
      const signature = JSON.stringify({ stale: true, channel });
      if (signature !== lastSignature) {
        lastSignature = signature;
        options.onState({
          channel,
          phase: 'connecting',
          title: `[${channel}] 重新连接中`,
          lines: ['已发送重新连接请求，等待 gateway 更新状态…'],
        });
      }
      if (Date.now() - started > timeoutMs) {
        return 'timeout';
      }
      await delay(pollMs);
      continue;
    }
    const signature = JSON.stringify({
      phase: state.phase,
      prompt: state.prompt,
      account: state.account,
      error: state.error,
    });
    if (signature !== lastSignature) {
      lastSignature = signature;
      options.onState(await buildConnectionView(state));
    }
    if (state.phase === 'connected') {
      return 'connected';
    }
    if (state.phase === 'error') {
      return 'error';
    }
    if (Date.now() - started > timeoutMs) {
      return 'timeout';
    }
    await delay(pollMs);
  }
  return 'aborted';
}

export function connectionErrorView(channel: string, headline: string, error: unknown): ConnectionView {
  return {
    channel,
    phase: 'error',
    title: `[${channel}] 连接失败`,
    lines: [
      `${headline}：${formatErrorMessage(error)}`,
      '请检查数据库连接，以及 gateway 是否正在运行：zleap serve --gateway',
    ],
  };
}

export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }
  return '未知错误';
}

export async function probeGatewayRecent(
  service: ConnectionsService,
  channels: readonly string[],
): Promise<boolean> {
  const now = Date.now();
  let latest = 0;
  for (const channel of channels) {
    const state = await service.getState(channel);
    const ts = Date.parse(state.updatedAt);
    if (Number.isFinite(ts) && ts > latest) {
      latest = ts;
    }
  }
  return latest > 0 && now - latest < GATEWAY_PROBE_MS;
}

export async function runChannelConnectLoop(
  service: ConnectionsService,
  channel: string,
  action: ConnectionCommandType,
  onView: (view: ConnectionView) => void,
): Promise<number> {
  const command = await service.requestCommand(channel, action);
  if (action === 'logout') {
    return 0;
  }

  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.once('SIGINT', onSigint);
  let exitCode = 0;

  try {
    const result = await pollChannelConnection(service, channel, {
      signal: controller.signal,
      onState: onView,
      freshAfter: command.at,
    });
    if (result === 'connected') {
      process.stdout.write('\n连接成功。可在 Web 管理台或 IM 中测试消息。\n');
    } else if (result === 'error') {
      process.stderr.write('\n连接失败。\n');
      exitCode = 1;
    } else if (result === 'timeout') {
      process.stderr.write('\n连接超时（5 分钟）。请检查 gateway 是否在运行。\n');
      exitCode = 1;
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
  return exitCode;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
