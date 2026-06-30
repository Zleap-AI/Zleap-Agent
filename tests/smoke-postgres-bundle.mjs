#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const archive = process.argv[2] ?? findArchive();
if (!archive || !existsSync(archive)) {
  throw new Error(`Postgres bundle archive not found: ${archive ?? '(auto)'}`);
}

const { stdout } = await execFileAsync('tar', ['-tf', archive], { maxBuffer: 20 * 1024 * 1024 });
const entries = stdout.split(/\r?\n/u).filter(Boolean);
const windows = basename(archive).includes('-win-');
const exe = windows ? '.exe' : '';
for (const name of ['pg_ctl', 'initdb', 'postgres', 'psql', 'createdb', 'pg_isready', 'pg_config']) {
  assertSuffix(`/bin/${name}${exe}`);
}
assertSuffix('/share/extension/vector.control');
if (!entries.some((entry) => /\/lib\/vector\.(dll|dylib|so)$/iu.test(entry))) {
  throw new Error(`${archive} does not contain pgvector shared library`);
}

process.stdout.write(`Postgres bundle smoke OK: ${archive}\n`);

function assertSuffix(suffix) {
  if (!entries.some((entry) => entry.endsWith(suffix))) {
    throw new Error(`${archive} missing ${suffix}`);
  }
}

function findArchive() {
  const dir = join(process.cwd(), 'dist', 'postgres', 'upload');
  if (!existsSync(dir)) return undefined;
  return readdirSync(dir)
    .filter((item) => /^zleap-postgres-.+\.tar\.gz$/u.test(item))
    .map((item) => join(dir, item))[0];
}
