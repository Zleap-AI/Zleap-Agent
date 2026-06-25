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
};

export type MaterializedPayload = {
  payloadDir: string;
  cleanupDir?: string;
};

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
    const dl = JSON.parse(readFileSync(downloadPath, 'utf8')) as { url?: string; archive?: string };
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
    };
  } catch {
    return undefined;
  }
}

/** Download + verify payload archives described by a thin descriptor directory. */
export async function materializePayloadFromDescriptor(
  descriptorDir: string,
): Promise<MaterializedPayload> {
  const descriptor = readPayloadDownloadDescriptor(descriptorDir);
  if (!descriptor) {
    throw new Error(`Thin payload descriptor is invalid: ${descriptorDir}`);
  }

  const cleanupDir = await mkdtemp(join(tmpdir(), 'zleap-payload-dl-'));
  const archivePath = join(cleanupDir, descriptor.archive || 'payload.tar.gz');
  process.stderr.write(`Downloading Zleap payload from ${descriptor.url}\n`);
  await downloadFile(descriptor.url, archivePath);

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
): Promise<MaterializedPayload> {
  if (existsSync(join(payloadDir, 'app.tar.gz'))) {
    return { payloadDir };
  }
  if (isThinPayloadDescriptor(payloadDir)) {
    if (!downloadIfMissing) {
      throw new Error(`Payload archives missing under ${payloadDir}; enable download to fetch from release`);
    }
    return materializePayloadFromDescriptor(payloadDir);
  }
  throw new Error(`Payload directory is incomplete: ${payloadDir}`);
}

function downloadFile(url: string, dest: string, redirects = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error(`Too many redirects while downloading ${url}`));
      return;
    }
    const request = httpsGet(url, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        const next = new URL(response.headers.location, url).toString();
        downloadFile(next, dest, redirects + 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`Download failed (HTTP ${status}) for ${url}`));
        return;
      }
      pipeline(response, createWriteStream(dest)).then(resolve, reject);
    });
    request.on('error', reject);
  });
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
