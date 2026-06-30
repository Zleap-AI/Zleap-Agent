#!/usr/bin/env node
import { createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { get as httpsGet } from 'node:https';
import { pipeline } from 'node:stream/promises';
import { createRequire } from 'node:module';

const requireFromHere = createRequire(import.meta.url);

// Resolve the installed platform package directory via Node module resolution so
// it is found whether npm hoists it to a sibling scope or nests it under the
// CLI's own node_modules. The thin platform package has no exports map, so
// resolving its package.json is always allowed.
function resolvePlatformPackageRoot(): string | undefined {
  try {
    return dirname(requireFromHere.resolve(`${platformPackageName()}/package.json`));
  } catch {
    return undefined;
  }
}

type RuntimeMetadata = {
  version: string;
  platform: string;
  builtAt?: string;
  nodeVersion?: string;
  features?: Partial<Record<'node' | 'postgres' | 'web' | 'tasks' | 'gateway' | 'cli', boolean>>;
  deps?: Partial<Record<'node' | 'postgres', { managed?: boolean; version?: string; archive?: string; sha256?: string }>>;
};

type RuntimeResolution = {
  home: string;
  appRoot: string;
  runtimeRoot: string;
  nodeBin: string;
  cliEntry: string;
};

type InstallPayload = (options: {
  payloadDir: string;
  home?: string;
  source: 'npm';
}) => Promise<{ version: string; platform: string; installed: boolean }>;

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  let runtime = resolveRuntime();

  if (!runtimeAvailable(runtime)) {
    await installRuntimeFromPlatformPayload(runtime);
    runtime = resolveRuntime();
  }

  if (!runtimeAvailable(runtime)) {
    printMissingRuntime(runtime);
    process.exitCode = 1;
    return;
  }

  process.exitCode = await runRuntimeCli(runtime, args);
}

function resolveRuntime(): RuntimeResolution {
  const home = process.env.ZLEAP_HOME?.trim() || join(homedir(), '.zleap');
  const runtimeRoot = process.env.ZLEAP_RUNTIME_ROOT?.trim() || join(home, 'app');
  const appRoot = process.env.ZLEAP_APP_ROOT?.trim() || join(runtimeRoot, 'current');
  const nodeBin = resolveNodeBin(home, appRoot);
  const cliEntry = join(appRoot, 'runtime', 'node_modules', '@zleap-ai', 'cli', 'dist', 'index.js');
  return { home, appRoot, runtimeRoot, nodeBin, cliEntry };
}

function resolveNodeBin(home: string, appRoot: string): string {
  if (process.env.ZLEAP_NODE_BIN?.trim() && existsSync(process.env.ZLEAP_NODE_BIN.trim())) {
    return process.env.ZLEAP_NODE_BIN.trim();
  }
  const metadata = readRuntimeMetadata(appRoot) ?? readRuntimeMetadata(join(home, 'app'));
  const version = metadata?.nodeVersion;
  if (version) {
    const managed = nodeBinInRoot(nodeToolsRoot(home, version));
    if (existsSync(managed)) {
      return managed;
    }
  }
  const candidates = [
    join(appRoot, 'node', 'bin', 'node'),
    join(appRoot, 'node', 'node.exe'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? process.execPath;
}

function runtimeAvailable(runtime: RuntimeResolution): boolean {
  if (appChecks(runtime.appRoot).length > 0) {
    return false;
  }
  const metadata = readRuntimeMetadata(runtime.appRoot);
  if (metadata?.deps?.node?.managed === true && metadata.nodeVersion) {
    if (!existsSync(nodeBinInRoot(nodeToolsRoot(runtime.home, metadata.nodeVersion)))) {
      return false;
    }
  }
  if (metadata?.deps?.postgres?.managed === true) {
    if (!existsPostgresBin(join(postgresToolsRoot(runtime.home), 'bin'))) {
      return false;
    }
  }
  return true;
}

async function installRuntimeFromPlatformPayload(runtime: RuntimeResolution): Promise<void> {
  let payloadDir = resolvePlatformPayloadDir();
  let cleanupDir: string | undefined;

  if (!payloadDir) {
    // No payload staged locally (the thin platform package only ships a manifest
    // + download descriptor — the ~200MB+ payload is too large for npmjs). Fetch
    // and verify it from the GitHub Release on first run.
    const descriptor = resolvePayloadDownload();
    if (descriptor) {
      const downloaded = await downloadPlatformPayload(descriptor);
      payloadDir = downloaded.payloadDir;
      cleanupDir = downloaded.cleanupDir;
    }
  }

  if (!payloadDir) {
    throw new Error(
      [
        `Zleap platform payload is not installed for ${releasePlatformTag()}.`,
        `Expected npm package: ${platformPackageName()}`,
        '',
        'Reinstall the CLI with npm so optional platform dependencies are installed:',
        '  npm install -g @zleap-ai/cli',
      ].join('\n'),
    );
  }

  try {
    const manifest = readPayloadManifest(payloadDir);
    process.stderr.write(`Installing Zleap payload ${manifest.version} for ${manifest.platform}...\n`);
    const installPayload = await loadInstallPayload(payloadDir);
    const result = await installPayload({ payloadDir, home: runtime.home, source: 'npm' });
    process.stderr.write(
      result.installed
        ? `Zleap payload ${result.version} installed.\n`
        : `Zleap payload ${result.version} already installed.\n`,
    );
  } finally {
    if (cleanupDir) {
      await rm(cleanupDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

type PayloadDownloadDescriptor = {
  url: string;
  archive: string;
  files: Record<string, { sha256?: string; size?: number }>;
  mirrors?: string[];
};

function resolvePayloadDownload(): PayloadDownloadDescriptor | undefined {
  const packageDir = resolvePlatformPackageDir();
  if (!packageDir) {
    return undefined;
  }
  const downloadPath = join(packageDir, 'download.json');
  const manifestPath = join(packageDir, 'manifest.json');
  if (!existsSync(downloadPath) || !existsSync(manifestPath)) {
    return undefined;
  }
  try {
    const dl = JSON.parse(readFileSync(downloadPath, 'utf8')) as {
      url?: string;
      archive?: string;
      mirrors?: string[];
    };
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as RuntimeMetadata & {
      payload?: { files?: Record<string, { sha256?: string; size?: number }> };
    };
    if (!dl.url) {
      return undefined;
    }
    return {
      url: dl.url,
      archive: dl.archive ?? basename(new URL(dl.url).pathname),
      files: manifest.payload?.files ?? {},
      mirrors: Array.isArray(dl.mirrors) ? dl.mirrors.filter((m): m is string => typeof m === 'string') : undefined,
    };
  } catch {
    return undefined;
  }
}

function resolvePlatformPackageDir(): string | undefined {
  const here = fileURLToPath(import.meta.url);
  const packageRoot = dirname(dirname(dirname(here)));
  const scopeRoot = dirname(packageRoot);
  const platformDir = platformPackageDir();
  const repoRoot = findRepoRoot(dirname(here));
  const resolvedRoot = resolvePlatformPackageRoot();
  const candidates = [
    resolvedRoot,
    join(scopeRoot, platformDir),
    repoRoot ? join(repoRoot, 'dist', 'npm', platformDir) : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => existsSync(join(candidate, 'download.json')));
}

async function downloadPlatformPayload(
  descriptor: PayloadDownloadDescriptor,
): Promise<{ payloadDir: string; cleanupDir: string }> {
  const cleanupDir = await mkdtemp(join(tmpdir(), 'zleap-payload-dl-'));
  const archivePath = join(cleanupDir, descriptor.archive || 'payload.tar.gz');
  process.stderr.write(`Downloading Zleap payload from ${descriptor.url}\n`);
  await downloadFile(descriptor.url, archivePath, makeStderrProgress(), descriptor.mirrors);

  const extractRoot = join(cleanupDir, 'extract');
  await mkdir(extractRoot, { recursive: true });
  await extractArchive(archivePath, extractRoot);

  const payloadDir = join(extractRoot, 'payload');
  if (!existsSync(join(payloadDir, 'manifest.json'))) {
    throw new Error(`Downloaded payload archive is missing payload/manifest.json: ${descriptor.url}`);
  }
  // Verify each component against the sha256 baked into the (npm-trusted) thin
  // platform package manifest, so a tampered Release asset is rejected.
  for (const name of ['app.tar.gz', 'node.tar.gz', 'postgres.tar.gz']) {
    const filePath = join(payloadDir, name);
    if (!existsSync(filePath)) {
      throw new Error(`Downloaded payload is missing ${name}`);
    }
    const expected = descriptor.files[name]?.sha256;
    if (!expected) {
      throw new Error(`Platform package manifest is missing sha256 for ${name}`);
    }
    const actual = await sha256File(filePath);
    if (actual !== expected) {
      throw new Error(`Checksum mismatch for ${name}\n  expected: ${expected}\n  actual:   ${actual}`);
    }
  }
  return { payloadDir, cleanupDir };
}

type DownloadProgress = { transferred: number; total?: number };

const IDLE_TIMEOUT_MS = Math.max(5_000, Number(process.env.ZLEAP_DOWNLOAD_TIMEOUT_MS) || 60_000);
const MAX_ATTEMPTS = Math.max(1, Number(process.env.ZLEAP_DOWNLOAD_RETRIES) || 4);

/** Ordered candidate URLs: ZLEAP_DOWNLOAD_MIRROR then descriptor mirrors, origin last. */
function downloadCandidates(url: string, descriptorMirrors: string[] = []): string[] {
  const envMirrors = (process.env.ZLEAP_DOWNLOAD_MIRROR ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const mirrors = [...envMirrors, ...descriptorMirrors.map((m) => m.trim()).filter(Boolean)];
  const list = mirrors.map((mirror) => applyMirror(mirror, url));
  list.push(url);
  return [...new Set(list)];
}

function applyMirror(mirror: string, url: string): string {
  if (mirror.includes('{url}')) {
    return mirror.replace('{url}', url);
  }
  if (mirror.endsWith('/')) {
    return `${mirror}${url}`;
  }
  try {
    const original = new URL(url);
    const replacement = new URL(mirror);
    return url.replace(`${original.protocol}//${original.host}`, `${replacement.protocol}//${replacement.host}`);
  } catch {
    return url;
  }
}

function makeStderrProgress(): (progress: DownloadProgress) => void {
  let lastEmit = 0;
  let lastPct = -1;
  const mb = (bytes: number) => (bytes / 1_048_576).toFixed(0);
  return ({ transferred, total }) => {
    const now = Date.now();
    const pct = total ? Math.floor((transferred / total) * 100) : undefined;
    const finished = total ? transferred >= total : false;
    if (!finished && now - lastEmit < 500 && pct === lastPct) {
      return;
    }
    lastEmit = now;
    lastPct = pct ?? lastPct;
    const line =
      pct !== undefined
        ? `  downloading ${pct}% (${mb(transferred)}/${mb(total ?? 0)} MB)`
        : `  downloading ${mb(transferred)} MB`;
    if (process.stderr.isTTY) {
      process.stderr.write(`\r${line}${finished ? '\n' : ''}`);
    } else if (finished || pct === undefined || pct % 10 === 0) {
      process.stderr.write(`${line}\n`);
    }
  };
}

async function downloadFile(
  url: string,
  dest: string,
  onProgress?: (progress: DownloadProgress) => void,
  descriptorMirrors: string[] = [],
): Promise<void> {
  const candidates = downloadCandidates(url, descriptorMirrors);
  let lastError: Error | undefined;
  for (const candidate of candidates) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        await downloadOnce(candidate, dest, onProgress);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        await rm(dest, { force: true }).catch(() => undefined);
        process.stderr.write(
          `Payload download attempt ${attempt}/${MAX_ATTEMPTS} from ${candidate} failed: ${lastError.message}\n`,
        );
        if (attempt < MAX_ATTEMPTS) {
          await delayMs(1_000 * attempt);
        }
      }
    }
  }
  throw lastError ?? new Error(`Download failed for ${url}`);
}

function downloadOnce(
  url: string,
  dest: string,
  onProgress?: (progress: DownloadProgress) => void,
  redirects = 0,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error(`Too many redirects while downloading ${url}`));
      return;
    }
    const request = httpsGet(url, { headers: { 'user-agent': 'zleap-installer' } }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        const next = new URL(response.headers.location, url).toString();
        downloadOnce(next, dest, onProgress, redirects + 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`Download failed (HTTP ${status}) for ${url}`));
        return;
      }
      const total = Number(response.headers['content-length']) || undefined;
      let transferred = 0;
      response.on('data', (chunk: Buffer) => {
        transferred += chunk.length;
        onProgress?.({ transferred, total });
      });
      pipeline(response, createWriteStream(dest)).then(resolve, reject);
    });
    request.setTimeout(IDLE_TIMEOUT_MS, () => {
      request.destroy(new Error(`Download stalled (no data for ${IDLE_TIMEOUT_MS}ms) from ${url}`));
    });
    request.on('error', reject);
  });
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function loadInstallPayload(payloadDir: string): Promise<InstallPayload> {
  const tmp = await mkdtemp(join(tmpdir(), 'zleap-host-installer-'));
  try {
    await extractArchive(join(payloadDir, 'app.tar.gz'), tmp);
    const installerPath = join(tmp, 'app', 'runtime', 'node_modules', '@zleap', 'host', 'dist', 'payload.js');
    if (!existsSync(installerPath)) {
      throw new Error(`Payload app is missing host installer: ${installerPath}`);
    }
    const mod = await import(pathToFileURL(installerPath).href);
    if (typeof mod.installPayload !== 'function') {
      throw new Error(`Payload host installer does not export installPayload(): ${installerPath}`);
    }
    const installPayload = mod.installPayload as InstallPayload;
    return async (options) => installPayload(options);
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

function resolvePlatformPayloadDir(): string | undefined {
  const explicit = process.env.ZLEAP_PAYLOAD_DIR?.trim();
  if (explicit && existsSync(join(explicit, 'manifest.json'))) {
    return explicit;
  }

  const here = fileURLToPath(import.meta.url);
  const packageRoot = dirname(dirname(dirname(here)));
  const scopeRoot = dirname(packageRoot);
  const platformDir = platformPackageDir();
  const repoRoot = findRepoRoot(dirname(here));
  const resolvedRoot = resolvePlatformPackageRoot();
  const candidates = [
    resolvedRoot ? join(resolvedRoot, 'payload') : undefined,
    join(scopeRoot, platformDir, 'payload'),
    repoRoot ? join(repoRoot, 'dist', 'npm', platformDir, 'payload') : undefined,
    repoRoot ? join(repoRoot, 'dist', 'payload', releasePlatformTag(), 'payload') : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => existsSync(join(candidate, 'manifest.json')));
}

function findRepoRoot(start: string): string | undefined {
  let current = start;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function readPayloadManifest(payloadDir: string): RuntimeMetadata {
  const manifest = JSON.parse(readFileSync(join(payloadDir, 'manifest.json'), 'utf8')) as RuntimeMetadata;
  if (!manifest.version || !manifest.platform) {
    throw new Error(`Invalid payload manifest: ${join(payloadDir, 'manifest.json')}`);
  }
  return manifest;
}

function appChecks(appRoot: string): string[] {
  const manifest = readRuntimeMetadata(appRoot);
  const features = manifest?.features ?? {};
  const deps = manifest?.deps ?? {};
  const required = [
    'runtime/node_modules/@zleap/host/dist/serve-cli.js',
    'runtime/node_modules/@zleap/host/dist/desktop-bootstrap-cli.js',
    'runtime/node_modules/@zleap/host/dist/control-cli.js',
    'runtime/node_modules/@zleap-ai/cli/dist/index.js',
    'runtime/node_modules/@zleap/store/dist/migrate.js',
    'runtime/node_modules/@zleap/tasks/dist/worker.js',
    'runtime/node_modules/@zleap/gateway/dist/worker.js',
    'web/packages/web/server.js',
    'manifest.json',
    'distribution.json',
  ];
  if (features.node !== false && deps.node?.managed !== true) {
    required.push(process.platform === 'win32' ? 'node/node.exe' : 'node/bin/node');
  }
  const missing = required.filter((rel) => !existsSync(join(appRoot, rel)));
  if (features.postgres === true && deps.postgres?.managed !== true) {
    const pgBin = join('postgres', releasePlatformTag(), 'bin');
    missing.push(
      ...[
        process.platform === 'win32' ? join(pgBin, 'pg_ctl.exe') : join(pgBin, 'pg_ctl'),
        process.platform === 'win32' ? join(pgBin, 'initdb.exe') : join(pgBin, 'initdb'),
      ].filter((rel) => !existsSync(join(appRoot, rel))),
    );
  }
  return missing;
}

function readRuntimeMetadata(root: string): RuntimeMetadata | undefined {
  for (const rel of ['manifest.json', 'metadata.json']) {
    try {
      return JSON.parse(readFileSync(join(root, rel), 'utf8')) as RuntimeMetadata;
    } catch {
      // try next
    }
  }
  return undefined;
}

function nodeToolsRoot(home: string, version: string): string {
  return join(home, 'tools', 'node', releasePlatformTag(), version);
}

function postgresToolsRoot(home: string): string {
  return join(home, 'tools', 'postgres', releasePlatformTag());
}

function nodeBinInRoot(root: string): string {
  return process.platform === 'win32' ? join(root, 'node.exe') : join(root, 'bin', 'node');
}

function existsPostgresBin(bin: string): boolean {
  const pgCtl = process.platform === 'win32' ? join(bin, 'pg_ctl.exe') : join(bin, 'pg_ctl');
  const initdb = process.platform === 'win32' ? join(bin, 'initdb.exe') : join(bin, 'initdb');
  return existsSync(pgCtl) && existsSync(initdb);
}

async function extractArchive(archivePath: string, destination: string): Promise<void> {
  await run('tar', ['-xzf', archivePath, '-C', destination]);
}

function releasePlatformTag(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'darwin') return `mac-${arch}`;
  if (process.platform === 'win32') return `win-${arch}`;
  return `linux-${arch}`;
}

function platformPackageName(): string {
  return `@zleap-ai/${platformPackageDir()}`;
}

function platformPackageDir(): string {
  const platform = releasePlatformTag();
  if (platform === 'mac-arm64') return 'app-darwin-arm64';
  if (platform === 'mac-x64') return 'app-darwin-x64';
  if (platform === 'win-x64') return 'app-win32-x64';
  if (platform === 'linux-arm64') return 'app-linux-arm64';
  return 'app-linux-x64';
}

function printMissingRuntime(runtime: RuntimeResolution): void {
  process.stderr.write(
    [
      'Zleap local app payload is not installed or is incomplete.',
      `  Expected: ${runtime.cliEntry}`,
      `  Platform package: ${platformPackageName()}`,
      '',
      'Try:',
      '  npm install -g @zleap-ai/cli',
      '',
    ].join('\n'),
  );
}

function runRuntimeCli(runtime: RuntimeResolution, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(runtime.nodeBin, [runtime.cliEntry, ...args], {
      stdio: 'inherit',
      windowsHide: true,
      env: {
        ...process.env,
        ZLEAP_HOME: runtime.home,
        ZLEAP_APP_ROOT: runtime.appRoot,
        ZLEAP_RUNTIME_ROOT: runtime.runtimeRoot,
        ZLEAP_REPO_ROOT: runtime.appRoot,
        ZLEAP_NODE_BIN: runtime.nodeBin,
        ZLEAP_SERVE_MODE: process.env.ZLEAP_SERVE_MODE ?? 'production',
        ZLEAP_SKIP_BUILD: '1',
      },
    });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', (error) => {
      process.stderr.write(`${error.message}\n`);
      resolve(1);
    });
  });
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', shell: process.platform === 'win32', windowsHide: true });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))));
    child.on('error', reject);
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
