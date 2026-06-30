import { type ChildProcess, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { buildServeEnv, nodeExecPath, webUrl } from './env.js';
import { runDevBuild, runMigrate, runWebProductionBuild } from './migrate.js';
import { ensurePostgres, probePostgres } from './postgres.js';
import { shouldStartGateway } from './gateway-policy.js';
import { isBundledInstall, resolveRepoRoot } from './paths.js';
import { resolveServeStatePath, zleapLayout } from './layout.js';
import { resolveScriptFromEntry, resolveServiceEntries } from './resolver.js';
import { resolvePnpm } from './pnpm.js';
import { sleep, spawnDetached } from './process.js';
import { acquireRuntimeLock, reclaimStaleRuntimeLock } from './lock.js';
import { readAppMetadata } from './upgrade.js';
import { writeRuntimeState } from './runtime-state.js';
import { DEFAULT_WEB_PORT } from './constants.js';

const execFileAsync = promisify(execFile);

export type ServeMode = 'dev' | 'production';

export type ServeOptions = {
  repoRoot?: string;
  mode?: ServeMode;
  gateway?: boolean;
  skipPostgres?: boolean;
  skipBuild?: boolean;
  env?: NodeJS.ProcessEnv;
  startedBy?: ServeStartedBy;
  sessionId?: string;
  stopPolicy?: ServeStopPolicy;
};

export type ServeStartedBy = 'cli' | 'desktop' | 'service' | 'dev';
export type ServeStopPolicy = 'explicit' | 'onDesktopQuit' | 'keepAlive';
export type ServeServiceName = 'postgres' | 'web' | 'worker' | 'gateway' | string;
export type ServeServiceState = {
  name: ServeServiceName;
  pid?: number;
  status?: 'starting' | 'running' | 'stopped' | 'failed';
};

export type ServeState = {
  pid: number;
  startedAt: string;
  mode: ServeMode;
  home: string;
  runtimeRoot: string;
  runtimeVersion: string;
  runtimeBuiltAt?: string;
  startedBy: ServeStartedBy;
  sessionId: string;
  stopPolicy: ServeStopPolicy;
  webPort: string;
  webUrl: string;
  services: ServeServiceState[];
};

export type HealthReport = {
  postgres: { ok: boolean; detail: string };
  web: { ok: boolean; detail: string; url: string };
  worker: { ok: boolean; detail: string };
  gateway: { ok: boolean; detail: string };
};

const children = new Set<ChildProcess>();
let shuttingDown = false;
let currentState: ServeState | undefined;

export async function runServe(options: ServeOptions = {}): Promise<number> {
  const repoRoot = options.repoRoot ?? resolveRepoRoot();
  const mode = options.mode ?? (process.env.ZLEAP_SERVE_MODE === 'production' ? 'production' : 'dev');
  const env = buildServeEnv({ ...options.env, ZLEAP_REPO_ROOT: repoRoot, ZLEAP_SERVE_MODE: mode });
  const layout = zleapLayout();
  const startedBy = options.startedBy ?? inferStartedBy(env, mode);
  const sessionId = options.sessionId ?? env.ZLEAP_LAUNCHER_SESSION_ID ?? randomUUID();
  const stopPolicy = options.stopPolicy ?? inferStopPolicy(env, startedBy);
  const lock = await acquireRuntimeLock(layout.serveLockPath, { owner: `serve:${startedBy}` });
  const skipBuild =
    options.skipBuild ?? (process.env.ZLEAP_SKIP_BUILD === '1' || (mode === 'production' && isBundledInstall(repoRoot)));
  const nodeBin = nodeExecPath(env);

  try {
    const webPort = env.ZLEAP_WEB_PORT ?? String(DEFAULT_WEB_PORT);
    if (mode === 'dev') {
      await prepareDevServe(Number(webPort));
    } else {
      const existing = await readServeState();
      if (existing?.pid && (await pidAlive(existing.pid))) {
        throw new Error(`Zleap 本地服务已在运行：${existing.webUrl}`);
      }
    }

    if (!options.skipPostgres) {
      await ensurePostgres(env);
    }

    if (!skipBuild) {
      if (mode === 'production') {
        await runDevBuild(repoRoot, env);
        await runWebProductionBuild(repoRoot, env);
      } else {
        await runDevBuild(repoRoot, env);
      }
    }

    await runMigrate(repoRoot, env);

    const services: ServeState['services'] = [];
    const entries = await resolveServiceEntries(repoRoot);

    let web: ChildProcess;
    if (mode === 'production') {
      const webLaunch = resolveWebLaunch(repoRoot, webPort, env);
      web = spawnDetached(nodeBin, webLaunch.args, { cwd: webLaunch.cwd, env: webLaunch.env });
    } else {
      const pnpm = await resolvePnpm();
      web = spawnDetached(pnpm.command, [...pnpm.argsPrefix, '--filter', '@zleap/web', 'dev:next'], {
        cwd: repoRoot,
        env,
      });
    }
    track(web);
    services.push({ name: 'web', pid: web.pid, status: 'running' });

    spawnWorker(repoRoot, env, services, entries);
    const startGateway =
      options.gateway === true ||
      (options.gateway !== false &&
        (env.ZLEAP_GATEWAY === '1' || (env.ZLEAP_GATEWAY !== '0' && (await shouldStartGateway(env)))));
    if (startGateway) {
      spawnGateway(repoRoot, env, services, entries);
    }

    const metadata = await readAppMetadata();
    await writeRuntimeState({ home: layout.home, runtimeRoot: repoRoot, version: metadata?.version, platform: metadata?.platform });
    const state: ServeState = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      mode,
      home: layout.home,
      runtimeRoot: repoRoot,
      runtimeVersion: metadata?.version ?? '0.0.0',
      runtimeBuiltAt: metadata?.builtAt,
      startedBy,
      sessionId,
      stopPolicy,
      webPort,
      webUrl: webUrl(env),
      services,
    };
    currentState = state;
    await persistServeState(state);
    await lock.release();

    process.stdout.write(`Zleap 本地服务已启动\n  Web   ${state.webUrl}\n  模式  ${mode}\n`);

    const shutdown = async (code = 0) => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      await stopTrackedChildren();
      try {
        await unlink(resolveServeStatePath());
      } catch {
        // ignore
      }
      setTimeout(() => process.exit(code), 300);
    };
    process.on('SIGINT', () => void shutdown(0));
    process.on('SIGTERM', () => void shutdown(0));

    await new Promise<void>((resolve, reject) => {
      web.on('exit', (code, signal) => {
        if (signal || code === 0) {
          resolve();
          return;
        }
        reject(new Error(`web process exited with code ${code}`));
      });
      web.on('error', reject);
    });
    await shutdown(0);
    return 0;
  } catch (error) {
    shuttingDown = true;
    await stopTrackedChildren();
    try {
      await unlink(resolveServeStatePath());
    } catch {
      // ignore
    }
    await lock.release();
    throw error;
  }
}

export type StopServeOptions = {
  onlyIfSessionOwned?: boolean;
  sessionId?: string;
  startedBy?: ServeStartedBy;
};

export async function stopServe(options: StopServeOptions = {}): Promise<{ stopped: string[]; missing: boolean; skipped?: string }> {
  const state = await readServeState();
  if (!state) {
    const orphans = await stopOrphanDevServices(resolveRepoRoot());
    await reclaimStaleRuntimeLock(zleapLayout().serveLockPath).catch(() => undefined);
    return { stopped: orphans, missing: orphans.length === 0 };
  }
  if (options.onlyIfSessionOwned) {
    if (options.sessionId && state.sessionId !== options.sessionId) {
      return { stopped: [], missing: false, skipped: `runtime started by another session (${state.startedBy})` };
    }
    if (options.startedBy && state.startedBy !== options.startedBy) {
      return { stopped: [], missing: false, skipped: `runtime started by ${state.startedBy}` };
    }
    if (state.stopPolicy !== 'onDesktopQuit') {
      return { stopped: [], missing: false, skipped: `runtime stop policy is ${state.stopPolicy}` };
    }
  }

  const stopped: string[] = [];
  for (const svc of state.services) {
    if (!svc.pid) {
      continue;
    }
    if (killProcessTree(svc.pid)) {
      stopped.push(`${svc.name}:${svc.pid}`);
    }
  }
  if (state.pid && state.pid !== process.pid) {
    if (killProcessTree(state.pid)) {
      stopped.push(`supervisor:${state.pid}`);
    }
  }
  stopped.push(...(await stopOrphanDevServices(state.runtimeRoot)));
  try {
    await unlink(resolveServeStatePath());
  } catch {
    // ignore
  }
  return { stopped, missing: false };
}

export async function readServeState(): Promise<ServeState | undefined> {
  try {
    const raw = await readFile(resolveServeStatePath(), 'utf8');
    return normalizeServeState(JSON.parse(raw) as Partial<ServeState>);
  } catch {
    return undefined;
  }
}

export async function healthCheck(env: NodeJS.ProcessEnv = buildServeEnv()): Promise<HealthReport> {
  const url = webUrl(env);
  const databaseUrl = env.ZLEAP_DATABASE_URL ?? env.DATABASE_URL ?? '';
  const pgOk = databaseUrl ? await probePostgres(databaseUrl) : false;

  let webOk = false;
  let webDetail = '未响应';
  try {
    const res = await fetch(`${url}/api/health/live`, { signal: AbortSignal.timeout(5_000) });
    webOk = res.ok;
    webDetail = res.ok ? '就绪' : `HTTP ${res.status}`;
  } catch (error) {
    webDetail = error instanceof Error ? error.message : String(error);
  }

  const state = await readServeState();
  const workerPid = state?.services.find((s) => s.name === 'worker')?.pid;
  const gatewayPid = state?.services.find((s) => s.name === 'gateway')?.pid;

  return {
    postgres: {
      ok: pgOk,
      detail: pgOk ? databaseUrl.replace(/:[^:@/]+@/, ':***@') : '无法连接',
    },
    web: { ok: webOk, detail: webDetail, url },
    worker: {
      ok: Boolean(workerPid && (await pidAlive(workerPid))),
      detail: workerPid ? `pid ${workerPid}` : '未在 serve 状态中记录',
    },
    gateway: {
      ok: gatewayPid ? await pidAlive(gatewayPid) : false,
      detail: gatewayPid ? `pid ${gatewayPid}` : '未启动',
    },
  };
}

function spawnWorker(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  services: ServeState['services'],
  entries: Record<string, string>,
): ChildProcess {
  const workerScript = entries.worker
    ? resolveScriptFromEntry(repoRoot, entries.worker)
    : resolveWorkerScript(repoRoot);
  const nodeBin = nodeExecPath(env);
  const worker = spawnDetached(nodeBin, [workerScript], { cwd: repoRoot, env });
  track(worker);
  upsertService(services, 'worker', worker.pid, 'running');
  void persistServeStateFromServices(services);

  worker.on('exit', (code, signal) => {
    if (shuttingDown) {
      return;
    }
    process.stderr.write(`worker 退出 (${signal ?? code})，1 秒后重启…\n`);
    setTimeout(() => {
      if (shuttingDown) {
        return;
      }
      spawnWorker(repoRoot, env, services, entries);
    }, 1_000);
  });
  return worker;
}

function spawnGateway(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  services: ServeState['services'],
  entries: Record<string, string>,
): ChildProcess {
  const gatewayScript = entries.gateway
    ? resolveScriptFromEntry(repoRoot, entries.gateway)
    : resolveGatewayScript(repoRoot);
  const nodeBin = nodeExecPath(env);
  const gateway = spawnDetached(nodeBin, [gatewayScript], { cwd: repoRoot, env });
  track(gateway);
  upsertService(services, 'gateway', gateway.pid, 'running');
  void persistServeStateFromServices(services);

  gateway.on('exit', (code, signal) => {
    if (shuttingDown) {
      return;
    }
    process.stderr.write(`gateway 退出 (${signal ?? code})，1 秒后重启…\n`);
    setTimeout(() => {
      if (shuttingDown) {
        return;
      }
      spawnGateway(repoRoot, env, services, entries);
    }, 1_000);
  });
  return gateway;
}

function resolveWorkerScript(repoRoot: string): string {
  const candidates = [
    join(repoRoot, 'runtime', 'node_modules', '@zleap', 'tasks', 'dist', 'worker.js'),
    join(repoRoot, 'tasks', 'dist', 'worker.js'),
    join(repoRoot, 'packages', 'tasks', 'dist', 'worker.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error('worker.js not found; run pnpm build');
}

function resolveGatewayScript(repoRoot: string): string {
  const candidates = [
    join(repoRoot, 'runtime', 'node_modules', '@zleap', 'gateway', 'dist', 'worker.js'),
    join(repoRoot, 'gateway', 'dist', 'worker.js'),
    join(repoRoot, 'packages', 'gateway', 'dist', 'worker.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error('gateway worker.js not found; run pnpm build');
}

function resolveWebLaunch(
  repoRoot: string,
  webPort: string,
  env: NodeJS.ProcessEnv,
): { cwd: string; args: string[]; env: NodeJS.ProcessEnv } {
  const standaloneServer = join(repoRoot, 'web', 'packages', 'web', 'server.js');
  if (existsSync(standaloneServer)) {
    return {
      cwd: join(repoRoot, 'web', 'packages', 'web'),
      args: ['server.js'],
      env: { ...env, PORT: webPort, HOSTNAME: '127.0.0.1' },
    };
  }
  const { cwd, nextBin } = resolveWebPaths(repoRoot);
  return {
    cwd,
    args: [nextBin, 'start', '-p', webPort],
    env,
  };
}

function resolveWebPaths(repoRoot: string): { cwd: string; nextBin: string } {
  const candidates = [
    {
      cwd: join(repoRoot, 'web'),
      nextBin: join(repoRoot, 'web', 'node_modules', 'next', 'dist', 'bin', 'next'),
    },
    {
      cwd: join(repoRoot, 'packages', 'web'),
      nextBin: join(repoRoot, 'packages', 'web', 'node_modules', 'next', 'dist', 'bin', 'next'),
    },
    {
      cwd: join(repoRoot, 'packages', 'web'),
      nextBin: join(repoRoot, 'node_modules', 'next', 'dist', 'bin', 'next'),
    },
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate.nextBin)) {
      return candidate;
    }
  }
  throw new Error('next binary not found; run pnpm install && pnpm build');
}

async function persistServeStateFromServices(services: ServeState['services']): Promise<void> {
  if (!currentState) {
    return;
  }
  currentState = { ...currentState, services: [...services] };
  await persistServeState(currentState);
}

async function persistServeState(state: ServeState): Promise<void> {
  const path = resolveServeStatePath();
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function upsertService(
  services: ServeState['services'],
  name: ServeServiceName,
  pid: number | undefined,
  status: ServeServiceState['status'] = 'running',
): void {
  const index = services.findIndex((s) => s.name === name);
  const entry = { name, pid, status };
  if (index >= 0) {
    services[index] = entry;
  } else {
    services.push(entry);
  }
}

function inferStartedBy(env: NodeJS.ProcessEnv, mode: ServeMode): ServeStartedBy {
  const raw = env.ZLEAP_STARTED_BY;
  if (raw === 'cli' || raw === 'desktop' || raw === 'service' || raw === 'dev') {
    return raw;
  }
  if (env.ZLEAP_DESKTOP === '1' || env.ZLEAP_INSTALL_METHOD === 'desktop') {
    return 'desktop';
  }
  return mode === 'dev' ? 'dev' : 'cli';
}

function inferStopPolicy(env: NodeJS.ProcessEnv, startedBy: ServeStartedBy): ServeStopPolicy {
  const raw = env.ZLEAP_STOP_POLICY;
  if (raw === 'explicit' || raw === 'onDesktopQuit' || raw === 'keepAlive') {
    return raw;
  }
  if (startedBy === 'desktop') {
    return 'onDesktopQuit';
  }
  if (startedBy === 'service') {
    return 'keepAlive';
  }
  return 'explicit';
}

function normalizeServeState(raw: Partial<ServeState>): ServeState {
  const layout = zleapLayout();
  const mode = raw.mode ?? 'production';
  const startedBy = raw.startedBy ?? inferStartedBy(process.env, mode);
  return {
    pid: raw.pid ?? 0,
    startedAt: raw.startedAt ?? new Date(0).toISOString(),
    mode,
    home: raw.home ?? layout.home,
    runtimeRoot: raw.runtimeRoot ?? process.env.ZLEAP_APP_ROOT ?? process.env.ZLEAP_REPO_ROOT ?? layout.current,
    runtimeVersion: raw.runtimeVersion ?? '0.0.0',
    runtimeBuiltAt: raw.runtimeBuiltAt,
    startedBy,
    sessionId: raw.sessionId ?? 'legacy',
    stopPolicy: raw.stopPolicy ?? inferStopPolicy(process.env, startedBy),
    webPort: raw.webPort ?? String(DEFAULT_WEB_PORT),
    webUrl: raw.webUrl ?? webUrl(),
    services: (raw.services ?? []).map((service) => ({ ...service, status: service.status ?? 'running' })),
  };
}

async function pidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Dev restarts: stop stale serve children and free the web port (e.g. orphan next dev). */
async function prepareDevServe(webPort: number): Promise<void> {
  const existing = await readServeState();
  if (existing?.pid && (await pidAlive(existing.pid))) {
    throw new Error(`Zleap 本地服务已在运行：${existing.webUrl}`);
  }
  await stopServe();
  await stopOrphanDevServices(resolveRepoRoot());
  await reclaimDevWebPort(webPort);
}

async function isPortAvailable(port: number, host = '0.0.0.0'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

async function reclaimDevWebPort(port: number): Promise<void> {
  if (await isPortAvailable(port)) {
    return;
  }

  const stopped = await stopWebPortListeners(port);

  if (stopped.length > 0) {
    process.stderr.write(`[dev] 已释放端口 ${port}（结束进程 ${stopped.join(', ')}）\n`);
  }

  if (!(await isPortAvailable(port))) {
    const hint =
      process.platform === 'win32'
        ? `结束占用 ${port} 的进程后重试，或运行 zleap stop`
        : `运行 zleap stop，或: lsof -ti :${port} | xargs kill`;
    throw new Error(`端口 ${port} 已被占用。${hint}`);
  }
}

export async function stopWebPortListeners(port: number): Promise<number[]> {
  if (process.platform === 'win32') {
    return [];
  }
  const stopped: number[] = [];
  try {
    const { stdout } = await execFileAsync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
    for (const line of stdout.trim().split('\n')) {
      const pid = Number(line.trim());
      if (!pid || pid === process.pid) {
        continue;
      }
      try {
        process.kill(pid, 'SIGTERM');
        stopped.push(pid);
      } catch {
        // already dead
      }
    }
  } catch {
    return [];
  }
  if (stopped.length === 0) {
    return stopped;
  }
  await sleep(500);
  if (!(await isPortAvailable(port))) {
    for (const pid of stopped) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already dead
      }
    }
    await sleep(500);
  }
  return stopped;
}

function track(child: ChildProcess): void {
  children.add(child);
  child.on('exit', () => children.delete(child));
}

function killProcessTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): boolean {
  if (!pid || pid === process.pid) {
    return false;
  }
  if (process.platform === 'win32') {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

async function stopTrackedChildren(): Promise<void> {
  for (const child of [...children]) {
    if (child.pid) {
      killProcessTree(child.pid);
    }
  }
  children.clear();
}

async function stopOrphanDevServices(repoRoot: string): Promise<string[]> {
  if (process.platform === 'win32') {
    return [];
  }
  const stopped: string[] = [];
  const markers = [
    join(repoRoot, 'packages', 'gateway', 'dist', 'worker.js'),
    join(repoRoot, 'packages', 'tasks', 'dist', 'worker.js'),
    join(repoRoot, 'node_modules', '.pnpm', '@larksuite+cli'),
  ];
  for (const marker of markers) {
    try {
      const { stdout } = await execFileAsync('pgrep', ['-f', marker], { encoding: 'utf8' });
      for (const line of stdout.trim().split('\n')) {
        const pid = Number(line.trim());
        if (pid && killProcessTree(pid, 'SIGKILL')) {
          stopped.push(`orphan:${pid}`);
        }
      }
    } catch {
      // no matching processes
    }
  }
  return stopped;
}
