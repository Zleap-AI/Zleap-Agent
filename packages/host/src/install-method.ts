import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { zleapLayout, releasePlatformTag } from './layout.js';
import { isBundledInstall, resolveRepoRoot } from './paths.js';
import { readAppMetadata } from './upgrade.js';

export type InstallMethod = 'cli' | 'desktop' | 'dev';

export type InstallState = {
  method: InstallMethod;
  version: string;
  platform: string;
  installedAt: string;
};

export async function readInstallState(): Promise<InstallState | undefined> {
  const { installStatePath } = zleapLayout();
  try {
    const raw = await readFile(installStatePath, 'utf8');
    return JSON.parse(raw) as InstallState;
  } catch {
    return undefined;
  }
}

export async function writeInstallState(state: Partial<InstallState> & { method: InstallMethod }): Promise<InstallState> {
  const layout = zleapLayout();
  await mkdir(layout.stateDir, { recursive: true });
  const meta = await readAppMetadata();
  const full: InstallState = {
    version: state.version ?? meta?.version ?? '0.0.0',
    platform: state.platform ?? meta?.platform ?? releasePlatformTag(),
    installedAt: state.installedAt ?? new Date().toISOString(),
    ...state,
  };
  await writeFile(layout.installStatePath, `${JSON.stringify(full, null, 2)}\n`, 'utf8');
  return full;
}

export function detectInstallMethod(repoRoot = resolveRepoRoot()): InstallMethod {
  if (process.env.ZLEAP_INSTALL_METHOD === 'desktop') {
    return 'desktop';
  }
  if (process.env.ZLEAP_INSTALL_METHOD === 'cli') {
    return 'cli';
  }
  if (isBundledInstall(repoRoot)) {
    const layout = zleapLayout();
    if (existsSync(join(layout.current, 'packages', 'host', 'dist', 'serve-cli.js'))) {
      return process.env.ZLEAP_DESKTOP === '1' ? 'desktop' : 'cli';
    }
    return 'cli';
  }
  return 'dev';
}
