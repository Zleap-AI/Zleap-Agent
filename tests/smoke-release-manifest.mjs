#!/usr/bin/env node
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateInstallManifest, writeInstallManifest } from '../scripts/distribution.mjs';

const tmp = await mkdtemp(join(tmpdir(), 'zleap-install-manifest-smoke-'));
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.ZLEAP_MANIFEST_PRIVATE_KEY = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

try {
  await smokeValidManifest();
  await smokeInvalidManifest();
  await smokeMissingExpectedPlatform();
  process.stdout.write('Install manifest smoke OK\n');
} finally {
  delete process.env.ZLEAP_EXPECT_RUNTIME_PLATFORMS;
  delete process.env.ZLEAP_EXPECT_PAYLOAD_PLATFORMS;
  delete process.env.ZLEAP_MANIFEST_PRIVATE_KEY;
  await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
}

async function smokeValidManifest() {
  const upload = join(tmp, 'upload');
  await mkdir(upload, { recursive: true });
  await writeArchive(upload, 'zleap-runtime-0.1.0-mac-arm64.tar.gz', 'mac runtime');
  await writeArchive(upload, 'zleap-runtime-0.1.0-win-x64.tar.gz', 'win runtime');
  await writeArchive(upload, 'zleap-payload-0.1.0-mac-arm64.tar.gz', 'mac payload');
  await writeArchive(upload, 'zleap-payload-0.1.0-win-x64.tar.gz', 'win payload');

  writeInstallManifest(upload, { version: '0.1.0', baseUrl: 'https://release.example/v0.1.0' });
  validateInstallManifest(join(upload, 'install-manifest.json'));

  const manifest = JSON.parse(await readFile(join(upload, 'install-manifest.json'), 'utf8'));
  assert(manifest.runtime.platforms['mac-arm64'], 'missing mac-arm64 runtime platform');
  assert(manifest.runtime.platforms['win-x64'], 'missing win-x64 runtime platform');
  assert(manifest.payload.platforms['mac-arm64'], 'missing mac-arm64 payload platform');
  assert(manifest.payload.platforms['win-x64'], 'missing win-x64 payload platform');
  assert(!manifest.platforms, 'install-manifest.json must not contain Tauri desktop platforms');
  assert(
    Object.keys(manifest.runtime.platforms).every((key) => !key.startsWith('darwin-') && !key.startsWith('windows-')),
    'desktop platform key leaked into runtime platforms',
  );
}

async function smokeMissingExpectedPlatform() {
  const upload = join(tmp, 'missing-platform');
  await mkdir(upload, { recursive: true });
  await writeArchive(upload, 'zleap-runtime-0.1.0-mac-arm64.tar.gz', 'mac runtime');
  await writeArchive(upload, 'zleap-payload-0.1.0-mac-arm64.tar.gz', 'mac payload');
  writeInstallManifest(upload, { version: '0.1.0', baseUrl: 'https://release.example/v0.1.0' });

  process.env.ZLEAP_EXPECT_RUNTIME_PLATFORMS = 'mac-arm64,win-x64';
  try {
    validateInstallManifest(join(upload, 'install-manifest.json'));
  } catch (error) {
    delete process.env.ZLEAP_EXPECT_RUNTIME_PLATFORMS;
    const message = error instanceof Error ? error.message : String(error);
    assert(message.includes('runtime.platforms.win-x64 is required'), 'missing expected runtime platform was not rejected');
    return;
  }
  delete process.env.ZLEAP_EXPECT_RUNTIME_PLATFORMS;
  throw new Error('manifest missing expected platform unexpectedly passed validation');
}

async function smokeInvalidManifest() {
  const invalidPath = join(tmp, 'invalid-install-manifest.json');
  await writeFile(
    invalidPath,
    `${JSON.stringify({
      version: '0.1.0',
      channel: 'stable',
      runtime: {
        version: '0.1.0',
        schemaVersion: 1,
        platforms: {
          'darwin-aarch64': {
            url: 'https://release.example/Zleap.dmg',
            size: 12,
          },
        },
      },
      payload: { version: '0.1.0', platforms: {} },
      cli: { npm: '@zleap-ai/cli' },
    })}\n`,
    'utf8',
  );

  try {
    validateInstallManifest(invalidPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(message.includes('not a runtime platform key'), 'invalid manifest did not reject desktop runtime key');
    assert(message.includes('sha256'), 'invalid manifest did not require sha256');
    assert(message.includes('desktop installer'), 'invalid manifest did not reject desktop URL in runtime platforms');
    return;
  }
  throw new Error('invalid install-manifest.json unexpectedly passed validation');
}

async function writeArchive(dir, name, content) {
  const path = join(dir, name);
  await writeFile(path, content);
  const bytes = await readFile(path);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(`${path}.sha256`, `${sha256}  ${name}\n`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
