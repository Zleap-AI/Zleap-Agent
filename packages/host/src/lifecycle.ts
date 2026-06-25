import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { writeInstallState, type InstallMethod } from './install-method.js';
import { zleapLayout } from './layout.js';
import { buildRuntimeEnv } from './resolver.js';
import { startDetachedServe, waitForHealthLive } from './service/manager.js';
import { webUrl } from './env.js';
import { ensureRuntimeInstalled } from './setup-runtime.js';

export type FinishInstallOptions = {
  method?: InstallMethod;
  version?: string;
  platform?: string;
  startServe?: boolean;
  openBrowser?: boolean;
};

export async function ensureLayoutDirs(): Promise<void> {
  const layout = zleapLayout();
  await mkdir(layout.stateDir, { recursive: true });
  await mkdir(layout.dataDir, { recursive: true });
  await mkdir(layout.configDir, { recursive: true });
  await mkdir(layout.logsDir, { recursive: true });
}

function onboardingUrlFromEnv(env: NodeJS.ProcessEnv): string {
  return `${webUrl(env)}/onboarding`;
}

/** Post-install: record state, optionally start serve and open onboarding. */
export async function finishInstall(options: FinishInstallOptions = {}): Promise<void> {
  await ensureLayoutDirs();
  await writeInstallState({
    method: options.method ?? 'cli',
    version: options.version,
    platform: options.platform,
    installedAt: new Date().toISOString(),
  });

  const { writeBootstrapState } = await import('./bootstrap-state.js');
  if (options.version) {
    await writeBootstrapState({
      completedAt: new Date().toISOString(),
      version: options.version,
      platform: options.platform ?? 'unknown',
      method: (options.method === 'dev' ? 'cli' : options.method) ?? 'cli',
    });
  }

  const env = buildRuntimeEnv();
  if (options.startServe !== false) {
    await startDetachedServe({ env });
    const ok = await waitForHealthLive(env, 120_000);
    if (!ok) {
      process.stderr.write('警告：服务启动超时，请运行 zleap doctor 排查\n');
    }
  }

  if (options.openBrowser !== false) {
    await openOnboardingUrl(env);
  }

  process.stdout.write(`\nZleap 已就绪。\n  Web: ${onboardingUrlFromEnv(env)}\n  日志: ${zleapLayout().logsDir}/serve.log\n\n`);
}

export async function openOnboardingUrl(env: NodeJS.ProcessEnv = buildRuntimeEnv()): Promise<void> {
  const url = onboardingUrlFromEnv(env);
  const platform = process.platform;
  if (platform === 'darwin') {
    await runOpen('open', [url]);
  } else if (platform === 'win32') {
    await runOpen('cmd', ['/c', 'start', '', url]);
  } else {
    await runOpen('xdg-open', [url]).catch(() => undefined);
  }
}

function runOpen(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, shell: process.platform === 'win32', windowsHide: true });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))));
    child.unref();
  });
}

export async function runSetupFlow(options: { openBrowser?: boolean } = {}): Promise<number> {
  await ensureLayoutDirs();
  const runtime = await ensureRuntimeInstalled({ method: 'cli', downloadIfMissing: true });
  const env =
    runtime.source === 'dev'
      ? buildRuntimeEnv()
      : buildRuntimeEnv({ ZLEAP_APP_ROOT: runtime.appRoot, ZLEAP_REPO_ROOT: runtime.appRoot });
  const healthy = await waitForHealthLive(env, 3_000);
  if (!healthy) {
    await startDetachedServe({ env, startedBy: 'cli', stopPolicy: 'explicit' });
    const ok = await waitForHealthLive(env, 120_000);
    if (!ok) {
      process.stderr.write('无法启动本地服务，请运行 zleap doctor\n');
      return 1;
    }
  }
  if (options.openBrowser !== false) {
    await openOnboardingUrl(env);
  }
  process.stdout.write(`请在浏览器中完成配置：${onboardingUrlFromEnv(env)}\n`);
  return 0;
}
