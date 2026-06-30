#!/usr/bin/env node
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmPackageMeta, platformTag } from './lib/platforms.mjs';
import { downloadMirrors, githubRepoSlug, payloadArchiveName, releaseDownloadBase } from './distribution.mjs';

const REPO_SLUG = githubRepoSlug();

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const version = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version ?? '0.1.0';
const PAYLOAD_ROOT = join(REPO_ROOT, 'dist', 'payload');
const NPM_ROOT = join(REPO_ROOT, 'dist', 'npm');

const selected = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
const platforms = selected.length > 0 ? selected : discoverPayloadPlatforms();
if (platforms.length === 0) {
  throw new Error('No payload platforms found. Run pnpm package:release first.');
}

for (const platform of platforms) {
  const meta = platformPackageMeta(platform);
  const sourcePayload = join(PAYLOAD_ROOT, platform, 'payload');
  const sourceManifest = join(sourcePayload, 'manifest.json');
  if (!existsSync(sourceManifest)) {
    throw new Error(`Payload missing for ${platform}: ${sourcePayload}`);
  }

  // Thin platform package: ship only the payload manifest (the trusted source of
  // per-file sha256 + sizes) plus a download descriptor pointing at the
  // version-pinned payload archive on the GitHub Release. The actual ~200MB+
  // payload is NOT embedded (npmjs rejects >~200MB tarballs with E413); the CLI
  // downloads + verifies it from the Release on first run. URL is derived from
  // distribution.json (single source of truth), never hardcoded.
  const archive = payloadArchiveName(version, platform);
  const url = `${releaseDownloadBase(version)}/${archive}`;
  const mirrors = downloadMirrors();

  const out = join(NPM_ROOT, meta.dir);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await cp(sourceManifest, join(out, 'manifest.json'));
  await writeFile(
    join(out, 'download.json'),
    `${JSON.stringify(
      mirrors.length > 0 ? { schema: 1, platform, version, archive, url, mirrors } : { schema: 1, platform, version, archive, url },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await writeFile(join(out, 'README.md'), platformReadme(meta.name), 'utf8');
  await writeFile(
    join(out, 'package.json'),
    `${JSON.stringify({
      name: meta.name,
      version,
      description: `Zleap platform payload descriptor for ${platform}`,
      repository: {
        type: 'git',
        url: `git+https://github.com/${REPO_SLUG}.git`,
      },
      os: [meta.os],
      cpu: [meta.cpu],
      files: ['manifest.json', 'download.json', 'README.md'],
      private: false,
      publishConfig: {
        access: 'public',
      },
    }, null, 2)}\n`,
    'utf8',
  );
  process.stdout.write(`Prepared ${meta.name} (thin) at ${out}\n`);
}

function discoverPayloadPlatforms() {
  if (!existsSync(PAYLOAD_ROOT)) {
    return [];
  }
  return [...new Set([platformTag(), ...safeReaddir(PAYLOAD_ROOT)])]
    .filter((platform) => existsSync(join(PAYLOAD_ROOT, platform, 'payload', 'manifest.json')));
}

function platformPackageMeta(platform) {
  return npmPackageMeta(platform);
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function platformReadme(name) {
  return `# ${name}

Platform payload descriptor for Zleap. This package is installed as an optional
dependency of \`@zleap-ai/cli\`. It contains the payload manifest (checksums) and
a download descriptor; the CLI downloads and verifies the platform payload from
the GitHub Release on first run.
`;
}
