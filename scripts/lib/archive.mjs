/**
 * Shared process + archive + checksum helpers for the release scripts.
 *
 * One implementation of: running child processes, hashing files, writing
 * checksum sidecars, and creating/extracting tar.gz / zip archives with a
 * Windows-safe extraction fallback (PowerShell Expand-Archive when `unzip` is
 * unavailable). All packaging scripts must reuse these instead of re-deriving
 * their own copies.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: options.stdio ?? 'inherit',
      shell: process.platform === 'win32',
      env: options.env ?? process.env,
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited ${code}`))));
    child.on('error', reject);
  });
}

export function capture(command, args, options = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    child.stdout?.on('data', (chunk) => chunks.push(chunk));
    child.on('exit', (code) => resolve(code === 0 ? Buffer.concat(chunks).toString('utf8') : undefined));
    child.on('error', () => resolve(undefined));
  });
}

export function sha256File(file, { allowEmpty = false } = {}) {
  const size = statSync(file).size;
  if (!allowEmpty && size <= 0) {
    throw new Error(`Refusing to hash empty file: ${file}`);
  }
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function writeChecksumSidecar(file) {
  const hash = sha256File(file);
  writeFileSync(`${file}.sha256`, `${hash}  ${basename(file)}\n`);
  return hash;
}

export async function archiveTarGz(out, cwd, entries) {
  await mkdir(dirname(out), { recursive: true });
  await rm(out, { force: true });
  await run('tar', ['-czf', out, '-C', cwd, ...entries]);
  return out;
}

export async function extractArchive(archive, dest) {
  await mkdir(dest, { recursive: true });
  if (archive.endsWith('.zip')) {
    await extractZip(archive, dest);
    return dest;
  }
  await run('tar', ['-xzf', archive, '-C', dest]);
  return dest;
}

export async function extractAnyArchive(archive, dest) {
  await mkdir(dest, { recursive: true });
  if (archive.endsWith('.zip')) {
    await extractZip(archive, dest);
  } else {
    await run('tar', ['-xf', archive, '-C', dest]);
  }
  return dest;
}

async function extractZip(zip, dest) {
  if (process.platform === 'win32') {
    await run('powershell', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -Path '${escapePowerShell(zip)}' -DestinationPath '${escapePowerShell(dest)}' -Force`,
    ]);
    return;
  }
  if (await commandExists('unzip')) {
    await run('unzip', ['-q', zip, '-d', dest]);
    return;
  }
  // Cross-platform fallback when `unzip` is not installed (e.g. minimal CI images).
  await run('powershell', [
    '-NoProfile',
    '-Command',
    `Expand-Archive -Path '${escapePowerShell(zip)}' -DestinationPath '${escapePowerShell(dest)}' -Force`,
  ]).catch(async () => {
    await run('tar', ['-xf', zip, '-C', dest]);
  });
}

async function commandExists(command) {
  const probe = process.platform === 'win32' ? 'where' : 'command';
  const args = process.platform === 'win32' ? [command] : ['-v', command];
  return (await capture(probe, args)) !== undefined;
}

function escapePowerShell(value) {
  return String(value).replace(/'/g, "''");
}
