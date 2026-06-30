import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeBootstrapState } from './bootstrap-state.js';
import { releasePlatformTag, zleapLayout } from './layout.js';
import { compareVersions, isAppComplete } from './app-layout.js';
import { readAppMetadata, swapApp, type AppMetadata } from './upgrade.js';
import { assertRuntimeUpdateAllowed } from './update-preflight.js';

export type SeedAppResult = {
  seeded: boolean;
  appRoot: string;
  version: string;
  reason: 'already-current' | 'seeded-from-bundle' | 'no-bundle';
};

async function readBundleMetadata(bundledRoot: string): Promise<AppMetadata | undefined> {
  const candidates = [join(dirname(bundledRoot), 'metadata.json'), join(bundledRoot, 'metadata.json')];
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

/** Seed ~/.zleap/app/current from a desktop bundle or other local app tree. */
export async function seedAppFromBundle(bundledRoot: string): Promise<SeedAppResult> {
  const layout = zleapLayout();
  const current = layout.current;

  if (!isAppComplete(bundledRoot, 'desktop')) {
    return { seeded: false, appRoot: current, version: '', reason: 'no-bundle' };
  }

  const bundledMeta = await readBundleMetadata(bundledRoot);
  if (!bundledMeta?.version) {
    throw new Error(`Bundle metadata missing at ${bundledRoot}`);
  }

  const currentMeta = await readAppMetadata();
  const versionCompare = currentMeta?.version ? compareVersions(bundledMeta.version, currentMeta.version) : 1;
  const sameBuild = versionCompare === 0 && !!bundledMeta.builtAt && bundledMeta.builtAt === currentMeta?.builtAt;
  if (isAppComplete(current, 'base') && currentMeta?.version && (versionCompare < 0 || sameBuild)) {
    return {
      seeded: false,
      appRoot: current,
      version: currentMeta.version,
      reason: 'already-current',
    };
  }
  assertRuntimeUpdateAllowed(currentMeta, bundledMeta);

  await swapApp(bundledRoot, bundledMeta);
  await writeBootstrapState({
    completedAt: new Date().toISOString(),
    version: bundledMeta.version,
    platform: bundledMeta.platform ?? releasePlatformTag(),
    seededFrom: bundledRoot,
    method: 'desktop',
  });

  return {
    seeded: true,
    appRoot: current,
    version: bundledMeta.version,
    reason: 'seeded-from-bundle',
  };
}
