#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash, createPublicKey } from 'node:crypto';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platformTag } from '../scripts/release-version.mjs';
import { OFFICIAL_PLATFORMS, OFFICIAL_TAURI_TARGETS, PLATFORM_MATRIX } from '../scripts/lib/platforms.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STRICT_RELEASE = process.argv.includes('--strict-release') || process.env.ZLEAP_RELEASE_STRICT === '1';
const LEGACY_SDK_PACKAGE = `@zleap/${'runtime'}-${'sdk'}`;
const LEGACY_SDK_PATH = `packages/${'runtime'}-${'sdk'}`;

const failures = [];
const warnings = [];

checkDistribution();
checkVersionConsistency();
checkEnvExamples();
checkPackageShape();
checkPackageScripts();
checkPayloadShape();
checkNpmPlatformPackageShape();
checkBoundaries();
checkHygiene();
checkReleasePlaceholders();

if (failures.length === 0 && warnings.length === 0) {
  console.log('Release readiness OK');
  process.exit(0);
}

console.log('Release readiness');
for (const failure of failures) {
  console.log(`FAIL ${failure}`);
}
for (const warning of warnings) {
  console.log(`WARN ${warning}`);
}

process.exit(failures.length > 0 ? 1 : 0);

function checkDistribution() {
  const dist = readJson('distribution.json');
  const required = [
    ['product.name', dist.product?.name],
    ['github.owner', dist.github?.owner],
    ['github.repo', dist.github?.repo],
    ['release.provider', dist.release?.provider],
    ['release.channel', dist.release?.channel],
    ['release.installBranch', dist.release?.installBranch],
    ['release.artifactBaseUrl', dist.release?.artifactBaseUrl],
    ['release.manifestUrl', dist.release?.manifestUrl],
    ['release.sourceBaseUrl', dist.release?.sourceBaseUrl],
    ['runtime.nodeVersion', dist.runtime?.nodeVersion],
    ['runtime.node.version', dist.runtime?.node?.version],
    ['runtime.node.sources', dist.runtime?.node?.sources],
    ['runtime.webPort', dist.runtime?.webPort],
    ['runtime.authMode', dist.runtime?.authMode],
    ['runtime.serveMode', dist.runtime?.serveMode],
    ['runtime.schemaVersion', dist.runtime?.schemaVersion],
    ['runtime.minCliVersion', dist.runtime?.minCliVersion],
    ['runtime.minDesktopVersion', dist.runtime?.minDesktopVersion],
    ['runtime.supportedCliRange', dist.runtime?.supportedCliRange],
    ['runtime.supportedDesktopRange', dist.runtime?.supportedDesktopRange],
    ['runtime.postgres.version', dist.runtime?.postgres?.version],
    ['runtime.postgres.pgvectorVersion', dist.runtime?.postgres?.pgvectorVersion],
    ['runtime.postgres.source.postgres.url', dist.runtime?.postgres?.source?.postgres?.url],
    ['runtime.postgres.source.postgres.sha256', dist.runtime?.postgres?.source?.postgres?.sha256],
    ['runtime.postgres.source.pgvector.url', dist.runtime?.postgres?.source?.pgvector?.url],
    ['runtime.postgres.source.pgvector.sha256', dist.runtime?.postgres?.source?.pgvector?.sha256],
    ['runtime.postgres.bundles', dist.runtime?.postgres?.bundles],
    ['cli.npm', dist.cli?.npm],
    ['cli.minVersion', dist.cli?.minVersion],
    ['desktop.identifier', dist.desktop?.identifier],
    ['desktop.platforms', dist.desktop?.platforms],
    ['updater.manifestFile', dist.updater?.manifestFile],
    ['updater.requireSignature', dist.updater?.requireSignature],
  ];
  for (const [name, value] of required) {
    if (value === undefined || value === null || value === '') {
      failures.push(`distribution.json missing ${name}`);
    }
  }
  if (dist.cli?.npm !== '@zleap-ai/cli') {
    failures.push('distribution.json cli.npm must be @zleap-ai/cli');
  }
  if (dist.updater?.requireSignature !== true) {
    failures.push('distribution.json updater.requireSignature must be true for release builds');
  }
  if (dist.updater?.manifestPublicKey?.trim() && dist.updater.manifestPublicKey.startsWith('REPLACE_WITH_')) {
    failures.push('distribution.json updater.manifestPublicKey must not be a REPLACE_WITH_* placeholder');
  }
  validateManifestPublicKey(dist.updater?.manifestPublicKey);
  validateEmbeddedManifestPublicKeys(dist.updater?.manifestPublicKey);
  if (dist.release?.provider !== 'github') {
    failures.push('distribution.json release.provider must be github');
  }
  validateTemplatedUrl(dist.release?.artifactBaseUrl, 'release.artifactBaseUrl', dist, {
    version: dist.runtime?.minCliVersion ?? '0.1.0',
  });
  validateTemplatedUrl(dist.release?.manifestUrl, 'release.manifestUrl', dist);
  validateTemplatedUrl(dist.release?.sourceBaseUrl, 'release.sourceBaseUrl', dist, {
    branch: dist.release?.installBranch ?? 'main',
  });
  if (dist.runtime?.postgresTarballs) {
    failures.push('distribution.json runtime.postgresTarballs is deprecated; use runtime.postgres.source and runtime.postgres.bundles');
  }
  validatePostgresSource(dist.runtime?.postgres?.source);
  validateNodeSources(dist.runtime?.node, dist.runtime?.nodeVersion);
  validatePostgresBundles(dist.runtime?.postgres, dist);
  const desktopPlatforms = new Set(dist.desktop?.platforms ?? []);
  for (const platform of OFFICIAL_TAURI_TARGETS) {
    if (!desktopPlatforms.has(platform)) {
      failures.push(`distribution.json desktop.platforms missing ${platform}`);
    }
  }
}

function validateNodeSources(node, legacyNodeVersion) {
  const version = node?.version ?? legacyNodeVersion;
  if (node?.version && legacyNodeVersion && node.version !== legacyNodeVersion) {
    failures.push('distribution.json runtime.node.version must match runtime.nodeVersion');
  }
  const sources = node?.sources;
  if (!version || !sources || typeof sources !== 'object') {
    failures.push('distribution.json runtime.node.sources is required');
    return;
  }
  for (const platform of OFFICIAL_PLATFORMS) {
    const source = sources[platform];
    if (!source?.url || !source.sha256) {
      failures.push(`distribution.json runtime.node.sources.${platform}.url/sha256 is required`);
      continue;
    }
    const url = parseUrl(source.url, `runtime.node.sources.${platform}.url`);
    if (url && (url.hostname !== 'nodejs.org' || !url.pathname.startsWith(`/dist/v${version}/`))) {
      failures.push(`runtime.node.sources.${platform}.url must use nodejs.org/dist/v${version}`);
    }
    const expectedExt = platform.startsWith('win-') ? '.zip' : '.tar.gz';
    if (url && !url.pathname.endsWith(expectedExt)) {
      failures.push(`runtime.node.sources.${platform}.url must end with ${expectedExt}`);
    }
    if (!/^[a-f0-9]{64}$/i.test(source.sha256)) {
      failures.push(`runtime.node.sources.${platform}.sha256 must be a 64-character hex digest`);
    }
  }
}

function checkVersionConsistency() {
  // Two authoritative version files, bumped together by releaser-pleaser on the
  // GitLab control plane: root package.json (packagejson updater) and
  // Cargo.toml [package].version (generic `# x-releaser-pleaser-version` marker).
  // tauri.conf.json intentionally has NO version field (it inherits from Cargo), and
  // the CLI npm version is derived from root package.json at pack time, so neither is
  // build-authoritative. This asserts the two real sources never drift.
  const rootVersion = readJson('package.json').version;
  if (!rootVersion) {
    failures.push('package.json version is required');
    return;
  }
  const cargoVersion = readText('packages/desktop/src-tauri/Cargo.toml')
    .match(/\[package\][\s\S]*?\nversion\s*=\s*"([^"]*)"/u)?.[1];
  if (cargoVersion !== rootVersion) {
    failures.push(`Cargo.toml [package].version (${cargoVersion}) must match root package.json (${rootVersion}); releaser-pleaser bumps both — run pnpm sync:version locally`);
  }
  // tauri.conf.json must NOT pin a version (it would become a second source that
  // drifts from Cargo). If one slips in, it must at least match.
  const tauriVersion = JSON.parse(readText('packages/desktop/src-tauri/tauri.conf.json')).version;
  if (tauriVersion !== undefined && tauriVersion !== rootVersion) {
    failures.push(`tauri.conf.json should omit "version" (inherits from Cargo.toml); found ${tauriVersion} != ${rootVersion}`);
  }
  // CLI package.json version is cosmetic (published version comes from root); flag
  // drift as a warning so `pnpm sync:version` can tidy it without blocking release.
  const cliVersion = readJson('packages/cli/package.json').version;
  if (cliVersion !== rootVersion) {
    warnings.push(`packages/cli/package.json version (${cliVersion}) differs from root (${rootVersion}); cosmetic — run pnpm sync:version`);
  }
}

function checkEnvExamples() {
  const runtimeExample = readText('.env.example');
  const releaseExample = readText('.env.release.example');
  const runtimeKeys = [
    'ZLEAP_MODEL_BASE_URL',
    'ZLEAP_MODEL_API_KEY',
    'ZLEAP_MODEL_NAME',
    'ZLEAP_EMBED_MODEL',
    'ZLEAP_EMBED_BASE_URL',
    'ZLEAP_EMBED_API_KEY',
    'ZLEAP_EMBED_DIM',
    'ZLEAP_DATABASE_URL',
    'ZLEAP_WEB_PORT',
    'ZLEAP_AUTH_MODE',
    'ZLEAP_GATEWAY',
    'ZLEAP_HOME',
    'ZLEAP_FILE_WORKSPACE_ROOT',
    'ZLEAP_WEB_SKILLS_ROOT',
    'FEISHU_APP_ID',
    'FEISHU_APP_SECRET',
    'FEISHU_DOMAIN',
    'FEISHU_CLI_ENABLED',
    'WECHAT_ENABLED',
    'WECHAT_BASE_URL',
  ];
  const releaseKeys = [
    'NPM_TOKEN',
    'ZLEAP_MANIFEST_PRIVATE_KEY',
    'ZLEAP_MANIFEST_PRIVATE_KEY_PATH',
    'ZLEAP_MANIFEST_PUBLIC_KEY',
    'TAURI_SIGNING_PRIVATE_KEY',
    'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
    'ZLEAP_RELEASE_BASE',
    'ZLEAP_INSTALL_MANIFEST_URL',
    'ZLEAP_UPDATER_MANIFEST_URL',
    'ZLEAP_MANIFEST_URL',
    'APPLE_CERTIFICATE_BASE64',
    'APPLE_CERTIFICATE_PASSWORD',
    'APPLE_SIGNING_IDENTITY',
    'APPLE_ID',
    'APPLE_PASSWORD',
    'APPLE_TEAM_ID',
    'WINDOWS_CERTIFICATE_BASE64',
    'WINDOWS_CERTIFICATE_PASSWORD',
    'ZLEAP_POSTGRES_BUNDLE',
    'ZLEAP_POSTGRES_BUNDLE_SHA256',
    'ZLEAP_POSTGRES_SOURCE_CACHE',
    'ZLEAP_POSTGRES_BUILD_DIR',
    'ZLEAP_POSTGRES_STAGED_ROOT',
    'ZLEAP_NODE_SOURCE_CACHE',
  ];
  for (const key of runtimeKeys) {
    if (!new RegExp(`(^|\\n)#?\\s*${escapeRegExp(key)}=`, 'u').test(runtimeExample)) {
      failures.push(`.env.example missing ${key}`);
    }
  }
  for (const key of releaseKeys) {
    if (!new RegExp(`(^|\\n)#?\\s*${escapeRegExp(key)}=`, 'u').test(releaseExample)) {
      failures.push(`.env.release.example missing ${key}`);
    }
  }
}

function validatePostgresSource(source) {
  const pgUrl = source?.postgres?.url;
  const vectorUrl = source?.pgvector?.url;
  if (pgUrl) {
    const url = parseUrl(pgUrl, 'runtime.postgres.source.postgres.url');
    if (url && !url.hostname.endsWith('postgresql.org')) {
      failures.push('runtime.postgres.source.postgres.url must use official postgresql.org source');
    }
  }
  if (vectorUrl) {
    const url = parseUrl(vectorUrl, 'runtime.postgres.source.pgvector.url');
    if (url && (url.hostname !== 'github.com' || !url.pathname.includes('/pgvector/pgvector/'))) {
      failures.push('runtime.postgres.source.pgvector.url must use github.com/pgvector/pgvector');
    }
  }
}

function validatePostgresBundles(postgres, dist) {
  const bundles = postgres?.bundles;
  if (!bundles || typeof bundles !== 'object') {
    return;
  }
  const runtimePlatforms = OFFICIAL_PLATFORMS;
  for (const platform of runtimePlatforms) {
    const entry = bundles[platform];
    if (!entry) {
      continue;
    }
    if (entry.url?.trim()) {
      parseUrl(entry.url.trim(), `runtime.postgres.bundles.${platform}.url`);
    }
    if (entry.url?.trim() && !entry.sha256?.trim()) {
      warnings.push(`distribution.json runtime.postgres.bundles.${platform}.sha256 is missing; remote Postgres bundle is optional outside the npm/Tauri payload path`);
    }
  }
  if (STRICT_RELEASE && postgres?.version && postgres?.pgvectorVersion) {
    const version = dist.runtime?.minCliVersion ?? '0.1.0';
    for (const platform of runtimePlatforms) {
      const expectedName = `zleap-postgres-${postgres.version}-pgvector-${postgres.pgvectorVersion}-${platform}.tar.gz`;
      const base = renderReleaseTemplate(dist.release?.artifactBaseUrl ?? '', dist, { version }).replace(/\/$/, '');
      const expectedUrl = `${base}/${expectedName}`;
      const configuredUrl = bundles[platform]?.url?.trim();
      if (configuredUrl && configuredUrl !== expectedUrl) {
        warnings.push(`runtime.postgres.bundles.${platform}.url differs from computed release URL (${expectedUrl})`);
      }
    }
  }
}

function checkPayloadShape() {
  const tag = platformTag();
  const payloadRoot = join(REPO_ROOT, 'dist', 'payload', tag, 'payload');
  if (!existsSync(payloadRoot)) {
    // Build artifacts only exist in the job that produced them (build-runtime) or
    // after a local full build. Their CI presence/completeness is guaranteed by
    // upload-artifact (if-no-files-found: error) and the release job preflight, so
    // absence here just means "not an artifact-producing context" — skip, never
    // fail. When present we still validate shape strictly below.
    warnings.push(`platform payload not staged for ${tag} (run pnpm package:payload to validate locally)`);
    return;
  }

  const manifestPath = join(payloadRoot, 'manifest.json');
  const sumsPath = join(payloadRoot, 'SHA256SUMS');
  for (const name of ['app.tar.gz', 'node.tar.gz', 'postgres.tar.gz', 'manifest.json', 'SHA256SUMS']) {
    if (!existsSync(join(payloadRoot, name))) {
      failures.push(`platform payload missing ${name}: ${relative(REPO_ROOT, payloadRoot)}`);
    }
  }
  if (!existsSync(manifestPath) || !existsSync(sumsPath)) {
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    failures.push(`platform payload manifest is not valid JSON: ${relative(REPO_ROOT, manifestPath)}`);
    return;
  }
  if (manifest.kind !== 'payload') {
    failures.push(`platform payload manifest.kind must be payload: ${relative(REPO_ROOT, manifestPath)}`);
  }
  if (manifest.platform !== tag) {
    failures.push(`platform payload manifest.platform must be ${tag}: ${relative(REPO_ROOT, manifestPath)}`);
  }
  const expectedFiles = ['app.tar.gz', 'node.tar.gz', 'postgres.tar.gz'];
  for (const name of expectedFiles) {
    const file = join(payloadRoot, name);
    const info = manifest.payload?.files?.[name];
    if (!existsSync(file) || !info) {
      failures.push(`platform payload manifest missing payload.files.${name}`);
      continue;
    }
    const hash = sha256(file);
    const size = statSync(file).size;
    if (info.sha256 !== hash) {
      failures.push(`platform payload sha mismatch for ${name}`);
    }
    if (info.size !== size) {
      failures.push(`platform payload size mismatch for ${name}`);
    }
  }

  const sums = parseSha256Sums(readFileSync(sumsPath, 'utf8'));
  for (const name of [...expectedFiles, 'manifest.json']) {
    const file = join(payloadRoot, name);
    if (!sums.has(name)) {
      failures.push(`platform payload SHA256SUMS missing ${name}`);
      continue;
    }
    if (existsSync(file) && sums.get(name) !== sha256(file)) {
      failures.push(`platform payload SHA256SUMS mismatch for ${name}`);
    }
  }
}

function checkNpmPlatformPackageShape() {
  const tag = platformTag();
  const expected = PLATFORM_MATRIX[tag]?.npm;
  if (!expected) {
    return;
  }
  const packageRoot = join(REPO_ROOT, 'dist', 'npm', expected.dir);
  if (!existsSync(packageRoot)) {
    // See checkPayloadShape: npm platform staging is produced by build-npm-platforms
    // and its completeness is enforced by the release job preflight. Absence here is
    // a non-producing context — skip, never fail; validate shape strictly if present.
    warnings.push(`npm platform package not staged for ${tag} (run pnpm pack:npm-platforms to validate locally)`);
    return;
  }
  const packageJsonPath = join(packageRoot, 'package.json');
  if (!existsSync(packageJsonPath)) {
    failures.push(`npm platform package missing package.json: ${relative(REPO_ROOT, packageRoot)}`);
    return;
  }
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  if (pkg.name !== expected.name) {
    failures.push(`npm platform package name must be ${expected.name}: ${relative(REPO_ROOT, packageJsonPath)}`);
  }
  if (!Array.isArray(pkg.os) || pkg.os.length !== 1 || pkg.os[0] !== expected.os) {
    failures.push(`npm platform package ${expected.name} must declare os ["${expected.os}"]`);
  }
  if (!Array.isArray(pkg.cpu) || pkg.cpu.length !== 1 || pkg.cpu[0] !== expected.cpu) {
    failures.push(`npm platform package ${expected.name} must declare cpu ["${expected.cpu}"]`);
  }
  // Thin package: the heavy payload is downloaded from the Release on first run,
  // so the npm tarball stays under the registry size limit. It must ship the
  // payload manifest (trusted checksums) and a download descriptor.
  if (!Array.isArray(pkg.files) || !pkg.files.includes('manifest.json') || !pkg.files.includes('download.json')) {
    failures.push(`npm platform package ${expected.name} must whitelist manifest.json and download.json in files`);
  }
  const manifestPath = join(packageRoot, 'manifest.json');
  const downloadPath = join(packageRoot, 'download.json');
  if (!existsSync(manifestPath) || !existsSync(downloadPath)) {
    failures.push(`npm platform package ${expected.name} must include manifest.json and download.json`);
    return;
  }
  let download;
  try {
    download = JSON.parse(readFileSync(downloadPath, 'utf8'));
  } catch {
    failures.push(`npm platform package ${expected.name} download.json is not valid JSON`);
    return;
  }
  if (!/zleap-payload-\d.*\.tar\.gz$/i.test(String(download.url ?? ''))) {
    failures.push(`npm platform package ${expected.name} download.json.url must point to a zleap-payload archive`);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    failures.push(`npm platform package ${expected.name} manifest.json is not valid JSON`);
    return;
  }
  for (const name of ['app.tar.gz', 'node.tar.gz', 'postgres.tar.gz']) {
    if (!/^[a-f0-9]{64}$/i.test(String(manifest.payload?.files?.[name]?.sha256 ?? ''))) {
      failures.push(`npm platform package ${expected.name} manifest.json missing sha256 for ${name}`);
    }
  }
}

function parseSha256Sums(text) {
  const out = new Map();
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/iu.exec(trimmed);
    if (match) {
      out.set(match[2], match[1].toLowerCase());
    }
  }
  return out;
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function parseUrl(value, name) {
  try {
    return new URL(value);
  } catch {
    failures.push(`${name} must be a valid URL`);
    return undefined;
  }
}

function validateTemplatedUrl(value, name, dist, values = {}) {
  if (!value) return;
  parseUrl(renderReleaseTemplate(value, dist, values), name);
}

function renderReleaseTemplate(template, dist, values = {}) {
  const version = String(values.version ?? '0.1.0').replace(/^v/u, '');
  const branch = values.branch ?? dist.release?.installBranch ?? 'main';
  const context = {
    owner: dist.github?.owner ?? '',
    repo: dist.github?.repo ?? '',
    version,
    tag: `v${version}`,
    branch,
    channel: dist.release?.channel ?? 'stable',
    manifestFile: dist.updater?.manifestFile ?? 'latest.json',
  };
  return String(template).replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (match, key) => context[key] || match);
}

function checkPackageShape() {
  const expected = new Set([
    'agent',
    'ai',
    'avatar',
    'cli',
    'core',
    'desktop',
    'gateway',
    'host',
    'runtime',
    'store',
    'tasks',
    'web',
  ]);
  const packageRoot = join(REPO_ROOT, 'packages');
  for (const name of readdirSync(packageRoot)) {
    const full = join(packageRoot, name);
    if (!statSync(full).isDirectory()) continue;
    if (!/^[a-z]+$/u.test(name)) {
      failures.push(`package directory must be a single lowercase word: packages/${name}`);
    }
    if (!expected.has(name)) {
      failures.push(`unexpected package directory packages/${name}`);
    }
  }
  for (const name of expected) {
    if (!existsSync(join(packageRoot, name, 'package.json'))) {
      failures.push(`missing package packages/${name}`);
    }
  }
  for (const legacy of [LEGACY_SDK_PATH]) {
    if (existsSync(join(REPO_ROOT, legacy))) {
      failures.push(`legacy package directory still exists: ${legacy}`);
    }
  }
}

function checkPackageScripts() {
  const pkg = readJson('package.json');
  for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
    const value = String(script);
    if (value.includes("--filter './packages/*'")) {
      failures.push(`package.json scripts.${name} uses single-quoted pnpm workspace glob; use double quotes for Windows compatibility`);
    }
  }
}

function checkBoundaries() {
  const legacyPattern = new RegExp(
    [
      escapeRegExp(LEGACY_SDK_PACKAGE),
      escapeRegExp(LEGACY_SDK_PATH),
    ].join('|'),
    'u',
  );
  for (const file of repoFiles()) {
    const rel = relative(REPO_ROOT, file);
    const text = readFileSync(file, 'utf8');
    if (legacyPattern.test(text)) {
      failures.push(`legacy package name remains in ${rel}`);
    }
  }

  const runtimeImports = [];
  for (const root of ['packages/agent/src', 'packages/host/src', 'packages/web', 'packages/cli/src', 'packages/tasks/src', 'packages/gateway/src']) {
    runtimeImports.push(...scanImports(join(REPO_ROOT, root), /^@zleap\/runtime(?:\/.*)?$/u));
  }
  for (const item of runtimeImports) {
    failures.push(`new code must import @zleap/agent or @zleap/host, not @zleap/runtime: ${item}`);
  }

  const agentHostImports = scanImports(join(REPO_ROOT, 'packages/agent/src'), /^@zleap\/host(?:\/.*)?$/u);
  for (const item of agentHostImports) {
    failures.push(`@zleap/agent must not import @zleap/host: ${item}`);
  }

  const coreBoundaryImports = scanImports(
    join(REPO_ROOT, 'packages/core/src'),
    /^@zleap\/(?:store|agent|host|web|cli|tasks|gateway|runtime)(?:\/.*)?$/u,
  );
  for (const item of coreBoundaryImports) {
    failures.push(`@zleap/core must not import outer layers: ${item}`);
  }

  const storeBoundaryImports = scanImports(
    join(REPO_ROOT, 'packages/store/src'),
    /^@zleap\/(?:agent|host|web|cli|tasks|gateway|runtime)(?:\/.*)?$/u,
  );
  for (const item of storeBoundaryImports) {
    failures.push(`@zleap/store must not import host/agent/surface layers: ${item}`);
  }

  const storePostgresBundleImports = scanImports(join(REPO_ROOT, 'packages/store/src'), /postgres-bundle|ensurePostgres|pg_ctl/u);
  for (const item of storePostgresBundleImports) {
    failures.push(`@zleap/store must not manage Postgres binaries: ${item}`);
  }

  for (const path of [
    'packages/cli/src/engine.ts',
    'packages/cli/src/conversation',
    'packages/cli/src/workspaces',
    `packages/cli/src/${'runtime'}-${'sdk'}`,
  ]) {
    if (existsSync(join(REPO_ROOT, path))) {
      failures.push(`CLI contains duplicated runtime implementation surface: ${path}`);
    }
  }
}

function checkHygiene() {
  const badNames = [];
  for (const file of repoFiles({ includeDotFiles: true })) {
    const rel = relative(REPO_ROOT, file);
    const name = basename(file);
    if (
      /^tmp[_-]/u.test(name) ||
      /\.(tmp|bak|orig|old|log)$/u.test(name) ||
      name === '.DS_Store'
    ) {
      badNames.push(rel);
    }
  }
  for (const item of badNames) {
    failures.push(`temporary or local artifact file must not be committed: ${item}`);
  }
}

function checkReleasePlaceholders() {
  const tauriConf = readText('packages/desktop/src-tauri/tauri.conf.json');
  if (/REPLACE_WITH_/u.test(tauriConf)) {
    const message = 'tauri.conf.json still contains REPLACE_WITH_* placeholder; commit the public Tauri updater pubkey (plugins.updater.pubkey)';
    failures.push(message);
  }
  validateTauriUpdaterPubkey(tauriConf);
  const dist = readJson('distribution.json');
  const endpoint = renderReleaseTemplate(dist.release?.manifestUrl ?? '', dist);
  const tauri = JSON.parse(tauriConf);
  const endpoints = tauri.plugins?.updater?.endpoints;
  if (endpoint && Array.isArray(endpoints) && !endpoints.includes(endpoint)) {
    const message = `tauri.conf.json updater endpoint does not match distribution.release.manifestUrl (${endpoint}); run pnpm sync:version`;
    if (STRICT_RELEASE) failures.push(message);
    else warnings.push(message);
  }

  if (STRICT_RELEASE) {
    requireEnv('NPM_TOKEN');
    requireEnv('TAURI_SIGNING_PRIVATE_KEY');
    requireEnv('TAURI_SIGNING_PRIVATE_KEY_PASSWORD');
    requireAnyEnv(['ZLEAP_MANIFEST_PRIVATE_KEY', 'ZLEAP_MANIFEST_PRIVATE_KEY_PATH']);
    requireConfiguredManifestPublicKey(dist);
    requireEnv('APPLE_CERTIFICATE_BASE64');
    requireEnv('APPLE_CERTIFICATE_PASSWORD');
    requireEnv('APPLE_SIGNING_IDENTITY');
    requireEnv('APPLE_ID');
    requireEnv('APPLE_PASSWORD');
    requireEnv('APPLE_TEAM_ID');
    warnMissingOptionalWindowsSigning();
    if (process.env.ZLEAP_POSTGRES_STAGED_ROOT?.trim()) {
      failures.push('strict release must build Postgres from declared sources, not ZLEAP_POSTGRES_STAGED_ROOT');
    }
  }
}

function requireConfiguredManifestPublicKey(dist) {
  const configured = dist.updater?.manifestPublicKey?.trim();
  if (configured && !configured.startsWith('REPLACE_WITH_')) {
    return;
  }
  failures.push('strict release requires distribution.json updater.manifestPublicKey');
}

function validateManifestPublicKey(value) {
  const configured = value?.trim();
  if (!configured || configured.startsWith('REPLACE_WITH_')) {
    return;
  }
  try {
    const pem = decodePossiblyBase64PublicKey(configured);
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== 'rsa') {
      const message = 'distribution.json updater.manifestPublicKey must be an RSA public key for RSA-SHA256 manifest signatures';
      if (STRICT_RELEASE) failures.push(message);
      else warnings.push(message);
    }
  } catch (error) {
    const message = `distribution.json updater.manifestPublicKey is not a valid public key: ${error instanceof Error ? error.message : String(error)}`;
    if (STRICT_RELEASE) failures.push(message);
    else warnings.push(message);
  }
}

function validateEmbeddedManifestPublicKeys(value) {
  const configured = value?.trim();
  if (!configured || configured.startsWith('REPLACE_WITH_')) {
    return;
  }
  const sh = readText('scripts/install.sh').match(/ZLEAP_EMBEDDED_MANIFEST_PUBLIC_KEY_B64="([^"]+)"/u)?.[1];
  const ps = readText('scripts/install.ps1').match(/\$EmbeddedManifestPublicKey = "([^"]+)"/u)?.[1];
  if (sh !== configured) {
    failures.push('scripts/install.sh embedded manifest public key must match distribution.json updater.manifestPublicKey');
  }
  if (ps !== configured) {
    failures.push('scripts/install.ps1 embedded manifest public key must match distribution.json updater.manifestPublicKey');
  }
}

function validateTauriUpdaterPubkey(tauriConfText) {
  let tauri;
  try {
    tauri = JSON.parse(tauriConfText);
  } catch {
    failures.push('packages/desktop/src-tauri/tauri.conf.json is not valid JSON');
    return;
  }
  const pubkey = tauri.plugins?.updater?.pubkey?.trim();
  if (!pubkey) {
    failures.push('tauri.conf.json plugins.updater.pubkey is required (public minisign key, committed)');
    return;
  }
  if (pubkey.startsWith('REPLACE_WITH_')) {
    failures.push('tauri.conf.json plugins.updater.pubkey must not be a REPLACE_WITH_* placeholder');
  }
}

function decodePossiblyBase64PublicKey(value) {
  if (value.includes('BEGIN PUBLIC KEY')) {
    return value.replace(/\\n/g, '\n');
  }
  const decoded = Buffer.from(value, 'base64').toString('utf8');
  return decoded.includes('BEGIN PUBLIC KEY') ? decoded : value;
}

function requireEnv(name) {
  if (!process.env[name]?.trim()) {
    failures.push(`strict release requires env ${name}`);
  }
}

function requireAnyEnv(names) {
  if (!names.some((name) => process.env[name]?.trim())) {
    failures.push(`strict release requires one of ${names.join(', ')}`);
  }
}

function warnMissingOptionalWindowsSigning() {
  const cert = process.env.WINDOWS_CERTIFICATE_BASE64?.trim();
  const password = process.env.WINDOWS_CERTIFICATE_PASSWORD?.trim();
  if (cert && password) {
    return;
  }
  warnings.push('WINDOWS_CERTIFICATE_BASE64/WINDOWS_CERTIFICATE_PASSWORD are not set; win-x64 release assets will be unsigned');
}

function scanImports(root, pattern) {
  const matches = [];
  if (!existsSync(root)) return matches;
  for (const file of repoFiles({ root })) {
    if (!/\.(ts|tsx|js|mjs)$/u.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    const importIds = [
      ...text.matchAll(/from\s+['"]([^'"]+)['"]/g),
      ...text.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
      ...text.matchAll(/vi\.mock\s*\(\s*['"]([^'"]+)['"]/g),
    ].map((match) => match[1]);
    for (const id of importIds) {
      if (pattern.test(id)) {
        matches.push(`${relative(REPO_ROOT, file)} -> ${id}`);
      }
    }
  }
  return matches;
}

function repoFiles(options = {}) {
  const root = options.root ?? REPO_ROOT;
  const out = [];
  walk(root, out, options);
  return out;
}

function walk(dir, out, options) {
  const skipped = new Set([
    '.git',
    'node_modules',
    'dist',
    '.next',
    '.turbo',
    'coverage',
    'target',
    'resources',
    'gen',
  ]);
  for (const name of readdirSync(dir)) {
    if (skipped.has(name)) continue;
    if (!options.includeDotFiles && name.startsWith('.') && !['.env.example', '.env.release.example'].includes(name)) {
      continue;
    }
    const full = join(dir, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walk(full, out, options);
      continue;
    }
    if (stat.isFile() && isTextFile(name)) {
      out.push(full);
    }
  }
}

function isTextFile(name) {
  return /\.(ts|tsx|js|mjs|json|md|yml|yaml|sh|ps1|rs|toml|html|css|example)$/u.test(name) || name.startsWith('.env');
}

function readJson(path) {
  return JSON.parse(readText(path));
}

function readText(path) {
  return readFileSync(join(REPO_ROOT, path), 'utf8');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
