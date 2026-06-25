#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const managerEntry = process.env.ZLEAP_MANAGER_ENTRY?.trim() || process.argv[2] || join(REPO_ROOT, 'packages/cli/dist/manager/index.js');
if (!existsSync(managerEntry)) {
  throw new Error(`CLI manager entry missing at ${managerEntry}. Run pnpm --filter @zleap-ai/cli build first.`);
}

const tmp = await mkdtemp(join(tmpdir(), 'zleap-cli-manager-smoke-'));
try {
  const payload = join(tmp, 'payload');
  const work = join(tmp, 'work');
  const appDir = join(work, 'app');
  await mkdir(appDir, { recursive: true });

  const requiredFiles = [
    'runtime/node_modules/@zleap/host/dist/serve-cli.js',
    'runtime/node_modules/@zleap/host/dist/desktop-bootstrap-cli.js',
    'runtime/node_modules/@zleap/host/dist/control-cli.js',
    'runtime/node_modules/@zleap/store/dist/migrate.js',
    'runtime/node_modules/@zleap/tasks/dist/worker.js',
    'runtime/node_modules/@zleap/gateway/dist/worker.js',
    'web/packages/web/server.js',
  ];
  for (const rel of requiredFiles) {
    const target = join(appDir, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, 'export {};\n', 'utf8');
  }
  await writeFile(join(appDir, 'runtime/node_modules/@zleap/host/package.json'), '{"type":"module"}\n', 'utf8');
  await writeFile(join(appDir, 'runtime/node_modules/@zleap/host/dist/payload.js'), hostInstallerStub(), 'utf8');

  const cliEntry = join(appDir, 'runtime/node_modules/@zleap-ai/cli/dist/index.js');
  await mkdir(dirname(cliEntry), { recursive: true });
  await writeFile(cliEntry, "console.log(`runtime-cli:${process.argv.slice(2).join(' ')}`);\n", 'utf8');
  await writeFile(
    join(appDir, 'distribution.json'),
    `${JSON.stringify({ runtime: { webPort: 4789, serveMode: 'production', authMode: 'localhost', gateway: false } })}\n`,
    'utf8',
  );

  const metadata = {
    version: '9.9.9',
    platform: platformTag(),
    builtAt: new Date(0).toISOString(),
    schemaVersion: 1,
    nodeVersion: '20.0.0-smoke',
    features: {
      node: true,
      postgres: true,
      web: true,
      tasks: true,
      gateway: true,
      cli: true,
    },
    deps: {
      node: { managed: true, version: '20.0.0-smoke', archive: 'node.tar.gz' },
      postgres: { managed: true, version: '17-smoke', archive: 'postgres.tar.gz' },
    },
  };
  await writeFile(join(appDir, 'manifest.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');

  await mkdir(payload, { recursive: true });
  await tar(payload, 'app.tar.gz', work, ['app']);
  await createNodeArchive(payload, metadata.nodeVersion);
  await createPostgresArchive(payload);

  const payloadFiles = {};
  for (const name of ['app.tar.gz', 'node.tar.gz', 'postgres.tar.gz']) {
    const full = join(payload, name);
    payloadFiles[name] = { sha256: await sha256File(full), size: (await readFile(full)).byteLength };
  }
  const manifest = { ...metadata, kind: 'payload', payloadVersion: 1, payload: { files: payloadFiles } };
  await writeFile(join(payload, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const sums = [];
  for (const name of ['app.tar.gz', 'node.tar.gz', 'postgres.tar.gz', 'manifest.json']) {
    sums.push(`${await sha256File(join(payload, name))}  ${name}`);
  }
  await writeFile(join(payload, 'SHA256SUMS'), `${sums.join('\n')}\n`, 'utf8');

  const home = join(tmp, 'home');
  const child = spawnSync(process.execPath, [managerEntry, 'doctor'], {
    env: {
      ...process.env,
      ZLEAP_HOME: home,
      ZLEAP_PAYLOAD_DIR: payload,
    },
    encoding: 'utf8',
  });
  if (child.status !== 0) {
    throw new Error(`manager failed:\nSTDOUT:\n${child.stdout}\nSTDERR:\n${child.stderr}`);
  }
  if (!child.stdout.includes('runtime-cli:doctor')) {
    throw new Error(`manager did not proxy to runtime CLI:\n${child.stdout}\n${child.stderr}`);
  }
  if (!existsSync(join(home, 'app/current/runtime/node_modules/@zleap-ai/cli/dist/index.js'))) {
    throw new Error('manager did not install runtime into ~/.zleap/app/current');
  }
  if (!existsSync(join(home, 'tools/node', platformTag(), metadata.nodeVersion))) {
    throw new Error('manager did not install managed Node into ~/.zleap/tools');
  }
  if (!existsSync(join(home, 'tools/postgres', platformTag(), 'bin'))) {
    throw new Error('manager did not install managed Postgres into ~/.zleap/tools');
  }

  process.stdout.write(`CLI manager smoke OK: ${managerEntry}\n`);
} finally {
  await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
}

async function createNodeArchive(payload, version) {
  const root = join(tmp, 'node-stage', `node-v${version}-${platformTag()}`);
  const nodeBin = process.platform === 'win32' ? join(root, 'node.exe') : join(root, 'bin', 'node');
  await mkdir(dirname(nodeBin), { recursive: true });
  await cp(process.execPath, nodeBin);
  await chmod(nodeBin, 0o755);
  await tar(payload, 'node.tar.gz', join(tmp, 'node-stage'), [`node-v${version}-${platformTag()}`]);
}

async function createPostgresArchive(payload) {
  const root = join(tmp, 'pg-stage', `zleap-postgres-smoke-${platformTag()}`);
  const pgCtl = process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl';
  const initdb = process.platform === 'win32' ? 'initdb.exe' : 'initdb';
  await mkdir(join(root, 'bin'), { recursive: true });
  await writeFile(join(root, 'bin', pgCtl), '#!/bin/sh\n', 'utf8');
  await writeFile(join(root, 'bin', initdb), '#!/bin/sh\n', 'utf8');
  await tar(payload, 'postgres.tar.gz', join(tmp, 'pg-stage'), [`zleap-postgres-smoke-${platformTag()}`]);
}

async function tar(outDir, name, cwd, entries) {
  const result = spawnSync('tar', ['-czf', join(outDir, name), '-C', cwd, ...entries], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`tar ${name} failed: ${result.stderr || result.stdout}`);
  }
}

async function sha256File(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

function platformTag() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'darwin') return `mac-${arch}`;
  if (process.platform === 'win32') return `win-${arch}`;
  return `linux-${arch}`;
}

function hostInstallerStub() {
  return String.raw`
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

export async function installPayload({ payloadDir, home }) {
  const manifest = JSON.parse(readFileSync(join(payloadDir, 'manifest.json'), 'utf8'));
  const root = home || join(tmpdir(), 'zleap-home');
  await installApp(payloadDir, root);
  await installNode(payloadDir, root, manifest);
  await installPostgres(payloadDir, root, manifest);
  await mkdir(join(root, 'state'), { recursive: true });
  await writeFile(join(root, 'state', 'install.json'), JSON.stringify({ method: 'cli', version: manifest.version, platform: manifest.platform }) + '\n');
  await writeFile(join(root, 'state', 'runtime.json'), JSON.stringify({ runtimeRoot: join(root, 'app/current'), version: manifest.version, platform: manifest.platform }) + '\n');
  return { appRoot: join(root, 'app/current'), version: manifest.version, platform: manifest.platform, installed: true, source: 'npm' };
}

async function installApp(payloadDir, home) {
  const tmp = await mkdtemp(join(tmpdir(), 'zleap-smoke-app-'));
  try {
    tar(join(payloadDir, 'app.tar.gz'), tmp);
    await mkdir(join(home, 'app'), { recursive: true });
    await rm(join(home, 'app/current'), { recursive: true, force: true });
    await cp(join(tmp, 'app'), join(home, 'app/current'), { recursive: true });
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function installNode(payloadDir, home, manifest) {
  const tmp = await mkdtemp(join(tmpdir(), 'zleap-smoke-node-'));
  try {
    tar(join(payloadDir, 'node.tar.gz'), tmp);
    const root = firstChild(tmp);
    const dest = join(home, 'tools/node', manifest.platform, manifest.nodeVersion);
    await mkdir(dirname(dest), { recursive: true });
    await rm(dest, { recursive: true, force: true });
    await cp(root, dest, { recursive: true });
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function installPostgres(payloadDir, home, manifest) {
  const tmp = await mkdtemp(join(tmpdir(), 'zleap-smoke-pg-'));
  try {
    tar(join(payloadDir, 'postgres.tar.gz'), tmp);
    const root = firstChild(tmp);
    const dest = join(home, 'tools/postgres', manifest.platform);
    await mkdir(dirname(dest), { recursive: true });
    await rm(dest, { recursive: true, force: true });
    await cp(root, dest, { recursive: true });
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

function firstChild(root) {
  const children = readdirSync(root);
  if (!children[0]) throw new Error('archive did not contain a root directory');
  return join(root, children[0]);
}

function tar(archive, dest) {
  const result = spawnSync('tar', ['-xzf', archive, '-C', dest], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'tar failed');
}
`;
}
