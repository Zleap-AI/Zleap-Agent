import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Canonical ~/.zleap layout (code vs data separation). */
export type ZleapLayout = {
  home: string;
  stateDir: string;
  runtimeStatePath: string;
  launcherStatePath: string;
  installStatePath: string;
  serveStatePath: string;
  legacyServeStatePath: string;
  serveLockPath: string;
  updateLockPath: string;
  updateLogPath: string;
  bootstrapStatePath: string;
  desktopLogPath: string;
  dataDir: string;
  configDir: string;
  settingsPath: string;
  logsDir: string;
  appRoot: string;
  current: string;
  previous: string;
  metadataPath: string;
  binDir: string;
};

export function zleapHome(): string {
  return process.env.ZLEAP_HOME?.trim() || join(homedir(), '.zleap');
}

export function zleapLayout(): ZleapLayout {
  const home = zleapHome();
  const stateDir = join(home, 'state');
  return {
    home,
    stateDir,
    runtimeStatePath: join(stateDir, 'runtime.json'),
    launcherStatePath: join(stateDir, 'launcher.json'),
    installStatePath: join(stateDir, 'install.json'),
    serveStatePath: join(stateDir, 'serve.json'),
    legacyServeStatePath: join(home, 'serve.json'),
    serveLockPath: join(stateDir, 'serve.lock'),
    updateLockPath: join(stateDir, 'update.lock'),
    updateLogPath: join(stateDir, 'update.log'),
    bootstrapStatePath: join(stateDir, 'bootstrap.json'),
    desktopLogPath: join(home, 'logs', 'desktop.log'),
    dataDir: join(home, 'data'),
    configDir: join(home, 'config'),
    settingsPath: join(home, 'config', 'settings.json'),
    logsDir: join(home, 'logs'),
    appRoot: process.env.ZLEAP_RUNTIME_ROOT?.trim() || join(home, 'app'),
    current: process.env.ZLEAP_APP_ROOT?.trim() || join(home, 'app', 'current'),
    previous: join(home, 'app', 'previous'),
    metadataPath: join(process.env.ZLEAP_RUNTIME_ROOT?.trim() || join(home, 'app'), 'metadata.json'),
    binDir: join(home, 'bin'),
  };
}

/** Resolve serve state file (prefer state/serve.json, fall back to legacy). */
export function resolveServeStatePath(): string {
  const layout = zleapLayout();
  if (existsSync(layout.serveStatePath)) {
    return layout.serveStatePath;
  }
  if (existsSync(layout.legacyServeStatePath)) {
    return layout.legacyServeStatePath;
  }
  return layout.serveStatePath;
}

export function releasePlatformTag(): string {
  if (process.platform === 'win32') return 'win-x64';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
}

/** Platform install root: ~/.zleap/tools/postgres/{platform} (contains bin/, share/, …). */
export function postgresToolsPlatformRoot(
  home = zleapHome(),
  platform = releasePlatformTag(),
): string {
  return join(home, 'tools', 'postgres', platform);
}

export function postgresToolsBinDir(
  home = zleapHome(),
  platform = releasePlatformTag(),
): string {
  return join(postgresToolsPlatformRoot(home, platform), 'bin');
}

/** Platform Node install root: ~/.zleap/tools/node/{platform}/{version}. */
export function nodeToolsPlatformRoot(
  version: string,
  home = zleapHome(),
  platform = releasePlatformTag(),
): string {
  return join(home, 'tools', 'node', platform, version);
}

export function nodeToolsBin(
  version: string,
  home = zleapHome(),
  platform = releasePlatformTag(),
): string {
  const root = nodeToolsPlatformRoot(version, home, platform);
  return process.platform === 'win32' ? join(root, 'node.exe') : join(root, 'bin', 'node');
}
