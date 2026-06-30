import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDistributionConfigCache } from '../src/distribution.js';
import { postgresToolsBinDir, postgresToolsPlatformRoot } from '../src/layout.js';
import { resolvePostgresBundleSpec } from '../src/postgres-bundle.js';

describe('postgres-bundle', () => {
  beforeEach(() => {
    resetDistributionConfigCache();
    delete process.env.ZLEAP_POSTGRES_BUNDLE;
    delete process.env.ZLEAP_POSTGRES_BUNDLE_SHA256;
    delete process.env.ZLEAP_VERSION;
    delete process.env.ZLEAP_HOME;
  });

  it('resolves file bundle from ZLEAP_POSTGRES_BUNDLE', () => {
    process.env.ZLEAP_POSTGRES_BUNDLE = '/tmp/zleap-postgres.tar.gz';
    process.env.ZLEAP_POSTGRES_BUNDLE_SHA256 = 'abc123';
    const spec = resolvePostgresBundleSpec('/repo', 'mac-arm64');
    expect(spec.kind).toBe('file');
    expect(spec.file).toBe('/tmp/zleap-postgres.tar.gz');
    expect(spec.sha256).toBe('abc123');
  });

  it('resolves bundled payload checksum from SHA256SUMS', async () => {
    const payloadDir = await mkdtemp(join(tmpdir(), 'zleap-postgres-payload-'));
    try {
      process.env.ZLEAP_POSTGRES_BUNDLE = join(payloadDir, 'postgres.tar.gz');
      await writeFile(
        join(payloadDir, 'SHA256SUMS'),
        [
          'aaa111  app.tar.gz',
          'bbb222  node.tar.gz',
          'ccc333  postgres.tar.gz',
          'ddd444  manifest.json',
        ].join('\n'),
        'utf8',
      );

      const spec = resolvePostgresBundleSpec('/repo', 'mac-arm64');

      expect(spec.kind).toBe('file');
      expect(spec.file).toBe(join(payloadDir, 'postgres.tar.gz'));
      expect(spec.sha256).toBe('ccc333');
    } finally {
      await rm(payloadDir, { recursive: true, force: true });
    }
  });

  it('requires checksum before lazy download', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'zleap-postgres-test-'));
    try {
      await writeFile(
        join(repoRoot, 'distribution.json'),
        JSON.stringify({
          product: { name: 'Zleap' },
          github: { owner: 'zleap-ai', repo: 'zleap-agent' },
          release: {
            provider: 'static',
            channel: 'stable',
            installBranch: 'main',
            artifactBaseUrl: 'https://example.test/releases/v{version}',
            sourceBaseUrl: 'https://example.test/{branch}',
          },
          runtime: {
            nodeVersion: '20.18.1',
            webPort: 3000,
            authMode: 'localhost',
            serveMode: 'production',
            gateway: false,
            minCliVersion: '0.1.0',
            postgres: {
              version: '17.10',
              pgvectorVersion: '0.8.3',
              bundles: {
                'mac-arm64': {
                  url: 'https://example.test/zleap-postgres.tar.gz',
                  sha256: '',
                },
              },
            },
          },
          updater: { manifestFile: 'latest.json' },
        }),
        'utf8',
      );
      expect(() => resolvePostgresBundleSpec(repoRoot, 'mac-arm64')).toThrow(/sha256 is required/i);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it('exposes tools layout under ZLEAP_HOME', () => {
    process.env.ZLEAP_HOME = '/tmp/zleap-test-home';
    expect(postgresToolsPlatformRoot()).toBe('/tmp/zleap-test-home/tools/postgres/mac-arm64');
    expect(postgresToolsBinDir()).toBe('/tmp/zleap-test-home/tools/postgres/mac-arm64/bin');
  });
});
