#!/usr/bin/env node
/** Validate slim desktop resources (bootstrap + thin payload descriptor). */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const root = resolve(process.argv[2] ?? 'packages/desktop/src-tauri/resources');

if (existsSync(join(root, 'app'))) {
  fail(`Desktop resources must not contain expanded app runtime: ${join(root, 'app')}`);
}
if (existsSync(join(root, 'node_modules'))) {
  fail(`Desktop resources must not contain expanded node_modules: ${join(root, 'node_modules')}`);
}
if (containsNestedNodeModules(root)) {
  fail(`Desktop resources must not contain expanded nested node_modules under ${root}`);
}

const slim = existsSync(join(root, 'bootstrap.tar.gz')) && existsSync(join(root, 'download.json'));
if (slim) {
  for (const name of ['metadata.json', 'download.json', 'manifest.json', 'bootstrap.tar.gz']) {
    const file = join(root, name);
    if (!existsSync(file) || !statSync(file).isFile()) {
      fail(`Missing slim desktop resource file: ${file}`);
    }
  }
  if (existsSync(join(root, 'payload', 'app.tar.gz'))) {
    fail('Slim desktop resources must not embed full payload archives');
  }
  await verifyBootstrapArchive(join(root, 'bootstrap.tar.gz'));
  process.stdout.write(`Desktop resources smoke OK (slim): ${root}\n`);
  process.exit(0);
}

const payload = join(root, 'payload');
if (!existsSync(payload) || !statSync(payload).isDirectory()) {
  fail(`Missing payload directory: ${payload}`);
}
for (const name of ['app.tar.gz', 'node.tar.gz', 'postgres.tar.gz', 'manifest.json', 'SHA256SUMS']) {
  const file = join(payload, name);
  if (!existsSync(file) || !statSync(file).isFile()) {
    fail(`Missing desktop payload file: ${file}`);
  }
}

const smoke = spawnSync(process.execPath, ['tests/smoke-payload.mjs', payload], {
  cwd: process.cwd(),
  encoding: 'utf8',
});
if (smoke.status !== 0) {
  fail(smoke.stderr || smoke.stdout || 'payload smoke failed');
}

process.stdout.write(`Desktop resources smoke OK (embedded payload): ${root}\n`);

async function verifyBootstrapArchive(archive) {
  const temp = await mkdtemp(join(tmpdir(), 'zleap-bootstrap-smoke-'));
  try {
    const extract = spawnSync('tar', ['-xzf', archive, '-C', temp], { encoding: 'utf8' });
    if (extract.status !== 0) {
      fail(extract.stderr || extract.stdout || `failed to extract ${archive}`);
    }
    const cli = join(
      temp,
      'runtime',
      'node_modules',
      '@zleap',
      'host',
      'dist',
      'desktop-bootstrap-cli.js',
    );
    if (!existsSync(cli)) {
      fail(`bootstrap archive missing desktop-bootstrap-cli.js: ${cli}`);
    }
    if (!existsSync(join(temp, 'node.tar.gz'))) {
      fail('bootstrap archive missing node.tar.gz');
    }
    if (existsSync(join(temp, 'runtime', 'node_modules', '@larksuite'))) {
      fail('bootstrap archive must not embed @larksuite (gateway-only dependency)');
    }
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
}

function containsNestedNodeModules(dir) {
  for (const name of safeReaddir(dir)) {
    const full = join(dir, name);
    if (name === 'node_modules') {
      return true;
    }
    try {
      if (statSync(full).isDirectory() && containsNestedNodeModules(full)) {
        return true;
      }
    } catch {
      // ignore
    }
  }
  return false;
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
