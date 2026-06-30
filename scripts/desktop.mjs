#!/usr/bin/env node
/**
 * Local desktop workflow — one entry for engineers, same path as end users.
 *
 *   pnpm desktop              # app runtime (if missing) → tauri dev
 *   pnpm desktop:build        # app runtime → embed in app → .dmg / .exe
 *   pnpm desktop:package      # app runtime only
 *   pnpm desktop:resources    # app runtime → compressed payload resources only
 *
 * Options (env):
 *   ZLEAP_NODE_BUNDLE         explicit zleap-node bundle for release packaging
 *   ZLEAP_POSTGRES_BUNDLE     explicit zleap-postgres bundle for release packaging
 *   ZLEAP_SKIP_PACKAGE=1      reuse dist/app/<platform>/app
 *   ZLEAP_FORCE_PACKAGE=1     rebuild app runtime even when present
 */
import { cp, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { platformTag, REPO_ROOT } from './release-version.mjs';

const DESKTOP_DIR = join(REPO_ROOT, 'packages/desktop');
const DESKTOP_DIST_DIR = join(DESKTOP_DIR, 'dist');
const RESOURCES_DIR = join(DESKTOP_DIR, 'src-tauri/resources');
const tag = platformTag();
const releaseDir = join(REPO_ROOT, 'dist', 'release', tag, 'desktop');
const appDir = join(REPO_ROOT, 'dist', 'app', tag, 'app');
const appMetadata = join(REPO_ROOT, 'dist', 'app', tag, 'metadata.json');
const payloadDir = join(REPO_ROOT, 'dist', 'payload', tag, 'payload');
const serveCli = join(appDir, 'runtime/node_modules/@zleap/host/dist/serve-cli.js');

const mode = process.argv[2] ?? 'dev';

function appReady() {
  return existsSync(serveCli);
}

function run(command, args, envOrOptions = process.env) {
  const options = envOrOptions?.env || envOrOptions?.cwd ? envOrOptions : { env: envOrOptions };
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: options.env ?? envOrOptions,
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))));
    child.on('error', reject);
  });
}

async function ensureAppRuntime() {
  if (process.env.ZLEAP_SKIP_PACKAGE === '1' && !appReady()) {
    throw new Error(`ZLEAP_SKIP_PACKAGE=1 but app runtime is missing: ${appDir}\nRun: pnpm desktop:package`);
  }
  if (appReady() && process.env.ZLEAP_FORCE_PACKAGE !== '1') {
    process.stdout.write(`App runtime ready: ${appDir}\n`);
    return;
  }
  process.stdout.write('Building app runtime…\n');
  const nodeEnv = await resolveNodeBundleEnv();
  const postgresEnv = await resolvePostgresBundleEnv();
  await run(process.execPath, [join(REPO_ROOT, 'scripts/package-release.mjs'), '--target', 'desktop'], {
    ...process.env,
    ...nodeEnv,
    ...postgresEnv,
  });
  await run(process.execPath, [join(REPO_ROOT, 'tests/smoke-app-runtime.mjs'), appDir]);
  await run(process.execPath, [join(REPO_ROOT, 'tests/smoke-payload.mjs'), payloadDir]);
}

async function resolveNodeBundleEnv() {
  if (process.env.ZLEAP_NODE_BUNDLE?.trim()) {
    return {};
  }
  await run('pnpm', ['package:node']);
  const envFile = join(REPO_ROOT, 'dist', 'node', 'upload', 'node-bundle.env');
  if (!existsSync(envFile)) {
    throw new Error(`Node bundle env missing: ${envFile}`);
  }
  return readEnvFile(envFile);
}

async function resolvePostgresBundleEnv() {
  if (process.env.ZLEAP_POSTGRES_BUNDLE?.trim()) {
    return {};
  }
  await run('pnpm', ['package:postgres']);
  const envFile = join(REPO_ROOT, 'dist', 'postgres', 'upload', 'postgres-bundle.env');
  if (!existsSync(envFile)) {
    throw new Error(`Postgres bundle env missing: ${envFile}`);
  }
  return readEnvFile(envFile);
}

function readEnvFile(envFile) {
  return Object.fromEntries(
    readFileSync(envFile, 'utf8')
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
}

async function syncResources(env = process.env) {
  if (!appReady()) {
    throw new Error(`App runtime missing: ${appDir}`);
  }
  if (!existsSync(join(payloadDir, 'manifest.json'))) {
    throw new Error(`Desktop payload missing: ${payloadDir}\nRun: pnpm desktop:package`);
  }
  const fat = env.ZLEAP_DESKTOP_EMBED_PAYLOAD === '1';
  await run(process.execPath, [
    join(REPO_ROOT, 'scripts/prepare-desktop-resources.mjs'),
    tag,
    '--out',
    RESOURCES_DIR,
    ...(fat ? ['--mode', 'fat'] : []),
  ], env);
  await assertNoExpandedAppResource();
  await run(process.execPath, [join(REPO_ROOT, 'tests/smoke-desktop-resources.mjs'), RESOURCES_DIR]);
  process.stdout.write(
    `Embedded ${fat ? 'fat (self-contained)' : 'slim'} desktop resources → ${RESOURCES_DIR}\n`,
  );
}

async function resolveDesktopPayloadDir(env = process.env) {
  if (shouldSignEmbeddedArchives(env)) {
    return signedPayloadDir(env);
  }
  return payloadDir;
}

async function syncDesktopFrontend() {
  await resetDir(DESKTOP_DIST_DIR);
  await mkdir(DESKTOP_DIST_DIR, { recursive: true });
  for (const file of ['index.html', 'splash.html', 'error.html']) {
    await cp(join(DESKTOP_DIR, file), join(DESKTOP_DIST_DIR, file));
  }
  process.stdout.write(`Desktop frontend → ${DESKTOP_DIST_DIR}\n`);
}

/** Minimal resources for `tauri dev` — app runtime comes from ZLEAP_BUNDLED_ROOT, not packaged resources. */
async function ensureResourcesStub() {
  await resetDir(RESOURCES_DIR);
  await mkdir(RESOURCES_DIR, { recursive: true });
  if (existsSync(join(payloadDir, 'manifest.json'))) {
    await cp(payloadDir, join(RESOURCES_DIR, 'payload'), { recursive: true, verbatimSymlinks: true });
  }
  const metadata = resolveMetadataPath();
  if (existsSync(metadata)) {
    await cp(metadata, join(RESOURCES_DIR, 'metadata.json'));
  }
  await writeFile(
    join(RESOURCES_DIR, '.dev-stub'),
    `ZLEAP_BUNDLED_ROOT=${appDir}\n`,
    'utf8',
  );
  process.stdout.write(`Resources stub ready (app runtime via ZLEAP_BUNDLED_ROOT)\n`);
}

function resolveMetadataPath() {
  const candidates = [join(releaseDir, 'metadata.json'), appMetadata, join(appDir, 'manifest.json')];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function shouldSignEmbeddedArchives(env = process.env) {
  return (
    process.platform === 'darwin' &&
    env.ZLEAP_SKIP_MACOS_APP_SIGN !== '1' &&
    Boolean(env.APPLE_SIGNING_IDENTITY?.trim())
  );
}

async function signedPayloadDir(env) {
  const out = join(REPO_ROOT, 'dist', 'payload', tag, 'desktop-signed-payload', 'payload');
  await resetDir(dirname(out));
  await mkdir(out, { recursive: true });
  await cp(payloadDir, out, { recursive: true, verbatimSymlinks: true });

  for (const name of ['app.tar.gz', 'node.tar.gz', 'postgres.tar.gz']) {
    await signPayloadArchive(join(out, name), env);
  }

  const manifestPath = join(out, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.payload ??= {};
  manifest.payload.files ??= {};
  for (const name of ['app.tar.gz', 'node.tar.gz', 'postgres.tar.gz']) {
    const file = join(out, name);
    manifest.payload.files[name] = {
      sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
      size: statSync(file).size,
    };
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const checksums = [];
  for (const name of ['app.tar.gz', 'node.tar.gz', 'postgres.tar.gz', 'manifest.json']) {
    const file = join(out, name);
    checksums.push(`${createHash('sha256').update(readFileSync(file)).digest('hex')}  ${name}`);
  }
  await writeFile(join(out, 'SHA256SUMS'), `${checksums.join('\n')}\n`, 'utf8');
  return out;
}

async function signPayloadArchive(archive, env) {
  const temp = await mkdtemp(join(tmpdir(), 'zleap-signed-payload-'));
  try {
    await extractArchive(archive, temp);
    const entries = readdirSync(temp);
    if (entries.length === 0) {
      throw new Error(`Payload archive is empty: ${archive}`);
    }
    for (const entry of entries) {
      const root = join(temp, entry);
      if (existsSync(root)) {
        await run(process.execPath, [join(REPO_ROOT, 'scripts/sign-macos-app.mjs'), root], env);
      }
    }
    await rm(archive, { force: true });
    await archiveDirectory(temp, archive, entries);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function extractArchive(archive, dest) {
  if (archive.endsWith('.zip')) {
    await run('unzip', ['-q', archive, '-d', dest]);
  } else {
    await run('tar', ['-xzf', archive, '-C', dest]);
  }
}

async function archiveDirectory(cwd, archive, entries) {
  await mkdir(dirname(archive), { recursive: true });
  if (archive.endsWith('.zip')) {
    await run('zip', ['-qry', archive, ...entries], { cwd, env: process.env });
  } else {
    await run('tar', ['-czf', archive, '-C', cwd, ...entries]);
  }
}

async function assertNoExpandedAppResource() {
  const expandedNodeModules = join(RESOURCES_DIR, 'app', 'node_modules');
  if (existsSync(expandedNodeModules)) {
    throw new Error(`Desktop resources must embed a seed archive, not expanded node_modules: ${expandedNodeModules}`);
  }
}

async function resetDir(dir) {
  if (!existsSync(dir)) {
    return;
  }
  const trash = `${dir}.old-${process.pid}-${Date.now()}`;
  await rename(dir, trash);
  await rm(trash, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

async function runTauriDev() {
  await syncDesktopFrontend();
  await ensureResourcesStub();
  process.stdout.write(`Launching desktop (bundled app runtime: ${appDir})\n`);
  await run('pnpm', ['--filter', '@zleap/desktop', 'dev'], {
    ...process.env,
    ZLEAP_BUNDLED_ROOT: appDir,
  });
}

async function runTauriBuild() {
  const buildEnv = prepareTauriBuildEnv();
  validateMacSigningIdentity(buildEnv);
  await syncDesktopFrontend();
  await syncResources(buildEnv);
  process.stdout.write('Building desktop installer…\n');
  const buildArgs = ['--filter', '@zleap/desktop', 'build:app'];
  if (process.env.ZLEAP_TAURI_BUNDLES?.trim()) {
    buildArgs.push('--bundles', process.env.ZLEAP_TAURI_BUNDLES.trim());
  }
  await run('pnpm', buildArgs, buildEnv);
  const bundleRoot = join(DESKTOP_DIR, 'src-tauri/target/release/bundle');
  process.stdout.write(`\nDone. Install from:\n  ${bundleRoot}\n`);
}

function prepareTauriBuildEnv() {
  const buildEnv = { ...process.env };
  if (process.platform === 'darwin' && buildEnv.APPLE_APP_SPECIFIC_PASSWORD?.trim()) {
    buildEnv.APPLE_PASSWORD = buildEnv.APPLE_APP_SPECIFIC_PASSWORD;
  }
  if (process.platform === 'darwin' && buildEnv.ZLEAP_SKIP_NOTARIZE === '1') {
    delete buildEnv.APPLE_ID;
    delete buildEnv.APPLE_PASSWORD;
    delete buildEnv.APPLE_TEAM_ID;
    delete buildEnv.APPLE_API_ISSUER;
    delete buildEnv.APPLE_API_KEY;
    delete buildEnv.APPLE_API_KEY_PATH;
    process.stdout.write('Skipping macOS notarization credentials (ZLEAP_SKIP_NOTARIZE=1)\n');
  }
  return buildEnv;
}

function validateMacSigningIdentity(env) {
  if (process.platform !== 'darwin' || !env.APPLE_SIGNING_IDENTITY?.trim()) {
    return;
  }
  const identity = env.APPLE_SIGNING_IDENTITY.trim();
  const result = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    return;
  }
  const identities = result.stdout;
  if (identities.includes(identity)) {
    return;
  }
  throw new Error(
    `APPLE_SIGNING_IDENTITY is not available in the current keychain: ${identity}\n` +
      'Use the full identity from `security find-identity -v -p codesigning`, or unset APPLE_SIGNING_IDENTITY for ad-hoc local builds.',
  );
}

async function main() {
  switch (mode) {
    case 'package':
      await ensureAppRuntime();
      break;
    case 'resources':
      await ensureAppRuntime();
      await syncResources(prepareTauriBuildEnv());
      break;
    case 'dev':
      await ensureAppRuntime();
      await runTauriDev();
      break;
    case 'build':
      await ensureAppRuntime();
      await runTauriBuild();
      break;
    default:
      process.stderr.write(`Unknown mode: ${mode}\nUsage: pnpm desktop | desktop:build | desktop:package | desktop:resources\n`);
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
