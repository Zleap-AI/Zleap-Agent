#!/usr/bin/env node
/**
 * Download and normalize the managed Node.js runtime used by Zleap payloads.
 *
 * Source of truth:
 *   distribution.json runtime.node.sources[platform].url/sha256
 *
 * Output:
 *   dist/node/upload/zleap-node-{version}-{platform}.tar.gz
 *   dist/node/upload/zleap-node-{version}-{platform}.tar.gz.sha256
 */
import { createWriteStream, existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { loadDistribution, nodeBundleArchiveName, platformTag } from './release-version.mjs';
import { archiveTarGz, extractAnyArchive, sha256File } from './lib/archive.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_ROOT = join(REPO_ROOT, 'dist', 'node');
const UPLOAD_DIR = join(OUT_ROOT, 'upload');
const CACHE_DIR = resolve(process.env.ZLEAP_NODE_SOURCE_CACHE || join(OUT_ROOT, 'sources'));
const platform = process.env.ZLEAP_RELEASE_PLATFORM || process.env.ZLEAP_PLATFORM || platformTag();
const dist = loadDistribution();
const nodeConfig = dist.runtime?.node;
const nodeVersion = nodeConfig?.version ?? dist.runtime?.nodeVersion;

async function main() {
  if (!nodeVersion) {
    throw new Error('distribution.json runtime.node.version or runtime.nodeVersion is required');
  }
  if (dist.runtime?.nodeVersion && dist.runtime.nodeVersion !== nodeVersion) {
    throw new Error('distribution.json runtime.nodeVersion must match runtime.node.version');
  }
  const source = nodeConfig?.sources?.[platform];
  if (!source?.url || !source.sha256) {
    throw new Error(`distribution.json runtime.node.sources.${platform}.url/sha256 is required`);
  }
  validateNodeSource(source, nodeVersion, platform);

  await mkdir(CACHE_DIR, { recursive: true });
  await mkdir(UPLOAD_DIR, { recursive: true });
  const sourceArchive = await downloadSource(source);
  const archiveName = nodeBundleArchiveName(platform, dist);
  const archive = join(UPLOAD_DIR, archiveName);
  await rm(archive, { force: true });
  await rm(`${archive}.sha256`, { force: true });
  const tmp = await mkdtemp(join(tmpdir(), 'zleap-node-extract-'));
  try {
    await extractAnyArchive(sourceArchive, tmp);
    await archiveTarGz(archive, tmp, [nodeRootName(nodeVersion, source.url)]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  const sha256 = sha256File(archive);
  await writeFile(`${archive}.sha256`, `${sha256}  ${basename(archive)}\n`, 'utf8');
  await writeFile(
    join(UPLOAD_DIR, 'node-bundle.env'),
    `ZLEAP_NODE_BUNDLE=${archive}\nZLEAP_NODE_BUNDLE_SHA256=${sha256}\n`,
    'utf8',
  );
  process.stdout.write(`Node bundle written to ${archive} (${statSync(archive).size} bytes)\n`);
}

function validateNodeSource(source, version, targetPlatform) {
  const url = new URL(source.url);
  if (url.hostname !== 'nodejs.org' || !url.pathname.startsWith(`/dist/v${version}/`)) {
    throw new Error(`runtime.node.sources.${targetPlatform}.url must use nodejs.org/dist/v${version}`);
  }
  const expectedExt = targetPlatform.startsWith('win-') ? '.zip' : '.tar.gz';
  if (!url.pathname.endsWith(expectedExt)) {
    throw new Error(`runtime.node.sources.${targetPlatform}.url must end with ${expectedExt}`);
  }
  if (!/^[a-f0-9]{64}$/i.test(source.sha256)) {
    throw new Error(`runtime.node.sources.${targetPlatform}.sha256 must be a 64-character hex digest`);
  }
}

async function downloadSource(source) {
  const archive = join(CACHE_DIR, basename(new URL(source.url).pathname));
  if (!existsSync(archive)) {
    process.stdout.write(`Downloading Node.js from ${source.url}\n`);
    const response = await fetch(source.url);
    if (!response.ok || !response.body) {
      throw new Error(`Failed to download Node.js dependency: HTTP ${response.status}`);
    }
    await pipeline(response.body, createWriteStream(archive));
  }
  const actual = sha256File(archive);
  if (actual !== source.sha256) {
    await rm(archive, { force: true });
    throw new Error(`Node.js source checksum mismatch: expected ${source.sha256}, got ${actual}`);
  }
  return archive;
}

function nodeRootName(version, url) {
  const name = basename(new URL(url).pathname).replace(/\.(tar\.gz|zip)$/u, '');
  if (!name.startsWith(`node-v${version}-`)) {
    throw new Error(`Unexpected Node.js archive name: ${name}`);
  }
  return name;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
