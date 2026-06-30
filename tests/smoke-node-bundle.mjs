#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const archive = process.argv[2] ?? findArchive();
if (!archive || !existsSync(archive)) {
  throw new Error(`Node bundle archive not found: ${archive ?? '(auto)'}`);
}

const { stdout } = await execFileAsync('tar', ['-tf', archive], { maxBuffer: 10 * 1024 * 1024 });
const entries = stdout.split(/\r?\n/u).filter(Boolean);
const name = basename(archive);
const platform = name.includes('-win-') ? 'win' : 'posix';
const hasNode = entries.some((entry) => (
  platform === 'win'
    ? /\/node\.exe$/iu.test(entry)
    : /\/bin\/node$/u.test(entry)
));
if (!hasNode) {
  throw new Error(`${archive} does not contain a Node executable`);
}

process.stdout.write(`Node bundle smoke OK: ${archive}\n`);

function findArchive() {
  const dir = join(process.cwd(), 'dist', 'node', 'upload');
  if (!existsSync(dir)) return undefined;
  return readdirSync(dir)
    .filter((item) => /^zleap-node-.+\.tar\.gz$/u.test(item))
    .map((item) => join(dir, item))[0];
}
