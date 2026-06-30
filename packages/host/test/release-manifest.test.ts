import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runtimeArtifactFromManifest,
  runtimeVersionFromManifest,
  verifyReleaseManifestSignature,
  verifyReleaseManifestText,
  type RuntimeReleaseManifest,
} from '../src/release-manifest.js';
import { verifyArchiveChecksum } from '../src/upgrade.js';

describe('@zleap/host release manifest', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ZLEAP_SKIP_CHECKSUM;
    delete process.env.ZLEAP_MANIFEST_PUBLIC_KEY;
    delete process.env.ZLEAP_MANIFEST_PUBLIC_KEY_PATH;
    delete process.env.ZLEAP_MANIFEST_SIGNATURE_URL;
    delete process.env.ZLEAP_REQUIRE_MANIFEST_SIGNATURE;
  });

  it('resolves runtime version and platform artifact from current manifest shape', () => {
    const manifest: RuntimeReleaseManifest = {
      version: '0.2.0',
      runtime: {
        version: 'v0.3.0',
        schemaVersion: 3,
        platforms: {
          'mac-arm64': {
            url: 'https://release.example/zleap-runtime-0.3.0-mac-arm64.tar.gz',
            sha256: 'abc123',
            size: 123,
          },
        },
      },
    };

    expect(runtimeVersionFromManifest(manifest)).toBe('0.3.0');
    expect(runtimeArtifactFromManifest(manifest, 'mac-arm64')).toMatchObject({
      url: 'https://release.example/zleap-runtime-0.3.0-mac-arm64.tar.gz',
      sha256: 'abc123',
    });
  });

  it('ignores non-runtime manifest fields', () => {
    const manifest: RuntimeReleaseManifest = {
      version: '0.2.0',
      ...({
        app: {
        version: 'v0.2.1',
        platforms: {
          'linux-x64': {
            url: 'https://release.example/zleap-runtime-0.2.1-linux-x64.tar.gz',
          },
        },
        },
      } as Record<string, unknown>),
    };

    expect(runtimeVersionFromManifest(manifest)).toBe('0.2.0');
    expect(runtimeArtifactFromManifest(manifest, 'linux-x64')).toBeUndefined();
  });

  it('verifies manifest-provided sha256', async () => {
    const bytes = Buffer.from('runtime archive');
    const sha256 = createHash('sha256').update(bytes).digest('hex');

    await expect(
      verifyArchiveChecksum('1.0.0', bytes, {
        archiveName: 'zleap-runtime-1.0.0-mac-arm64.tar.gz',
        expectedSha256: sha256,
      }),
    ).resolves.toBeUndefined();

    await expect(
      verifyArchiveChecksum('1.0.0', bytes, {
        archiveName: 'zleap-runtime-1.0.0-mac-arm64.tar.gz',
        expectedSha256: 'deadbeef',
      }),
    ).rejects.toThrow(/Checksum mismatch/);
  });

  it('requires checksum file when manifest sha256 is absent', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('missing', { status: 404 }));

    await expect(
      verifyArchiveChecksum('1.0.0', Buffer.from('runtime archive'), {
        archiveName: 'zleap-runtime-1.0.0-mac-arm64.tar.gz',
        checksumUrl: 'https://release.example/missing.sha256',
      }),
    ).rejects.toThrow(/Checksum unavailable/);
  });

  it('verifies release manifest detached signatures', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const raw = '{"version":"1.0.0"}\n';
    const sig = sign('RSA-SHA256', Buffer.from(raw), privateKey).toString('base64');
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

    expect(verifyReleaseManifestSignature(raw, sig, publicPem)).toBe(true);
    expect(verifyReleaseManifestSignature(`${raw} `, sig, publicPem)).toBe(false);
  });

  it('fetches and verifies manifest signature when public key is configured', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const raw = '{"version":"1.0.0"}\n';
    const sig = sign('RSA-SHA256', Buffer.from(raw), privateKey).toString('base64');
    process.env.ZLEAP_MANIFEST_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(`${sig}\n`, { status: 200 }));

    await expect(verifyReleaseManifestText(raw, 'https://release.example/latest.json')).resolves.toBeUndefined();

    await expect(verifyReleaseManifestText(`${raw} `, 'https://release.example/latest.json')).rejects.toThrow(/signature verification failed/);
  });
});
