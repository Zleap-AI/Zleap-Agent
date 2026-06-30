#!/usr/bin/env node
/** Validate a freshly built app runtime layout and runtime portability. */
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { existsSync, realpathSync } from 'node:fs';
import { lstat, mkdtemp, readdir, readFile, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { platformTag, REPO_ROOT } from '../scripts/release-version.mjs';

const tag = platformTag();
const root = resolve(process.argv[2] ?? join(REPO_ROOT, 'dist', 'app', tag, 'app'));
const releaseDir = dirname(root);
const metadataPath = existsSync(join(root, 'manifest.json')) ? join(root, 'manifest.json') : join(releaseDir, 'metadata.json');
const skipServer = process.env.ZLEAP_SMOKE_SKIP_SERVER === '1';

const metadata = await readMetadata();
const features = metadata?.features ?? {};
const deps = metadata?.deps ?? {};
const required = [
  'runtime/node_modules/@zleap/host/dist/serve-cli.js',
  'runtime/node_modules/@zleap/host/dist/desktop-bootstrap-cli.js',
  'runtime/node_modules/@zleap/host/dist/control-cli.js',
  'runtime/node_modules/@zleap/store/dist/migrate.js',
  'web/packages/web/server.js',
  'web/node_modules',
  'runtime/node_modules',
  'manifest.json',
  'distribution.json',
];
if (features.tasks !== false) required.push('runtime/node_modules/@zleap/tasks/dist/worker.js');
if (features.gateway !== false) required.push('runtime/node_modules/@zleap/gateway/dist/worker.js');
if (features.cli === true) required.push('runtime/node_modules/@zleap-ai/cli/dist/index.js');

let ok = true;

for (const rel of required) {
  const full = join(root, rel);
  if (!existsSync(full)) {
    fail(`Missing ${full}`);
  }
}

const nodeRel = process.platform === 'win32' ? 'node/node.exe' : 'node/bin/node';
const bundledNodeBin = join(root, nodeRel);
const nodeBin = existsSync(bundledNodeBin) ? bundledNodeBin : process.execPath;
if (features.node !== false && !existsSync(bundledNodeBin) && deps.node?.managed !== true) {
  fail(`Missing bundled Node: ${nodeRel}`);
} else {
  const nodeVersion = await runCapture(nodeBin, ['--version']);
  if (nodeVersion.code !== 0) {
    fail(`Bundled Node failed: ${nodeVersion.stderr || nodeVersion.stdout}`);
  }
}

if (features.postgres === true && deps.postgres?.managed !== true) {
  const pgCtl =
    process.platform === 'win32'
      ? join(root, 'postgres', tag, 'bin', 'pg_ctl.exe')
      : join(root, 'postgres', tag, 'bin', 'pg_ctl');
  if (!existsSync(pgCtl)) {
    fail(`Missing bundled Postgres: ${pgCtl}`);
  }
  const vectorControl = join(root, 'postgres', tag, 'share', 'extension', 'vector.control');
  if (!existsSync(vectorControl)) {
    fail(`Missing bundled pgvector extension: ${vectorControl}`);
  }
}

if (deps.node?.managed === true && existsSync(join(root, 'node'))) {
  fail('Managed Node must not be expanded inside app/node');
}
if (deps.postgres?.managed === true && existsSync(join(root, 'postgres'))) {
  fail('Managed Postgres must not be expanded inside app/postgres');
}

await assertNoAbsoluteSymlinks(root);
await assertNoBrokenSymlinks(root);
await assertSingleSharedNodeModules(root);
assertWebDependencies();
assertRuntimeDependencies();

if (!skipServer) {
  await assertWebServer();
}

if (!ok) process.exit(1);
process.stdout.write(`App runtime smoke OK: ${root}\n`);

function fail(message) {
  process.stderr.write(`${message}\n`);
  ok = false;
}

async function readMetadata() {
  try {
    return JSON.parse(await readFile(metadataPath, 'utf8'));
  } catch {
    return undefined;
  }
}

async function assertNoAbsoluteSymlinks(dir) {
  const bad = [];
  await walk(dir, async (file) => {
    const stat = await lstat(file);
    if (!stat.isSymbolicLink()) return;
    const target = await readlink(file);
    if (isAbsolute(target)) {
      bad.push(`${file} -> ${target}`);
      return;
    }
    const normalized = target.replace(/\\/g, '/');
    if (normalized.includes('.node-fetch-tmp') || normalized.includes('.next/standalone')) {
      bad.push(`${file} -> ${target}`);
    }
  });
  if (bad.length > 0) {
    fail(`Found non-portable symlinks:\n${bad.slice(0, 20).join('\n')}${bad.length > 20 ? `\n... ${bad.length - 20} more` : ''}`);
  }
}

async function assertNoBrokenSymlinks(dir) {
  const bad = [];
  await walk(dir, async (file) => {
    const stat = await lstat(file);
    if (!stat.isSymbolicLink()) return;
    if (!existsSync(file)) {
      bad.push(`${file} -> ${await readlink(file)}`);
    }
  });
  if (bad.length > 0) {
    fail(`Found broken symlinks:\n${bad.slice(0, 20).join('\n')}${bad.length > 20 ? `\n... ${bad.length - 20} more` : ''}`);
  }
}

function assertWebDependencies() {
  const req = createRequire(join(root, 'web', 'packages', 'web', 'server.js'));
  for (const id of ['next']) {
    try {
      req.resolve(id);
    } catch (error) {
      fail(`Cannot resolve ${id} from web/packages/web/server.js: ${error?.code ?? error}`);
    }
  }
  for (const rel of [
    'runtime/node_modules/@zleap/agent/dist/index.js',
    'runtime/node_modules/@zleap/host/dist/index.js',
    'runtime/node_modules/@zleap/store/dist/index.js',
    'runtime/node_modules/@zleap/tasks/dist/index.js',
    'runtime/node_modules/@zleap/gateway/dist/worker.js',
  ]) {
    if (!existsSync(join(root, rel))) {
      fail(`Missing shared runtime package file: ${rel}`);
    }
  }
  if (features.cli === true && !existsSync(join(root, 'runtime/node_modules/@zleap-ai/cli/dist/index.js'))) {
    fail('Missing CLI runtime package file: runtime/node_modules/@zleap-ai/cli/dist/index.js');
  }
}

function assertRuntimeDependencies() {
  const req = createRequire(realpathSync(join(root, 'runtime/node_modules/@zleap/host/dist/desktop-bootstrap-cli.js')));
  for (const id of ['pg']) {
    try {
      req(id);
    } catch (error) {
      fail(`Cannot load ${id} from host desktop bootstrap: ${error?.code ?? error}`);
    }
  }
}

async function assertSingleSharedNodeModules(rootDir) {
  const bad = [];
  await walk(rootDir, async (file) => {
    if (!file.endsWith(`${join('', 'node_modules')}`)) return;
    const rel = relative(rootDir, file).replace(/\\/g, '/');
    if (rel === 'web/node_modules' || rel.startsWith('web/node_modules/')) return;
    if (rel === 'web/packages/web/node_modules' || rel.startsWith('web/packages/web/node_modules/')) return;
    if (rel === 'web/packages/web/.next/node_modules' || rel.startsWith('web/packages/web/.next/node_modules/')) return;
    if (rel === 'runtime/node_modules' || rel.startsWith('runtime/node_modules/')) return;
    const stat = await lstat(file);
    if (stat.isDirectory()) {
      bad.push(rel);
    }
  });
  if (bad.length > 0) {
    fail(`Nested node_modules are not allowed in release app:\n${bad.slice(0, 20).join('\n')}${bad.length > 20 ? `\n... ${bad.length - 20} more` : ''}`);
  }
}

async function assertWebServer() {
  const tempHome = await mkdtemp(join(tmpdir(), 'zleap-app-smoke-'));
  let port;
  try {
    port = await freePort();
  } catch (error) {
    await rm(tempHome, { recursive: true, force: true });
    fail(`Cannot allocate local smoke port: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const child = spawn(nodeBin, ['server.js'], {
    cwd: join(root, 'web', 'packages', 'web'),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
      ZLEAP_HOME: tempHome,
      ZLEAP_APP_ROOT: root,
      ZLEAP_REPO_ROOT: root,
      ZLEAP_NODE_BIN: nodeBin,
      ZLEAP_SERVE_MODE: 'production',
      ZLEAP_SKIP_BUILD: '1',
      ZLEAP_AUTH_MODE: 'localhost',
      ZLEAP_GATEWAY: '0',
      ZLEAP_WEB_PORT: String(port),
      ZLEAP_WEB_MODEL_CONFIG_PATH: join(tempHome, 'web-models.json'),
      ZLEAP_DATABASE_URL: '',
      DATABASE_URL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  try {
    await waitForUrl(`http://127.0.0.1:${port}/api/health/live`, 30_000);
    const models = await fetch(`http://127.0.0.1:${port}/api/models`, { signal: AbortSignal.timeout(10_000) });
    if (!models.ok) {
      const body = await models.text().catch(() => '');
      fail(`/api/models returned HTTP ${models.status}\nbody:\n${body}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
  } catch (error) {
    fail(`Web server smoke failed: ${error instanceof Error ? error.message : String(error)}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolveExit) => {
      child.once('exit', resolveExit);
      setTimeout(resolveExit, 2_000);
    });
    await rm(tempHome, { recursive: true, force: true });
  }
}

async function walk(dir, visit) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    await visit(full);
    if (entry.isDirectory()) {
      await walk(full, visit);
    }
  }
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

async function waitForUrl(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function runCapture(command, args) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('exit', (code) => resolveRun({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() }));
    child.on('error', (error) => resolveRun({ code: 1, stdout, stderr: error.message }));
  });
}
