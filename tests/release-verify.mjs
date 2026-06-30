#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

await run('pnpm', ['check']);
await run(process.execPath, [join(REPO_ROOT, 'tests/check-release-readiness.mjs')]);
await run('pnpm', ['package:payload']);
await run(process.execPath, [join(REPO_ROOT, 'tests/smoke-app-runtime.mjs'), join(REPO_ROOT, 'dist/app', platformTag(), 'app')]);
await run(process.execPath, [join(REPO_ROOT, 'tests/smoke-payload.mjs'), join(REPO_ROOT, 'dist/payload', platformTag(), 'payload')]);
await run('pnpm', ['pack:npm-platforms']);
await run('pnpm', ['smoke:cli-npm']);
await run('pnpm', ['desktop:resources'], { ZLEAP_SKIP_MACOS_APP_SIGN: '1' });
await run('pnpm', ['smoke:desktop-resources']);
await run('npm', ['--cache', '/tmp/zleap-npm-cache', 'pack', '--dry-run', join(REPO_ROOT, 'dist/npm/cli')]);

console.log('Release verify OK');

function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { ...process.env, ...env },
    });
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

function platformTag() {
  if (process.platform === 'win32') return 'win-x64';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
}
