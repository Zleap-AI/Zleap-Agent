import { existsSync } from 'node:fs';
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  githubLatestReleaseApiUrl,
  normalizeVersion,
  appArchiveName,
  appDownloadUrl,
} from './distribution.js';
import {
  runtimeArtifactFromManifest,
  runtimeVersionFromManifest,
  type RuntimeReleaseManifest,
} from './release-manifest.js';
import { zleapLayout, releasePlatformTag } from './layout.js';
import { bundledAppRoot, runtimeRoot, appMetadataPath } from './paths.js';
import { appChecks } from './app-layout.js';
import { stopServe } from './supervisor.js';

export type AppMetadata = {
  version: string;
  platform: string;
  builtAt: string;
  schemaVersion?: number;
  minCliVersion?: string;
  minDesktopVersion?: string;
  supportedCliRange?: string;
  supportedDesktopRange?: string;
  nodeVersion?: string;
  postgresVersion?: string;
  pgvectorVersion?: string;
  entry?: Record<string, string>;
  entries?: Record<string, string>;
  features?: Record<string, boolean>;
};

export type UpgradeResult = {
  previousVersion?: string;
  newVersion: string;
  restarted: boolean;
};

export async function readAppMetadata(): Promise<AppMetadata | undefined> {
  try {
    const raw = await readFile(appMetadataPath(), 'utf8');
    return JSON.parse(raw) as AppMetadata;
  } catch {
    return undefined;
  }
}

export async function readPreviousAppMetadata(): Promise<AppMetadata | undefined> {
  try {
    const raw = await readFile(join(zleapLayout().appRoot, 'metadata.previous.json'), 'utf8');
    return JSON.parse(raw) as AppMetadata;
  } catch {
    return undefined;
  }
}

export async function validateAppStaging(stagingAppDir: string, metadata: AppMetadata): Promise<void> {
  const missing = appChecks(stagingAppDir);
  if (missing.length > 0) {
    throw new Error(`Invalid app staging: missing ${missing.join(', ')}`);
  }
  if (!metadata.version || !metadata.platform) {
    throw new Error('Invalid app metadata: version/platform required');
  }
}

/** Install extracted app `app/` tree from a staging directory. */
export async function swapApp(stagingAppDir: string, metadata: AppMetadata): Promise<UpgradeResult> {
  await validateAppStaging(stagingAppDir, metadata);
  const appRoot = runtimeRoot();
  const current = bundledAppRoot();
  const previous = join(appRoot, 'previous');
  const previousMeta = await readAppMetadata();

  await stopServe().catch(() => undefined);

  if (existsSync(current)) {
    await rm(previous, { recursive: true, force: true });
    await cp(current, previous, { recursive: true });
    if (previousMeta) {
      await writeFile(
        join(appRoot, 'metadata.previous.json'),
        `${JSON.stringify(previousMeta, null, 2)}\n`,
        'utf8',
      );
    }
    await rm(current, { recursive: true, force: true });
  }

  const { mkdir } = await import('node:fs/promises');
  await mkdir(appRoot, { recursive: true });
  await cp(stagingAppDir, current, { recursive: true });
  await writeFile(
    appMetadataPath(),
    `${JSON.stringify({ ...metadata, version: normalizeVersion(metadata.version) }, null, 2)}\n`,
    'utf8',
  );

  return {
    previousVersion: previousMeta?.version,
    newVersion: normalizeVersion(metadata.version),
    restarted: false,
  };
}

export async function restorePreviousApp(): Promise<boolean> {
  const layout = zleapLayout();
  const current = layout.current;
  const previous = layout.previous;
  if (!existsSync(previous)) {
    return false;
  }
  await stopServe().catch(() => undefined);
  if (existsSync(current)) {
    await rm(current, { recursive: true, force: true });
  }
  await cp(previous, current, { recursive: true });
  const prevMetaPath = join(layout.appRoot, 'metadata.previous.json');
  if (existsSync(prevMetaPath)) {
    const { cp: cpFile } = await import('node:fs/promises');
    await cpFile(prevMetaPath, appMetadataPath());
  }
  return true;
}

export function zleapInstallLayout() {
  const layout = zleapLayout();
  return {
    home: layout.home,
    appRoot: layout.appRoot,
    current: layout.current,
    metadataPath: layout.metadataPath,
  };
}

export type VerifyArchiveChecksumOptions = {
  skipChecksum?: boolean;
  expectedSha256?: string;
  checksumUrl?: string;
  archiveName?: string;
};

export async function verifyArchiveChecksum(
  version: string,
  bytes: Buffer,
  options: VerifyArchiveChecksumOptions = {},
): Promise<void> {
  if (options.skipChecksum || process.env.ZLEAP_SKIP_CHECKSUM === '1') {
    return;
  }
  const platform = releasePlatformTag();
  const archiveName = options.archiveName ?? appArchiveName(version, platform);
  let expected = options.expectedSha256?.trim().toLowerCase();
  if (!expected) {
    const checksumUrl = options.checksumUrl ?? `${appDownloadUrl(version, platform)}.sha256`;
    const response = await fetch(checksumUrl);
    if (!response.ok) {
      throw new Error(`Checksum unavailable for ${archiveName}: HTTP ${response.status}`);
    }
    expected = (await response.text()).trim().split(/\s+/)[0]?.toLowerCase();
    if (!expected) {
      throw new Error(`Checksum response is empty for ${archiveName}`);
    }
  }
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (expected !== actual) {
    throw new Error(`Checksum mismatch for ${archiveName}`);
  }
}

export async function fetchLatestReleaseVersion(): Promise<string> {
  const response = await fetch(githubLatestReleaseApiUrl(), {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'zleap-runtime' },
  });
  if (!response.ok) {
    throw new Error(`Failed to query latest release: HTTP ${response.status}`);
  }
  const data = (await response.json()) as { tag_name?: string };
  if (!data.tag_name) {
    throw new Error('Latest release missing tag_name');
  }
  return normalizeVersion(data.tag_name);
}

export async function downloadAppArchive(
  version: string,
  options: { skipChecksum?: boolean; manifest?: RuntimeReleaseManifest } = {},
): Promise<{ tmpDir: string; metadata: AppMetadata; stagingAppDir: string }> {
  const platform = releasePlatformTag();
  const manifestVersion = runtimeVersionFromManifest(options.manifest);
  const manifestArtifact =
    !manifestVersion || manifestVersion === normalizeVersion(version)
      ? runtimeArtifactFromManifest(options.manifest, platform)
      : undefined;
  const url = manifestArtifact?.url ?? appDownloadUrl(version, platform);
  const archive = archiveNameFromUrl(url) ?? appArchiveName(version, platform);
  const tmpDir = await mkdtemp(join(tmpdir(), 'zleap-install-'));

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed (${url}): HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  await verifyArchiveChecksum(version, bytes, {
    archiveName: archive,
    checksumUrl: manifestArtifact ? undefined : `${appDownloadUrl(version, platform)}.sha256`,
    expectedSha256: manifestArtifact?.sha256,
    skipChecksum: options.skipChecksum,
  });

  if (archive.endsWith('.zip')) {
    const zipPath = join(tmpDir, archive);
    await writeFile(zipPath, bytes);
    await run('powershell', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${tmpDir.replace(/'/g, "''")}' -Force`,
    ]);
  } else {
    const tarPath = join(tmpDir, archive);
    await writeFile(tarPath, bytes);
    await run('tar', ['-xzf', tarPath, '-C', tmpDir]);
  }

  const metadata = JSON.parse(await readFile(join(tmpDir, 'metadata.json'), 'utf8')) as AppMetadata;
  const stagingAppDir = join(tmpDir, 'app');
  await validateAppStaging(stagingAppDir, metadata);
  return { tmpDir, metadata, stagingAppDir };
}

function archiveNameFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const name = parsed.pathname.split('/').filter(Boolean).pop();
    return name ? decodeURIComponent(name) : undefined;
  } catch {
    const name = url.split(/[\\/]/).filter(Boolean).pop();
    return name || undefined;
  }
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))));
    child.on('error', reject);
  });
}
