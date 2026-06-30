import { createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { loadDistributionConfig, installManifestUrl, normalizeVersion } from './distribution.js';

export type RuntimeArtifact = {
  url: string;
  sha256?: string;
  size?: number;
};

export type RuntimeReleaseManifest = {
  version: string;
  channel?: string;
  runtime?: {
    version?: string;
    schemaVersion?: number;
    nodeVersion?: string;
    postgresVersion?: string;
    pgvectorVersion?: string;
    platforms?: Record<string, RuntimeArtifact>;
  };
  cli?: {
    npm?: string;
    minVersion?: string;
  };
  desktop?: Record<string, unknown>;
};

export class ManifestSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestSignatureError';
  }
}

export type FetchRuntimeReleaseManifestOptions = {
  url?: string;
  signal?: AbortSignal;
};

export async function fetchRuntimeReleaseManifest(
  options: FetchRuntimeReleaseManifestOptions = {},
): Promise<RuntimeReleaseManifest | undefined> {
  const url = options.url ?? installManifestUrl();
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'zleap-runtime' },
    signal: options.signal,
  }).catch((error: unknown) => {
    if (manifestSignatureRequired()) {
      throw new ManifestSignatureError(`Manifest unavailable while signature verification is required: ${String(error)}`);
    }
    return undefined;
  });
  if (!response) {
    return undefined;
  }
  if (!response.ok) {
    if (manifestSignatureRequired()) {
      throw new ManifestSignatureError(`Manifest unavailable while signature verification is required: HTTP ${response.status}`);
    }
    return undefined;
  }
  const raw = await response.text();
  await verifyReleaseManifestText(raw, url);
  return JSON.parse(raw) as RuntimeReleaseManifest;
}

export function runtimeVersionFromManifest(manifest: RuntimeReleaseManifest | undefined): string | undefined {
  const version = manifest?.runtime?.version ?? manifest?.version;
  return version ? normalizeVersion(version) : undefined;
}

export function runtimeArtifactFromManifest(
  manifest: RuntimeReleaseManifest | undefined,
  platform: string,
): RuntimeArtifact | undefined {
  return manifest?.runtime?.platforms?.[platform];
}

export async function verifyReleaseManifestText(raw: string, manifestUrl = installManifestUrl()): Promise<void> {
  const publicKey = await readManifestPublicKey();
  if (!publicKey) {
    if (manifestSignatureRequired()) {
      throw new ManifestSignatureError('Manifest signature is required but no public key is configured');
    }
    return;
  }
  const signatureUrl = process.env.ZLEAP_MANIFEST_SIGNATURE_URL?.trim() || `${manifestUrl}.sig`;
  const signatureText = await readUrlOrFile(signatureUrl);
  if (!verifyReleaseManifestSignature(raw, signatureText, publicKey)) {
    throw new ManifestSignatureError('Manifest signature verification failed');
  }
}

export function verifyReleaseManifestSignature(raw: string | Buffer, signatureBase64: string, publicKeyPem: string): boolean {
  const signature = Buffer.from(signatureBase64.trim(), 'base64');
  if (signature.length === 0) {
    return false;
  }
  const key = createPublicKey(publicKeyPem);
  return verify('RSA-SHA256', Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8'), key, signature);
}

async function readManifestPublicKey(): Promise<string | undefined> {
  const inline = process.env.ZLEAP_MANIFEST_PUBLIC_KEY?.trim();
  if (inline) {
    return decodePossiblyBase64Pem(inline);
  }
  const path = process.env.ZLEAP_MANIFEST_PUBLIC_KEY_PATH?.trim();
  if (path) {
    return readFile(path, 'utf8');
  }
  const configured = loadDistributionConfig().updater?.manifestPublicKey?.trim();
  if (configured && !configured.startsWith('REPLACE_WITH_')) {
    return decodePossiblyBase64Pem(configured);
  }
  return undefined;
}

function manifestSignatureRequired(): boolean {
  return process.env.ZLEAP_REQUIRE_MANIFEST_SIGNATURE === '1' || loadDistributionConfig().updater?.requireSignature === true;
}

function decodePossiblyBase64Pem(value: string): string {
  if (value.includes('BEGIN PUBLIC KEY')) {
    return value.replace(/\\n/g, '\n');
  }
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    return decoded.includes('BEGIN PUBLIC KEY') ? decoded : value;
  } catch {
    return value;
  }
}

async function readUrlOrFile(url: string): Promise<string> {
  if (url.startsWith('file://')) {
    return readFile(new URL(url), 'utf8');
  }
  const response = await fetch(url, {
    headers: { Accept: 'text/plain', 'User-Agent': 'zleap-runtime' },
  });
  if (!response.ok) {
    throw new ManifestSignatureError(`Manifest signature unavailable: HTTP ${response.status}`);
  }
  return response.text();
}
