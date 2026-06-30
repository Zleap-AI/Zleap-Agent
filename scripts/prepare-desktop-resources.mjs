#!/usr/bin/env node
/**
 * Prepare desktop app resources in one of two modes:
 *
 *   --mode slim (default): a bootstrap bundle (Node + host bootstrap scripts) plus a
 *     thin payload descriptor (manifest + download.json) for first-launch fetch.
 *     Bootstrap intentionally deploys only @zleap/host (not the full @zleap/runtime
 *     tree) so third-party Mach-O such as @larksuite/cli are not embedded in the .app.
 *
 *   --mode fat: embed the FULL payload (app/node/postgres tar.gz) under resources/payload
 *     so the installer is completely self-contained — first launch only extracts locally
 *     and never downloads anything. No bootstrap.tar.gz / download.json is emitted (no
 *     download URL ⇒ hard guarantee of offline self-containment). The Rust loader detects
 *     resources/payload/app.tar.gz and automatically takes the local-seed path
 *     (ZLEAP_DESKTOP_DOWNLOAD=0).
 */
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { OFFICIAL_PLATFORMS, platformTag } from './lib/platforms.mjs';
import { downloadMirrors, payloadArchiveName, releaseDownloadBase } from './distribution.mjs';
import { archiveTarGz, sha256File } from './lib/archive.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const cliArgs = process.argv.slice(2);

const modeArgIndex = cliArgs.indexOf('--mode');
const mode = modeArgIndex >= 0 ? cliArgs[modeArgIndex + 1] : 'slim';
if (mode !== 'slim' && mode !== 'fat') {
  throw new Error(`Unknown --mode "${mode}" (expected "slim" or "fat")`);
}

const outArgIndex = cliArgs.indexOf('--out');
// A value consumed by a flag (--out/--mode) must not be mistaken for the platform positional.
const flagValueIndexes = new Set([outArgIndex + 1, modeArgIndex + 1].filter((index) => index > 0));
const platform =
  cliArgs.find((arg) => OFFICIAL_PLATFORMS.includes(arg)) ??
  cliArgs.find((arg, index) => !arg.startsWith('-') && !flagValueIndexes.has(index)) ??
  platformTag();
const outDir = outArgIndex >= 0 ? cliArgs[outArgIndex + 1] : join(REPO_ROOT, 'packages', 'desktop', 'src-tauri', 'resources');

const payloadSource = join(REPO_ROOT, 'dist', 'payload', platform, 'payload');
const version = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version ?? '0.1.0';

const HOST_BOOTSTRAP_PATHS = [
  'node_modules/@zleap/host/dist/desktop-bootstrap-cli.js',
  'node_modules/@zleap/host/dist/desktop-bootstrap.js',
  'node_modules/@zleap/host/dist/setup-runtime.js',
  'node_modules/@zleap/host/dist/payload-fetch.js',
  'node_modules/@zleap/host/dist/payload.js',
  'node_modules/@zleap/host/dist/serve-cli.js',
];

if (!existsSync(join(payloadSource, 'manifest.json'))) {
  throw new Error(`Payload missing for ${platform}: ${payloadSource}\nRun: pnpm package:release`);
}

if (mode === 'fat') {
  // Self-contained installer: embed the full payload verbatim under resources/payload.
  // The Rust loader (resolve_bundled_seed_dir / resolve_bundled_payload_dir) looks for
  // resources/payload/{app,node,postgres}.tar.gz + manifest.json and seeds locally with
  // ZLEAP_DESKTOP_DOWNLOAD=0. No download.json is written, so there is no fetch URL at all.
  await resetDir(outDir);
  await mkdir(outDir, { recursive: true });
  await cp(payloadSource, join(outDir, 'payload'), { recursive: true, verbatimSymlinks: true });
  const fatManifest = JSON.parse(readFileSync(join(payloadSource, 'manifest.json'), 'utf8'));
  process.stdout.write(
    `Prepared fat (self-contained) desktop resources for ${platform} at ${outDir}\n` +
      `  payload/ embedded (app/node/postgres.tar.gz, v${fatManifest.version ?? version}) — first launch is offline\n`,
  );
  process.exit(0);
}

const manifest = JSON.parse(readFileSync(join(payloadSource, 'manifest.json'), 'utf8'));
const archive = payloadArchiveName(version, platform);
const url = `${releaseDownloadBase(version)}/${archive}`;
const mirrors = downloadMirrors();

await resetDir(outDir);
await mkdir(outDir, { recursive: true });

await writeFile(
  join(outDir, 'download.json'),
  `${JSON.stringify(
    mirrors.length > 0 ? { schema: 1, platform, version, archive, url, mirrors } : { schema: 1, platform, version, archive, url },
    null,
    2,
  )}\n`,
  'utf8',
);
await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
await writeFile(
  join(outDir, 'metadata.json'),
  `${JSON.stringify(
    {
      version: manifest.version ?? version,
      platform: manifest.platform ?? platform,
      builtAt: manifest.builtAt,
      nodeVersion: manifest.nodeVersion,
    },
    null,
    2,
  )}\n`,
  'utf8',
);

const bootstrapRoot = join(REPO_ROOT, 'dist', 'desktop-bootstrap', platform);
await resetDir(bootstrapRoot);
const bootstrapRuntime = join(bootstrapRoot, 'runtime');
await deployHostBootstrap(bootstrapRuntime);
await cp(join(payloadSource, 'node.tar.gz'), join(bootstrapRoot, 'node.tar.gz'));

const bootstrapArchive = join(outDir, 'bootstrap.tar.gz');
await archiveTarGz(bootstrapArchive, bootstrapRoot, ['runtime', 'node.tar.gz']);
await writeFile(`${bootstrapArchive}.sha256`, `${sha256File(bootstrapArchive)}  bootstrap.tar.gz\n`, 'utf8');

process.stdout.write(
  `Prepared slim desktop resources for ${platform} at ${outDir}\n` +
    `  bootstrap.tar.gz (${sha256File(bootstrapArchive).slice(0, 12)}…)\n` +
    `  payload via ${url}\n`,
);

async function deployHostBootstrap(runtimeDir) {
  // `pnpm deploy` lays the target package at the stage root (stage/dist + stage/package.json)
  // with its dependencies under stage/node_modules. The desktop host loader (lib.rs) expects
  // the host package itself at runtime/node_modules/@zleap/host, so reshape the layout here.
  const stageDir = `${runtimeDir}.stage`;
  await resetDir(stageDir);
  await pnpmDeploy('@zleap/host', stageDir, [
    'dist/desktop-bootstrap-cli.js',
    join('node_modules', '@zleap', 'store', 'package.json'),
    join('node_modules', 'pg', 'package.json'),
  ]);

  const nodeModules = join(runtimeDir, 'node_modules');
  const hostDir = join(nodeModules, '@zleap', 'host');
  await mkdir(hostDir, { recursive: true });
  for (const entry of ['dist', 'package.json', 'README.md']) {
    const src = join(stageDir, entry);
    if (existsSync(src)) {
      await cp(src, join(hostDir, entry), { recursive: true });
    }
  }
  const stageNodeModules = join(stageDir, 'node_modules');
  if (existsSync(stageNodeModules)) {
    for (const name of await readdir(stageNodeModules)) {
      if (name === '.bin') continue;
      await cp(join(stageNodeModules, name), join(nodeModules, name), {
        recursive: true,
        verbatimSymlinks: true,
      });
    }
  }
  await resetDir(stageDir);

  await removeBinDirs(nodeModules);
  const missing = HOST_BOOTSTRAP_PATHS.filter((rel) => !existsSync(join(runtimeDir, rel)));
  if (missing.length > 0) {
    throw new Error(`host bootstrap deploy incomplete: missing ${missing.join(', ')}`);
  }
  if (existsSync(join(nodeModules, '@larksuite'))) {
    throw new Error('host bootstrap unexpectedly contains @larksuite');
  }
}

function deployEnv() {
  return { ...process.env, npm_config_node_linker: 'hoisted' };
}

/**
 * Deploy a workspace package's production dependency tree into destDir.
 *
 * pnpm links Windows bin shims (node_modules/.bin/*.cmd) as its final step; on
 * GitHub-hosted Windows runners that step intermittently fails with EPERM
 * (Defender scans the freshly written shim). We never ship those shims, so treat
 * the deploy as successful whenever the dependency tree itself is complete
 * (verified via requiredRelPaths), regardless of pnpm's exit code. A genuinely
 * incomplete tree still retries and ultimately fails.
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

    if (attempt === attempts) {
      throw (
        deployError ??
        new Error(`pnpm deploy ${filterPkg} produced an incomplete tree: missing ${missing.join(', ')}`)
      );
    }
    const reason = deployError
      ? deployError.message
      : `dependency tree incomplete (missing: ${missing.join(', ') || 'node_modules'})`;
    process.stderr.write(`pnpm deploy ${filterPkg} attempt ${attempt}/${attempts} failed: ${reason}\nretrying...\n`);
    await resetDir(destDir);
    await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
  }
}

async function removeBinDirs(root) {
  if (!existsSync(root)) return;
  for (const name of await readdir(root)) {
    const full = join(root, name);
    if (name === '.bin') {
      await rm(full, { recursive: true, force: true });
      continue;
    }
    if (existsSync(full) && statSync(full).isDirectory()) {
      await removeBinDirs(full);
    }
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

async function resetDir(dir) {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
