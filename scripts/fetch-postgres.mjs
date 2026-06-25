#!/usr/bin/env node
/**
 * Install a Zleap Postgres bundle into a destination bin directory.
 *
 * Used for manual prefetch (e.g. ~/.zleap/tools/postgres/{platform}/bin).
 * Normal installs lazy-download via @zleap/host ensurePostgres at bootstrap.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { platformTag, REPO_ROOT } from './release-version.mjs';

const runtimeBundle = join(REPO_ROOT, 'packages/host/dist/postgres-bundle.js');

async function main() {
  const destBinDir = process.argv[2];
  if (!destBinDir) {
    throw new Error('Usage: node scripts/fetch-postgres.mjs <destBinDir>');
  }
  if (!existsSync(runtimeBundle)) {
    throw new Error('Build @zleap/host first: pnpm --filter @zleap/host build');
  }

  const { installPostgresBundleToBinDir, resolvePostgresBundleSpec } = await import(runtimeBundle);
  const tag = platformTag();
  const spec = resolvePostgresBundleSpec(REPO_ROOT, tag);
  await installPostgresBundleToBinDir(resolve(destBinDir), spec);
  process.stdout.write(`Postgres bundle installed from ${spec.description}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
