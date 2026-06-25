#!/usr/bin/env node
/**
 * Build one clean Zleap app runtime, then materialize the official platform payload
 * consumed by both Desktop resources and npm platform packages.
 *
 * Outputs:
 *   dist/app/<platform>/app
 *   dist/deps/<platform>/{manifest.json,node-*.tar.gz,postgres-*.tar.gz}
 *   dist/payload/<platform>/payload/{app.tar.gz,node.tar.gz,postgres.tar.gz,manifest.json,SHA256SUMS}
 *
 * Legacy compatibility outputs may still be derived while callers migrate:
 *   dist/release/<platform>/cli/{metadata.json,zleap-runtime-*.tar.gz}
 *   dist/release/<platform>/desktop/{metadata.json,zleap-app-seed-*.tar.gz}
 */
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  normalizeReleaseVersion,
  nodeBundleArchiveName,
  platformTag,
  postgresBundleArchiveName,
  postgresDownloadUrl,
  payloadArchiveName,
  REPO_ROOT,
  loadDistribution,
  shellEnv,
} from './release-version.mjs';

const APP_ROOT = join(REPO_ROOT, 'dist', 'app');
const DEPS_ROOT = join(REPO_ROOT, 'dist', 'deps');
const PAYLOAD_ROOT = join(REPO_ROOT, 'dist', 'payload');
const RELEASE_ROOT = join(REPO_ROOT, 'dist', 'release');
const tag = process.env.ZLEAP_RELEASE_PLATFORM || process.env.ZLEAP_PLATFORM || platformTag();
const version = normalizeReleaseVersion(process.env.ZLEAP_VERSION);
const selectedTarget = readArg('--target') ?? process.env.ZLEAP_RELEASE_TARGET ?? process.env.ZLEAP_APP_TARGET ?? 'all';
const targets = selectedTarget === 'all' ? ['desktop', 'cli'] : [selectedTarget];
const WEB_STANDALONE_ROOT = join(REPO_ROOT, 'packages', 'web', '.next', 'standalone');
const WEB_STANDALONE_APP = join(WEB_STANDALONE_ROOT, 'packages', 'web');
const WEB_STATIC = join(REPO_ROOT, 'packages', 'web', '.next', 'static');
const WEB_PUBLIC = join(REPO_ROOT, 'packages', 'web', 'public');
const WEB_SERVER_REL = 'web/packages/web/server.js';

async function main() {
  for (const target of targets) {
    if (target !== 'desktop' && target !== 'cli') {
      throw new Error(`Unknown ZLEAP_RELEASE_TARGET: ${target}`);
    }
  }

  const dist = loadDistribution();
  await run('pnpm', ['build']);

  const deps = await materializeDeps(dist);
  const { appDir, metadataText } = await materializeApp(dist, deps);
  await writePlatformPayload(appDir, join(DEPS_ROOT, tag), metadataText, deps);
  await archivePlatformPayload();
  await cleanupLegacyReleasePaths();
  await writeEntryReleases(targets, appDir, metadataText);

  const envLines = Object.entries(shellEnv(dist))
    .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`)
    .join('\n');
  await writeFile(join(RELEASE_ROOT, tag, 'distribution.env'), `${envLines}\n`, 'utf8');
  process.stdout.write(`App runtime written to ${appDir} (v${version})\n`);
  process.stdout.write(`Platform payload written to ${join(PAYLOAD_ROOT, tag, 'payload')} (v${version})\n`);
}

async function cleanupLegacyReleasePaths() {
  await resetDir(join(RELEASE_ROOT, tag, 'app'));
  await rm(join(RELEASE_ROOT, tag, 'metadata.json'), { force: true });
}

async function materializeDeps(dist) {
  const depsDir = join(DEPS_ROOT, tag);
  await resetDir(depsDir);
  await mkdir(depsDir, { recursive: true });

  const node = await materializeNodeDep(dist, depsDir);
  const postgres = await materializePostgresDep(dist, depsDir);
  const deps = { node, postgres };
  await writeFile(join(depsDir, 'manifest.json'), `${JSON.stringify({ version, platform: tag, deps }, null, 2)}\n`, 'utf8');
  return deps;
}

async function materializeNodeDep(dist, depsDir) {
  const nodeVersion = process.env.ZLEAP_NODE_VERSION ?? dist.runtime.node?.version ?? dist.runtime.nodeVersion;
  const source = resolveLocalNodeArchive();
  const archiveName = basename(source);
  const archive = join(depsDir, archiveName);
  await copyFile(source, archive);
  const sha256 = await sha256File(archive);
  await writeFile(`${archive}.sha256`, `${sha256}  ${archiveName}\n`, 'utf8');
  return {
    managed: true,
    version: nodeVersion,
    platform: tag,
    archive: archiveName,
    sha256,
  };
}

function resolveLocalNodeArchive() {
  if (process.env.ZLEAP_NODE_BUNDLE?.trim()) {
    return process.env.ZLEAP_NODE_BUNDLE.trim();
  }
  const configured = join(REPO_ROOT, 'dist', 'node', 'upload', nodeBundleArchiveName(tag));
  if (existsSync(configured)) {
    return configured;
  }
  throw new Error('Node dependency archive is required. Run pnpm package:node or set ZLEAP_NODE_BUNDLE.');
}

async function materializePostgresDep(dist, depsDir) {
  const source = resolveLocalPostgresArchive();
  const archiveName = basename(source);
  const archive = join(depsDir, archiveName);
  await copyFile(source, archive);
  const sha256 = await sha256File(archive);
  await writeFile(`${archive}.sha256`, `${sha256}  ${archiveName}\n`, 'utf8');
  return {
    managed: true,
    version: dist.runtime.postgres?.version,
    pgvectorVersion: dist.runtime.postgres?.pgvectorVersion,
    platform: tag,
    archive: archiveName,
    sha256,
  };
}

function resolveLocalPostgresArchive() {
  if (process.env.ZLEAP_POSTGRES_BUNDLE?.trim()) {
    return process.env.ZLEAP_POSTGRES_BUNDLE.trim();
  }
  const configured = join(REPO_ROOT, 'dist', 'postgres', 'upload', postgresBundleArchiveName(tag));
  if (existsSync(configured)) {
    return configured;
  }
  const env = localPostgresBundleEnv();
  if (env.ZLEAP_POSTGRES_BUNDLE?.trim()) {
    return env.ZLEAP_POSTGRES_BUNDLE.trim();
  }
  throw new Error('Postgres dependency archive is required. Run pnpm package:postgres or set ZLEAP_POSTGRES_BUNDLE.');
}

async function archivePlatformPayload() {
  const payloadRoot = join(PAYLOAD_ROOT, tag);
  const uploadDir = join(RELEASE_ROOT, tag, 'payload');
  await resetDir(uploadDir);
  await mkdir(uploadDir, { recursive: true });
  const archive = join(uploadDir, payloadArchiveName(version, tag));
  await archiveTarGz(archive, payloadRoot, ['payload']);
  await writeFile(`${archive}.sha256`, `${await sha256File(archive)}  ${basename(archive)}\n`, 'utf8');
  process.stdout.write(`payload archive -> ${archive}\n`);
}

async function materializeApp(dist, deps) {
  const appRoot = join(APP_ROOT, tag);
  const appDir = join(appRoot, 'app');
  await resetDir(appDir);
  await resetDir(join(appRoot, 'cli'));
  await resetDir(join(appRoot, 'desktop'));
  await mkdir(appDir, { recursive: true });

  await deployRuntime(appDir);
  await copyWeb(appDir);
  await copyRootFiles(appDir, dist, deps);

  const metadata = appMetadata(dist, deps);
  const metadataText = `${JSON.stringify(metadata, null, 2)}\n`;
  await writeFile(join(appDir, 'manifest.json'), metadataText, 'utf8');
  await writeFile(join(dirname(appDir), 'metadata.json'), metadataText, 'utf8');
  await assertPortableTree(appDir);
  return { appDir, metadataText };
}

async function deployRuntime(appDir) {
  const runtimeDir = join(appDir, 'runtime');
  await resetDir(runtimeDir);
  await pnpmDeploy('@zleap/runtime', runtimeDir, [
    'node_modules/@zleap/host/dist/serve-cli.js',
    'node_modules/@zleap/host/dist/desktop-bootstrap-cli.js',
    'node_modules/@zleap/host/dist/control-cli.js',
    'node_modules/@zleap/store/dist/migrate.js',
    'node_modules/@zleap/tasks/dist/worker.js',
    'node_modules/@zleap/gateway/dist/worker.js',
    'node_modules/@zleap-ai/cli/dist/index.js',
  ]);
  await pruneDeploySelfReference(runtimeDir, '@zleap/runtime');
}

async function writeEntryReleases(selectedTargets, appDir, metadataText) {
  for (const target of selectedTargets) {
    const releaseDir = join(RELEASE_ROOT, tag, target);
    await resetDir(releaseDir);
    await mkdir(releaseDir, { recursive: true });
    await writeFile(join(releaseDir, 'metadata.json'), metadataText, 'utf8');

    if (target === 'cli') {
      const archive = await archiveRuntime(appDir, releaseDir);
      process.stdout.write(`cli runtime archive -> ${archive}\n`);
    } else {
      const archive = await archiveDesktopSeed(appDir, releaseDir);
      process.stdout.write(`desktop app seed -> ${archive}\n`);
    }
  }
}

async function writePlatformPayload(appDir, depsDir, metadataText, deps) {
  const payloadDir = join(PAYLOAD_ROOT, tag, 'payload');
  await resetDir(payloadDir);
  await mkdir(payloadDir, { recursive: true });

  const appArchive = join(payloadDir, 'app.tar.gz');
  await archiveTarGz(appArchive, dirname(appDir), ['app']);

  const nodeArchive = join(payloadDir, 'node.tar.gz');
  await copyFile(join(depsDir, deps.node.archive), nodeArchive);

  const postgresArchive = join(payloadDir, 'postgres.tar.gz');
  await copyFile(join(depsDir, deps.postgres.archive), postgresArchive);

  const fileInfo = {};
  for (const name of ['app.tar.gz', 'node.tar.gz', 'postgres.tar.gz']) {
    const file = join(payloadDir, name);
    fileInfo[name] = {
      sha256: await sha256File(file),
      size: statSync(file).size,
    };
  }

  const baseManifest = JSON.parse(metadataText);
  const manifest = {
    ...baseManifest,
    kind: 'payload',
    payloadVersion: 1,
    payload: {
      files: fileInfo,
    },
  };
  await writeFile(join(payloadDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const checksums = [];
  for (const name of ['app.tar.gz', 'node.tar.gz', 'postgres.tar.gz', 'manifest.json']) {
    checksums.push(`${await sha256File(join(payloadDir, name))}  ${name}`);
  }
  await writeFile(join(payloadDir, 'SHA256SUMS'), `${checksums.join('\n')}\n`, 'utf8');
}

async function copyWeb(appDir) {
  const webDir = join(appDir, 'web');
  if (!existsSync(join(WEB_STANDALONE_APP, 'server.js'))) {
    throw new Error('Next.js standalone output missing. Ensure packages/web has been built.');
  }
  await resetDir(webDir);

  // Next.js standalone output is the canonical, self-contained server bundle: the
  // entry stays at packages/web/server.js and is launched with `node server.js`.
  // Copy everything EXCEPT the traced node_modules. That traced tree is pnpm's
  // symlinked `.pnpm` layout (module resolution depends on symlink + realpath),
  // which is not portable: copied verbatim it carries absolute/external/dangling
  // symlinks (notably on Windows). We instead provide a flat, hoisted node_modules
  // below. The non-node_modules part of the output is plain real files.
  await cp(WEB_STANDALONE_ROOT, webDir, {
    recursive: true,
    dereference: true,
    filter: (src) => {
      const rel = relative(WEB_STANDALONE_ROOT, src).replace(/\\/g, '/');
      if (rel === 'node_modules' || rel.startsWith('node_modules/')) {
        return false;
      }
      return nextStandaloneFilter(src);
    },
  });

  const webPackageDir = join(webDir, 'packages', 'web');
  if (!existsSync(join(webPackageDir, 'server.js'))) {
    throw new Error('Next.js standalone output is incomplete: packages/web/server.js is missing.');
  }

  // Resolve runtime dependencies into a flat, hoisted node_modules at the standalone
  // root — the directory `node server.js` walks up to. `pnpm deploy` with the
  // hoisted node-linker produces real files (npm-style flat tree, no `.pnpm`
  // symlinks), so resolution works by plain directory walking and the result is
  // identical and portable on every platform.
  await deployWebNodeModules(join(webDir, 'node_modules'));

  await mkdir(join(webPackageDir, '.next'), { recursive: true });
  await cp(WEB_STATIC, join(webPackageDir, '.next/static'), {
    recursive: true,
    dereference: true,
  });
  if (existsSync(WEB_PUBLIC)) {
    await cp(WEB_PUBLIC, join(webPackageDir, 'public'), { recursive: true, dereference: true });
  }
}

async function deployWebNodeModules(destNodeModules) {
  // pnpm resolves the deploy directory relative to the workspace root. On Windows
  // an out-of-tree temp dir on a different drive becomes a malformed path
  // (D:\repo\C:\Users\...). Keep the deploy target inside the repo so pnpm
  // relativizes it correctly, mirroring the in-tree runtime deploy.
  await mkdir(join(REPO_ROOT, 'dist'), { recursive: true });
  const tempDir = await mkdtemp(join(REPO_ROOT, 'dist', 'zleap-web-deploy-'));
  try {
    // pnpmDeploy strips node_modules/.bin and verifies the tree is complete via
    // these entry points (next + its peer @swc/helpers/@next/env are what the
    // standalone server resolves at the root node_modules).
    await pnpmDeploy('@zleap/web', tempDir, [
      'node_modules/next/package.json',
      'node_modules/@swc/helpers/package.json',
      'node_modules/@next/env/package.json',
      'node_modules/react/package.json',
      'node_modules/react-dom/package.json',
    ]);
    await rm(destNodeModules, { recursive: true, force: true });
    await cp(join(tempDir, 'node_modules'), destNodeModules, { recursive: true });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function removeBinDirs(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const child = join(dir, entry.name);
    if (entry.name === '.bin') {
      await rm(child, { recursive: true, force: true });
    } else {
      await removeBinDirs(child);
    }
  }
}

async function pruneDeploySelfReference(deployDir, packageName) {
  const link = join(deployDir, 'node_modules', '.pnpm', 'node_modules', ...packageName.split('/'));
  const stat = await lstat(link).catch(() => undefined);
  if (!stat?.isSymbolicLink()) {
    return;
  }
  const target = resolve(dirname(link), await readlink(link));
  if (isInsidePath(deployDir, target)) {
    return;
  }
  await rm(link, { force: true });
}

async function assertPortableTree(root) {
  const bad = [];
  await walk(root, async (file) => {
    const stat = await lstat(file);
    if (!stat.isSymbolicLink()) {
      return;
    }
    const target = await readlink(file);
    if (!existsSync(file)) {
      bad.push(`${relative(root, file)} -> ${target} (broken)`);
      return;
    }
    if (isAbsolute(target)) {
      bad.push(`${relative(root, file)} -> ${target} (absolute)`);
      return;
    }
    const resolved = resolve(dirname(file), target);
    if (!isInsidePath(root, resolved)) {
      bad.push(`${relative(root, file)} -> ${target} (outside app root)`);
    }
  });
  if (bad.length > 0) {
    throw new Error(`Release app is not portable:\n${bad.slice(0, 20).join('\n')}${bad.length > 20 ? `\n... ${bad.length - 20} more` : ''}`);
  }
}

function isInsidePath(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function walk(dir, visit) {
  let stat;
  try {
    stat = await lstat(dir);
  } catch {
    return;
  }
  await visit(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return;
  }
  for (const entry of await readdir(dir)) {
    await walk(join(dir, entry), visit);
  }
}

async function copyRootFiles(appDir, dist, deps) {
  for (const file of ['.env.example']) {
    const src = join(REPO_ROOT, file);
    if (existsSync(src)) {
      await copyFile(src, join(appDir, file));
    }
  }
  await writeShippedDistribution(appDir, dist, deps);
}

/**
 * The committed distribution.json keeps runtime.postgres.bundles empty (it is a
 * read-only template; CI never writes back to it). The SHIPPED copy embeds the
 * current platform's Postgres bundle url + sha256 so the host lazy-install path
 * (runtime-only updates / desktop) can fetch it. We do not mutate the repo file.
 */
async function writeShippedDistribution(appDir, dist, deps) {
  const shipped = JSON.parse(JSON.stringify(dist));
  shipped.runtime ??= {};
  shipped.runtime.postgres ??= {};
  const bundles = { ...(shipped.runtime.postgres.bundles ?? {}) };
  if (deps?.postgres?.sha256) {
    const archive = join(DEPS_ROOT, tag, deps.postgres.archive);
    bundles[tag] = {
      url: postgresDownloadUrl(version, tag, dist),
      sha256: deps.postgres.sha256,
      size: existsSync(archive) ? statSync(archive).size : undefined,
    };
  }
  shipped.runtime.postgres.bundles = bundles;
  await writeFile(join(appDir, 'distribution.json'), `${JSON.stringify(shipped, null, 2)}\n`, 'utf8');
}

function appMetadata(dist, deps) {
  const entries = {
    serve: 'node runtime/node_modules/@zleap/host/dist/serve-cli.js',
    control: 'node runtime/node_modules/@zleap/host/dist/control-cli.js',
    web: `node ${WEB_SERVER_REL}`,
    worker: 'node runtime/node_modules/@zleap/tasks/dist/worker.js',
    gateway: 'node runtime/node_modules/@zleap/gateway/dist/worker.js',
    cli: 'node runtime/node_modules/@zleap-ai/cli/dist/index.js',
  };
  return {
    version,
    platform: tag,
    builtAt: new Date().toISOString(),
    kind: 'app',
    target: 'app',
    schemaVersion: dist.runtime.schemaVersion ?? 1,
    minCliVersion: dist.runtime.minCliVersion ?? version,
    minDesktopVersion: dist.runtime.minDesktopVersion ?? version,
    supportedCliRange: dist.runtime.supportedCliRange ?? `>=${version}`,
    supportedDesktopRange: dist.runtime.supportedDesktopRange ?? `>=${version}`,
    nodeVersion: process.env.ZLEAP_NODE_VERSION ?? dist.runtime.node?.version ?? dist.runtime.nodeVersion,
    postgresVersion: dist.runtime.postgres?.version,
    pgvectorVersion: dist.runtime.postgres?.pgvectorVersion,
    features: {
      node: true,
      postgres: true,
      web: true,
      tasks: true,
      gateway: true,
      cli: true,
    },
    deps,
    entries,
  };
}

async function archiveRuntime(appDir, releaseDir) {
  const archiveName = `zleap-runtime-${version}-${tag}.tar.gz`;
  const archive = join(releaseDir, archiveName);
  await archiveTarGz(archive, dirname(appDir), ['app', 'metadata.json']);
  return archive;
}

async function archiveTarGz(archive, cwd, entries) {
  await writeArchiveFromTemp(archive, '.tar.gz', async (tempArchive) => {
    await run('tar', [
      '-czf',
      tempArchive,
      '-C',
      cwd,
      ...entries,
    ]);
  });
  return archive;
}

async function writeArchiveFromTemp(archive, extension, writeTempArchive) {
  const tempDir = await mkdtemp(join(tmpdir(), 'zleap-archive-'));
  const tempArchive = join(tempDir, `archive${extension}`);
  try {
    await rm(archive, { force: true });
    await mkdir(dirname(archive), { recursive: true });
    await writeTempArchive(tempArchive);
    await copyFile(tempArchive, archive);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function archiveDesktopSeed(appDir, releaseDir) {
  const archiveName = `zleap-app-seed-${version}-${tag}.tar.gz`;
  const archive = join(releaseDir, archiveName);
  await archiveTarGz(archive, dirname(appDir), ['app', 'metadata.json']);
  await writeFile(`${archive}.sha256`, `${await sha256File(archive)}  ${archiveName}\n`, 'utf8');
  return archive;
}

function nextStandaloneFilter(src) {
  const rel = relative(WEB_STANDALONE_ROOT, src).replace(/\\/g, '/');
  return !(rel === 'packages/web/.next/cache' || rel.startsWith('packages/web/.next/cache/'));
}

async function resetDir(dir) {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

function localPostgresBundleEnv() {
  if (process.env.ZLEAP_POSTGRES_BUNDLE?.trim()) {
    return {};
  }
  const envFile = join(REPO_ROOT, 'dist', 'postgres', 'upload', 'postgres-bundle.env');
  if (!existsSync(envFile)) {
    return {};
  }
  const env = {};
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/u)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index > 0) env[line.slice(0, index)] = line.slice(index + 1);
  }
  return env;
}

async function sha256File(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

/**
 * Force `pnpm deploy` to produce a hoisted (npm-style flat) node_modules tree
 * instead of the default symlinked `.pnpm` layout. A hoisted tree is real files
 * with no package symlinks, so module resolution works by plain directory walking
 * and the output is portable across machines and platforms (the symlinked layout
 * depends on symlink + realpath resolution and breaks once moved, especially on
 * Windows). The only symlinks a hoisted deploy still emits are CLI bin shims,
 * which callers strip via removeBinDirs.
 */
function deployEnv() {
  return { ...process.env, npm_config_node_linker: 'hoisted' };
}

/**
 * Deploy a workspace package's production dependency tree into destDir.
 *
 * pnpm copies the dependency tree first and links Windows bin shims
 * (node_modules/.bin/*.cmd|*.exe) as its FINAL step. On GitHub-hosted Windows
 * runners that final step intermittently fails with EPERM because Defender scans
 * the freshly written shim, and the runner image silently ignores Defender
 * exclusions / Tamper Protection blocks disabling real-time protection — so the
 * flake is not reliably fixable at the runner level.
 *
 * We never ship those bin shims: every runtime/web process is launched by an
 * explicit `node <path>` (see packages/host supervisor), never through .bin. So
 * the bin-linking phase is irrelevant to us. This deploy therefore strips .bin
 * regardless of pnpm's exit code and treats the deploy as successful as long as
 * the dependency tree itself is complete (verified via requiredRelPaths). This
 * makes packaging deterministic instead of depending on AV timing. A genuinely
 * incomplete tree (pnpm failed before/while copying packages) still retries and
 * ultimately fails.
 */
async function pnpmDeploy(filterPkg, destDir, requiredRelPaths = []) {
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let deployError;
    try {
      await run('pnpm', ['--filter', filterPkg, '--prod', 'deploy', destDir], { env: deployEnv() });
    } catch (error) {
      deployError = error instanceof Error ? error : new Error(String(error));
    }

    await removeBinDirs(join(destDir, 'node_modules'));

    const treeExists = existsSync(join(destDir, 'node_modules'));
    const missing = requiredRelPaths.filter((rel) => !existsSync(join(destDir, rel)));
    if (treeExists && missing.length === 0) {
      if (deployError) {
        process.stderr.write(
          `pnpm deploy ${filterPkg}: dependency tree is complete; ignoring non-fatal bin-link error (bin shims are stripped and unused): ${deployError.message}\n`,
        );
      }
      return;
    }

    const reason = deployError
      ? deployError.message
      : `dependency tree incomplete (missing: ${missing.join(', ') || 'node_modules'})`;
    if (attempt === attempts) {
      throw deployError ?? new Error(`pnpm deploy ${filterPkg} produced an incomplete tree: missing ${missing.join(', ')}`);
    }
    process.stderr.write(`pnpm deploy ${filterPkg} attempt ${attempt}/${attempts} failed: ${reason}\nretrying...\n`);
    await resetDir(destDir);
    await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: options.env ?? process.env,
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited ${code}`))));
    child.on('error', reject);
  });
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index >= 0) {
    return process.argv[index + 1];
  }
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
