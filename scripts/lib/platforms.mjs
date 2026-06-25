/**
 * Single source of truth for release platform identity.
 *
 * Three naming spaces exist for historical/tooling reasons and are mapped here
 * exactly once:
 *   - runtime tag    : mac-arm64 / win-x64        (payload, runtime archives, node/pg bundles)
 *   - tauri target   : darwin-aarch64 / windows-x86_64 (Tauri updater latest.json keys)
 *   - npm os/cpu     : darwin/arm64, win32/x64    (per-platform optional dependency packages)
 *
 * OFFICIAL_PLATFORMS is the set the CI builds and ships. Everything that needs a
 * platform list (CI matrix, expected-platform validation, npm packaging,
 * distribution.json node sources) must derive from this table.
 */

export const PLATFORM_MATRIX = {
  'mac-arm64': {
    runner: 'macos-14',
    nodeDownload: 'darwin-arm64',
    nodeExt: '.tar.gz',
    tauriTarget: 'darwin-aarch64',
    npm: { dir: 'app-darwin-arm64', name: '@zleap-ai/app-darwin-arm64', os: 'darwin', cpu: 'arm64' },
  },
  'win-x64': {
    runner: 'windows-latest',
    nodeDownload: 'win-x64',
    nodeExt: '.zip',
    tauriTarget: 'windows-x86_64',
    npm: { dir: 'app-win32-x64', name: '@zleap-ai/app-win32-x64', os: 'win32', cpu: 'x64' },
  },
};

export const OFFICIAL_PLATFORMS = Object.keys(PLATFORM_MATRIX);

export const OFFICIAL_TAURI_TARGETS = OFFICIAL_PLATFORMS.map((tag) => PLATFORM_MATRIX[tag].tauriTarget);

export function platformInfo(tag) {
  const info = PLATFORM_MATRIX[tag];
  if (!info) {
    throw new Error(`Unsupported release platform: ${tag}. Official platforms: ${OFFICIAL_PLATFORMS.join(', ')}`);
  }
  return info;
}

export function npmPackageMeta(tag) {
  return platformInfo(tag).npm;
}

export function tauriTargetForTag(tag) {
  return platformInfo(tag).tauriTarget;
}

export function platformTag(nodePlatform = process.platform, nodeArch = process.arch) {
  if (nodePlatform === 'win32') return 'win-x64';
  if (nodePlatform === 'darwin') return nodeArch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  if (nodePlatform === 'linux') return nodeArch === 'arm64' ? 'linux-arm64' : 'linux-x64';
  throw new Error(`Unsupported platform: ${nodePlatform} ${nodeArch}`);
}

export function nodeDownloadPlatform(nodePlatform = process.platform, nodeArch = process.arch) {
  if (nodePlatform === 'win32') return 'win-x64';
  if (nodePlatform === 'darwin') return nodeArch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  if (nodePlatform === 'linux') return nodeArch === 'arm64' ? 'linux-arm64' : 'linux-x64';
  throw new Error(`Unsupported platform: ${nodePlatform} ${nodeArch}`);
}
