#!/usr/bin/env node
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OFFICIAL_PLATFORMS, npmPackageMeta } from './lib/platforms.mjs';
import { githubRepoSlug } from './distribution.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI_ROOT = join(REPO_ROOT, 'packages', 'cli');
const OUT_DIR = join(REPO_ROOT, 'dist', 'npm', 'cli');

const sourcePkg = JSON.parse(readFileSync(join(CLI_ROOT, 'package.json'), 'utf8'));
// The published version is the release version (root package.json = single source
// of truth), NOT the monorepo-internal cli package version. This keeps the CLI and
// the platform payload packages (which also derive from the root version) in
// lockstep so `npm i -g @zleap-ai/cli` resolves matching optionalDependencies.
const releaseVersion = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version ?? sourcePkg.version;
const managerDist = join(CLI_ROOT, 'dist', 'manager');
if (!existsSync(join(managerDist, 'index.js'))) {
  throw new Error('Missing packages/cli/dist/manager/index.js. Run pnpm --filter @zleap-ai/cli build first.');
}
if (!existsSync(join(managerDist, 'distribution.json'))) {
  throw new Error('Missing packages/cli/dist/manager/distribution.json. Run pnpm --filter @zleap-ai/cli build first.');
}

await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(join(OUT_DIR, 'dist'), { recursive: true });
await cp(managerDist, join(OUT_DIR, 'dist', 'manager'), { recursive: true });
await writeFile(join(OUT_DIR, 'README.md'), cliReadme(releaseVersion), 'utf8');

const thinPkg = {
  name: sourcePkg.name,
  version: releaseVersion,
  type: 'module',
  description: 'Zleap thin CLI manager. Installs and launches the local Zleap app payload.',
  repository: {
    type: 'git',
    url: `git+https://github.com/${githubRepoSlug()}.git`,
  },
  bin: {
    zleap: 'dist/manager/index.js',
  },
  main: 'dist/manager/index.js',
  exports: {
    '.': {
      import: './dist/manager/index.js',
    },
  },
  files: ['dist/manager', 'README.md'],
  optionalDependencies: Object.fromEntries(
    OFFICIAL_PLATFORMS.map((platform) => [npmPackageMeta(platform).name, releaseVersion]),
  ),
  engines: {
    node: '>=20',
  },
};

await writeFile(join(OUT_DIR, 'package.json'), `${JSON.stringify(thinPkg, null, 2)}\n`, 'utf8');
process.stdout.write(`Prepared thin CLI npm package at ${OUT_DIR}\n`);

function cliReadme(version) {
  return `# @zleap-ai/cli

Thin command-line entry for Zleap.

The npm package installs the \`zleap\` launcher plus the current platform payload
through npm optional dependencies. On first run it unpacks that local payload into
\`~/.zleap\`, then proxies commands to the runtime-bundled full CLI.

## Install

\`\`\`bash
npm install -g @zleap-ai/cli
zleap setup
zleap
\`\`\`

## Common Commands

\`\`\`bash
zleap setup
zleap status
zleap doctor
zleap update
zleap rollback
zleap stop
\`\`\`

## Runtime Location

The canonical local runtime is installed under:

\`\`\`text
~/.zleap/app/current
\`\`\`

CLI, Desktop, and Web all share this runtime. The npm package does not include
Postgres, Web, workers, gateway services, and the full agent runtime are provided
by the platform payload package, not by this thin CLI package.

Version: ${version}
`;
}
