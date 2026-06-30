import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { appendDesktopLog, writeBootstrapState } from './bootstrap-state.js';
import { normalizeVersion } from './distribution.js';
import { buildRuntimeEnv, resolveNodeBin, resolvePostgresBin } from './resolver.js';
import { ensureLayoutDirs } from './lifecycle.js';
import { bundledAppRoot, isBundledInstall, resolveBundledRoot } from './paths.js';
import { ensureAppUpToDate } from './app-update.js';
import { isAppComplete } from './app-layout.js';
import { startDetachedServe, waitForHealthLive } from './service/manager.js';
import { readAppMetadata as readInstalledAppMetadata, type AppMetadata } from './upgrade.js';
import { webUrl } from './env.js';
import { ensureRuntimeInstalled } from './setup-runtime.js';
import { readServeState, stopServe, stopWebPortListeners } from './supervisor.js';
import { DEFAULT_WEB_PORT } from './constants.js';

export type BootstrapStep = {
  step: string;
  message: string;
  ok?: boolean;
};

export type DesktopBootstrapResult = {
  ok: boolean;
  url: string;
  landing: string;
  appRoot: string;
  version?: string;
  error?: string;
};

export type DesktopBootstrapOptions = {
  bundledRoot?: string;
  payloadDir?: string;
  appRoot?: string;
  onProgress?: (step: BootstrapStep) => void;
  downloadIfMissing?: boolean;
  startServe?: boolean;
  autoUpdate?: boolean;
};

function progress(options: DesktopBootstrapOptions, step: string, message: string, ok = true): void {
  options.onProgress?.({ step, message, ok });
  void appendDesktopLog(`[${step}] ${message}`);
}

/** Throttled reporter that surfaces payload download progress to the splash. */
function makeDownloadReporter(
  options: DesktopBootstrapOptions,
): (progress: { transferred: number; total?: number }) => void {
  let lastEmit = 0;
  let lastPct = -1;
  return ({ transferred, total }) => {
    const now = Date.now();
    const pct = total ? Math.floor((transferred / total) * 100) : undefined;
    const finished = total ? transferred >= total : false;
    if (!finished && now - lastEmit < 400 && pct === lastPct) {
      return;
    }
    lastEmit = now;
    lastPct = pct ?? lastPct;
    const mb = (bytes: number) => (bytes / 1_048_576).toFixed(0);
    const message =
      pct !== undefined
        ? `下载运行时 ${pct}%（${mb(transferred)}/${mb(total ?? 0)} MB）`
        : `下载运行时 ${mb(transferred)} MB…`;
    options.onProgress?.({ step: 'download', message, ok: true });
  };
}

async function readAppMetadataForRoot(appRoot: string): Promise<AppMetadata | undefined> {
  const fromLayout = await readInstalledAppMetadata();
  if (fromLayout) return fromLayout;
  const candidates = [join(dirname(appRoot), 'metadata.json'), join(appRoot, 'metadata.json')];
  for (const file of candidates) {
    try {
      const raw = await readFile(file, 'utf8');
      return JSON.parse(raw) as AppMetadata;
    } catch {
      // try next
    }
  }
  return undefined;
}

async function ensureRuntimeDeps(options: DesktopBootstrapOptions, appRoot: string): Promise<void> {
  progress(options, 'deps', '检查 Node.js…');
  const nodeBin = resolveNodeBin(appRoot);
  if (!existsSync(nodeBin) && nodeBin === process.execPath) {
    throw new Error('未找到 bundled Node.js');
  }

  progress(options, 'deps', '检查 Postgres…');
  const pgBin = resolvePostgresBin(appRoot);
  if (!pgBin) {
    progress(options, 'deps', '未找到便携 Postgres，将尝试系统/Docker 回退', false);
  }
}

async function resolveLandingPath(env: NodeJS.ProcessEnv): Promise<string> {
  const base = webUrl(env);
  try {
    const response = await fetch(`${base}/api/models`, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) {
      return '/onboarding';
    }
    const data = (await response.json()) as {
      models?: Array<{ config?: { hasApiKey?: boolean; model?: string } }>;
    };
    const configured = data.models?.some((m) => m.config?.hasApiKey || m.config?.model);
    return configured ? '/' : '/onboarding';
  } catch {
    return '/onboarding';
  }
}

/** Full desktop first-launch bootstrap: layout → seed → serve → route. */
export async function runDesktopBootstrap(
  options: DesktopBootstrapOptions = {},
): Promise<DesktopBootstrapResult> {
  try {
    progress(options, 'init', '初始化用户目录…');
    await ensureLayoutDirs();

    process.env.ZLEAP_DESKTOP = '1';
    process.env.ZLEAP_INSTALL_METHOD = 'desktop';

    const bundledRoot = options.bundledRoot ?? resolveBundledRoot();
    progress(options, 'deps', '检查运行时组件…');
    if (bundledRoot) {
      progress(options, 'seed', '准备运行时…');
    }
    const reportDownload = makeDownloadReporter(options);
    const runtime = await ensureRuntimeInstalled({
      method: 'desktop',
      bundledRoot,
      payloadDir: options.payloadDir,
      downloadIfMissing: options.downloadIfMissing === true,
      onDownloadProgress: reportDownload,
    });
    progress(options, 'deps', runtimeStatusMessage(runtime.source, runtime.version));

    let appRoot = runtime.appRoot;

    if (options.autoUpdate === true) {
      progress(options, 'update', '检查 app 更新…');
      const update = await ensureAppUpToDate({ autoUpdate: true });
      if (update.updated) {
        progress(options, 'update', `已更新到 v${update.latestVersion}`);
        appRoot = bundledAppRoot();
      } else if (update.blocked && update.error) {
        progress(options, 'update', `暂未自动更新：${update.error}`, false);
      } else if (!update.upToDate && update.latestVersion) {
        progress(options, 'update', `有新版本 v${update.latestVersion}（请通过新版 Desktop 安装包或 Tauri updater 更新）`, false);
      }
    }

    process.env.ZLEAP_APP_ROOT = appRoot;
    process.env.ZLEAP_REPO_ROOT = appRoot;

    await ensureRuntimeDeps(options, appRoot);

    const meta = await readAppMetadataForRoot(appRoot);
    progress(options, 'init', '写入安装状态…');
    if (meta?.version) {
      await writeBootstrapState({
        completedAt: new Date().toISOString(),
        version: meta.version,
        platform: meta.platform ?? 'unknown',
        method: 'desktop',
      });
    }

    const env = buildRuntimeEnv({
      ZLEAP_APP_ROOT: appRoot,
      ZLEAP_REPO_ROOT: appRoot,
      ZLEAP_DESKTOP: '1',
      ZLEAP_INSTALL_METHOD: 'desktop',
    });

    if (options.startServe !== false) {
      progress(options, 'serve', '检查本地服务…');
      const live = await probeLiveService(env);
      const reusable = live.ok ? await reconcileRunningServe(options, env, appRoot, meta, live.service) : false;
      if (!reusable) {
        progress(options, 'serve', '启动 Postgres / Web / Worker…');
        await startDetachedServe({
          env,
          startedBy: 'desktop',
          sessionId: process.env.ZLEAP_LAUNCHER_SESSION_ID,
          stopPolicy: 'onDesktopQuit',
        });
        progress(options, 'connect', '等待服务就绪…');
        const ok = await waitForHealthLive(env, 240_000);
        if (!ok) {
          throw new Error('本地服务启动超时，请查看 ~/.zleap/logs/serve.log');
        }
      } else {
        progress(options, 'connect', '本地服务已在运行');
      }
    }

    progress(options, 'route', '检测配置状态…');
    const landing = await resolveLandingPath(env);
    const url = `${webUrl(env)}${landing}`;
    progress(options, 'done', landing === '/' ? '已进入主界面' : '请完成首次配置');

    return {
      ok: true,
      url,
      landing,
      appRoot,
      version: meta?.version ? normalizeVersion(meta.version) : undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    progress(options, 'error', message, false);
    return {
      ok: false,
      url: '',
      landing: '/onboarding',
      appRoot: options.appRoot ?? bundledAppRoot(),
      error: message,
    };
  }
}

async function probeLiveService(env: NodeJS.ProcessEnv): Promise<{ ok: boolean; service?: string }> {
  const base = webUrl(env);
  try {
    const response = await fetch(`${base}/api/health/live`, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) {
      return { ok: false };
    }
    const body = await response.json().catch(() => undefined) as { service?: string } | undefined;
    return { ok: true, service: body?.service };
  } catch {
    return { ok: false };
  }
}

async function reconcileRunningServe(
  options: DesktopBootstrapOptions,
  env: NodeJS.ProcessEnv,
  appRoot: string,
  meta: AppMetadata | undefined,
  service?: string,
): Promise<boolean> {
  const state = await readServeState();
  if (state?.runtimeRoot && samePath(state.runtimeRoot, appRoot) && state.runtimeBuiltAt && state.runtimeBuiltAt === meta?.builtAt) {
    return true;
  }

  if (state) {
    progress(options, 'serve', '检测到旧运行时服务，正在重启…', false);
    await stopServe();
    return false;
  }

  if (service === 'zleap-web') {
    const port = Number(env.ZLEAP_WEB_PORT ?? env.PORT ?? DEFAULT_WEB_PORT);
    progress(options, 'serve', '检测到失联的旧 Zleap 服务，正在替换…', false);
    await stopWebPortListeners(port);
    return false;
  }

  throw new Error(`端口 ${env.ZLEAP_WEB_PORT ?? env.PORT ?? DEFAULT_WEB_PORT} 已被其他服务占用，请释放端口后重试。`);
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

function runtimeStatusMessage(source: 'dev' | 'existing' | 'embedded' | 'download', version?: string): string {
  const suffix = version ? ` v${normalizeVersion(version)}` : '';
  if (source === 'dev') return `使用开发运行时${suffix}`;
  if (source === 'embedded') return `已安装内嵌运行时${suffix}`;
  if (source === 'download') return `已下载运行时${suffix}`;
  return `当前运行时可用${suffix}`;
}

export async function verifyDesktopApp(appRoot: string): Promise<boolean> {
  return isAppComplete(appRoot, 'desktop');
}

export function isBundledDesktopApp(appRoot: string): boolean {
  return isBundledInstall(appRoot) && existsSync(join(appRoot, 'web', 'server.js'));
}

export { readBootstrapState, isBootstrapComplete, appendDesktopLog, desktopLogPath } from './bootstrap-state.js';
