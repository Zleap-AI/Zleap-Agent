#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI_ROOT = join(REPO_ROOT, 'packages', 'cli');
const STAGED_ROOT = join(REPO_ROOT, 'dist', 'npm', 'cli');
const PKG_PATH = join(STAGED_ROOT, 'package.json');
const SOURCE_PKG_PATH = join(CLI_ROOT, 'package.json');
const REPORT_ONLY = process.argv.includes('--report');

const sourcePkg = JSON.parse(readFileSync(SOURCE_PKG_PATH, 'utf8'));
// The published CLI version tracks the release version (root package.json), the
// same single source of truth the platform payload packages use, so the thin CLI
// and its platform optionalDependencies stay in lockstep.
const releaseVersion = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version ?? sourcePkg.version;
const pkg = existsSync(PKG_PATH) ? JSON.parse(readFileSync(PKG_PATH, 'utf8')) : undefined;
const failures = [];
const warnings = [];
const thinBlockers = [];

if (!pkg) {
  failures.push('Missing thin CLI staging package at dist/npm/cli/package.json; run pnpm pack:cli-npm');
}

if (pkg && pkg.name !== '@zleap-ai/cli') {
  failures.push(`Expected package name @zleap-ai/cli, got ${pkg.name}`);
}

if (pkg && pkg.version !== releaseVersion) {
  failures.push(`Staged CLI version ${pkg.version} does not match release version ${releaseVersion}`);
}

if (pkg) {
  for (const [name, range] of Object.entries(pkg.optionalDependencies ?? {})) {
    if (String(range) !== releaseVersion) {
      failures.push(`optionalDependencies.${name} is ${range}; must match release version ${releaseVersion}`);
    }
  }
}

for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
  if (!pkg) break;
  const deps = pkg[section] ?? {};
  for (const [name, range] of Object.entries(deps)) {
    const value = String(range);
    if (value.startsWith('workspace:')) {
      failures.push(`${section}.${name} uses ${value}; npm packages cannot publish workspace:* ranges`);
    }
    if (value.startsWith('file:') || value.startsWith('link:')) {
      failures.push(`${section}.${name} uses local range ${value}; publishable CLI must use registry semver ranges`);
    }
  }
}

if (!pkg?.bin?.zleap) {
  failures.push('Missing bin.zleap entry');
} else if (pkg.bin.zleap !== 'dist/manager/index.js') {
  failures.push(`bin.zleap should point at dist/manager/index.js, got ${pkg.bin.zleap}`);
}

const binPath = join(STAGED_ROOT, pkg?.bin?.zleap ?? 'dist/manager/index.js');
if (!existsSync(binPath)) {
  failures.push(`Staged CLI bin not found at ${binPath}; run pnpm pack:cli-npm`);
}

const files = Array.isArray(pkg?.files) ? pkg.files.map(String) : [];
if (files.length === 0) {
  failures.push('Missing package.files whitelist; npm publish would include an uncontrolled package surface');
} else {
  if (!files.includes('README.md')) {
    failures.push('package.files should include README.md');
  }
  if (!files.includes('dist/manager')) {
    failures.push('package.files should include dist/manager');
  }
  if (files.includes('payload')) {
    failures.push('package.files must not include payload; payload belongs in @zleap-ai/app-* platform packages');
  }
  for (const forbidden of ['dist', 'src', 'test', '../../dist', 'node_modules']) {
    if (files.includes(forbidden)) {
      failures.push(`package.files must not include ${forbidden}`);
    }
  }
}

const runtimeLikeDeps = ['@zleap/agent', '@zleap/host', '@zleap/runtime', '@zleap/core', '@zleap/ai', '@zleap/store'];
const leaked = runtimeLikeDeps.filter((name) => pkg?.dependencies?.[name]);
if (leaked.length > 0) {
  failures.push(`staged package dependencies include runtime/core packages: ${leaked.join(', ')}`);
}

const expectedPlatformDeps = ['@zleap-ai/app-darwin-arm64', '@zleap-ai/app-win32-x64'];
for (const dep of expectedPlatformDeps) {
  if (!pkg?.optionalDependencies?.[dep]) {
    failures.push(`staged package optionalDependencies missing ${dep}`);
  }
}
if (existsSync(join(STAGED_ROOT, 'payload'))) {
  failures.push('staged @zleap-ai/cli must not contain payload directory');
}

const internalExports = Object.keys(pkg?.exports ?? {}).filter((key) => key !== '.');
if (internalExports.length > 0) {
  failures.push(`staged package exports internal runtime SDK surfaces: ${internalExports.join(', ')}`);
}

const managerPath = join(CLI_ROOT, 'src', 'manager', 'index.ts');
if (!existsSync(managerPath)) {
  failures.push('Missing src/manager/index.ts; npm CLI needs a manager-only runtime launcher entry');
} else {
  const manager = readFileSync(managerPath, 'utf8');
  const managerLeaks = findPackageImports(manager, runtimeLikeDeps);
  if (managerLeaks.length > 0) {
    failures.push(`src/manager/index.ts imports runtime/core packages: ${managerLeaks.join(', ')}`);
  }
  if (!/ZLEAP_APP_ROOT/.test(manager) || !/ZLEAP_RUNTIME_ROOT/.test(manager)) {
    failures.push('src/manager/index.ts must resolve canonical runtime layout env vars');
  }
}

const runtimeCliImports = scanTextImports(
  [join(REPO_ROOT, 'packages', 'agent', 'src'), join(REPO_ROOT, 'packages', 'host', 'src'), join(REPO_ROOT, 'packages', 'runtime', 'src')],
  /^@zleap\/cli(?:\/.*)?$/u,
);
if (runtimeCliImports.length > 0) {
  failures.push(`agent/host/runtime layers must not import @zleap-ai/cli: ${runtimeCliImports.slice(0, 8).join(', ')}`);
}

const entryPath = join(CLI_ROOT, 'src', 'index.tsx');
if (existsSync(entryPath)) {
  const entry = readFileSync(entryPath, 'utf8');
  for (const forbidden of ['./chat/mode.js', './cli/router.js']) {
    if (new RegExp(`^import\\s+.*${escapeRegExp(forbidden)}`, 'm').test(entry)) {
      failures.push(`src/index.tsx statically imports ${forbidden}; thin CLI entry must lazy-load surfaces by command`);
    }
  }
}

const routerPath = join(CLI_ROOT, 'src', 'cli', 'router.ts');
if (existsSync(routerPath)) {
  const router = readFileSync(routerPath, 'utf8');
  const staticCommandImports = [...router.matchAll(/^import\s+.*from\s+['"](\.\/[^'"]+)['"]/gm)]
    .map((match) => match[1])
    .filter((id) => id !== '../util/version.js');
  if (staticCommandImports.length > 0) {
    failures.push(`src/cli/router.ts statically imports command surfaces: ${staticCommandImports.join(', ')}`);
  }
}

const sourceImports = scanSourceImports(join(CLI_ROOT, 'src'), runtimeLikeDeps);
if (sourceImports.length > 0) {
  warnings.push(`source full CLI still imports runtime/core packages in ${sourceImports.length} file(s); this is allowed only for runtime-bundled CLI`);
  for (const item of sourceImports.slice(0, 12)) {
    warnings.push(`${item.file}: ${item.imports.join(', ')}`);
  }
  if (sourceImports.length > 12) {
    warnings.push(`... ${sourceImports.length - 12} more file(s) import runtime/core packages`);
  }
}

const sourceDeps = sourcePkg.dependencies ?? {};
const sourceRuntimeDeps = runtimeLikeDeps.filter((name) => sourceDeps[name]);
if (sourceRuntimeDeps.length > 0) {
  warnings.push(`packages/cli remains a runtime-bundled full CLI with dependencies: ${sourceRuntimeDeps.join(', ')}`);
}

const runtimeConsumers = ['packages/web', 'packages/tasks', 'packages/gateway'];
const directCliRuntimeImports = scanTextImports(
  runtimeConsumers.map((rel) => join(REPO_ROOT, rel)),
  /^@zleap\/cli\/(engine|conversation|workspaces|sdkMcpExecutor)$/u,
);
if (directCliRuntimeImports.length > 0) {
  failures.push(`runtime consumers import @zleap-ai/cli internal SDK surfaces: ${directCliRuntimeImports.slice(0, 8).join(', ')}`);
}

if (failures.length === 0 && warnings.length === 0) {
  console.log('@zleap-ai/cli publish check passed');
  process.exit(0);
}

console.log('@zleap-ai/cli publish readiness');
for (const failure of failures) {
  console.log(`FAIL ${failure}`);
}
for (const warning of warnings) {
  console.log(`WARN ${warning}`);
}
for (const blocker of thinBlockers) {
  console.log(`TODO ${blocker}`);
}

if (REPORT_ONLY) {
  process.exit(0);
}

console.log('');
if (failures.length > 0 || thinBlockers.length > 0) {
  console.log('Refusing to pack/publish @zleap-ai/cli until the npm package is thin and registry-installable.');
  process.exit(1);
}
process.exit(0);

function scanSourceImports(root, packageNames) {
  const results = [];
  if (!existsSync(root)) return results;
  for (const file of walk(root)) {
    if (!/\.(ts|tsx)$/.test(file)) continue;
    const rel = file.slice(CLI_ROOT.length + 1);
    const text = readFileSync(file, 'utf8');
    const imports = findPackageImports(text, packageNames);
    if (imports.length > 0) {
      results.push({ file: rel, imports });
    }
  }
  return results;
}

function scanTextImports(roots, packagePattern) {
  const matches = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const file of walk(root)) {
      if (!/\.(ts|tsx|js|mjs)$/.test(file)) continue;
      const rel = file.slice(REPO_ROOT.length + 1);
      const text = readFileSync(file, 'utf8');
      const importIds = [
        ...text.matchAll(/from\s+['"]([^'"]+)['"]/g),
        ...text.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
        ...text.matchAll(/vi\.mock\s*\(\s*['"]([^'"]+)['"]/g),
      ].map((match) => match[1]);
      for (const id of importIds) {
        if (packagePattern.test(id)) {
          matches.push(`${rel} -> ${id}`);
        }
      }
    }
  }
  return matches;
}

function findPackageImports(text, packageNames) {
  const imports = [];
  for (const name of packageNames) {
    const pattern = new RegExp(`from\\s+['"]${escapeRegExp(name)}(?:/[^'"]*)?['"]|import\\s*\\(\\s*['"]${escapeRegExp(name)}(?:/[^'"]*)?['"]\\s*\\)`, 'g');
    if (pattern.test(text)) {
      imports.push(name);
    }
  }
  return imports;
}

function walk(root) {
  const out = [];
  const skipped = new Set(['node_modules', 'dist', '.next', '.turbo', 'coverage']);
  for (const entry of readdirSync(root)) {
    if (skipped.has(entry)) {
      continue;
    }
    const full = join(root, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
