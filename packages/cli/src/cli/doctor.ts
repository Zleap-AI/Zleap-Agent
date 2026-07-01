import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  detectInstallMethod,
  fetchRuntimeReleaseManifest,
  healthCheck,
  isBootstrapComplete,
  isBundledInstall,
  ManifestSignatureError,
  readBootstrapState,
  readInstallState,
  readLauncherState,
  readRuntimeState,
  readServeState,
  readAppMetadata,
  resolveBundledNodeBin,
  resolveBundledPostgresBin,
  resolveRuntimeRoot,
  bundledAppRoot,
  appChecks,
  runtimeVersionFromManifest,
  installManifestUrl,
  zleapLayout,
} from '@zleap/host';
import { CONFIG_PATH, loadConfigWithMeta, resolvePersistence } from '@zleap/host';
import { resolveIntegration302Detailed, setIntegration302Store, type ResolvedIntegration302 } from '@zleap/agent';
import { resolveCliContext, modelSourceLabel } from './context.js';
import { formatChannelsStatusSummary } from './channels.js';
import { ConnectionsService } from '@zleap/agent/conversation';
import { createSharedStore } from '@zleap/agent/conversation';
import { loadProjectEnv } from '../dotenv.js';

export type DoctorCheck = {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
  critical?: boolean;
};

const GATEWAY_CHANNELS = ['feishu', 'wechat', 'feishu-cli'] as const;
const GATEWAY_PROBE_MS = 30_000;

export async function runDoctor(options: { json?: boolean } = {}): Promise<number> {
  const checks = await collectDoctorChecks();
  if (options.json) {
    process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
  } else {
    printDoctorTable(checks);
  }
  return checks.some((c) => c.critical !== false && !c.ok) ? 1 : 0;
}

export async function collectDoctorChecks(): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push({
    name: 'Node.js',
    ok: nodeMajor >= 20,
    detail: `v${process.versions.node}`,
    fix: nodeMajor < 20 ? '请安装 Node.js 20+' : undefined,
    critical: !isBundledInstall(),
  });

  const appMeta = await readAppMetadata();
  const installState = await readInstallState();
  const bootstrapState = await readBootstrapState();
  const runtimeState = await readRuntimeState();
  const launcherState = await readLauncherState();
  const bootstrapOk = await isBootstrapComplete();
  const layout = zleapLayout();
  const appRoot = bundledAppRoot();
  const runtimeRoot = resolveRuntimeRoot();
  const runtimeMissing = appChecks(appRoot, 'cli');
  const isDevRuntime = existsSync(join(runtimeRoot, 'pnpm-workspace.yaml'));
  const bundledNode = resolveBundledNodeBin(appRoot);
  const bundledPg = resolveBundledPostgresBin(appRoot);
  checks.push(await releaseManifestCheck(isDevRuntime));
  checks.push({
    name: 'Runtime Layout',
    ok: runtimeMissing.length === 0 || isDevRuntime,
    detail:
      runtimeMissing.length === 0
        ? `${layout.current} 完整`
        : isDevRuntime
          ? `开发模式（${runtimeRoot}）`
          : `${layout.current} 缺少 ${runtimeMissing.length} 个组件`,
    fix: runtimeMissing.length === 0 || isDevRuntime ? undefined : '运行 zleap setup 修复或重新安装 runtime',
    critical: false,
  });
  checks.push({
    name: 'Runtime State',
    ok: Boolean(runtimeState) || isDevRuntime,
    detail: runtimeState
      ? `v${runtimeState.version} · ${runtimeState.platform} · ${runtimeState.runtimeRoot}`
      : isDevRuntime
        ? '开发模式不要求 state/host.json'
        : '缺少 state/host.json',
    fix: runtimeState || isDevRuntime ? undefined : '运行 zleap setup 重新写入 runtime 状态',
    critical: false,
  });
  checks.push({
    name: 'Launcher State',
    ok: true,
    detail: launcherState
      ? `${launcherState.lastLauncher ?? 'unknown'} · ${launcherState.lastBootstrapSource ?? 'unknown'} · ${launcherState.updatedAt}`
      : '未记录 launcher.json（首次启动前正常）',
    critical: false,
  });
  checks.push(await lockCheck('Serve Lock', layout.serveLockPath, '如果没有正在启动服务，删除 stale serve.lock 后重试'));
  checks.push(await lockCheck('Update Lock', layout.updateLockPath, '如果没有正在升级，删除 stale update.lock 后重试'));
  checks.push({
    name: 'App Runtime',
    ok: existsSync(join(appRoot, 'runtime/node_modules/@zleap/host/dist/serve-cli.js')) || !isBundledInstall(),
    detail: appMeta
      ? `v${appMeta.version} · ${appRoot}${runtimeRoot !== appRoot ? ` (runtime ${runtimeRoot})` : ''}`
      : isBundledInstall()
        ? '未找到 metadata.json'
        : '开发模式（monorepo）',
    fix: appMeta ? undefined : '重新运行 zleap setup，或重新安装 @zleap-ai/cli / Desktop',
    critical: isBundledInstall(),
  });

  if (isBundledInstall()) {
    checks.push({
      name: 'Bootstrap',
      ok: bootstrapOk,
      detail: bootstrapState
        ? `${bootstrapState.method ?? 'unknown'} · v${bootstrapState.version} · ${bootstrapState.completedAt}`
        : '未完成 bootstrap（state/bootstrap.json 缺失）',
      fix: bootstrapOk ? undefined : '重新打开 Desktop 或运行 zleap setup',
      critical: false,
    });
  }
  if (bundledNode) {
    checks.push({
      name: 'Bundled Node',
      ok: true,
      detail: bundledNode,
      critical: false,
    });
  }
  if (bundledPg) {
    checks.push({
      name: 'Bundled Postgres',
      ok: true,
      detail: bundledPg,
      critical: false,
    });
  } else if (isBundledInstall()) {
    checks.push({
      name: 'Bundled Postgres',
      ok: false,
      detail: '未找到便携 Postgres',
      fix: '重新安装 App runtime 或设置 ZLEAP_DATABASE_URL',
      critical: false,
    });
  }

  loadProjectEnv();
  let integration302: ResolvedIntegration302 | undefined;
  checks.push({
    name: '.env 加载',
    ok: true,
    detail: '已从项目目录与 ~/.zleap/.env 尝试加载',
    critical: false,
  });

  if (installState) {
    checks.push({
      name: '安装方式',
      ok: true,
      detail: `${installState.method} · v${installState.version} · ${installState.platform}`,
      critical: false,
    });
  } else if (isBundledInstall()) {
    checks.push({
      name: '安装方式',
      ok: false,
      detail: 'App runtime 已安装但未写入 state/install.json',
      fix: '重新运行 zleap setup，或重新安装 @zleap-ai/cli / Desktop',
      critical: false,
    });
  } else {
    checks.push({
      name: '安装方式',
      ok: true,
      detail: `开发模式（${detectInstallMethod()}）`,
      critical: false,
    });
  }

  const { config, parseError } = await loadConfigWithMeta();
  const configExists = existsSync(CONFIG_PATH);
  checks.push({
    name: 'CLI 配置缓存',
    ok: !parseError,
    detail: parseError ?? (configExists ? CONFIG_PATH : '可选；主配置在 Web/数据库'),
    fix: parseError ? '修复 JSON 或 zleap init --force' : undefined,
    critical: parseError ? true : false,
  });

  const ctx = await resolveCliContext();
  checks.push({
    name: 'LLM 模型',
    ok: Boolean(ctx.model),
    detail: ctx.model ? `${ctx.model.displayName ?? ctx.model.model}（${modelSourceLabel(ctx.modelSource)}）` : '未配置',
    fix: '运行 zleap setup 在 Web 完成 onboarding',
    critical: true,
  });

  const persistence = resolvePersistence(config);
  if (persistence.databaseUrl) {
    const store = await createSharedStore({ onWarn: () => undefined });
    checks.push({
      name: 'Postgres',
      ok: Boolean(store),
      detail: store ? '连接成功' : '无法连接',
      fix: '检查 ZLEAP_DATABASE_URL，运行 zleap serve 或 docker compose up postgres',
      critical: false,
    });
    if (store) {
      try {
        await store.integrations.getIntegration('connections:wechat');
        checks.push({
          name: 'Gateway 表',
          ok: true,
          detail: 'gateway_integrations 可读',
          critical: false,
        });
      } catch {
        checks.push({
          name: 'Gateway 表',
          ok: false,
          detail: '无法读取 gateway_integrations',
          fix: '运行 zleap serve --gateway 触发 migrate',
          critical: false,
        });
      }
      integration302 = await resolveIntegration302Detailed();
      await store.close().catch(() => undefined);
      setIntegration302Store(undefined);
    }
  } else {
    checks.push({
      name: 'Postgres',
      ok: false,
      detail: '未配置 ZLEAP_DATABASE_URL',
      fix: 'zleap init 或在 .env 中设置 ZLEAP_DATABASE_URL',
      critical: false,
    });
  }

  integration302 ??= await resolveIntegration302Detailed();

  const embedModel = persistence.embedding?.model ?? process.env.ZLEAP_EMBED_MODEL;
  checks.push({
    name: 'Embedding',
    ok: Boolean(embedModel),
    detail: embedModel ? embedModel : '未配置（将使用 faux embedding）',
    fix: embedModel ? undefined : '在 .env 设置 ZLEAP_EMBED_* 或 Web 管理台配置',
    critical: false,
  });

  checks.push({
    name: 'Web Search',
    ok: Boolean(integration302.apiKey),
    detail: integration302.apiKey
      ? `302 API Key 已配置（${integration302SourceLabel(integration302.source.apiKey)}） · ${integration302.apiBaseUrl}`
      : `未配置 302 API Key · ${integration302.apiBaseUrl}（${integration302SourceLabel(integration302.source.apiBaseUrl)}）`,
    fix: integration302.apiKey ? undefined : '运行 zleap config 302 setup 或在 Web 通用配置填写',
    critical: false,
  });

  const gateway = await probeGateway();
  checks.push({
    name: 'Gateway 进程',
    ok: gateway.alive,
    detail: gateway.detail,
    fix: gateway.alive ? undefined : '配置 IM 频道后运行 zleap serve --gateway',
    critical: false,
  });

  const serveState = await readServeState();
  const stackHealth = await healthCheck();
  const serveAlive = serveState ? pidAlive(serveState.pid) : false;
  checks.push({
    name: 'Serve State',
    ok: serveAlive,
    detail: serveState
      ? `${serveAlive ? 'running' : 'stale'} · pid ${serveState.pid} · ${serveState.startedBy ?? 'unknown'} · ${serveState.runtimeVersion ?? 'unknown'}`
      : '未找到 state/serve.json',
    fix: serveState ? (serveAlive ? undefined : '运行 zleap serve 重新启动，或 zleap stop 清理状态') : '运行 zleap serve',
    critical: false,
  });
  checks.push({
    name: 'Web 服务',
    ok: stackHealth.web.ok,
    detail: serveState ? `${stackHealth.web.detail} · ${stackHealth.web.url}` : stackHealth.web.detail,
    fix: stackHealth.web.ok ? undefined : '运行 zleap serve',
    critical: false,
  });
  checks.push({
    name: 'Task Worker',
    ok: stackHealth.worker.ok,
    detail: stackHealth.worker.detail,
    fix: stackHealth.worker.ok ? undefined : '运行 zleap serve',
    critical: false,
  });

  const feishuCliEnabled = await isFeishuCliEnabled();
  if (feishuCliEnabled) {
    checks.push({
      name: 'lark-cli',
      ok: resolveLarkCliBin() != null,
      detail: resolveLarkCliBin() ?? '未找到 @larksuite/cli',
      fix: 'pnpm install（项目已 bundled @larksuite/cli）',
      critical: false,
    });
  }

  return checks;
}

/** Compact summary for TUI `/doctor`. */
export async function formatDoctorSummary(): Promise<string> {
  const checks = await collectDoctorChecks();
  const lines = ['环境体检：'];
  for (const check of checks) {
    lines.push(`  ${check.ok ? '✓' : '✗'} ${check.name.padEnd(14)} ${check.detail}`);
    if (!check.ok && check.fix) {
      lines.push(`      → ${check.fix}`);
    }
  }
  const channels = await formatChannelsStatusSummary();
  if (channels) {
    lines.push('', channels);
  }
  return lines.join('\n');
}

async function probeGateway(): Promise<{ alive: boolean; detail: string }> {
  const store = await createSharedStore({ onWarn: () => undefined });
  if (!store) {
    return { alive: false, detail: '需要数据库才能探测 gateway' };
  }
  try {
    const service = new ConnectionsService(store.integrations);
    const now = Date.now();
    let latest = 0;
    let latestChannel = '';
    for (const channel of GATEWAY_CHANNELS) {
      const state = await service.getState(channel);
      const ts = Date.parse(state.updatedAt);
      if (Number.isFinite(ts) && ts > latest) {
        latest = ts;
        latestChannel = channel;
      }
    }
    if (latest > 0 && now - latest < GATEWAY_PROBE_MS) {
      return { alive: true, detail: `${latestChannel} 状态 ${Math.round((now - latest) / 1000)}s 前更新` };
    }
    return { alive: false, detail: '30s 内无频道状态更新（gateway 可能未运行）' };
  } finally {
    await store.close().catch(() => undefined);
    setIntegration302Store(undefined);
  }
}

async function isFeishuCliEnabled(): Promise<boolean> {
  const store = await createSharedStore({ onWarn: () => undefined });
  if (!store) return false;
  try {
    const row = await store.integrations.getIntegration('feishu-cli');
    return row?.config?.enabled === true;
  } catch {
    return false;
  } finally {
    await store.close().catch(() => undefined);
    setIntegration302Store(undefined);
  }
}

function resolveLarkCliBin(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkgJson = require.resolve('@larksuite/cli/package.json');
    const runJs = join(dirname(pkgJson), 'scripts/run.js');
    return existsSync(runJs) ? runJs : null;
  } catch {
    return null;
  }
}

function integration302SourceLabel(source: string): string {
  switch (source) {
    case 'db':
      return 'DB';
    case 'env':
      return 'env';
    case 'file':
      return 'legacy file';
    case 'model':
      return 'model config';
    case 'default':
      return 'default';
    default:
      return 'none';
  }
}

function printDoctorTable(checks: DoctorCheck[]): void {
  process.stdout.write('\nZleap 环境体检\n\n');
  for (const check of checks) {
    const mark = check.ok ? '✓' : '✗';
    process.stdout.write(`${mark} ${check.name.padEnd(16)} ${check.detail}\n`);
    if (!check.ok && check.fix) {
      process.stdout.write(`  建议：${check.fix}\n`);
    }
  }
  process.stdout.write('\n');
}

export async function releaseManifestCheck(isDevRuntime = false): Promise<DoctorCheck> {
  const shouldProbe = !isDevRuntime || process.env.ZLEAP_DOCTOR_CHECK_MANIFEST === '1';
  const signed =
    Boolean(process.env.ZLEAP_MANIFEST_PUBLIC_KEY?.trim()) ||
    Boolean(process.env.ZLEAP_MANIFEST_PUBLIC_KEY_PATH?.trim());
  const required = process.env.ZLEAP_REQUIRE_MANIFEST_SIGNATURE === '1';
  const url = installManifestUrl();

  if (!shouldProbe) {
    return {
      name: 'Release Manifest',
      ok: true,
      detail: `开发模式跳过网络探测 · ${signed ? 'signed' : 'unsigned'} · ${url}`,
      critical: false,
    };
  }

  try {
    const manifest = await fetchRuntimeReleaseManifest({ signal: AbortSignal.timeout(5_000) });
    if (!manifest) {
      return {
        name: 'Release Manifest',
        ok: false,
        detail: `无法访问 manifest · ${signed ? 'signed' : 'unsigned'} · ${url}`,
        fix: '检查 Tauri updater manifest / 官网 CDN 配置，CLI 首装不依赖该 manifest',
        critical: false,
      };
    }
    const version = runtimeVersionFromManifest(manifest) ?? manifest.version ?? 'unknown';
    return {
      name: 'Release Manifest',
      ok: true,
      detail: `v${version} · ${signed ? 'signature verified' : required ? 'signature required' : 'unsigned compatibility'} · ${url}`,
      critical: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: 'Release Manifest',
      ok: false,
      detail: message,
      fix: error instanceof ManifestSignatureError
        ? '检查 updater manifest 公钥、signature 和 ZLEAP_REQUIRE_MANIFEST_SIGNATURE'
        : '检查 Tauri updater manifest URL 或稍后重试',
      critical: false,
    };
  }
}

async function lockCheck(name: string, path: string, staleFix: string): Promise<DoctorCheck> {
  const lock = await readLockFile(path);
  if (!lock) {
    return {
      name,
      ok: true,
      detail: '未锁定',
      critical: false,
    };
  }
  const alive = typeof lock.pid === 'number' && pidAlive(lock.pid);
  return {
    name,
    ok: false,
    detail: `${alive ? 'active' : 'stale'} · pid ${lock.pid ?? 'unknown'} · ${lock.owner ?? 'unknown'} · ${lock.acquiredAt ?? 'unknown'}`,
    fix: alive ? '等待当前操作完成后重试' : staleFix,
    critical: false,
  };
}

async function readLockFile(path: string): Promise<{ pid?: number; owner?: string; acquiredAt?: string } | undefined> {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as { pid?: number; owner?: string; acquiredAt?: string };
  } catch {
    return undefined;
  }
}

function pidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
