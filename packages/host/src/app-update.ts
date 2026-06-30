import { normalizeVersion } from './distribution.js';
import {
  fetchRuntimeReleaseManifest,
  runtimeVersionFromManifest,
  type RuntimeReleaseManifest,
} from './release-manifest.js';
import { runUpdate } from './update-engine.js';
import { compareVersions } from './app-layout.js';
import { readAppMetadata } from './upgrade.js';

export type LatestManifest = RuntimeReleaseManifest;

export async function fetchLatestManifest(): Promise<LatestManifest | undefined> {
  return fetchRuntimeReleaseManifest();
}

export async function ensureAppUpToDate(options: { autoUpdate?: boolean } = {}): Promise<{
  upToDate: boolean;
  currentVersion?: string;
  latestVersion?: string;
  updated: boolean;
  blocked?: boolean;
  error?: string;
}> {
  const current = await readAppMetadata();
  const manifest = await fetchLatestManifest();
  const latestVersion = normalizeVersion(runtimeVersionFromManifest(manifest) ?? '');
  const currentVersion = current?.version ? normalizeVersion(current.version) : undefined;

  if (!latestVersion) {
    return { upToDate: true, currentVersion, updated: false };
  }

  if (currentVersion && compareVersions(currentVersion, latestVersion) >= 0) {
    return { upToDate: true, currentVersion, latestVersion, updated: false };
  }

  const runtime = manifest?.runtime;
  if (
    (runtime?.nodeVersion && current?.nodeVersion && runtime.nodeVersion !== current.nodeVersion) ||
    (runtime?.postgresVersion && current?.postgresVersion && runtime.postgresVersion !== current.postgresVersion) ||
    (runtime?.pgvectorVersion && current?.pgvectorVersion && runtime.pgvectorVersion !== current.pgvectorVersion)
  ) {
    return {
      upToDate: false,
      currentVersion,
      latestVersion,
      updated: false,
      blocked: true,
      error: '新版包含 Node/Postgres runtime 依赖变更，请通过 npm reinstall、安装脚本或新版 Desktop 安装包执行 full payload 更新。',
    };
  }

  if (!options.autoUpdate) {
    return { upToDate: false, currentVersion, latestVersion, updated: false };
  }

  try {
    await runUpdate({ version: latestVersion });
    return { upToDate: true, currentVersion, latestVersion, updated: true };
  } catch (error) {
    return {
      upToDate: false,
      currentVersion,
      latestVersion,
      updated: false,
      blocked: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
