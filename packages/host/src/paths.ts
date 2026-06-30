import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  releasePlatformTag,
  resolveServeStatePath,
  zleapHome,
  zleapLayout,
  postgresToolsBinDir,
} from './layout.js';
import { isAppComplete } from './app-layout.js';

function devMonorepoRoot(start = import.meta.url): string {
  const here = dirname(fileURLToPath(start));
  return dirname(dirname(dirname(here)));
}

/** Canonical runtime root: ~/.zleap/app/current in production, monorepo in dev. */
export function resolveRuntimeRoot(start = import.meta.url): string {
  if (process.env.ZLEAP_REPO_ROOT?.trim()) {
    return process.env.ZLEAP_REPO_ROOT.trim();
  }
  if (process.env.ZLEAP_APP_ROOT?.trim()) {
    return process.env.ZLEAP_APP_ROOT.trim();
  }

  const devRoot = devMonorepoRoot(start);
  if (isDevMonorepoRoot(devRoot)) {
    return devRoot;
  }

  const layout = zleapLayout();
  if (isAppComplete(layout.current, 'base')) {
    return layout.current;
  }

  const bundled = process.env.ZLEAP_BUNDLED_ROOT?.trim();
  if (bundled && isAppComplete(bundled, 'base')) {
    return bundled;
  }

  return devRoot;
}

/** @deprecated alias — use resolveRuntimeRoot */
export function resolveRepoRoot(start = import.meta.url): string {
  return resolveRuntimeRoot(start);
}

export function resolveBundledRoot(): string | undefined {
  const bundled = process.env.ZLEAP_BUNDLED_ROOT?.trim();
  if (bundled && existsSync(bundled)) {
    return bundled;
  }
  return undefined;
}

export { zleapHome, releasePlatformTag } from './layout.js';

export function runtimeRoot(): string {
  return zleapLayout().appRoot;
}

export function serveStatePath(): string {
  return resolveServeStatePath();
}

export function bundledAppRoot(): string {
  return zleapLayout().current;
}

export function appMetadataPath(): string {
  return zleapLayout().metadataPath;
}

/** True when running from a packaged app (not monorepo dev tree). */
export function isBundledInstall(repoRoot = resolveRuntimeRoot()): boolean {
  if (process.env.ZLEAP_APP_ROOT?.trim() || process.env.ZLEAP_BUNDLED_ROOT?.trim()) {
    if (isAppComplete(repoRoot, 'base')) {
      return true;
    }
  }
  if (process.env.ZLEAP_SKIP_BUILD === '1' || process.env.ZLEAP_SERVE_MODE === 'production') {
    if (existsSync(join(repoRoot, 'node', 'bin', 'node')) || existsSync(join(repoRoot, 'node', 'node.exe'))) {
      return true;
    }
    if (existsSync(join(repoRoot, 'web', 'server.js'))) {
      return true;
    }
  }
  return existsSync(join(repoRoot, 'web', 'server.js')) && !existsSync(join(repoRoot, 'packages', 'web', 'package.json'));
}

function isDevMonorepoRoot(root: string): boolean {
  return (
    existsSync(join(root, 'pnpm-workspace.yaml')) &&
    existsSync(join(root, 'packages', 'runtime', 'package.json')) &&
    existsSync(join(root, 'packages', 'cli', 'package.json'))
  );
}

export function resolveBundledNodeBin(repoRoot = bundledAppRoot()): string | undefined {
  const explicit = process.env.ZLEAP_NODE_BIN?.trim();
  if (explicit && existsSync(explicit)) {
    const home = zleapHome();
    const managedRoots = [home, join(repoRoot, 'node'), process.env.ZLEAP_APP_ROOT?.trim()].filter(
      (value): value is string => Boolean(value),
    );
    const trusted = managedRoots.some(
      (root) => explicit === root || explicit.startsWith(`${root}/`) || explicit.startsWith(`${root}\\`),
    );
    if (trusted) {
      return explicit;
    }
  }
  const candidates = [
    join(repoRoot, 'node', 'bin', 'node'),
    join(repoRoot, 'node', 'node.exe'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** Portable Postgres shipped with desktop / release tarball. */
export function resolveBundledPostgresBin(repoRoot = bundledAppRoot()): string | undefined {
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

function existsPgBin(dir: string): boolean {
  const pgCtl = process.platform === 'win32' ? join(dir, 'pg_ctl.exe') : join(dir, 'pg_ctl');
  const initdb = process.platform === 'win32' ? join(dir, 'initdb.exe') : join(dir, 'initdb');
  return existsSync(pgCtl) && existsSync(initdb);
}

export function pgBinary(name: string, pgBin: string): string {
  if (process.platform === 'win32' && !name.endsWith('.exe')) {
    return join(pgBin, `${name}.exe`);
  }
  return join(pgBin, name);
}
