import { join } from 'node:path';
import { loadServeEnvFiles } from './dotenv.js';
import { buildServeEnv } from './env.js';
import { runDevBuild, runDevBuildGateway, runMigrate } from './migrate.js';
import { ensurePostgres } from './postgres.js';
import { resolveRepoRoot } from './paths.js';
import { resolvePnpm } from './pnpm.js';
import { runForeground } from './process.js';

export type DevOptions = {
  repoRoot?: string;
  skipPostgres?: boolean;
  skipBuild?: boolean;
};

/** Web-only dev loop: Postgres → build → migrate → `next dev`. */
export async function runDevWeb(options: DevOptions = {}): Promise<number> {
  const repoRoot = options.repoRoot ?? resolveRepoRoot();
  loadServeEnvFiles(repoRoot);
  const env = buildServeEnv({ ZLEAP_REPO_ROOT: repoRoot });

  if (!options.skipPostgres) {
    await ensurePostgres(env);
  }
  if (!options.skipBuild) {
    await runDevBuild(repoRoot, env);
  }
  await runMigrate(repoRoot, env);

  const pnpm = await resolvePnpm();
  await runForeground(pnpm.command, [...pnpm.argsPrefix, '--filter', '@zleap/web', 'dev:next'], {
    cwd: repoRoot,
    env,
  });
  return 0;
}

/** Standalone task worker for `pnpm dev:tasks`. */
export async function runDevWorker(options: DevOptions = {}): Promise<number> {
  const repoRoot = options.repoRoot ?? resolveRepoRoot();
  loadServeEnvFiles(repoRoot);
  const env = buildServeEnv({ ZLEAP_REPO_ROOT: repoRoot });

  if (!options.skipBuild) {
    await runDevBuild(repoRoot, env);
  }

  const workerScript = join(repoRoot, 'packages', 'tasks', 'dist', 'worker.js');
  await runForeground(process.execPath, [workerScript], { cwd: repoRoot, env });
  return 0;
}

/** Standalone IM gateway worker for `pnpm dev:gateway`. */
export async function runDevGateway(options: DevOptions = {}): Promise<number> {
  const repoRoot = options.repoRoot ?? resolveRepoRoot();
  loadServeEnvFiles(repoRoot);
  const env = buildServeEnv({ ZLEAP_REPO_ROOT: repoRoot });

  if (!options.skipBuild) {
    await runDevBuildGateway(repoRoot, env);
  }

  const gatewayScript = join(repoRoot, 'packages', 'gateway', 'dist', 'worker.js');
  await runForeground(process.execPath, [gatewayScript], { cwd: repoRoot, env });
  return 0;
}
