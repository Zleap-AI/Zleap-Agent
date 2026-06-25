import { open, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { zleapLayout } from '../layout.js';
import { buildRuntimeEnv, resolveNodeBin, resolveScriptFromEntry, resolveServiceEntries } from '../resolver.js';
import { shouldStartGateway } from '../gateway-policy.js';
import { resolveRepoRoot } from '../paths.js';
import { webUrl } from '../env.js';
import { stopServe, type ServeStartedBy, type ServeStopPolicy } from '../supervisor.js';
import { sleep } from '../process.js';

export type DetachedServeOptions = {
  env?: NodeJS.ProcessEnv;
  gateway?: boolean;
  startedBy?: ServeStartedBy;
  sessionId?: string;
  stopPolicy?: ServeStopPolicy;
};

export async function startDetachedServe(options: DetachedServeOptions = {}): Promise<void> {
  const baseEnv = buildRuntimeEnv(options.env ?? {});
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    ZLEAP_SERVE_MODE: 'production',
    ...(options.startedBy ? { ZLEAP_STARTED_BY: options.startedBy } : {}),
    ...(options.sessionId ? { ZLEAP_LAUNCHER_SESSION_ID: options.sessionId } : {}),
    ...(options.stopPolicy ? { ZLEAP_STOP_POLICY: options.stopPolicy } : {}),
  };
  if (options.gateway === true) {
    env.ZLEAP_GATEWAY = '1';
  } else if (options.gateway === false) {
    env.ZLEAP_GATEWAY = '0';
  } else if (env.ZLEAP_GATEWAY !== '1' && (await shouldStartGateway(baseEnv))) {
    env.ZLEAP_GATEWAY = '1';
  }
  const repoRoot = env.ZLEAP_REPO_ROOT ?? resolveRepoRoot();
  const nodeBin = resolveNodeBin(repoRoot);
  const serveScript = await resolveServeScript(repoRoot);
  const layout = zleapLayout();
  await mkdir(layout.logsDir, { recursive: true });
  const logPath = join(layout.logsDir, 'serve.log');
  const logHandle = await open(logPath, 'a');

  const child = spawn(nodeBin, [serveScript], {
    env,
    cwd: repoRoot,
    detached: true,
    stdio: ['ignore', logHandle.fd, logHandle.fd],
  });
  child.unref();
  await logHandle.close();
}

export async function waitForHealthLive(env: NodeJS.ProcessEnv = buildRuntimeEnv(), timeoutMs = 120_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const url = `${webUrl(env)}/api/health/live`;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) {
        return true;
      }
    } catch {
      // retry
    }
    await sleep(1_000);
  }
  return false;
}

export async function restartServe(options: DetachedServeOptions = {}): Promise<void> {
  await stopServe().catch(() => undefined);
  await sleep(500);
  await startDetachedServe(options);
  const env = buildRuntimeEnv(options.env ?? {});
  const ok = await waitForHealthLive(env, 120_000);
  if (!ok) {
    throw new Error('服务重启后健康检查超时');
  }
}

export async function installUserService(env: NodeJS.ProcessEnv = buildRuntimeEnv()): Promise<void> {
  if (process.platform === 'darwin') {
    await installLaunchdService(env);
    return;
  }
  if (process.platform === 'linux') {
    await installSystemdUserService(env);
    return;
  }
  if (process.platform === 'win32') {
    throw new Error('Windows 服务注册暂未实现，请使用 zleap serve --detach');
  }
  throw new Error(`不支持的平台：${process.platform}`);
}

async function installLaunchdService(env: NodeJS.ProcessEnv): Promise<void> {
  const repoRoot = env.ZLEAP_REPO_ROOT ?? resolveRepoRoot();
  const nodeBin = resolveNodeBin(repoRoot);
  const serveScript = await resolveServeScript(repoRoot);
  const layout = zleapLayout();
  const logPath = join(layout.logsDir, 'serve.log');
  await mkdir(layout.logsDir, { recursive: true });

  const plistPath = join(process.env.HOME ?? '', 'Library', 'LaunchAgents', 'ai.zleap.serve.plist');
  const envPairs = Object.entries(env)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `    <key>${key}</key>\n    <string>${escapeXml(String(value))}</string>`)
    .join('\n');

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.zleap.serve</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${serveScript}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${repoRoot}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envPairs}
  </dict>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>`;

  const { writeFile } = await import('node:fs/promises');
  await writeFile(plistPath, plist, 'utf8');
  await runCapture('launchctl', ['unload', plistPath]).catch(() => undefined);
  await runCapture('launchctl', ['load', plistPath]);
  process.stdout.write(`已注册 launchd 服务：${plistPath}\n`);
}

async function installSystemdUserService(env: NodeJS.ProcessEnv): Promise<void> {
  const repoRoot = env.ZLEAP_REPO_ROOT ?? resolveRepoRoot();
  const nodeBin = resolveNodeBin(repoRoot);
  const serveScript = await resolveServeScript(repoRoot);
  const layout = zleapLayout();
  const unitDir = join(process.env.HOME ?? '', '.config', 'systemd', 'user');
  await mkdir(unitDir, { recursive: true });
  const unitPath = join(unitDir, 'zleap-serve.service');
  const envLines = Object.entries(env)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `Environment=${key}=${String(value).replace(/\s/g, '\\s')}`)
    .join('\n');

  const unit = `[Unit]
Description=Zleap local stack
After=network.target

[Service]
Type=simple
WorkingDirectory=${repoRoot}
ExecStart=${nodeBin} ${serveScript}
Restart=always
RestartSec=3
${envLines}

[Install]
WantedBy=default.target
`;

  const { writeFile } = await import('node:fs/promises');
  await writeFile(unitPath, unit, 'utf8');
  await runCapture('systemctl', ['--user', 'daemon-reload']);
  await runCapture('systemctl', ['--user', 'enable', '--now', 'zleap-serve.service']);
  process.stdout.write(`已注册 systemd user 服务：${unitPath}\n`);
}

async function resolveServeScript(repoRoot: string): Promise<string> {
  const entries = await resolveServiceEntries(repoRoot);
  return resolveScriptFromEntry(repoRoot, entries.serve);
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function runCapture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.on('exit', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`${command} exited ${code}`))));
    child.on('error', reject);
  });
}
