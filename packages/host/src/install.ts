import { rm } from 'node:fs/promises';
import {
  downloadAppArchive,
  readAppMetadata,
  swapApp,
  type UpgradeResult,
} from './upgrade.js';
import { fetchRuntimeReleaseManifest, runtimeVersionFromManifest } from './release-manifest.js';
import { assertRuntimeUpdateAllowed, type RuntimeUpdatePolicy } from './update-preflight.js';

export type InstallAppOptions = RuntimeUpdatePolicy & {
  version?: string;
  checkOnly?: boolean;
  skipChecksum?: boolean;
};

export type InstallAppResult = UpgradeResult & {
  checked?: boolean;
  upToDate?: boolean;
};

/** Download a release app and atomically swap `~/.zleap/app/current`. */
export async function installAppFromRelease(options: InstallAppOptions = {}): Promise<InstallAppResult> {
  const current = await readAppMetadata();
  const manifest = await fetchRuntimeReleaseManifest();
  const targetVersion = options.version
    ? options.version.replace(/^v/, '')
    : runtimeVersionFromManifest(manifest);
  if (!targetVersion) {
    throw new Error('Release manifest is unavailable or missing runtime.version');
  }
  assertRuntimeUpdateAllowed(
    current,
    {
      version: targetVersion,
      schemaVersion: manifest?.runtime?.schemaVersion,
    },
    options,
  );

  if (options.checkOnly) {
    return {
      previousVersion: current?.version,
      newVersion: targetVersion,
      restarted: false,
      checked: true,
      upToDate: current?.version === targetVersion,
    };
  }

  if (current?.version === targetVersion) {
    return {
      previousVersion: current.version,
      newVersion: targetVersion,
      restarted: false,
      upToDate: true,
    };
  }

  const { tmpDir, metadata, stagingAppDir } = await downloadAppArchive(targetVersion, {
    manifest,
    skipChecksum: options.skipChecksum,
  });
  try {
    assertRuntimeUpdateAllowed(current, metadata, options);
    return await swapApp(stagingAppDir, metadata);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
