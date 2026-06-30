import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRepoRoot } from './paths.js';
import { resolvePnpm, type PnpmRef } from './pnpm.js';
import { run } from './process.js';

export async function runMigrate(repoRoot = resolveRepoRoot(), env: NodeJS.ProcessEnv): Promise<void> {
  const migrateJs = resolveMigrateScript(repoRoot);
  const node = env.ZLEAP_NODE_BIN ?? process.execPath;
  await run(node, [migrateJs], { cwd: repoRoot, env });
}

export async function runDevBuild(repoRoot: string, env: NodeJS.ProcessEnv): Promise<void> {
  const pnpm = await resolvePnpm();
  await runPnpm(pnpm, ['--filter', '@zleap/core', 'build'], repoRoot, env);
  await runPnpm(pnpm, ['--filter', '@zleap/store', 'build'], repoRoot, env);
  await runPnpm(pnpm, ['--filter', '@zleap-ai/cli', 'build'], repoRoot, env);
  await runPnpm(pnpm, ['--filter', '@zleap/tasks', 'build'], repoRoot, env);
  await runPnpm(pnpm, ['--filter', '@zleap/gateway', 'build'], repoRoot, env);
}

export async function runDevBuildGateway(repoRoot: string, env: NodeJS.ProcessEnv): Promise<void> {
  const pnpm = await resolvePnpm();
  await runPnpm(pnpm, ['--filter', '@zleap/ai', 'build'], repoRoot, env);
  await runPnpm(pnpm, ['--filter', '@zleap/core', 'build'], repoRoot, env);
  await runPnpm(pnpm, ['--filter', '@zleap/store', 'build'], repoRoot, env);
  await runPnpm(pnpm, ['--filter', '@zleap-ai/cli', 'build'], repoRoot, env);
  await runPnpm(pnpm, ['--filter', '@zleap/gateway', 'build'], repoRoot, env);
}

export async function runWebProductionBuild(repoRoot: string, env: NodeJS.ProcessEnv): Promise<void> {
  const pnpm = await resolvePnpm();
  await runPnpm(pnpm, ['--filter', '@zleap/web', 'build'], repoRoot, env);
}

function resolveMigrateScript(repoRoot: string): string {
  const storeDist = join('@zleap', 'store', 'dist', 'migrate.js');
  const candidates = [
    join(repoRoot, 'packages', 'store', 'dist', 'migrate.js'),
    join(repoRoot, 'store', 'dist', 'migrate.js'),
    join(repoRoot, 'runtime', 'node_modules', storeDist),
    join(repoRoot, 'node_modules', storeDist),
    join(repoRoot, 'web', 'node_modules', storeDist),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`migrate.js not found under ${repoRoot}; run pnpm build`);
}

function runPnpm(pnpm: PnpmRef, args: string[], repoRoot: string, env: NodeJS.ProcessEnv): Promise<void> {
  return run(pnpm.command, [...pnpm.argsPrefix, ...args], { cwd: repoRoot, env });
}
