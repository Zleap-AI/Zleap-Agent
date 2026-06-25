import { spawn } from 'node:child_process';
import { open, readFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildServeEnv, healthCheck, readServeState, stopServe, webUrl, zleapLayout } from '@zleap/host';
import type { ServeCommandOptions } from './serve.js';

export type StackHealth = 'off' | 'starting' | 'ok' | 'partial';

export async function summarizeStackHealth(): Promise<StackHealth> {
  const state = await readServeState();
  if (!state) {
    return 'off';
  }
  const health = await healthCheck(buildServeEnv());
  if (!health.postgres.ok && !health.web.ok) {
    return 'starting';
  }
  if (health.web.ok && health.postgres.ok && health.worker.ok) {
    return 'ok';
  }
  if (health.web.ok || health.postgres.ok) {
    return 'partial';
  }
  return 'starting';
}

export function stackHealthBadge(health: StackHealth): string {
  switch (health) {
    case 'ok':
      return '栈✓';
    case 'partial':
      return '栈~';
    case 'starting':
      return '栈…';
    default:
      return '栈✗';
  }
}

export async function formatStackStatusSummary(): Promise<string> {
  const state = await readServeState();
  const health = await healthCheck(buildServeEnv());
  const lines = ['本地栈：'];
  if (state) {
    lines.push(`  模式       ${state.mode}`);
    lines.push(`  Web        ${state.webUrl}`);
    for (const svc of state.services) {
      lines.push(`  ${svc.name.padEnd(10)} pid ${svc.pid ?? '-'}`);
    }
  } else {
    lines.push('  未运行（/serve 后台启动）');
  }
  lines.push(
    `  Postgres   ${health.postgres.ok ? '✓' : '✗'} ${health.postgres.detail}`,
    `  Web        ${health.web.ok ? '✓' : '✗'} ${health.web.detail}`,
    `  Worker     ${health.worker.ok ? '✓' : '✗'} ${health.worker.detail}`,
    `  Gateway    ${health.gateway.ok ? '✓' : '✗'} ${health.gateway.detail}`,
    `  打开       ${webUrl(buildServeEnv())}`,
  );
  return lines.join('\n');
}

export async function spawnServeDetached(options: ServeCommandOptions = {}): Promise<string> {
  const health = await summarizeStackHealth();
  if (health === 'ok' || health === 'partial') {
    const env = buildServeEnv();
    const live = await healthCheck(env);
    if (!options.gateway || live.gateway.ok) {
      return [
        '本地栈已在运行。',
        `  Web     ${live.web.ok ? '✓' : '✗'} ${webUrl(env)}`,
        `  Worker  ${live.worker.ok ? '✓' : '✗'}`,
        `  Gateway ${live.gateway.ok ? '✓' : '✗'}`,
        '可用 /connect 连接 IM，或 /stop 停止。',
      ].join('\n');
    }
    await stopServe().catch(() => undefined);
    await delay(500);
  }

  const entry = join(dirname(fileURLToPath(import.meta.url)), '../index.js');
  const args = ['serve'];
  if (options.gateway) args.push('--gateway');
  if (options.production) args.push('--production');
  if (options.skipPostgres) args.push('--skip-postgres');
  if (options.skipBuild) args.push('--skip-build');

  const logPath = await prepareServeLog();
  const child = spawn(process.execPath, [entry, ...args], {
    detached: true,
    stdio: ['ignore', logPath.fd, logPath.fd],
    env: process.env,
    cwd: process.cwd(),
    windowsHide: true,
  });
  child.unref();
  await logPath.close();

  for (let attempt = 0; attempt < 30; attempt += 1) {
    await delay(2_000);
    const next = await summarizeStackHealth();
    const live = await healthCheck(buildServeEnv());
    if ((next === 'ok' || next === 'partial') && (!options.gateway || live.gateway.ok)) {
      return [
        health === 'ok' || health === 'partial' ? '本地栈已重启并启用 Gateway。' : '本地栈已在后台启动。',
        `  Web     ${live.web.ok ? '✓' : '✗'} ${webUrl(buildServeEnv())}`,
        `  Worker  ${live.worker.ok ? '✓' : '✗'}`,
        `  Gateway ${live.gateway.ok ? '✓' : '✗'}`,
        '可用 /connect 连接 IM 频道。',
      ].join('\n');
    }
  }
  const live = await healthCheck(buildServeEnv());
  const logTail = await readServeLogTail();
  return [
    '已在后台启动 serve，服务仍在初始化…',
    `  Web     ${live.web.ok ? '✓' : '✗'} ${webUrl(buildServeEnv())}`,
    `  Worker  ${live.worker.ok ? '✓' : '✗'}`,
    `  Gateway ${live.gateway.ok ? '✓' : '✗'}`,
    ...(logTail ? ['', '最近日志：', logTail] : []),
    '稍后用 /status 查看进度。',
  ].join('\n');
}

export async function stopServeFromTui(): Promise<string> {
  const result = await stopServe();
  if (result.missing) {
    return '未找到运行中的本地栈（~/.zleap/serve.json 不存在）。';
  }
  if (result.stopped.length === 0) {
    return '已清除 serve 状态，但未找到存活进程。';
  }
  return `已停止：${result.stopped.join(', ')}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function prepareServeLog(): Promise<Awaited<ReturnType<typeof open>>> {
  const layout = zleapLayout();
  await mkdir(layout.logsDir, { recursive: true });
  return open(join(layout.logsDir, 'serve.log'), 'a');
}

async function readServeLogTail(): Promise<string | undefined> {
  try {
    const raw = await readFile(join(zleapLayout().logsDir, 'serve.log'), 'utf8');
    const lines = raw.split('\n').filter(Boolean).slice(-8);
    return lines.length ? lines.join('\n') : undefined;
  } catch {
    return undefined;
  }
}
