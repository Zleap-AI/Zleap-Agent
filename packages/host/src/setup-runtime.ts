import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeInstallState, type InstallMethod } from './install-method.js';
import { installAppFromRelease, type InstallAppOptions, type InstallAppResult } from './install.js';
import { installPayload } from './payload.js';
import { resolvePayloadDir, type DownloadProgress } from './payload-fetch.js';
import { zleapLayout } from './layout.js';
import { resolveRuntimeRoot } from './paths.js';
import { seedAppFromBundle } from './seed-app.js';
import { appChecks, type AppTarget } from './app-layout.js';
import { readAppMetadata, type AppMetadata } from './upgrade.js';
import { writeRuntimeState } from './runtime-state.js';

export type EnsureRuntimeSource = 'dev' | 'existing' | 'embedded' | 'download';

export type EnsureRuntimeInstalledOptions = {
  method?: InstallMethod;
  bundledRoot?: string;
  payloadDir?: string;
  downloadIfMissing?: boolean;
  version?: string;
  skipChecksum?: boolean;
  installApp?: (options?: InstallAppOptions) => Promise<InstallAppResult>;
  onDownloadProgress?: (progress: DownloadProgress) => void;
};

export type EnsureRuntimeInstalledResult = {
  appRoot: string;
  source: EnsureRuntimeSource;
  installed: boolean;
  repaired: boolean;
  version?: string;
  platform?: string;
  missing?: string[];
};

export async function ensureRuntimeInstalled(
  options: EnsureRuntimeInstalledOptions = {},
): Promise<EnsureRuntimeInstalledResult> {
  await ensureRuntimeLayoutDirs();

  const layout = zleapLayout();
  const resolved = resolveRuntimeRoot();
  if (isDevRuntimeRoot(resolved) && !process.env.ZLEAP_APP_ROOT?.trim()) {
    return {
      appRoot: resolved,
      source: 'dev',
      installed: false,
      repaired: false,
    };
  }

  if (options.bundledRoot) {
    const seed = await seedAppFromBundle(options.bundledRoot);
    if (seed.reason !== 'no-bundle') {
      const meta = await readAppMetadata();
      await persistRuntimeInstallState(options.method ?? 'desktop', layout.current, meta?.version, meta?.platform);
      return {
        appRoot: layout.current,
        source: seed.seeded ? 'embedded' : 'existing',
        installed: seed.seeded,
        repaired: seed.seeded,
        version: meta?.version ?? seed.version,
        platform: meta?.platform,
      };
    }
  }

  if (options.payloadDir) {
    // Skip re-materializing (and re-downloading) the payload when the runtime is
    // already installed at the expected version. Without this, slim desktop bundles
    // re-download the full payload from GitHub on every launch because the bundled
    // resources only carry download.json, never the app itself.
    const target = appTargetForMethod(options.method);
    const expected = await readPayloadDirMetadata(options.payloadDir);
    const installedMeta = await readAppMetadata();
    const alreadyCurrent =
      Boolean(expected?.version) &&
      installedMeta?.version === expected?.version &&
      appChecks(layout.current, target).length === 0;
    if (alreadyCurrent) {
      await persistRuntimeInstallState(
        options.method ?? 'cli',
        layout.current,
        installedMeta?.version,
        installedMeta?.platform,
      );
      return {
        appRoot: layout.current,
        source: 'existing',
        installed: false,
        repaired: false,
        version: installedMeta?.version,
        platform: installedMeta?.platform,
      };
    }

    const materialized = await resolvePayloadDir(options.payloadDir, options.downloadIfMissing === true, {
      onProgress: options.onDownloadProgress,
    });
    try {
      const installed = await installPayload({
        payloadDir: materialized.payloadDir,
        source: options.method === 'desktop' ? 'desktop' : 'npm',
      });
      const meta = await readAppMetadata();
      await persistRuntimeInstallState(
        options.method ?? 'cli',
        layout.current,
        meta?.version ?? installed.version,
        meta?.platform ?? installed.platform,
      );
      return {
        appRoot: installed.appRoot,
        source: materialized.cleanupDir ? 'download' : 'embedded',
        installed: installed.installed,
        repaired: installed.installed,
        version: meta?.version ?? installed.version,
        platform: meta?.platform ?? installed.platform,
      };
    } finally {
      if (materialized.cleanupDir) {
        await rm(materialized.cleanupDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  const target = appTargetForMethod(options.method);
  const missing = appChecks(layout.current, target);
  if (missing.length === 0) {
    const meta = await readAppMetadata();
    await persistRuntimeInstallState(options.method ?? 'cli', layout.current, meta?.version, meta?.platform);
    return {
      appRoot: layout.current,
      source: 'existing',
      installed: false,
      repaired: false,
      version: meta?.version,
      platform: meta?.platform,
    };
  }

  if (options.downloadIfMissing !== true) {
    throw new Error(`Runtime 不完整：${missing.join(', ')}`);
  }

  const install = options.installApp ?? installAppFromRelease;
  await install({ version: options.version, skipChecksum: options.skipChecksum });
  const afterMissing = appChecks(layout.current, target);
  if (afterMissing.length > 0) {
    throw new Error(`Runtime 安装后仍不完整：${afterMissing.join(', ')}`);
  }

  const meta = await readAppMetadata();
  await persistRuntimeInstallState(options.method ?? 'cli', layout.current, meta?.version, meta?.platform);
  return {
    appRoot: layout.current,
    source: 'download',
    installed: true,
    repaired: missing.length > 0,
    version: meta?.version,
    platform: meta?.platform,
    missing,
  };
}

function appTargetForMethod(method: InstallMethod | undefined): AppTarget {
  return method === 'desktop' ? 'desktop' : 'cli';
}

async function readPayloadDirMetadata(payloadDir: string): Promise<AppMetadata | undefined> {
  for (const file of ['metadata.json', 'manifest.json']) {
    try {
      const raw = await readFile(join(payloadDir, file), 'utf8');
      return JSON.parse(raw) as AppMetadata;
    } catch {
      // try next candidate
    }
  }
  return undefined;
}

function isDevRuntimeRoot(root: string): boolean {
  return (
    existsSync(join(root, 'pnpm-workspace.yaml')) &&
    existsSync(join(root, 'packages', 'runtime', 'package.json')) &&
    existsSync(join(root, 'packages', 'cli', 'package.json'))
  );
}

async function ensureRuntimeLayoutDirs(): Promise<void> {
  const layout = zleapLayout();
  await mkdir(layout.stateDir, { recursive: true });
  await mkdir(layout.dataDir, { recursive: true });
  await mkdir(layout.configDir, { recursive: true });
  await mkdir(layout.logsDir, { recursive: true });
}

async function persistRuntimeInstallState(
  method: InstallMethod,
  appRoot: string,
  version?: string,
  platform?: string,
): Promise<void> {
  await writeInstallState({ method, version, platform });
  await writeRuntimeState({ runtimeRoot: appRoot, version, platform });
}
