#!/usr/bin/env node
/**
 * Distribution + release helpers for scripts (install.sh, package-release, CI).
 *
 * Two manifests, one responsibility each:
 *   - latest.json          Tauri updater manifest (desktop auto-update). Produced
 *                          and signed (minisign) by tauri-action. NOT written here.
 *   - install-manifest.json Custom install contract for the curl/npm payload +
 *                          runtime-only update path. Written and RSA-signed here.
 *
 * Usage:
 *   node scripts/distribution.mjs version
 *   node scripts/distribution.mjs platform
 *   node scripts/distribution.mjs release-base [version]
 *   node scripts/distribution.mjs archive-name [version] [platform]
 *   node scripts/distribution.mjs payload-archive-name [version] [platform]
 *   node scripts/distribution.mjs shell-env
 *   node scripts/distribution.mjs sync-version
 *   node scripts/distribution.mjs write-distribution-env [outDir]
 *   node scripts/distribution.mjs write-checksums [uploadDir]
 *   node scripts/distribution.mjs write-install-manifest [uploadDir]
 *   node scripts/distribution.mjs validate-install-manifest [manifestPath]
 */
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OFFICIAL_PLATFORMS,
  nodeDownloadPlatform,
  platformTag,
} from './lib/platforms.mjs';
import { sha256File, writeChecksumSidecar } from './lib/archive.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_WEB_PORT = 4789;
const DIST_PATH = join(REPO_ROOT, 'distribution.json');
const INSTALL_MANIFEST_FILE = 'install-manifest.json';

export { platformTag, nodeDownloadPlatform, REPO_ROOT, OFFICIAL_PLATFORMS };

export function loadDistribution() {
  return JSON.parse(readFileSync(DIST_PATH, 'utf8'));
}

export function readReleaseVersion() {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  return String(pkg.version ?? '0.1.0');
}

export function normalizeReleaseVersion(raw) {
  const value = String(raw ?? readReleaseVersion()).trim();
  return value.startsWith('v') ? value.slice(1) : value;
}

export function githubRepoSlug(dist = loadDistribution()) {
  return `${dist.github.owner}/${dist.github.repo}`;
}

export function releaseDownloadBase(version, dist = loadDistribution()) {
  if (process.env.ZLEAP_RELEASE_BASE?.trim()) {
    return process.env.ZLEAP_RELEASE_BASE.trim().replace(/\/$/, '');
  }
  const v = normalizeReleaseVersion(version);
  const configured = dist.release?.artifactBaseUrl?.trim();
  if (configured) {
    return renderReleaseTemplate(configured, dist, { version: v }).replace(/\/$/, '');
  }
  throw new Error('distribution.release.artifactBaseUrl is required');
}

/**
 * Optional China-friendly mirror/proxy entries baked into download.json so the
 * desktop GUI (which can't read user env vars) tries a fast domestic mirror
 * before the GitHub origin. Configure via ZLEAP_DOWNLOAD_MIRROR (comma-separated)
 * or distribution.release.downloadMirrors.
 */
export function downloadMirrors(dist = loadDistribution()) {
  const fromEnv = (process.env.ZLEAP_DOWNLOAD_MIRROR ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const configured = Array.isArray(dist.release?.downloadMirrors)
    ? dist.release.downloadMirrors.map((entry) => String(entry).trim()).filter(Boolean)
    : [];
  return [...new Set([...fromEnv, ...configured])];
}

export function updaterManifestUrl(dist = loadDistribution()) {
  if (process.env.ZLEAP_UPDATER_MANIFEST_URL?.trim()) {
    return process.env.ZLEAP_UPDATER_MANIFEST_URL.trim();
  }
  const configured = dist.release?.manifestUrl?.trim();
  if (configured) {
    return renderReleaseTemplate(configured, dist);
  }
  throw new Error('distribution.release.manifestUrl is required');
}

export function installManifestUrl(dist = loadDistribution()) {
  if (process.env.ZLEAP_INSTALL_MANIFEST_URL?.trim()) {
    return process.env.ZLEAP_INSTALL_MANIFEST_URL.trim();
  }
  if (process.env.ZLEAP_MANIFEST_URL?.trim()) {
    return process.env.ZLEAP_MANIFEST_URL.trim();
  }
  const configured = dist.release?.installManifestUrl?.trim();
  if (configured) {
    return renderReleaseTemplate(configured, dist);
  }
  // Derive from the manifest URL template, swapping the file name.
  const manifestTemplate = dist.release?.manifestUrl?.trim();
  if (manifestTemplate) {
    return renderReleaseTemplate(manifestTemplate, dist, { manifestFile: INSTALL_MANIFEST_FILE });
  }
  throw new Error('distribution.release.installManifestUrl or release.manifestUrl is required');
}

export function manifestPublicKey(dist = loadDistribution()) {
  return String(dist.updater?.manifestPublicKey ?? '').trim();
}

function renderReleaseTemplate(template, dist = loadDistribution(), values = {}) {
  const version = normalizeReleaseVersion(values.version ?? readReleaseVersion());
  const branch = values.branch ?? process.env.ZLEAP_INSTALL_BRANCH ?? dist.release?.installBranch ?? 'main';
  const context = {
    owner: dist.github?.owner ?? '',
    repo: dist.github?.repo ?? '',
    version,
    tag: `v${version}`,
    branch,
    channel: dist.release?.channel ?? 'stable',
    manifestFile: values.manifestFile ?? dist.updater?.manifestFile ?? 'latest.json',
  };
  return String(template).replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (match, key) => {
    const value = context[key];
    return value === undefined || value === '' ? match : String(value);
  });
}

export function appArchiveName(version, platform = platformTag()) {
  return `zleap-runtime-${normalizeReleaseVersion(version)}-${platform}.tar.gz`;
}

export function payloadArchiveName(version, platform = platformTag()) {
  return `zleap-payload-${normalizeReleaseVersion(version)}-${platform}.tar.gz`;
}

export function nodeBundleArchiveName(platform, dist = loadDistribution()) {
  const version = dist.runtime?.node?.version ?? dist.runtime?.nodeVersion;
  if (!version) {
    throw new Error('distribution.runtime.node.version or runtime.nodeVersion is required');
  }
  return `zleap-node-${version}-${platform}.tar.gz`;
}

export function postgresBundleArchiveName(platform, dist = loadDistribution()) {
  const pg = dist.runtime?.postgres;
  if (!pg?.version || !pg?.pgvectorVersion) {
    throw new Error('distribution.runtime.postgres.version and pgvectorVersion are required');
  }
  return `zleap-postgres-${pg.version}-pgvector-${pg.pgvectorVersion}-${platform}.tar.gz`;
}

export function postgresDownloadUrl(version, platform, dist = loadDistribution()) {
  const base = releaseDownloadBase(version, dist);
  return `${base}/${postgresBundleArchiveName(platform, dist)}`;
}

export function shellEnv(dist = loadDistribution()) {
  const version = readReleaseVersion();
  const platform = platformTag();
  const webPort = dist.runtime.webPort ?? DEFAULT_WEB_PORT;
  return {
    ZLEAP_VERSION: version,
    ZLEAP_PLATFORM: platform,
    ZLEAP_RELEASE_PROVIDER: dist.release?.provider ?? 'github',
    ZLEAP_RELEASE_BASE: releaseDownloadBase(version, dist),
    ZLEAP_ARCHIVE: appArchiveName(version, platform),
    ZLEAP_PAYLOAD_ARCHIVE: payloadArchiveName(version, platform),
    ZLEAP_GITHUB_REPO: githubRepoSlug(dist),
    ZLEAP_WEB_PORT: String(webPort),
    ZLEAP_NODE_VERSION: dist.runtime.node?.version ?? dist.runtime.nodeVersion,
    ZLEAP_AUTH_MODE: dist.runtime.authMode,
    ZLEAP_SERVE_MODE: dist.runtime.serveMode,
    ZLEAP_GATEWAY: dist.runtime.gateway ? '1' : '0',
    ZLEAP_ONBOARDING_URL: `http://127.0.0.1:${webPort}/onboarding`,
    ZLEAP_INSTALL_MANIFEST_URL: installManifestUrl(dist),
    ZLEAP_UPDATER_MANIFEST_URL: updaterManifestUrl(dist),
  };
}

export function syncVersion() {
  const version = readReleaseVersion();
  const dist = loadDistribution();
  const tauriConfPath = join(REPO_ROOT, 'packages/desktop/src-tauri/tauri.conf.json');
  const tauriConf = JSON.parse(readFileSync(tauriConfPath, 'utf8'));
  const productName = typeof dist.product === 'object' && dist.product?.desktopName
    ? dist.product.desktopName
    : typeof dist.product === 'object' && dist.product?.name
      ? dist.product.name
      : dist.product;
  if (productName) {
    tauriConf.productName = productName;
  }
  if (dist.desktop?.identifier) {
    tauriConf.identifier = dist.desktop.identifier;
  }
  // tauri.conf.json deliberately has NO version field: Tauri inherits the desktop
  // version from Cargo.toml [package].version, which releaser-pleaser bumps on the
  // GitLab control plane. Keeping a version here too would be a second source that
  // can drift, so we actively strip it.
  delete tauriConf.version;
  tauriConf.bundle ??= {};
  tauriConf.bundle.createUpdaterArtifacts = true;
  tauriConf.plugins ??= {};
  tauriConf.plugins.updater ??= {};
  tauriConf.plugins.updater.endpoints = [updaterManifestUrl(dist)];
  // The Tauri updater public key (minisign) is public and stays committed in
  // tauri.conf.json. CI never injects it.
  writeFileSync(tauriConfPath, `${JSON.stringify(tauriConf, null, 2)}\n`);
  process.stdout.write(`Synced version ${version} → tauri.conf.json\n`);

  const cliPkgPath = join(REPO_ROOT, 'packages', 'cli', 'package.json');
  const cliPkg = JSON.parse(readFileSync(cliPkgPath, 'utf8'));
  if (cliPkg.version !== version) {
    cliPkg.version = version;
    writeFileSync(cliPkgPath, `${JSON.stringify(cliPkg, null, 2)}\n`);
    process.stdout.write(`Synced version ${version} → packages/cli/package.json\n`);
  }

  syncCargoVersion(version);
}

// Cargo.toml [package].version is the authoritative desktop version: it feeds both
// `env!("CARGO_PKG_VERSION")` (the macOS "About" box) and — because tauri.conf.json
// has no version field — the Tauri bundle/updater version. releaser-pleaser bumps it
// via the `# x-releaser-pleaser-version` marker; this keeps local `sync:version` in
// lockstep. A scoped regex on the [package] table avoids a TOML parser dependency.
export function syncCargoVersion(version = readReleaseVersion()) {
  const cargoPath = join(REPO_ROOT, 'packages/desktop/src-tauri/Cargo.toml');
  if (!existsSync(cargoPath)) {
    return;
  }
  const original = readFileSync(cargoPath, 'utf8');
  let replaced = false;
  const next = original.replace(/(\[package\][\s\S]*?\n)(version\s*=\s*")([^"]*)(")/u, (match, head, pre, current, post) => {
    if (current === version) {
      return match;
    }
    replaced = true;
    return `${head}${pre}${version}${post}`;
  });
  if (replaced) {
    writeFileSync(cargoPath, next);
    process.stdout.write(`Synced version ${version} → packages/desktop/src-tauri/Cargo.toml\n`);
  }
}

export function writeDistributionEnv(outDir = join(REPO_ROOT, 'dist', 'release', platformTag())) {
  const env = shellEnv();
  const lines = Object.entries(env)
    .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`)
    .join('\n');
  writeFileSync(join(outDir, 'distribution.env'), `${lines}\n`);
  process.stdout.write(`Wrote ${join(outDir, 'distribution.env')}\n`);
}

export function writeChecksums(uploadDir) {
  if (!existsSync(uploadDir)) {
    throw new Error(`Upload dir not found: ${uploadDir}`);
  }
  const lines = [];
  for (const name of readdirSync(uploadDir)) {
    if (name.endsWith('.sha256') || name === 'SHA256SUMS') continue;
    const full = join(uploadDir, name);
    if (!statSync(full).isFile()) continue;
    const hash = writeChecksumSidecar(full);
    lines.push(`${hash}  ${name}`);
  }
  writeFileSync(join(uploadDir, 'SHA256SUMS'), `${lines.join('\n')}\n`);
  process.stdout.write(`Wrote checksums for ${lines.length} files in ${uploadDir}\n`);
}

export function writeInstallManifest(uploadDir, options = {}) {
  if (!existsSync(uploadDir)) {
    throw new Error(`Upload dir not found: ${uploadDir}`);
  }
  const version = normalizeReleaseVersion(options.version ?? readReleaseVersion());
  const dist = loadDistribution();
  const base = options.baseUrl ?? releaseDownloadBase(version);
  const runtimePlatforms = collectArtifacts(uploadDir, `zleap-runtime-${version}-`, base, /\.(tar\.gz|zip)$/);
  const payloadPlatforms = collectArtifacts(uploadDir, `zleap-payload-${version}-`, base, /\.tar\.gz$/);

  const manifest = {
    version,
    channel: dist.release?.channel ?? 'stable',
    notes: options.notes ?? `Zleap v${version}`,
    pub_date: new Date().toISOString(),
    runtime: {
      version,
      schemaVersion: dist.runtime?.schemaVersion ?? 1,
      minCliVersion: dist.runtime?.minCliVersion ?? version,
      minDesktopVersion: dist.runtime?.minDesktopVersion ?? version,
      supportedCliRange: dist.runtime?.supportedCliRange ?? `>=${version}`,
      supportedDesktopRange: dist.runtime?.supportedDesktopRange ?? `>=${version}`,
      nodeVersion: dist.runtime?.node?.version ?? dist.runtime?.nodeVersion,
      postgresVersion: dist.runtime?.postgres?.version,
      pgvectorVersion: dist.runtime?.postgres?.pgvectorVersion,
      platforms: runtimePlatforms,
    },
    payload: {
      version,
      platforms: payloadPlatforms,
    },
    cli: {
      npm: dist.cli?.npm ?? '@zleap-ai/cli',
      minVersion: dist.cli?.minVersion ?? version,
    },
  };
  const manifestPath = join(uploadDir, INSTALL_MANIFEST_FILE);
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(manifestPath, manifestText);
  writeManifestSignature(manifestPath, manifestText);
  process.stdout.write(`Wrote ${manifestPath}\n`);
}

function collectArtifacts(uploadDir, prefix, base, extPattern) {
  const platforms = {};
  for (const name of readdirSync(uploadDir)) {
    if (!name.startsWith(prefix) || name.endsWith('.sha256')) continue;
    if (!extPattern.test(name)) continue;
    const platform = name.slice(prefix.length).replace(/\.(tar\.gz|zip)$/, '');
    const full = join(uploadDir, name);
    const shaPath = `${full}.sha256`;
    const sha256 = existsSync(shaPath) ? readFileSync(shaPath, 'utf8').trim().split(/\s+/)[0] : undefined;
    platforms[platform] = {
      url: `${base}/${name}`,
      size: statSync(full).size,
      ...(sha256 ? { sha256 } : {}),
    };
  }
  return platforms;
}

export function validateInstallManifest(manifestPath = join(REPO_ROOT, 'dist', 'upload', INSTALL_MANIFEST_FILE)) {
  if (!existsSync(manifestPath)) {
    throw new Error(`${INSTALL_MANIFEST_FILE} not found: ${manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const failures = [];
  if (!isNonEmptyString(manifest.version)) {
    failures.push('version is required');
  }
  if (!isNonEmptyString(manifest.channel)) {
    failures.push('channel is required');
  }
  const runtime = manifest.runtime;
  if (!runtime || typeof runtime !== 'object') {
    failures.push('runtime object is required');
  } else {
    if (!isNonEmptyString(runtime.version)) {
      failures.push('runtime.version is required');
    }
    if (!Number.isFinite(runtime.schemaVersion) || runtime.schemaVersion < 1) {
      failures.push('runtime.schemaVersion must be a positive number');
    }
    validateRuntimePlatforms(runtime.platforms, failures);
    validateExpectedPlatforms('runtime.platforms', runtime.platforms, expectedRuntimePlatforms(), failures);
  }
  const payload = manifest.payload;
  if (!payload || typeof payload !== 'object') {
    failures.push('payload object is required');
  } else {
    validatePayloadPlatforms(payload.platforms, failures);
    validateExpectedPlatforms('payload.platforms', payload.platforms, expectedPayloadPlatforms(), failures);
  }
  if (!manifest.cli || manifest.cli.npm !== '@zleap-ai/cli') {
    failures.push('cli.npm must be @zleap-ai/cli');
  }
  const dist = loadDistribution();
  const requireSignature = dist.updater?.requireSignature === true || process.env.ZLEAP_REQUIRE_MANIFEST_SIGNATURE === '1';
  if (requireSignature && !existsSync(`${manifestPath}.sig`)) {
    failures.push(`${basename(manifestPath)}.sig is required by updater.requireSignature`);
  }
  if (failures.length > 0) {
    throw new Error(`Invalid ${basename(manifestPath)}:\n- ${failures.join('\n- ')}`);
  }
  process.stdout.write(`Validated ${manifestPath}\n`);
}

export function writeManifestSignature(manifestPath, manifestText = readFileSync(manifestPath, 'utf8')) {
  const privateKeyText = readSigningPrivateKey();
  if (!privateKeyText) {
    return false;
  }
  const key = createPrivateKey(privateKeyText);
  const signature = sign('RSA-SHA256', Buffer.from(manifestText, 'utf8'), key).toString('base64');
  writeFileSync(`${manifestPath}.sig`, `${signature}\n`);
  process.stdout.write(`Wrote ${manifestPath}.sig\n`);
  return true;
}

function readSigningPrivateKey() {
  if (process.env.ZLEAP_MANIFEST_PRIVATE_KEY?.trim()) {
    return decodePossiblyBase64Pem(process.env.ZLEAP_MANIFEST_PRIVATE_KEY.trim());
  }
  if (process.env.ZLEAP_MANIFEST_PRIVATE_KEY_PATH?.trim()) {
    return readFileSync(process.env.ZLEAP_MANIFEST_PRIVATE_KEY_PATH.trim(), 'utf8');
  }
  return undefined;
}

function decodePossiblyBase64Pem(value) {
  if (value.includes('BEGIN PRIVATE KEY')) {
    return value.replace(/\\n/g, '\n');
  }
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    return decoded.includes('BEGIN PRIVATE KEY') ? decoded : value;
  } catch {
    return value;
  }
}

function validateRuntimePlatforms(platforms, failures, label = 'runtime.platforms') {
  if (!platforms || typeof platforms !== 'object' || Object.keys(platforms).length === 0) {
    failures.push(`${label} must contain at least one platform`);
    return;
  }
  const runtimeKeyPattern = /^(mac|win|linux)-(arm64|x64)$/;
  for (const [platform, artifact] of Object.entries(platforms)) {
    if (!runtimeKeyPattern.test(platform)) {
      failures.push(`${label}.${platform} is not a runtime platform key`);
    }
    validateArtifact(`${label}.${platform}`, artifact, failures, { requireSha: true, requireSize: true });
    const url = typeof artifact?.url === 'string' ? artifact.url : '';
    if (/\.(dmg|exe|msi)$/i.test(url)) {
      failures.push(`${label}.${platform}.url points to a desktop installer`);
    }
  }
}

function validatePayloadPlatforms(platforms, failures) {
  if (!platforms || typeof platforms !== 'object' || Object.keys(platforms).length === 0) {
    failures.push('payload.platforms must contain at least one platform');
    return;
  }
  const runtimeKeyPattern = /^(mac|win|linux)-(arm64|x64)$/;
  for (const [platform, artifact] of Object.entries(platforms)) {
    if (!runtimeKeyPattern.test(platform)) {
      failures.push(`payload.platforms.${platform} is not a payload platform key`);
    }
    validateArtifact(`payload.platforms.${platform}`, artifact, failures, { requireSha: true, requireSize: true });
    const url = typeof artifact?.url === 'string' ? artifact.url : '';
    if (!/zleap-payload-\d.*\.tar\.gz$/i.test(url)) {
      failures.push(`payload.platforms.${platform}.url must point to a zleap-payload archive`);
    }
  }
}

function validateArtifact(label, artifact, failures, options) {
  if (!artifact || typeof artifact !== 'object') {
    failures.push(`${label} must be an object`);
    return;
  }
  if (!isNonEmptyString(artifact.url)) {
    failures.push(`${label}.url is required`);
  }
  if (options.requireSha && !/^[a-f0-9]{64}$/i.test(String(artifact.sha256 ?? ''))) {
    failures.push(`${label}.sha256 must be a 64-character hex digest`);
  }
  if (options.requireSize && (!Number.isFinite(artifact.size) || artifact.size <= 0)) {
    failures.push(`${label}.size must be a positive number`);
  }
}

function validateExpectedPlatforms(label, platforms, expected, failures) {
  if (expected.length === 0) {
    return;
  }
  const available = platforms && typeof platforms === 'object' ? platforms : {};
  for (const platform of expected) {
    if (!available[platform]) {
      failures.push(`${label}.${platform} is required by expected platform list`);
    }
  }
}

function expectedRuntimePlatforms() {
  return expectedPlatformList('ZLEAP_EXPECT_RUNTIME_PLATFORMS', OFFICIAL_PLATFORMS);
}

function expectedPayloadPlatforms() {
  return expectedPlatformList('ZLEAP_EXPECT_PAYLOAD_PLATFORMS', OFFICIAL_PLATFORMS);
}

function expectedPlatformList(envName, fallback = []) {
  const fromEnv = String(process.env[envName] ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return fromEnv.length > 0 ? fromEnv : [...fallback];
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const [cmd, arg1, arg2] = process.argv.slice(2);
  switch (cmd) {
  case 'version':
    process.stdout.write(`${readReleaseVersion()}\n`);
    break;
  case 'platform':
    process.stdout.write(`${platformTag()}\n`);
    break;
  case 'release-base':
    process.stdout.write(`${releaseDownloadBase(arg1 ?? readReleaseVersion())}\n`);
    break;
  case 'manifest-public-key':
    process.stdout.write(`${manifestPublicKey()}\n`);
    break;
  case 'archive-name':
    process.stdout.write(`${appArchiveName(arg1 ?? readReleaseVersion(), arg2 ?? platformTag())}\n`);
    break;
  case 'payload-archive-name':
    process.stdout.write(`${payloadArchiveName(arg1 ?? readReleaseVersion(), arg2 ?? platformTag())}\n`);
    break;
  case 'shell-env': {
    const env = shellEnv();
    for (const [key, value] of Object.entries(env)) {
      process.stdout.write(`${key}=${JSON.stringify(String(value))}\n`);
    }
    break;
  }
  case 'sync-version':
    syncVersion();
    break;
  case 'write-distribution-env':
    writeDistributionEnv(arg1 ? arg1 : undefined);
    break;
  case 'write-checksums':
    writeChecksums(arg1 ?? join(REPO_ROOT, 'dist', 'release', 'upload'));
    break;
  case 'write-install-manifest':
    writeInstallManifest(arg1 ?? join(REPO_ROOT, 'dist', 'upload'), {
      version: process.env.VERSION,
      baseUrl: process.env.BASE,
    });
    break;
  case 'validate-install-manifest':
    validateInstallManifest(arg1 ?? join(REPO_ROOT, 'dist', 'upload', INSTALL_MANIFEST_FILE));
    break;
  default:
    process.stderr.write(`Unknown command: ${cmd ?? '(none)'}\n`);
    process.exit(1);
  }
}
