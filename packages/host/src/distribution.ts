import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_WEB_PORT } from './constants.js';
import { releasePlatformTag, resolveRepoRoot } from './paths.js';

export type DistributionConfig = {
  product: string | { name: string; id?: string; desktopName?: string };
  github: { owner: string; repo: string };
  release: {
    provider?: 'github' | 'static' | string;
    channel: string;
    installBranch: string;
    artifactBaseUrl?: string;
    manifestUrl?: string;
    installManifestUrl?: string;
    sourceBaseUrl?: string;
  };
  runtime: {
    nodeVersion: string;
    node?: {
      version?: string;
      sources?: Record<string, { url?: string; sha256?: string }>;
    };
    webPort: number;
    authMode: string;
    serveMode: string;
    gateway: boolean;
    schemaVersion?: number;
    minCliVersion?: string;
    minDesktopVersion?: string;
    supportedCliRange?: string;
    supportedDesktopRange?: string;
    postgres?: {
      version: string;
      pgvectorVersion?: string;
      source?: {
        postgres?: { url: string; sha256?: string };
        pgvector?: { url: string; sha256?: string };
      };
      bundles?: Record<string, { url?: string; sha256?: string; size?: number }>;
    };
  };
  cli?: { npm?: string; minVersion?: string };
  desktop?: { identifier?: string; platforms?: string[] };
  updater: { manifestFile: string; requireSignature?: boolean; manifestPublicKey?: string };
};

let cached: DistributionConfig | undefined;

export function loadDistributionConfig(repoRoot = resolveRepoRoot()): DistributionConfig {
  if (cached) {
    return cached;
  }
  const candidates = [
    join(repoRoot, 'distribution.json'),
    join(repoRoot, '..', 'distribution.json'),
    join(repoRoot, '..', '..', 'distribution.json'),
  ];
  for (const file of candidates) {
    try {
      cached = JSON.parse(readFileSync(file, 'utf8')) as DistributionConfig;
      return cached;
    } catch {
      // try next
    }
  }
  cached = defaultDistributionConfig();
  return cached;
}

export function resetDistributionConfigCache(): void {
  cached = undefined;
}

function defaultDistributionConfig(): DistributionConfig {
  return {
    product: { name: 'Zleap', id: 'zleap', desktopName: 'Zleap' },
    github: { owner: 'zleap-ai', repo: 'zleap-agent' },
    release: {
      provider: 'github',
      channel: 'stable',
      installBranch: 'main',
      artifactBaseUrl: 'https://github.com/{owner}/{repo}/releases/download/v{version}',
      manifestUrl: 'https://github.com/{owner}/{repo}/releases/latest/download/{manifestFile}',
      installManifestUrl: 'https://github.com/{owner}/{repo}/releases/latest/download/install-manifest.json',
      sourceBaseUrl: 'https://raw.githubusercontent.com/{owner}/{repo}/{branch}',
    },
    runtime: {
      nodeVersion: process.env.ZLEAP_NODE_VERSION ?? '20.18.1',
      webPort: Number(process.env.ZLEAP_WEB_PORT ?? DEFAULT_WEB_PORT),
      authMode: 'localhost',
      serveMode: 'production',
      schemaVersion: 1,
      minCliVersion: '0.1.0',
      minDesktopVersion: '0.1.0',
      supportedCliRange: '>=0.1.0',
      supportedDesktopRange: '>=0.1.0',
      gateway: true,
      postgres: {
        version: '17.10',
        pgvectorVersion: '0.8.3',
        source: {
          postgres: {
            url: 'https://ftp.postgresql.org/pub/source/v17.10/postgresql-17.10.tar.gz',
            sha256: 'e4b43025f32ea3d271be64365d284c8462cffd41d80db0c3df6fc62417a2d9dc',
          },
          pgvector: {
            url: 'https://github.com/pgvector/pgvector/archive/refs/tags/v0.8.3.tar.gz',
            sha256: 'dc080c511a6354a1628eb19f9bc8e77ce880dde16c889744a6814c8c0006e36c',
          },
        },
        bundles: {},
      },
    },
    cli: { npm: '@zleap-ai/cli', minVersion: '0.1.0' },
    desktop: {
      identifier: 'ai.zleap.desktop',
      platforms: ['darwin-aarch64', 'windows-x86_64'],
    },
    updater: { manifestFile: 'latest.json', requireSignature: true, manifestPublicKey: '' },
  };
}

export function githubRepoSlug(config = loadDistributionConfig()): string {
  return `${config.github.owner}/${config.github.repo}`;
}

export function normalizeVersion(raw: string): string {
  const value = String(raw).trim();
  return value.startsWith('v') ? value.slice(1) : value;
}

export function releaseDownloadBaseUrl(version: string, config = loadDistributionConfig()): string {
  if (process.env.ZLEAP_RELEASE_BASE?.trim()) {
    return process.env.ZLEAP_RELEASE_BASE.trim().replace(/\/$/, '');
  }
  const v = normalizeVersion(version);
  if (config.release.artifactBaseUrl?.trim()) {
    return renderReleaseTemplate(config.release.artifactBaseUrl, config, { version: v }).replace(/\/$/, '');
  }
  throw new Error('distribution.release.artifactBaseUrl is required');
}

export function githubLatestReleaseApiUrl(config = loadDistributionConfig()): string {
  if (process.env.ZLEAP_RELEASE_API?.trim()) {
    return process.env.ZLEAP_RELEASE_API.trim();
  }
  if (releaseProvider(config) !== 'github') {
    throw new Error('GitHub release API is only available when distribution.release.provider is github');
  }
  return `https://api.github.com/repos/${githubRepoSlug(config)}/releases/latest`;
}

export function appArchiveName(version: string, platform = releasePlatformTag()): string {
  return `zleap-runtime-${normalizeVersion(version)}-${platform}.tar.gz`;
}

export function appDownloadUrl(
  version: string,
  platform = releasePlatformTag(),
  config = loadDistributionConfig(),
): string {
  return `${releaseDownloadBaseUrl(version, config)}/${appArchiveName(version, platform)}`;
}

export function postgresBundleArchiveName(
  platform = releasePlatformTag(),
  config = loadDistributionConfig(),
): string {
  const pg = config.runtime.postgres;
  if (!pg?.version || !pg?.pgvectorVersion) {
    throw new Error('distribution.runtime.postgres.version and pgvectorVersion are required');
  }
  return `zleap-postgres-${pg.version}-pgvector-${pg.pgvectorVersion}-${platform}.tar.gz`;
}

export function postgresDownloadUrl(
  version: string,
  platform = releasePlatformTag(),
  config = loadDistributionConfig(),
): string {
  return `${releaseDownloadBaseUrl(version, config)}/${postgresBundleArchiveName(platform, config)}`;
}

export function updaterManifestUrl(config = loadDistributionConfig()): string {
  if (process.env.ZLEAP_UPDATER_MANIFEST_URL?.trim()) {
    return process.env.ZLEAP_UPDATER_MANIFEST_URL.trim();
  }
  if (process.env.ZLEAP_MANIFEST_URL?.trim()) {
    return process.env.ZLEAP_MANIFEST_URL.trim();
  }
  if (config.release.manifestUrl?.trim()) {
    return renderReleaseTemplate(config.release.manifestUrl, config);
  }
  throw new Error('distribution.release.manifestUrl is required');
}

/**
 * URL of the custom install manifest (runtime + payload contract). Distinct from
 * {@link updaterManifestUrl}, which points at the Tauri desktop updater manifest.
 */
export function installManifestUrl(config = loadDistributionConfig()): string {
  if (process.env.ZLEAP_INSTALL_MANIFEST_URL?.trim()) {
    return process.env.ZLEAP_INSTALL_MANIFEST_URL.trim();
  }
  if (process.env.ZLEAP_MANIFEST_URL?.trim()) {
    return process.env.ZLEAP_MANIFEST_URL.trim();
  }
  if (config.release.installManifestUrl?.trim()) {
    return renderReleaseTemplate(config.release.installManifestUrl, config);
  }
  if (config.release.manifestUrl?.trim()) {
    return renderReleaseTemplate(config.release.manifestUrl, config, { manifestFile: 'install-manifest.json' });
  }
  throw new Error('distribution.release.installManifestUrl or release.manifestUrl is required');
}

export function installScriptUrl(
  script: 'install.sh' | 'install.ps1',
  config = loadDistributionConfig(),
): string {
  const branch = process.env.ZLEAP_INSTALL_BRANCH ?? config.release.installBranch;
  if (config.release.sourceBaseUrl?.trim()) {
    return `${renderReleaseTemplate(config.release.sourceBaseUrl, config, { branch }).replace(/\/$/, '')}/scripts/${script}`;
  }
  throw new Error('distribution.release.sourceBaseUrl is required');
}

function releaseProvider(config: DistributionConfig): string {
  return config.release.provider ?? 'github';
}

function renderReleaseTemplate(
  template: string,
  config: DistributionConfig,
  values: { version?: string; branch?: string; manifestFile?: string } = {},
): string {
  const version = normalizeVersion(values.version ?? process.env.ZLEAP_VERSION ?? '0.1.0');
  const branch = values.branch ?? process.env.ZLEAP_INSTALL_BRANCH ?? config.release.installBranch;
  const context: Record<string, string> = {
    owner: config.github.owner,
    repo: config.github.repo,
    version,
    tag: `v${version}`,
    branch,
    channel: config.release.channel,
    manifestFile: values.manifestFile ?? config.updater.manifestFile,
  };
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (match, key: string) => context[key] || match);
}

export function webPort(config = loadDistributionConfig()): number {
  const fromEnv = Number(process.env.ZLEAP_WEB_PORT ?? process.env.PORT);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  return config.runtime.webPort ?? DEFAULT_WEB_PORT;
}

export function webBaseUrl(config = loadDistributionConfig()): string {
  return `http://127.0.0.1:${webPort(config)}`;
}

export function onboardingPath(): string {
  return '/onboarding';
}

export function onboardingUrl(config = loadDistributionConfig()): string {
  return `${webBaseUrl(config)}${onboardingPath()}`;
}

export function healthLivePath(): string {
  return '/api/health/live';
}

export function healthLiveUrl(config = loadDistributionConfig()): string {
  return `${webBaseUrl(config)}${healthLivePath()}`;
}

/** Standard production env for bundled app / CLI wrappers / desktop spawn. */
export function bundledServeEnv(appRoot: string, platform = releasePlatformTag()): NodeJS.ProcessEnv {
  const config = loadDistributionConfig(appRoot);
  const nodeBin =
    process.platform === 'win32'
      ? join(appRoot, 'node', 'node.exe')
      : join(appRoot, 'node', 'bin', 'node');
  const nodeEnv = existsSync(nodeBin) ? { ZLEAP_NODE_BIN: nodeBin } : {};
  return {
    ZLEAP_APP_ROOT: appRoot,
    ZLEAP_REPO_ROOT: appRoot,
    ZLEAP_SERVE_MODE: config.runtime.serveMode,
    ZLEAP_SKIP_BUILD: '1',
    ZLEAP_AUTH_MODE: config.runtime.authMode,
    ZLEAP_GATEWAY: config.runtime.gateway ? '1' : '0',
    ...nodeEnv,
    ZLEAP_WEB_PORT: String(webPort(config)),
  };
}
