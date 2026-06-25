import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import pg from 'pg';
import {
  DEFAULT_PG_DATABASE,
  DEFAULT_PG_HOST,
  DEFAULT_PG_PASSWORD,
  DEFAULT_PG_PORT,
  DEFAULT_PG_USER,
} from './constants.js';
import { ensurePostgresToolsInstalled } from './postgres-bundle.js';
import { pgBinary, resolveBundledPostgresBin, resolveRepoRoot } from './paths.js';
import { run, runCapture, runQuiet, sleep } from './process.js';

export type PostgresEnv = NodeJS.ProcessEnv;

export async function ensurePostgres(env: PostgresEnv): Promise<void> {
  const configuredDatabaseUrl =
    env.ZLEAP_DATABASE_URL ?? env.DATABASE_URL ?? process.env.ZLEAP_DATABASE_URL ?? process.env.DATABASE_URL;
  if (configuredDatabaseUrl && !isManagedLocalDatabaseUrl(configuredDatabaseUrl)) {
    return;
  }
  if (process.env.ZLEAP_WEB_SKIP_DOCKER_DB === '1') {
    return;
  }

  const repoRoot = env.ZLEAP_APP_ROOT ?? env.ZLEAP_REPO_ROOT ?? resolveRepoRoot();
  let bundled = resolveBundledPostgresBin(repoRoot);
  if (!bundled) {
    try {
      bundled = await ensurePostgresToolsInstalled({ repoRoot });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[postgres] Lazy install failed: ${detail}\n`);
    }
    bundled = resolveBundledPostgresBin(repoRoot);
  }
  if (bundled) {
    await ensureLocalPostgres(bundled, env);
    return;
  }

  const local = await findLocalPostgresBin();
  if (local) {
    await ensureLocalPostgres(local, env);
    return;
  }

  if (await runQuiet('docker', ['compose', 'version'], { env })) {
    const repoRoot = env.ZLEAP_REPO_ROOT ?? resolveRepoRoot();
    await run('docker', ['compose', 'up', '-d', 'postgres'], { env, cwd: repoRoot });
    await waitForPostgres({
      command: 'docker',
      args: ['compose', 'exec', '-T', 'postgres', 'pg_isready', '-U', DEFAULT_PG_USER, '-d', DEFAULT_PG_DATABASE],
      env,
      cwd: repoRoot,
    });
    return;
  }

  throw new Error(
    'Postgres is required. Set ZLEAP_DATABASE_URL, allow bootstrap to download portable Postgres, install PostgreSQL with pgvector locally, or run Docker Desktop.',
  );
}

async function ensureLocalPostgres(pgBin: string, env: PostgresEnv): Promise<void> {
  const pgEnv = { ...env, PGPASSWORD: DEFAULT_PG_PASSWORD };
  const pgIsReady = pgBinary('pg_isready', pgBin);
  const pgConfig = pgBinary('pg_config', pgBin);
  const psql = pgBinary('psql', pgBin);
  const pgCtl = pgBinary('pg_ctl', pgBin);
  const initdb = pgBinary('initdb', pgBin);
  const createdb = pgBinary('createdb', pgBin);
  const dataDir = await localPostgresDataDir(pgConfig);

  if (!(await runQuiet(pgIsReady, ['-h', DEFAULT_PG_HOST, '-p', DEFAULT_PG_PORT, '-d', 'postgres'], { env: pgEnv }))) {
    await mkdir(dataDir, { recursive: true });
    if (!existsSync(join(dataDir, 'PG_VERSION'))) {
      await run(initdb, ['-D', dataDir, '--auth=trust'], { env: pgEnv });
    }
    await run(pgCtl, ['-D', dataDir, '-l', join(dataDir, 'postgres.log'), '-o', `-p ${DEFAULT_PG_PORT}`, 'start'], {
      env: pgEnv,
    });
    await waitForPostgres({
      command: pgIsReady,
      args: ['-h', DEFAULT_PG_HOST, '-p', DEFAULT_PG_PORT, '-d', 'postgres'],
      env: pgEnv,
    });
  }

  await run(
    psql,
    [
      '-h',
      DEFAULT_PG_HOST,
      '-p',
      DEFAULT_PG_PORT,
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DEFAULT_PG_USER}') THEN CREATE ROLE ${DEFAULT_PG_USER} LOGIN SUPERUSER PASSWORD '${DEFAULT_PG_PASSWORD}'; ELSE ALTER ROLE ${DEFAULT_PG_USER} WITH LOGIN SUPERUSER PASSWORD '${DEFAULT_PG_PASSWORD}'; END IF; END $$;`,
    ],
    { env: pgEnv },
  );

  const databaseExists = await runQuiet(
    psql,
    ['-h', DEFAULT_PG_HOST, '-p', DEFAULT_PG_PORT, '-U', DEFAULT_PG_USER, '-d', DEFAULT_PG_DATABASE, '-c', 'select 1'],
    { env: pgEnv },
  );
  if (!databaseExists) {
    await run(
      createdb,
      ['-h', DEFAULT_PG_HOST, '-p', DEFAULT_PG_PORT, '-U', DEFAULT_PG_USER, '-O', DEFAULT_PG_USER, DEFAULT_PG_DATABASE],
      { env: pgEnv },
    );
  }

  await ensurePgVectorExtension(psql, pgEnv);
}

export function isManagedLocalDatabaseUrl(databaseUrl: string): boolean {
  try {
    const parsed = new URL(databaseUrl);
    return (
      (parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:') &&
      parsed.username === DEFAULT_PG_USER &&
      parsed.password === DEFAULT_PG_PASSWORD &&
      (parsed.hostname === DEFAULT_PG_HOST || parsed.hostname === 'localhost') &&
      (parsed.port || '5432') === DEFAULT_PG_PORT &&
      parsed.pathname === `/${DEFAULT_PG_DATABASE}`
    );
  } catch {
    return false;
  }
}

async function ensurePgVectorExtension(psql: string, env: PostgresEnv): Promise<void> {
  try {
    await run(
      psql,
      [
        '-h',
        DEFAULT_PG_HOST,
        '-p',
        DEFAULT_PG_PORT,
        '-U',
        DEFAULT_PG_USER,
        '-d',
        DEFAULT_PG_DATABASE,
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        'CREATE EXTENSION IF NOT EXISTS vector;',
      ],
      { env },
    );
  } catch {
    // Bundled/dev PG without pgvector still works with faux embeddings.
  }
}

async function waitForPostgres(check: {
  command: string;
  args: string[];
  env?: PostgresEnv;
  cwd?: string;
}): Promise<void> {
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    if (await runQuiet(check.command, check.args, { env: check.env, cwd: check.cwd })) {
      return;
    }
    await sleep(1_500);
  }
  throw new Error('Postgres did not become ready.');
}

async function findLocalPostgresBin(): Promise<string | undefined> {
  const candidates = [
    process.env.ZLEAP_PG_BIN,
    '/opt/homebrew/opt/postgresql@18/bin',
    '/opt/homebrew/opt/postgresql@17/bin',
    '/opt/homebrew/opt/postgresql@16/bin',
    '/usr/local/opt/postgresql@18/bin',
    '/usr/local/opt/postgresql@17/bin',
    '/usr/local/opt/postgresql@16/bin',
    process.platform !== 'win32' ? await commandDir('pg_ctl') : undefined,
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    const pgConfig = join(candidate, process.platform === 'win32' ? 'pg_config.exe' : 'pg_config');
    if (!existsSync(pgConfig) || !existsSync(join(candidate, process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl'))) {
      continue;
    }
    const sharedir = (await runCapture(pgConfig, ['--sharedir']).catch(() => '')).trim();
    if (sharedir && existsSync(join(sharedir, 'extension', 'vector.control'))) {
      return candidate;
    }
    if (sharedir) {
      return candidate;
    }
  }
  return undefined;
}

async function commandDir(command: string): Promise<string | undefined> {
  const resolved = (await runCapture('sh', ['-lc', `command -v ${command}`]).catch(() => '')).trim();
  return resolved ? dirname(resolved) : undefined;
}

async function localPostgresDataDir(pgConfig: string): Promise<string> {
  const version = (await runCapture(pgConfig, ['--version']).catch(() => '')).trim();
  const major = version.match(/PostgreSQL\s+(\d+)/)?.[1] ?? 'default';
  return join(homedir(), '.zleap', `postgres-${major}`);
}

export async function probePostgres(databaseUrl: string): Promise<boolean> {
  try {
    const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
    await client.connect();
    await client.query('select 1');
    await client.end();
    return true;
  } catch {
    return false;
  }
}
