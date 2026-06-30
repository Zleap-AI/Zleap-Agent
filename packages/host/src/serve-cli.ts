#!/usr/bin/env node
import { loadServeEnvFiles } from './dotenv.js';
import { resolveRepoRoot } from './paths.js';
import { runServe } from './supervisor.js';

loadServeEnvFiles(resolveRepoRoot());

runServe().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
