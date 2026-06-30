#!/usr/bin/env node
/** Dev convenience: Web + Task Worker + IM Gateway under one supervisor. */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
process.env.ZLEAP_REPO_ROOT ??= REPO_ROOT;

const { runServe } = await import(join(REPO_ROOT, 'packages/host/dist/supervisor.js'));

runServe({ repoRoot: REPO_ROOT, mode: 'dev', gateway: true }).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
