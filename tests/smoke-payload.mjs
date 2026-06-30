#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? `dist/payload/${platformTag()}/payload`);

const required = ['app.tar.gz', 'node.tar.gz', 'postgres.tar.gz', 'manifest.json', 'SHA256SUMS'];
for (const name of required) {
  requireFile(name);
}

if (existsSync(join(root, 'app'))) {
  fail(`Payload must not contain expanded app runtime: ${join(root, 'app')}`);
}
if (existsSync(join(root, 'node_modules'))) {
  fail(`Payload must not contain expanded node_modules: ${join(root, 'node_modules')}`);
}

const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
if (manifest.kind !== 'payload') {
  fail(`payload manifest kind must be "payload", got ${manifest.kind}`);
}
if (!manifest.version || !manifest.platform) {
  fail('payload manifest must include version and platform');
}
for (const name of ['app.tar.gz', 'node.tar.gz', 'postgres.tar.gz']) {
  const info = manifest.payload?.files?.[name];
  if (!info?.sha256 || info.sha256 !== sha256(join(root, name))) {
    fail(`payload manifest checksum mismatch for ${name}`);
  }
  if (info.size !== statSync(join(root, name)).size) {
    fail(`payload manifest size mismatch for ${name}`);
  }
}

const sums = new Map(
  readFileSync(join(root, 'SHA256SUMS'), 'utf8')
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const [hash, name] = line.trim().split(/\s+/, 2);
      return [name, hash];
    }),
);
for (const name of ['app.tar.gz', 'node.tar.gz', 'postgres.tar.gz', 'manifest.json']) {
  const expected = sums.get(name);
  if (!expected) {
    fail(`SHA256SUMS missing ${name}`);
  }
  const actual = sha256(join(root, name));
  if (actual !== expected) {
    fail(`SHA256SUMS mismatch for ${name}: expected ${expected}, got ${actual}`);
  }
}

for (const name of readdirSync(root)) {
  if (!required.includes(name)) {
    fail(`Unexpected payload file: ${join(root, name)}`);
  }
}

process.stdout.write(`Payload smoke OK: ${root}\n`);

function requireFile(name) {
  const file = join(root, name);
  if (!existsSync(file) || !statSync(file).isFile()) {
    fail(`Missing payload file: ${file}`);
  }
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function platformTag() {
  if (process.platform === 'win32') return 'win-x64';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
