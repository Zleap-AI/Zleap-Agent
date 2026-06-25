import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  nodeToolsBin,
  nodeToolsPlatformRoot,
  postgresToolsBinDir,
  postgresToolsPlatformRoot,
  releasePlatformTag,
  zleapLayout,
} from './layout.js';
import { writeBootstrapState } from './bootstrap-state.js';
import { writeInstallState, type InstallMethod } from './install-method.js';
import { writeRuntimeState } from './runtime-state.js';
import { swapApp, validateAppStaging, type AppMetadata } from './upgrade.js';

export type PayloadInstallSource = Extract<InstallMethod, 'cli' | 'desktop'> | 'npm';

export type InstallPayloadOptions = {
  payloadDir: string;
  home?: string;
  source: PayloadInstallSource;
};

export type InstallPayloadResult = {
  appRoot: string;
  version: string;
  platform: string;
  installed: boolean;
  source: PayloadInstallSource;
};

type PayloadManifest = AppMetadata & {
  nodeVersion?: string;
  postgresVersion?: string;
  payload?: {
    files?: Record<string, { sha256?: string; size?: number }>;
  };
};

export async function installPayload(options: InstallPayloadOptions): Promise<InstallPayloadResult> {
  return withOptionalHome(options.home, async () => {
    const payloadDir = options.payloadDir;
    const manifest = await readPayloadManifest(payloadDir);
    await verifyPayload(payloadDir, manifest);

    const nodeVersion = manifest.nodeVersion;
    if (!nodeVersion) {
      throw new Error('Payload manifest missing nodeVersion');
    }

    await installNodeArchive(join(payloadDir, 'node.tar.gz'), nodeVersion);
    await installPostgresArchive(join(payloadDir, 'postgres.tar.gz'));

    const layout = zleapLayout();
    const currentMeta = await readInstalledMetadata(layout.metadataPath);
    const upToDate =
      currentMeta?.version === manifest.version &&
      currentMeta?.builtAt &&
      currentMeta.builtAt === manifest.builtAt &&
      existsSync(join(layout.current, 'packages', 'host', 'dist', 'serve-cli.js'));

    if (!upToDate) {
      const tmp = await mkdtemp(join(tmpdir(), 'zleap-payload-app-'));
      try {
        await extractArchive(join(payloadDir, 'app.tar.gz'), tmp);
        const appDir = join(tmp, 'app');
        await validateAppStaging(appDir, manifest);
        await swapApp(appDir, manifest);
      } finally {
        await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      }
    }

    await writeInstallState({
      method: options.source === 'desktop' ? 'desktop' : 'cli',
      version: manifest.version,
      platform: manifest.platform,
    });
    await writeRuntimeState({
      runtimeRoot: layout.current,
      version: manifest.version,
      platform: manifest.platform,
    });
    await writeBootstrapState({
      completedAt: new Date().toISOString(),
      version: manifest.version,
      platform: manifest.platform,
      method: options.source === 'desktop' ? 'desktop' : 'cli',
      seededFrom: payloadDir,
    });

    return {
      appRoot: layout.current,
      version: manifest.version,
      platform: manifest.platform ?? releasePlatformTag(),
      installed: !upToDate,
      source: options.source,
    };
  });
}

async function withOptionalHome<T>(home: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!home?.trim()) {
    return fn();
  }
  const previous = process.env.ZLEAP_HOME;
  process.env.ZLEAP_HOME = home;
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.ZLEAP_HOME;
    } else {
      process.env.ZLEAP_HOME = previous;
    }
  }
}

async function readPayloadManifest(payloadDir: string): Promise<PayloadManifest> {
  const manifest = JSON.parse(await readFile(join(payloadDir, 'manifest.json'), 'utf8')) as PayloadManifest;
  if (!manifest.version || !manifest.platform || !manifest.builtAt) {
    throw new Error('Payload manifest must include version/platform/builtAt');
  }
  return manifest;
}

async function verifyPayload(payloadDir: string, manifest: PayloadManifest): Promise<void> {
  const sums = await readChecksums(join(payloadDir, 'SHA256SUMS'));
  for (const name of ['app.tar.gz', 'node.tar.gz', 'postgres.tar.gz', 'manifest.json']) {
    const file = join(payloadDir, name);
    if (!existsSync(file)) {
      throw new Error(`Payload missing ${name}`);
    }
    const actual = await sha256File(file);
    const expected = sums.get(name) ?? manifest.payload?.files?.[name]?.sha256;
    if (!expected) {
      throw new Error(`Payload missing checksum for ${name}`);
    }
    if (expected !== actual) {
      throw new Error(`Payload checksum mismatch for ${name}`);
    }
    const expectedSize = manifest.payload?.files?.[name]?.size;
    if (typeof expectedSize === 'number' && expectedSize !== statSync(file).size) {
      throw new Error(`Payload size mismatch for ${name}`);
    }
  }
}

async function readChecksums(path: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const raw = await readFile(path, 'utf8');
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const [hash, name] = line.trim().split(/\s+/, 2);
    if (hash && name) {
      map.set(name, hash);
    }
  }
  return map;
}

async function installNodeArchive(archive: string, version: string): Promise<void> {
  const nodeBin = nodeToolsBin(version);
  if (existsSync(nodeBin)) {
    return;
  }
  const root = nodeToolsPlatformRoot(version);
  const parent = join(root, '..');
  await mkdir(parent, { recursive: true });
  const tmp = await mkdtemp(join(tmpdir(), 'zleap-node-payload-'));
  try {
    await extractArchive(archive, tmp);
    const extracted = findChildRoot(tmp, (candidate) => existsSync(nodeBinInRoot(candidate)));
    if (!extracted) {
      throw new Error('node.tar.gz did not contain a Node executable');
    }
    await rm(root, { recursive: true, force: true });
    await cp(extracted, root, { recursive: true });
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function installPostgresArchive(archive: string): Promise<void> {
  const bin = postgresToolsBinDir();
  if (existsPostgresBin(bin)) {
    return;
  }
  const root = postgresToolsPlatformRoot();
  const parent = join(root, '..');
  await mkdir(parent, { recursive: true });
  const tmp = await mkdtemp(join(tmpdir(), 'zleap-postgres-payload-'));
  try {
    await extractArchive(archive, tmp);
    const extracted = findChildRoot(tmp, (candidate) => existsPostgresBin(join(candidate, 'bin')));
    if (!extracted) {
      throw new Error('postgres.tar.gz did not contain bin/pg_ctl and bin/initdb');
    }
    await rm(root, { recursive: true, force: true });
    await cp(extracted, root, { recursive: true });
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

function findChildRoot(root: string, predicate: (candidate: string) => boolean): string | undefined {
  if (predicate(root)) {
    return root;
  }
  const entries = safeReaddir(root);
  for (const name of entries) {
    const candidate = join(root, name);
    if (predicate(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function safeReaddir(dir: string): string[] {
  try {
    return statSync(dir).isDirectory() ? readdirSync(dir) : [];
  } catch {
    return [];
  }
}

function nodeBinInRoot(root: string): string {
  return process.platform === 'win32' ? join(root, 'node.exe') : join(root, 'bin', 'node');
}

function existsPostgresBin(bin: string): boolean {
  const pgCtl = process.platform === 'win32' ? join(bin, 'pg_ctl.exe') : join(bin, 'pg_ctl');
  const initdb = process.platform === 'win32' ? join(bin, 'initdb.exe') : join(bin, 'initdb');
  return existsSync(pgCtl) && existsSync(initdb);
}

async function extractArchive(archive: string, dest: string): Promise<void> {
  await run('tar', ['-xzf', archive, '-C', dest]);
}

async function sha256File(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function readInstalledMetadata(path: string): Promise<AppMetadata | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as AppMetadata;
  } catch {
    return undefined;
  }
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', shell: process.platform === 'win32' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited ${code}`))));
    child.on('error', reject);
  });
}
