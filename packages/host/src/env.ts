import { buildRuntimeEnv, resolveNodeBin } from './resolver.js';
import { resolveBundledNodeBin, resolveRepoRoot } from './paths.js';
import { webPort } from './distribution.js';

export { DEFAULT_DATABASE_URL, DEFAULT_WEB_PORT } from './constants.js';

export function buildServeEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return buildRuntimeEnv(overrides);
}

export function webUrl(env: NodeJS.ProcessEnv = process.env): string {
  const port = env.ZLEAP_WEB_PORT ?? env.PORT ?? String(webPort());
  return `http://127.0.0.1:${port}`;
}

export function nodeExecPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.ZLEAP_REPO_ROOT ?? resolveRepoRoot();
  return env.ZLEAP_NODE_BIN ?? resolveBundledNodeBin(root) ?? resolveNodeBin(root);
}
