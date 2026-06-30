import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { get as httpsGet } from 'node:https';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';

export type PayloadDownloadDescriptor = {
  url: string;
  archive: string;
  files: Record<string, { sha256?: string; size?: number }>;
  mirrors?: string[];
};

export type MaterializedPayload = {
  payloadDir: string;
  cleanupDir?: string;
};

export type DownloadProgress = {
  transferred: number;
  total?: number;
  url: string;
};

export type MaterializeOptions = {
  onProgress?: (progress: DownloadProgress) => void;
};

const IDLE_TIMEOUT_MS = Math.max(5_000, Number(process.env.ZLEAP_DOWNLOAD_TIMEOUT_MS) || 60_000);
const MAX_ATTEMPTS = Math.max(1, Number(process.env.ZLEAP_DOWNLOAD_RETRIES) || 4);

/**
 * Build the ordered list of URLs to try. A China-friendly mirror/proxy can be
 * configured via the ZLEAP_DOWNLOAD_MIRROR env var (comma-separated). Each entry
 * may be: a prefix proxy ending in '/' (e.g. https://ghproxy.com/), a template
 * containing '{url}', or a host replacement (e.g. https://mirror.example.com).
 * The original URL is always tried last as a fallback.
 */
export function downloadCandidates(url: string, descriptorMirrors: string[] = []): string[] {
  const envMirrors = (process.env.ZLEAP_DOWNLOAD_MIRROR ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  // Env-provided mirrors take precedence over ones baked into download.json.
  const mirrors = [...envMirrors, ...descriptorMirrors.map((m) => m.trim()).filter(Boolean)];
  const list = mirrors.map((mirror) => applyMirror(mirror, url));
  list.push(url);
  return [...new Set(list)];
}

function applyMirror(mirror: string, url: string): string {
  if (mirror.includes('{url}')) {
    return mirror.replace('{url}', url);
  }
  if (mirror.endsWith('/')) {
    return `${mirror}${url}`;
  }
  try {
    const original = new URL(url);
    const replacement = new URL(mirror);
    return url.replace(`${original.protocol}//${original.host}`, `${replacement.protocol}//${replacement.host}`);
  } catch {
    return url;
  }
}

/** True when the directory has a trusted descriptor but not the heavy archives yet. */
export function isThinPayloadDescriptor(dir: string): boolean {
  return (
    existsSync(join(dir, 'manifest.json')) &&
    existsSync(join(dir, 'download.json')) &&
    !existsSync(join(dir, 'app.tar.gz'))
  );
}

export function readPayloadDownloadDescriptor(descriptorDir: string): PayloadDownloadDescriptor | undefined {
  const downloadPath = join(descriptorDir, 'download.json');
  const manifestPath = join(descriptorDir, 'manifest.json');
  if (!existsSync(downloadPath) || !existsSync(manifestPath)) {
    return undefined;
  }
  try {
    const dl = JSON.parse(readFileSync(downloadPath, 'utf8')) as {
      url?: string;
      archive?: string;
      mirrors?: string[];
    };
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      payload?: { files?: Record<string, { sha256?: string; size?: number }> };
    };
    if (!dl.url) {
      return undefined;
    }
    return {
      url: dl.url,
      archive: dl.archive ?? basename(new URL(dl.url).pathname),
      files: manifest.payload?.files ?? {},
      mirrors: Array.isArray(dl.mirrors) ? dl.mirrors.filter((m): m is string => typeof m === 'string') : undefined,
    };
  } catch {
    return undefined;
  }
}

/** Download + verify payload archives described by a thin descriptor directory. */
export async function materializePayloadFromDescriptor(
  descriptorDir: string,
  options: MaterializeOptions = {},
): Promise<MaterializedPayload> {
  const descriptor = readPayloadDownloadDescriptor(descriptorDir);
  if (!descriptor) {
    throw new Error(`Thin payload descriptor is invalid: ${descriptorDir}`);
  }

  const cleanupDir = await mkdtemp(join(tmpdir(), 'zleap-payload-dl-'));
  const archivePath = join(cleanupDir, descriptor.archive || 'payload.tar.gz');
  process.stderr.write(`Downloading Zleap payload from ${descriptor.url}\n`);
  await downloadFile(descriptor.url, archivePath, options.onProgress, descriptor.mirrors);

  const extractRoot = join(cleanupDir, 'extract');
  await mkdir(extractRoot, { recursive: true });
  await extractArchive(archivePath, extractRoot);

  const payloadDir = join(extractRoot, 'payload');
  if (!existsSync(join(payloadDir, 'manifest.json'))) {
    throw new Error(`Downloaded payload archive is missing payload/manifest.json: ${descriptor.url}`);
  }

  for (const name of ['app.tar.gz', 'node.tar.gz', 'postgres.tar.gz']) {
    const filePath = join(payloadDir, name);
    if (!existsSync(filePath)) {
      throw new Error(`Downloaded payload is missing ${name}`);
    }
    const expected = descriptor.files[name]?.sha256;
    if (!expected) {
      throw new Error(`Payload descriptor is missing sha256 for ${name}`);
    }
    const actual = await sha256File(filePath);
    if (actual !== expected) {
      throw new Error(`Checksum mismatch for ${name}\n  expected: ${expected}\n  actual:   ${actual}`);
    }
  }

  return { payloadDir, cleanupDir };
}

export async function resolvePayloadDir(
  payloadDir: string,
  downloadIfMissing = false,
  options: MaterializeOptions = {},
): Promise<MaterializedPayload> {
  if (existsSync(join(payloadDir, 'app.tar.gz'))) {
    return { payloadDir };
  }
  if (isThinPayloadDescriptor(payloadDir)) {
    if (!downloadIfMissing) {
      throw new Error(`Payload archives missing under ${payloadDir}; enable download to fetch from release`);
    }
    return materializePayloadFromDescriptor(payloadDir, options);
  }
  throw new Error(`Payload directory is incomplete: ${payloadDir}`);
}

/**
 * Download a file with a stall timeout, automatic retries, and optional mirror
 * fallback. A bare httpsGet has no timeout, so a stalled connection (common when
 * reaching GitHub release CDNs from mainland China) would hang forever with no
 * feedback. This surfaces progress and fails fast so the caller can retry.
 */
async function downloadFile(
  url: string,
  dest: string,
  onProgress?: (progress: DownloadProgress) => void,
  descriptorMirrors: string[] = [],
): Promise<void> {
  const candidates = downloadCandidates(url, descriptorMirrors);
  let lastError: Error | undefined;
  for (const candidate of candidates) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        await downloadOnce(candidate, dest, onProgress);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        await rm(dest, { force: true }).catch(() => undefined);
        process.stderr.write(
          `Payload download attempt ${attempt}/${MAX_ATTEMPTS} from ${candidate} failed: ${lastError.message}\n`,
        );
        if (attempt < MAX_ATTEMPTS) {
          await delay(1_000 * attempt);
        }
      }
    }
  }
  throw lastError ?? new Error(`Download failed for ${url}`);
}

function downloadOnce(
  url: string,
  dest: string,
  onProgress?: (progress: DownloadProgress) => void,
  redirects = 0,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error(`Too many redirects while downloading ${url}`));
      return;
    }
    const request = httpsGet(url, { headers: { 'user-agent': 'zleap-installer' } }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        const next = new URL(response.headers.location, url).toString();
        downloadOnce(next, dest, onProgress, redirects + 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`Download failed (HTTP ${status}) for ${url}`));
        return;
      }
      const total = Number(response.headers['content-length']) || undefined;
      let transferred = 0;
      response.on('data', (chunk: Buffer) => {
        transferred += chunk.length;
        onProgress?.({ transferred, total, url });
      });
      pipeline(response, createWriteStream(dest)).then(resolve, reject);
    });
    request.setTimeout(IDLE_TIMEOUT_MS, () => {
      request.destroy(new Error(`Download stalled (no data for ${IDLE_TIMEOUT_MS}ms) from ${url}`));
    });
    request.on('error', reject);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function extractArchive(archivePath: string, destination: string): Promise<void> {
  await run('tar', ['-xzf', archivePath, '-C', destination]);
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))));
    child.on('error', reject);
  });
}
