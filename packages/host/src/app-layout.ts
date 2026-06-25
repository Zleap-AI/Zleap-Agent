import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { releasePlatformTag } from './layout.js';
import { normalizeVersion } from './distribution.js';

export type AppTarget = 'base' | 'cli' | 'desktop';

export type AppManifest = {
  version?: string;
  platform?: string;
  kind?: 'app' | string;
  features?: Partial<Record<'node' | 'postgres' | 'web' | 'tasks' | 'gateway' | 'cli', boolean>>;
  deps?: Partial<Record<'node' | 'postgres', { managed?: boolean; version?: string; archive?: string; sha256?: string }>>;
  entries?: Partial<Record<'serve' | 'control' | 'web' | 'worker' | 'gateway' | 'cli', string>>;
};

const BASE_REQUIRED = [
  'runtime/node_modules/@zleap/host/dist/serve-cli.js',
  'runtime/node_modules/@zleap/host/dist/desktop-bootstrap-cli.js',
  'runtime/node_modules/@zleap/host/dist/control-cli.js',
  'runtime/node_modules/@zleap/store/dist/migrate.js',
  'web/packages/web/server.js',
  'distribution.json',
] as const;

export function readAppManifest(appRoot: string): AppManifest | undefined {
  for (const rel of ['manifest.json', 'metadata.json']) {
    try {
      return JSON.parse(readFileSync(join(appRoot, rel), 'utf8')) as AppManifest;
    } catch {
      // try next
    }
  }
  return undefined;
}

export function appChecks(appRoot: string, target: AppTarget = 'base'): string[] {
  const manifest = readAppManifest(appRoot);
  const features = manifest?.features ?? {};
  const missing: string[] = [];

  for (const rel of BASE_REQUIRED) {
    requirePath(appRoot, rel, missing);
  }

  if (target === 'cli' || features.cli === true) {
    requirePath(appRoot, 'runtime/node_modules/@zleap-ai/cli/dist/index.js', missing);
  }

  if (target !== 'desktop' || features.tasks !== false) {
    requirePath(appRoot, 'runtime/node_modules/@zleap/tasks/dist/worker.js', missing);
  }

  if (features.gateway !== false) {
    requirePath(appRoot, 'runtime/node_modules/@zleap/gateway/dist/worker.js', missing);
  }

  if (features.node !== false && manifest?.deps?.node?.managed !== true) {
    const nodeRel = process.platform === 'win32' ? 'node/node.exe' : 'node/bin/node';
    requirePath(appRoot, nodeRel, missing);
  }

  if (features.postgres === true && manifest?.deps?.postgres?.managed !== true) {
    const pgBin = join('postgres', releasePlatformTag(), 'bin');
    requirePath(appRoot, process.platform === 'win32' ? join(pgBin, 'pg_ctl.exe') : join(pgBin, 'pg_ctl'), missing);
    requirePath(appRoot, process.platform === 'win32' ? join(pgBin, 'initdb.exe') : join(pgBin, 'initdb'), missing);
  }

  return missing;
}

export function isAppComplete(appRoot: string, target: AppTarget = 'base'): boolean {
  return appChecks(appRoot, target).length === 0;
}

/** Semver-ish compare: returns negative if a < b, 0 if equal, positive if a > b. */
export function compareVersions(a: string, b: string): number {
  const pa = normalizeVersion(a).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const pb = normalizeVersion(b).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) {
      return da - db;
    }
  }
  return 0;
}

function requirePath(appRoot: string, rel: string, missing: string[]): void {
  if (!existsSync(join(appRoot, rel))) {
    missing.push(rel);
  }
}
