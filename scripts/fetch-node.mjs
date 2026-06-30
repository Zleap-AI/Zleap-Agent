#!/usr/bin/env node
/**
 * Compatibility helper: materialize the managed Node.js bundle into a directory.
 * The download/checksum source of truth lives in scripts/package-node.mjs.
 * Usage: node scripts/fetch-node.mjs <destDir>
 */
import { chmod, cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { nodeBundleArchiveName, platformTag, REPO_ROOT } from './distribution.mjs';

async function main() {
  const destDir = process.argv[2];
  if (!destDir) {
    throw new Error('Usage: node scripts/fetch-node.mjs <destDir>');
  }

  await run(process.execPath, [join(REPO_ROOT, 'scripts', 'package-node.mjs')]);
  const archive = join(REPO_ROOT, 'dist', 'node', 'upload', nodeBundleArchiveName(platformTag()));
  if (!existsSync(archive)) {
    throw new Error(`Node bundle missing after package-node: ${archive}`);
  }

  const tmp = await mkdtemp(join(tmpdir(), 'zleap-fetch-node-'));
  try {
    await run('tar', ['-xzf', archive, '-C', tmp]);
    const entries = await readdir(tmp);
    if (entries.length !== 1) {
      throw new Error(`Unexpected Node bundle shape in ${archive}`);
    }
    await rm(destDir, { recursive: true, force: true });
    await mkdir(dirname(destDir), { recursive: true });
    await cp(join(tmp, entries[0]), destDir, { recursive: true, dereference: true });
    if (process.platform !== 'win32') {
      await chmod(join(destDir, 'bin', 'node'), 0o755);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  process.stdout.write(`Node.js written to ${destDir}\n`);
}

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.on('exit', (code) => (code === 0 ? resolveRun() : reject(new Error(`${command} exited ${code}`))));
    child.on('error', reject);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
