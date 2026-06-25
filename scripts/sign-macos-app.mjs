#!/usr/bin/env node
import { lstat, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, relative } from 'node:path';
import { spawn } from 'node:child_process';

const root = process.argv[2];
const identity = process.env.APPLE_SIGNING_IDENTITY?.trim();
const nodeEntitlements = new URL('./macos-node-entitlements.plist', import.meta.url).pathname;

if (process.platform !== 'darwin') {
  process.exit(0);
}

if (!root) {
  console.error('Usage: node scripts/sign-macos-app.mjs <resources-app-dir>');
  process.exit(1);
}

if (process.env.ZLEAP_SKIP_MACOS_APP_SIGN === '1') {
  process.stdout.write('Skipping macOS app runtime signing (ZLEAP_SKIP_MACOS_APP_SIGN=1)\n');
  process.exit(0);
}

if (!identity) {
  process.stdout.write('Skipping macOS app runtime signing: APPLE_SIGNING_IDENTITY is not set\n');
  process.exit(0);
}

const nativeExtensions = new Set(['.dylib', '.node', '.so']);
const candidates = [];

await collectCandidates(root);

const machOFiles = [];
for (const file of candidates) {
  const description = await capture('file', ['-b', file]);
  if (description.includes('Mach-O')) {
    machOFiles.push(file);
  }
}

process.stdout.write(`Signing ${machOFiles.length} macOS app runtime Mach-O file(s)\n`);

let signed = 0;
for (const file of machOFiles) {
  const args = [
    '--force',
    '--options',
    'runtime',
    '--timestamp',
    '--sign',
    identity,
  ];
  if (isBundledNode(file)) {
    args.push('--entitlements', nodeEntitlements);
  }
  args.push(file);
  await run('codesign', args);
  signed += 1;
  if (signed % 25 === 0 || signed === machOFiles.length) {
    process.stdout.write(`Signed ${signed}/${machOFiles.length}\n`);
  }
}

function isBundledNode(file) {
  const rel = relative(root, file);
  return rel === join('node', 'bin', 'node') || rel === join('bin', 'node');
}

async function collectCandidates(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      await collectCandidates(full);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }

    const stat = await lstat(full);
    const hasNativeExtension = nativeExtensions.has(extensionOf(entry.name));
    const isExecutable = (stat.mode & constants.S_IXUSR) !== 0;
    if (hasNativeExtension || isExecutable) {
      candidates.push(full);
    }
  }
}

function extensionOf(name) {
  const index = name.lastIndexOf('.');
  return index === -1 ? '' : name.slice(index);
}

function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('exit', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
      }
    });
    child.on('error', reject);
  });
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited ${code}`));
      }
    });
    child.on('error', reject);
  });
}
