import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_DATABASE_URL,
  DEFAULT_EMBED_DIM,
} from './constants.js';
import {
  bundledServeEnv,
  loadDistributionConfig,
  webPort,
  type DistributionConfig,
} from './distribution.js';
import { loadServeEnvFiles } from './dotenv.js';
import { zleapLayout, releasePlatformTag, nodeToolsBin, postgresToolsBinDir } from './layout.js';
import { detectInstallMethod } from './install-method.js';
import { isBundledInstall, pgBinary, resolveRepoRoot } from './paths.js';
import { readAppMetadata, type AppMetadata } from './upgrade.js';

export type ResolvedRuntime = {
  repoRoot: string;
  bundled: boolean;
  method: ReturnType<typeof detectInstallMethod>;
  nodeBin: string;
  postgresBin?: string;
  entries: Record<string, string>;
  env: NodeJS.ProcessEnv;
};

function existsPgBin(dir: string): boolean {
  const pgCtl = process.platform === 'win32' ? join(dir, 'pg_ctl.exe') : join(dir, 'pg_ctl');
  const initdb = process.platform === 'win32' ? join(dir, 'initdb.exe') : join(dir, 'initdb');
  return existsSync(pgCtl) && existsSync(initdb);
}

function isZleapManagedNodeBin(nodeBin: string, repoRoot: string): boolean {
  const normalized = nodeBin.trim();
  if (!normalized) {
    return false;
  }
  const home = zleapLayout().home;
  const managedRoots = [
    home,
    join(repoRoot, 'node'),
    process.env.ZLEAP_APP_ROOT?.trim(),
    process.env.ZLEAP_RUNTIME_ROOT?.trim(),
  ].filter((value): value is string => Boolean(value));
  return managedRoots.some(
    (root) => normalized === root || normalized.startsWith(`${root}/`) || normalized.startsWith(`${root}\\`),
  );
}

export function resolveNodeBin(repoRoot: string): string {
  // Monorepo dev: use the Node that launched pnpm/node — ignore foreign ZLEAP_NODE_BIN
  // (e.g. Hermes ~/.hermes/node leaked into the shell).
  if (detectInstallMethod(repoRoot) === 'dev') {
    return process.execPath;
  }

  const explicit = process.env.ZLEAP_NODE_BIN?.trim();
  if (explicit && existsSync(explicit) && isZleapManagedNodeBin(explicit, repoRoot)) {
    return explicit;
  }
  const candidates = [
    nodeToolsBin(process.env.ZLEAP_NODE_VERSION?.trim() || loadDistributionConfig(repoRoot).runtime.nodeVersion),
    join(repoRoot, 'node', 'bin', 'node'),
    join(repoRoot, 'node', 'node.exe'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return process.execPath;
}

export function resolvePostgresBin(repoRoot = zleapLayout().current): string | undefined {
  const explicit = process.env.ZLEAP_BUNDLED_PG_BIN ?? process.env.ZLEAP_PG_BIN;
  if (explicit && existsPgBin(explicit)) {
    return explicit;
  }
  const platformDir = releasePlatformTag();
  const layout = zleapLayout();
  const candidates = [
    postgresToolsBinDir(layout.home, platformDir),
    join(repoRoot, 'postgres', platformDir, 'bin'),
    join(layout.appRoot, 'postgres', platformDir, 'bin'),
    join(layout.current, 'postgres', platformDir, 'bin'),
  ];
  for (const candidate of candidates) {
    if (existsPgBin(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export function defaultServiceEntries(repoRoot: string): Record<string, string> {
  if (existsSync(join(repoRoot, 'runtime', 'node_modules', '@zleap', 'host', 'dist', 'serve-cli.js'))) {
    return {
      serve: 'node runtime/node_modules/@zleap/host/dist/serve-cli.js',
      control: 'node runtime/node_modules/@zleap/host/dist/control-cli.js',
      web: 'node web/packages/web/server.js',
      worker: 'node runtime/node_modules/@zleap/tasks/dist/worker.js',
      gateway: 'node runtime/node_modules/@zleap/gateway/dist/worker.js',
    };
  }
  return {
    serve: 'node packages/host/dist/serve-cli.js',
    control: 'node packages/host/dist/control-cli.js',
    web: 'node packages/web/server.js',
    worker: existsSync(join(repoRoot, 'tasks', 'dist', 'worker.js'))
      ? 'node tasks/dist/worker.js'
      : 'node packages/tasks/dist/worker.js',
    gateway: existsSync(join(repoRoot, 'gateway', 'dist', 'worker.js'))
      ? 'node gateway/dist/worker.js'
      : 'node packages/gateway/dist/worker.js',
  };
}

export async function resolveServiceEntries(repoRoot: string): Promise<Record<string, string>> {
  if (!isBundledInstall(repoRoot)) {
    return defaultServiceEntries(repoRoot);
  }
  const meta = await readAppMetadata();
  const entries = meta?.entries ?? meta?.entry;
  if (entries && Object.keys(entries).length > 0) {
    return entries;
  }
  return defaultServiceEntries(repoRoot);
}

/** Parse `node path/to/script.js` entry into script path relative to repoRoot. */
export function resolveScriptFromEntry(repoRoot: string, entry: string): string {
  const trimmed = entry.trim();
  const withoutNode = trimmed.startsWith('node ') ? trimmed.slice(5).trim() : trimmed;
  const absolute = join(repoRoot, withoutNode);
  if (existsSync(absolute)) {
    return absolute;
  }
  throw new Error(`Service entry not found: ${entry} (resolved ${absolute})`);
}

export function buildRuntimeEnv(
  overrides: NodeJS.ProcessEnv = {},
  config: DistributionConfig = loadDistributionConfig(overrides.ZLEAP_REPO_ROOT ?? resolveRepoRoot()),
): NodeJS.ProcessEnv {
  const repoRoot = overrides.ZLEAP_REPO_ROOT ?? process.env.ZLEAP_REPO_ROOT ?? resolveRepoRoot();
  loadServeEnvFiles(repoRoot);
  const layout = zleapLayout();
  const bundled = isBundledInstall(repoRoot);
  const method = detectInstallMethod(repoRoot);
  const databaseUrl =
    overrides.ZLEAP_DATABASE_URL ??
    overrides.DATABASE_URL ??
    process.env.ZLEAP_DATABASE_URL ??
    process.env.DATABASE_URL ??
    DEFAULT_DATABASE_URL;
  const embedDim =
    overrides.ZLEAP_EMBED_DIM ?? process.env.ZLEAP_EMBED_DIM ?? DEFAULT_EMBED_DIM;
  const port = String(overrides.ZLEAP_WEB_PORT ?? process.env.ZLEAP_WEB_PORT ?? webPort(config));
  const nodeBin = resolveNodeBin(repoRoot);
  const pgBin = resolvePostgresBin(repoRoot);
  const serveMode =
    overrides.ZLEAP_SERVE_MODE ??
    process.env.ZLEAP_SERVE_MODE ??
    (bundled || method !== 'dev' ? config.runtime.serveMode : undefined);
  const authMode =
    overrides.ZLEAP_AUTH_MODE ??
    process.env.ZLEAP_AUTH_MODE ??
    (bundled || serveMode === 'production' ? config.runtime.authMode : undefined);
  const gateway =
    overrides.ZLEAP_GATEWAY ??
    process.env.ZLEAP_GATEWAY ??
    (bundled || method !== 'dev' ? (config.runtime.gateway ? '1' : '0') : undefined);

  const base: NodeJS.ProcessEnv = {
    ...process.env,
    ...overrides,
    ZLEAP_HOME: overrides.ZLEAP_HOME ?? process.env.ZLEAP_HOME ?? layout.home,
    ZLEAP_REPO_ROOT: repoRoot,
    ZLEAP_RUNTIME_ROOT: overrides.ZLEAP_RUNTIME_ROOT ?? process.env.ZLEAP_RUNTIME_ROOT ?? layout.appRoot,
    ZLEAP_NODE_BIN: nodeBin,
    ...(bundled ? { ZLEAP_APP_ROOT: overrides.ZLEAP_APP_ROOT ?? process.env.ZLEAP_APP_ROOT ?? repoRoot } : {}),
    ...(serveMode ? { ZLEAP_SERVE_MODE: serveMode } : {}),
    ...(authMode ? { ZLEAP_AUTH_MODE: authMode } : {}),
    ...(gateway ? { ZLEAP_GATEWAY: gateway } : {}),
    ...(pgBin ? { ZLEAP_BUNDLED_PG_BIN: pgBin } : {}),
    ...(bundled && process.env.ZLEAP_SKIP_BUILD !== '0' ? { ZLEAP_SKIP_BUILD: '1' } : {}),
    NODE_ENV: overrides.NODE_ENV ?? process.env.NODE_ENV ?? (serveMode === 'production' ? 'production' : 'development'),
    DATABASE_URL: databaseUrl,
    ZLEAP_DATABASE_URL: databaseUrl,
    ZLEAP_EMBED_DIM: embedDim,
    PORT: port,
    ZLEAP_WEB_PORT: port,
  };

  if (bundled) {
    return { ...base, ...bundledServeEnv(repoRoot) };
  }
  return base;
}

export async function resolveRuntime(overrides: NodeJS.ProcessEnv = {}): Promise<ResolvedRuntime> {
  const repoRoot = overrides.ZLEAP_REPO_ROOT ?? resolveRepoRoot();
  const env = buildRuntimeEnv(overrides);
  const entries = await resolveServiceEntries(repoRoot);
  return {
    repoRoot,
    bundled: isBundledInstall(repoRoot),
    method: detectInstallMethod(repoRoot),
    nodeBin: resolveNodeBin(repoRoot),
    postgresBin: resolvePostgresBin(repoRoot),
    entries,
    env,
  };
}

export { pgBinary };
