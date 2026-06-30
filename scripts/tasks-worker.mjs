#!/usr/bin/env node
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
process.env.ZLEAP_REPO_ROOT ??= REPO_ROOT;

const { runDevWorker } = await import(join(REPO_ROOT, 'packages/host/dist/dev.js'));

runDevWorker({ repoRoot: REPO_ROOT }).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
