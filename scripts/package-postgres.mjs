#!/usr/bin/env node
/**
 * Build and package the portable Postgres runtime used by Zleap releases.
 *
 * Source of truth:
 *   distribution.json runtime.postgres.source.postgres
 *   distribution.json runtime.postgres.source.pgvector
 *
 * Output:
 *   dist/postgres/upload/zleap-postgres-{pg}-pgvector-{pgvector}-{platform}.tar.gz
 *   dist/postgres/upload/zleap-postgres-{pg}-pgvector-{pgvector}-{platform}.tar.gz.sha256
 */
import { createWriteStream, existsSync, readdirSync } from 'node:fs';
import { chmod, cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDistribution, platformTag } from './release-version.mjs';
import { capture, extractAnyArchive, run, sha256File } from './lib/archive.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const tag = process.env.ZLEAP_RELEASE_PLATFORM || process.env.ZLEAP_PLATFORM || platformTag();
const dist = loadDistribution();
const postgres = dist.runtime?.postgres;
const OUT_ROOT = join(REPO_ROOT, 'dist', 'postgres');
const SOURCE_CACHE = resolve(process.env.ZLEAP_POSTGRES_SOURCE_CACHE || join(OUT_ROOT, 'sources'));
const BUILD_ROOT = resolve(process.env.ZLEAP_POSTGRES_BUILD_DIR || join(OUT_ROOT, 'build', tag));
const UPLOAD_DIR = join(OUT_ROOT, 'upload');

async function main() {
  if (process.env.ZLEAP_PG_SOURCE || process.env.ZLEAP_PG_TARBALL || process.env.ZLEAP_SKIP_POSTGRES) {
    throw new Error(
      'Legacy Postgres env is not supported. package:postgres uses distribution.json runtime.postgres.source or ZLEAP_POSTGRES_STAGED_ROOT.',
    );
  }
  if (!postgres?.version) {
    throw new Error('distribution.json runtime.postgres.version is required');
  }
  if (!postgres?.pgvectorVersion) {
    throw new Error('distribution.json runtime.postgres.pgvectorVersion is required');
  }

  const bundleRootName = `zleap-postgres-${postgres.version}-pgvector-${postgres.pgvectorVersion}-${tag}`;
  const staged = process.env.ZLEAP_POSTGRES_STAGED_ROOT?.trim();
  let installRoot;
  let sourceInfo;
  if (staged) {
    installRoot = resolve(staged);
    sourceInfo = sourceInfoFromConfig();
    process.stdout.write(`Packaging staged official Postgres root ${installRoot}\n`);
  } else {
    ({ installRoot, sourceInfo } = await buildFromOfficialSources());
  }

  await prunePostgresRoot(installRoot);
  await fixDarwinInstallNames(installRoot);
  verifyPostgresRoot(installRoot);
  await chmodPostgresBins(installRoot);
  await writeBundleManifest(installRoot, sourceInfo);

  const bundleRoot = join(OUT_ROOT, bundleRootName);
  await rm(bundleRoot, { recursive: true, force: true });
  await mkdir(dirname(bundleRoot), { recursive: true });
  await cp(installRoot, bundleRoot, { recursive: true, dereference: true });

  await mkdir(UPLOAD_DIR, { recursive: true });
  const archive = join(UPLOAD_DIR, `${bundleRootName}.tar.gz`);
  await rm(archive, { force: true });
  await rm(`${archive}.sha256`, { force: true });
  await run('tar', ['-czf', archive, '-C', OUT_ROOT, bundleRootName]);
  const sha256 = sha256File(archive);
  await writeFile(`${archive}.sha256`, `${sha256}  ${basename(archive)}\n`, 'utf8');
  await writeFile(
    join(UPLOAD_DIR, 'postgres-bundle.env'),
    `ZLEAP_POSTGRES_BUNDLE=${archive}\nZLEAP_POSTGRES_BUNDLE_SHA256=${sha256}\n`,
    'utf8',
  );
  process.stdout.write(`Postgres bundle written to ${archive}\n`);
}

async function buildFromOfficialSources() {
  const source = sourceInfoFromConfig();
  const buildSourceRoot = join(BUILD_ROOT, 'source');
  const installRoot = join(BUILD_ROOT, 'install');
  await rm(BUILD_ROOT, { recursive: true, force: true });
  await mkdir(buildSourceRoot, { recursive: true });
  await mkdir(SOURCE_CACHE, { recursive: true });

  const postgresArchive = await downloadSource('PostgreSQL', source.postgres, SOURCE_CACHE);
  const pgvectorArchive = await downloadSource('pgvector', source.pgvector, SOURCE_CACHE);
  const postgresSource = await extractArchive(postgresArchive, join(buildSourceRoot, 'postgresql'));
  const pgvectorSource = await extractArchive(pgvectorArchive, join(buildSourceRoot, 'pgvector'));

  if (process.platform === 'win32') {
    await buildWindowsFromOfficialSources(postgresSource, pgvectorSource, installRoot);
    return { installRoot, sourceInfo: source };
  }

  await run('./configure', [
    `--prefix=${installRoot}`,
    '--without-icu',
    '--without-lz4',
    '--without-readline',
    '--without-zlib',
    '--without-zstd',
  ], {
    cwd: postgresSource,
  });
  await run('make', ['-j', String(Math.max(1, cpus().length))], { cwd: postgresSource });
  await run('make', ['install'], { cwd: postgresSource });

  const pgEnv = { ...process.env, PG_CONFIG: join(installRoot, 'bin', 'pg_config') };
  await run('make', [], { cwd: pgvectorSource, env: pgEnv });
  await run('make', ['install'], { cwd: pgvectorSource, env: pgEnv });

  return { installRoot, sourceInfo: source };
}

async function buildWindowsFromOfficialSources(postgresSource, pgvectorSource, installRoot) {
  const buildScript = join(postgresSource, 'src', 'tools', 'msvc', 'build.pl');
  const installScript = join(postgresSource, 'src', 'tools', 'msvc', 'install.pl');
  if (existsSync(buildScript) && existsSync(installScript)) {
    await run('perl', [buildScript], { cwd: postgresSource });
    await rm(installRoot, { recursive: true, force: true });
    await mkdir(installRoot, { recursive: true });
    await run('perl', [installScript, installRoot], { cwd: postgresSource });
  } else {
    await buildWindowsPostgresWithMeson(postgresSource, installRoot);
  }

  const pgEnv = {
    ...process.env,
    PGROOT: installRoot,
    PG_CONFIG: join(installRoot, 'bin', 'pg_config.exe'),
  };
  await run('nmake', ['/F', 'Makefile.win'], { cwd: pgvectorSource, env: pgEnv });
  await run('nmake', ['/F', 'Makefile.win', 'install'], { cwd: pgvectorSource, env: pgEnv });
}

async function buildWindowsPostgresWithMeson(postgresSource, installRoot) {
  const mesonBuild = join(BUILD_ROOT, 'postgres-meson');
  await rm(mesonBuild, { recursive: true, force: true });
  await rm(installRoot, { recursive: true, force: true });
  await mkdir(installRoot, { recursive: true });

  const mesonOptions = [
    '-m',
    'mesonbuild.mesonmain',
    'setup',
    mesonBuild,
    postgresSource,
    `--prefix=${installRoot}`,
    '--buildtype=release',
    '-Dauto_features=disabled',
    '-Ddocs=disabled',
    '-Dicu=disabled',
    '-Dlz4=disabled',
    '-Dreadline=disabled',
    '-Dssl=none',
    '-Dzlib=disabled',
    '-Dzstd=disabled',
  ];
  await run('python', mesonOptions);
  await run('python', ['-m', 'mesonbuild.mesonmain', 'compile', '-C', mesonBuild]);
  await run('python', ['-m', 'mesonbuild.mesonmain', 'install', '-C', mesonBuild]);
}

function sourceInfoFromConfig() {
  const source = postgres?.source;
  const pgSource = source?.postgres;
  const vectorSource = source?.pgvector;
  if (!pgSource?.url || !pgSource.sha256) {
    throw new Error('distribution.json runtime.postgres.source.postgres.url/sha256 is required');
  }
  if (!vectorSource?.url || !vectorSource.sha256) {
    throw new Error('distribution.json runtime.postgres.source.pgvector.url/sha256 is required');
  }
  if (!new URL(pgSource.url).hostname.endsWith('postgresql.org')) {
    throw new Error('PostgreSQL source URL must be an official postgresql.org URL');
  }
  if (new URL(vectorSource.url).hostname !== 'github.com' || !vectorSource.url.includes('/pgvector/pgvector/')) {
    throw new Error('pgvector source URL must point to github.com/pgvector/pgvector');
  }
  return {
    postgres: { url: pgSource.url, sha256: pgSource.sha256 },
    pgvector: { url: vectorSource.url, sha256: vectorSource.sha256 },
  };
}

async function downloadSource(label, descriptor, cacheDir) {
  const archive = join(cacheDir, basename(new URL(descriptor.url).pathname));
  if (!existsSync(archive)) {
    process.stdout.write(`Downloading ${label} source from ${descriptor.url}\n`);
    const response = await fetch(descriptor.url);
    if (!response.ok || !response.body) {
      throw new Error(`Failed to download ${label} source: HTTP ${response.status}`);
    }
    await pipeline(response.body, createWriteStream(archive));
  }
  const actual = sha256File(archive);
  if (actual !== descriptor.sha256) {
    await rm(archive, { force: true });
    throw new Error(`${label} source checksum mismatch: expected ${descriptor.sha256}, got ${actual}`);
  }
  return archive;
}

async function extractArchive(archive, dest) {
  await rm(dest, { recursive: true, force: true });
  await extractAnyArchive(archive, dest);
  const entries = await readdir(dest);
  if (entries.length === 1) {
    return join(dest, entries[0]);
  }
  return dest;
}

async function writeBundleManifest(root, sourceInfo) {
  const manifest = {
    product: 'zleap-postgres',
    platform: tag,
    layoutVersion: 1,
    builtAt: new Date().toISOString(),
    postgres: {
      version: postgres.version,
      source: sourceInfo.postgres,
    },
    pgvector: {
      version: postgres.pgvectorVersion,
      source: sourceInfo.pgvector,
    },
  };
  await writeFile(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function prunePostgresRoot(root) {
  const removable = [
    'doc',
    'include',
    'share/doc',
    'share/man',
    'lib/pgxs/src/test',
    'lib/pgxs/src/test/regress',
    'lib/pgxs/src/test/isolation',
  ];
  for (const rel of removable) {
    await rm(join(root, rel), { recursive: true, force: true });
  }
}

function verifyPostgresRoot(root) {
  const required = ['pg_ctl', 'initdb', 'postgres', 'psql', 'createdb', 'pg_isready', 'pg_config'];
  for (const name of required) {
    if (!existsSync(join(root, 'bin', exe(name)))) {
      throw new Error(`Postgres root missing bin/${exe(name)} at ${root}`);
    }
  }
  if (!existsSync(join(root, 'share', 'extension', 'vector.control'))) {
    throw new Error(`Postgres root missing share/extension/vector.control at ${root}`);
  }
  if (!hasVectorLibrary(root)) {
    throw new Error(`Postgres root missing pgvector shared library at ${root}`);
  }
}

function hasVectorLibrary(root) {
  const libRoot = join(root, 'lib');
  if (!existsSync(libRoot)) {
    return false;
  }
  const names = listFiles(libRoot).map((file) => basename(file));
  return names.some((name) => /^vector\.(so|dylib|dll)$/u.test(name));
}

function listFiles(root) {
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSyncSafe(dir)) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  visit(root);
  return files;
}

function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function fixDarwinInstallNames(root) {
  if (process.platform !== 'darwin') {
    return;
  }
  const libDir = join(root, 'lib');
  const binDir = join(root, 'bin');
  const dylibs = listFiles(libDir).filter((file) => file.endsWith('.dylib'));
  const sharedLibraries = dylibs
    .filter((file) => basename(file).startsWith('lib'))
    .map((file) => ({
      file,
      oldName: join(libDir, basename(file)),
      newName: `@rpath/${basename(file)}`,
    }));

  for (const item of sharedLibraries) {
    await run('install_name_tool', ['-id', item.newName, item.file]);
  }

  const machos = [...listFiles(binDir), ...dylibs];
  for (const file of machos) {
    const linked = await capture('otool', ['-L', file]);
    if (!linked) {
      continue;
    }
    const changes = [];
    for (const item of sharedLibraries) {
      if (linked.includes(item.oldName)) {
        changes.push('-change', item.oldName, item.newName);
      }
    }
    if (changes.length > 0) {
      await run('install_name_tool', [...changes, file]);
    }
    const rpath = file.startsWith(binDir) ? '@loader_path/../lib' : '@loader_path';
    const loadCommands = await capture('otool', ['-l', file]);
    if (loadCommands && !loadCommands.includes(rpath)) {
      await run('install_name_tool', ['-add_rpath', rpath, file]);
    }
  }
}

async function chmodPostgresBins(root) {
  if (process.platform === 'win32') {
    return;
  }
  for (const name of ['pg_ctl', 'initdb', 'postgres', 'psql', 'createdb', 'pg_isready', 'pg_config']) {
    const file = join(root, 'bin', name);
    if (existsSync(file)) await chmod(file, 0o755);
  }
}

function exe(name) {
  return tag.startsWith('win-') ? `${name}.exe` : name;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
