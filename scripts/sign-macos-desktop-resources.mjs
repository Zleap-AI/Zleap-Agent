#!/usr/bin/env node
/** Re-sign compressed Desktop payload archives before macOS notarization. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const resources = resolve(process.argv[2] ?? 'packages/desktop/src-tauri/resources');
const identity = process.env.APPLE_SIGNING_IDENTITY?.trim();

if (process.platform !== 'darwin') {
  process.exit(0);
}

if (process.env.ZLEAP_SKIP_MACOS_APP_SIGN === '1') {
  process.stdout.write('Skipping macOS desktop resources signing (ZLEAP_SKIP_MACOS_APP_SIGN=1)\n');
  process.exit(0);
}

if (!identity) {
  process.stdout.write('Skipping macOS desktop resources signing: APPLE_SIGNING_IDENTITY is not set\n');
  process.exit(0);
}

if (!existsSync(resources)) {
  throw new Error(`Desktop resources not found: ${resources}`);
}

if (existsSync(join(resources, 'bootstrap.tar.gz'))) {
  await signBootstrapArchive(join(resources, 'bootstrap.tar.gz'));
} else if (existsSync(join(resources, 'payload'))) {
  await signPayloadArchives(join(resources, 'payload'));
} else {
  await signSeedArchives(join(resources, 'seed'));
  await signNodeArchives(join(resources, 'deps'));
}

async function signPayloadArchives(payloadDir) {
  for (const name of ['app.tar.gz', 'node.tar.gz', 'postgres.tar.gz']) {
    const archive = join(payloadDir, name);
    if (!existsSync(archive)) {
      throw new Error(`Payload archive missing: ${archive}`);
    }
    const temp = await mkdtemp(join(tmpdir(), 'zleap-sign-payload-'));
    try {
      await extractArchive(archive, temp);
      const entries = readdirSync(temp);
      if (entries.length === 0) {
        throw new Error(`Payload archive is empty: ${archive}`);
      }
      for (const entry of entries) {
        await run(process.execPath, [new URL('./sign-macos-app.mjs', import.meta.url).pathname, join(temp, entry)]);
      }
      await rm(archive, { force: true });
      await archiveEntries(temp, archive, entries);
      process.stdout.write(`Signed payload archive: ${archive}\n`);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
  await rewritePayloadManifest(payloadDir);
}

async function signBootstrapArchive(archivePath) {
  const temp = await mkdtemp(join(tmpdir(), 'zleap-sign-bootstrap-'));
  try {
    await extractArchive(archivePath, temp);
    const nodeArchive = join(temp, 'node.tar.gz');
    if (!existsSync(nodeArchive)) {
      throw new Error(`bootstrap archive missing node.tar.gz: ${archivePath}`);
    }
    const nodeTemp = await mkdtemp(join(tmpdir(), 'zleap-sign-bootstrap-node-'));
    try {
      await extractArchive(nodeArchive, nodeTemp);
      const entries = readdirSync(nodeTemp);
      for (const entry of entries) {
        await run(process.execPath, [new URL('./sign-macos-app.mjs', import.meta.url).pathname, join(nodeTemp, entry)]);
      }
      await rm(nodeArchive, { force: true });
      await archiveEntries(nodeTemp, nodeArchive, entries);
    } finally {
      await rm(nodeTemp, { recursive: true, force: true });
    }
    const runtimeDir = join(temp, 'runtime');
    if (existsSync(runtimeDir)) {
      await run(process.execPath, [new URL('./sign-macos-app.mjs', import.meta.url).pathname, runtimeDir]);
    }
    await rm(archivePath, { force: true });
    await archiveEntries(temp, archivePath, ['runtime', 'node.tar.gz']);
    process.stdout.write(`Signed bootstrap archive: ${archivePath}\n`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function rewritePayloadManifest(payloadDir) {
  const manifestPath = join(payloadDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.payload ??= {};
  manifest.payload.files ??= {};
  for (const name of ['app.tar.gz', 'node.tar.gz', 'postgres.tar.gz']) {
    const file = join(payloadDir, name);
    manifest.payload.files[name] = {
      sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
      size: statSync(file).size,
    };
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const sums = [];
  for (const name of ['app.tar.gz', 'node.tar.gz', 'postgres.tar.gz', 'manifest.json']) {
    const file = join(payloadDir, name);
    sums.push(`${createHash('sha256').update(readFileSync(file)).digest('hex')}  ${name}`);
  }
  await writeFile(join(payloadDir, 'SHA256SUMS'), `${sums.join('\n')}\n`, 'utf8');
}

async function signSeedArchives(seedDir) {
  if (!existsSync(seedDir)) return;
  for (const name of readdirSync(seedDir)) {
    if (!name.startsWith('zleap-app-seed-') || (!name.endsWith('.tar.gz') && !name.endsWith('.zip'))) {
      continue;
    }
    const archive = join(seedDir, name);
    const temp = await mkdtemp(join(tmpdir(), 'zleap-sign-seed-'));
    try {
      await extractArchive(archive, temp);
      const app = join(temp, 'app');
      if (!existsSync(app)) {
        throw new Error(`Seed archive missing app/: ${archive}`);
      }
      await run(process.execPath, [new URL('./sign-macos-app.mjs', import.meta.url).pathname, app]);
      await rm(archive, { force: true });
      await archiveEntries(temp, archive, ['app', ...(existsSync(join(temp, 'metadata.json')) ? ['metadata.json'] : [])]);
      await writeChecksum(archive);
      process.stdout.write(`Signed desktop seed archive: ${archive}\n`);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
}

async function signNodeArchives(depsDir) {
  if (!existsSync(depsDir)) return;
  for (const name of readdirSync(depsDir)) {
    if (!name.startsWith('node-v') || (!name.endsWith('.tar.gz') && !name.endsWith('.zip'))) {
      continue;
    }
    const archive = join(depsDir, name);
    const temp = await mkdtemp(join(tmpdir(), 'zleap-sign-node-'));
    try {
      await extractArchive(archive, temp);
      const root = readdirSync(temp)
        .map((entry) => join(temp, entry))
        .find((candidate) => existsSync(join(candidate, 'bin', 'node')));
      if (!root) {
        throw new Error(`Node archive missing bin/node: ${archive}`);
      }
      await run(process.execPath, [new URL('./sign-macos-app.mjs', import.meta.url).pathname, root]);
      await rm(archive, { force: true });
      await archiveEntries(temp, archive, [basename(root)]);
      await writeChecksum(archive);
      process.stdout.write(`Signed Node dependency archive: ${archive}\n`);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
}

async function extractArchive(archive, dest) {
  if (archive.endsWith('.zip')) {
    await run('unzip', ['-q', archive, '-d', dest]);
  } else {
    await run('tar', ['-xzf', archive, '-C', dest]);
  }
}

async function archiveEntries(cwd, archive, entries) {
  await mkdir(dirname(archive), { recursive: true });
  if (archive.endsWith('.zip')) {
    await run('zip', ['-qry', archive, ...entries], { cwd });
  } else {
    await run('tar', ['-czf', archive, '-C', cwd, ...entries]);
  }
}

async function writeChecksum(file) {
  const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
  await writeFile(`${file}.sha256`, `${hash}  ${basename(file)}\n`, 'utf8');
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: 'inherit',
      env: options.env ?? process.env,
    });
    child.on('exit', (code) => (code === 0 ? resolveRun() : reject(new Error(`${command} ${args.join(' ')} exited ${code}`))));
    child.on('error', reject);
  });
}

process.on('unhandledRejection', (error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
