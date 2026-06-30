import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { chmod, cp, mkdir, readdir, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { basename, dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  loadDistributionConfig,
  normalizeVersion,
  postgresBundleArchiveName,
  postgresDownloadUrl,
  resetDistributionConfigCache,
} from './distribution.js';
import { releasePlatformTag, zleapHome, zleapLayout, postgresToolsBinDir, postgresToolsPlatformRoot } from './layout.js';
import { pgBinary, resolveRepoRoot, appMetadataPath } from './paths.js';
import { run } from './process.js';

export type PostgresBundleSpec = {
  kind: 'file' | 'url';
  url?: string;
  file?: string;
  sha256: string;
  description: string;
};

export type EnsurePostgresToolsOptions = {
  repoRoot?: string;
  platform?: string;
  onProgress?: (message: string) => void;
};

export function isPostgresToolsInstalled(
  home = zleapHome(),
  platform = releasePlatformTag(),
): boolean {
  return existsPgBin(postgresToolsBinDir(home, platform));
}

function existsPgBin(dir: string): boolean {
  return existsSync(pgBinary('pg_ctl', dir)) && existsSync(pgBinary('initdb', dir));
}

function readSiblingChecksum(file: string): string | undefined {
  const checksumFile = `${file}.sha256`;
  if (existsSync(checksumFile)) {
    return readFileSync(checksumFile, 'utf8').trim().split(/\s+/)[0];
  }
  return readPayloadChecksums(file).get(basename(file));
}

function readPayloadChecksums(file: string): Map<string, string> {
  const checksums = join(dirname(file), 'SHA256SUMS');
  if (!existsSync(checksums)) {
    return new Map();
  }
  return new Map(
    readFileSync(checksums, 'utf8')
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line): [string, string] | undefined => {
        const [hash, name] = line.split(/\s+/, 2);
        if (!hash || !name) {
          return undefined;
        }
        return [name.replace(/^\*/, ''), hash];
      })
      .filter((entry): entry is [string, string] => Boolean(entry)),
  );
}

function readInstalledAppVersion(): string | undefined {
  try {
    const metaPath = appMetadataPath();
    if (!existsSync(metaPath)) {
      return undefined;
    }
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { version?: string };
    return meta.version ? normalizeVersion(meta.version) : undefined;
  } catch {
    return undefined;
  }
}

export function resolvePostgresBundleSpec(
  repoRoot = resolveRepoRoot(),
  platform = releasePlatformTag(),
): PostgresBundleSpec {
  resetDistributionConfigCache();
  const dist = loadDistributionConfig(repoRoot);
  const configured = dist.runtime.postgres?.bundles?.[platform];

  if (process.env.ZLEAP_POSTGRES_BUNDLE?.trim()) {
    const file = resolve(process.env.ZLEAP_POSTGRES_BUNDLE.trim());
    const sha256 =
      process.env.ZLEAP_POSTGRES_BUNDLE_SHA256?.trim() || readSiblingChecksum(file) || '';
    return {
      kind: 'file',
      file,
      sha256,
      description: file,
    };
  }

  if (configured?.url?.trim()) {
    if (!configured.sha256?.trim()) {
      throw new Error(`distribution.json runtime.postgres.bundles.${platform}.sha256 is required`);
    }
    return {
      kind: 'url',
      url: configured.url.trim(),
      sha256: configured.sha256.trim(),
      description: configured.url.trim(),
    };
  }

  const appVersion =
    process.env.ZLEAP_VERSION?.trim() ||
    readInstalledAppVersion() ||
    dist.runtime.minCliVersion ||
    '0.1.0';
  const url = postgresDownloadUrl(appVersion, platform, dist);
  const sha256 = configured?.sha256?.trim() ?? '';
  if (!sha256) {
    throw new Error(
      `Postgres bundle checksum missing for ${platform}. Set distribution.json runtime.postgres.bundles.${platform}.sha256 or ZLEAP_POSTGRES_BUNDLE.`,
    );
  }
  return {
    kind: 'url',
    url,
    sha256,
    description: url,
  };
}

async function materializeBundle(
  bundle: PostgresBundleSpec,
  platformRoot: string,
): Promise<string> {
  if (bundle.kind === 'file') {
    if (!bundle.file || !existsSync(bundle.file)) {
      throw new Error(`ZLEAP_POSTGRES_BUNDLE not found: ${bundle.file ?? '(empty)'}`);
    }
    if (!bundle.sha256) {
      throw new Error(
        `Checksum required for ZLEAP_POSTGRES_BUNDLE. Set ZLEAP_POSTGRES_BUNDLE_SHA256 or provide ${bundle.file}.sha256`,
      );
    }
    return bundle.file;
  }

  if (!bundle.url) {
    throw new Error('Postgres bundle URL is required');
  }

  const tmp = join(platformRoot, '..', '.postgres-download');
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  const archive = join(tmp, basename(new URL(bundle.url).pathname) || postgresBundleArchiveName());
  const response = await fetch(bundle.url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download Postgres bundle: HTTP ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), createWriteStream(archive));
  return archive;
}

async function verifyChecksum(file: string, expected: string, description: string): Promise<void> {
  if (!expected) {
    throw new Error(`Checksum required for Postgres bundle: ${description}`);
  }
  const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (actual !== expected) {
    throw new Error(
      `Postgres bundle checksum mismatch for ${description}: expected ${expected}, got ${actual}`,
    );
  }
}

async function extractBundle(archive: string, platformRoot: string): Promise<void> {
  const tmp = join(platformRoot, '..', '.postgres-extract');
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  await run('tar', ['-xf', archive, '-C', tmp]);
  const bundleRoot = await findPostgresRoot(tmp);
  await rm(platformRoot, { recursive: true, force: true });
  await mkdir(dirname(platformRoot), { recursive: true });
  await cp(bundleRoot, platformRoot, { recursive: true, dereference: true });
  await rm(tmp, { recursive: true, force: true });
  await rm(join(platformRoot, '..', '.postgres-download'), { recursive: true, force: true });
}

async function findPostgresRoot(root: string): Promise<string> {
  if (isPostgresRoot(root)) {
    return root;
  }
  const entries = await readdir(root);
  for (const entry of entries) {
    const candidate = join(root, entry);
    if (isPostgresRoot(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Postgres bundle does not contain bin/pg_ctl: ${root}`);
}

function isPostgresRoot(root: string): boolean {
  return existsSync(pgBinary('pg_ctl', join(root, 'bin'))) && existsSync(pgBinary('initdb', join(root, 'bin')));
}

function verifyPostgresRoot(root: string): void {
  const required = ['pg_ctl', 'initdb', 'postgres', 'psql', 'createdb', 'pg_isready'];
  for (const name of required) {
    if (!existsSync(pgBinary(name, join(root, 'bin')))) {
      throw new Error(`Postgres bundle missing bin/${name} at ${root}`);
    }
  }
  if (!existsSync(join(root, 'share', 'extension', 'vector.control'))) {
    throw new Error(`Postgres bundle missing pgvector control file at ${root}`);
  }
}

async function chmodPostgresBins(root: string): Promise<void> {
  if (process.platform === 'win32') {
    return;
  }
  for (const name of ['pg_ctl', 'initdb', 'postgres', 'psql', 'createdb', 'pg_isready', 'pg_config']) {
    const file = join(root, 'bin', name);
    if (existsSync(file)) {
      await chmod(file, 0o755);
    }
  }
}

/** Install a checksum-verified Postgres bundle into destBinDir's platform root. */
export async function installPostgresBundleToBinDir(
  destBinDir: string,
  spec: PostgresBundleSpec,
): Promise<void> {
  const platformRoot = dirname(destBinDir);
  await rm(platformRoot, { recursive: true, force: true });
  await mkdir(platformRoot, { recursive: true });
  const archive = await materializeBundle(spec, platformRoot);
  await verifyChecksum(archive, spec.sha256, spec.description);
  await extractBundle(archive, platformRoot);
  verifyPostgresRoot(platformRoot);
  await chmodPostgresBins(platformRoot);
}

/** Download and install portable Postgres into ~/.zleap/tools/postgres/{platform} when missing. */
export async function ensurePostgresToolsInstalled(
  options: EnsurePostgresToolsOptions = {},
): Promise<string> {
  const platform = options.platform ?? releasePlatformTag();
  const home = zleapHome();
  const binDir = postgresToolsBinDir(home, platform);
  if (isPostgresToolsInstalled(home, platform)) {
    return binDir;
  }

  const progress = options.onProgress ?? ((message: string) => process.stderr.write(`${message}\n`));
  progress(`[postgres] Installing portable Postgres to ${postgresToolsPlatformRoot(home, platform)}…`);
  const repoRoot = options.repoRoot ?? resolveRepoRoot();
  const spec = resolvePostgresBundleSpec(repoRoot, platform);
  await installPostgresBundleToBinDir(binDir, spec);
  progress('[postgres] Portable Postgres installed.');
  return binDir;
}
