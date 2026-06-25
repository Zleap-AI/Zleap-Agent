import { describe, expect, it } from 'vitest';
import {
  githubLatestReleaseApiUrl,
  githubRepoSlug,
  healthLiveUrl,
  installScriptUrl,
  loadDistributionConfig,
  normalizeVersion,
  onboardingUrl,
  releaseDownloadBaseUrl,
  resetDistributionConfigCache,
  appArchiveName,
  appDownloadUrl,
  updaterManifestUrl,
  webPort,
} from '../src/distribution.js';

describe('@zleap/host distribution', () => {
  it('loads distribution.json from repo root', () => {
    resetDistributionConfigCache();
    const config = loadDistributionConfig();
    expect(config.github.owner).toBe('Zleap-AI');
    expect(config.github.repo).toBe('Zleap-Agent');
    expect(config.runtime.webPort).toBe(4789);
  });

  it('normalizes version tags', () => {
    expect(normalizeVersion('v1.2.3')).toBe('1.2.3');
    expect(normalizeVersion('1.2.3')).toBe('1.2.3');
  });

  it('builds release URLs from config', () => {
    resetDistributionConfigCache();
    const config = loadDistributionConfig();
    expect(config.release.provider).toBe('github');
    expect(releaseDownloadBaseUrl('1.0.0', config)).toBe(
      'https://github.com/Zleap-AI/Zleap-Agent/releases/download/v1.0.0',
    );
    expect(appArchiveName('1.0.0', 'mac-arm64')).toBe('zleap-runtime-1.0.0-mac-arm64.tar.gz');
    expect(appDownloadUrl('1.0.0', 'win-x64')).toBe(
      'https://github.com/Zleap-AI/Zleap-Agent/releases/download/v1.0.0/zleap-runtime-1.0.0-win-x64.tar.gz',
    );
    expect(updaterManifestUrl(config)).toBe(
      'https://github.com/Zleap-AI/Zleap-Agent/releases/latest/download/latest.json',
    );
    expect(installScriptUrl('install.sh', config)).toBe(
      'https://raw.githubusercontent.com/Zleap-AI/Zleap-Agent/main/scripts/install.sh',
    );
  });

  it('supports non-GitHub release URL templates', () => {
    resetDistributionConfigCache();
    const base = loadDistributionConfig();
    const config = {
      ...base,
      release: {
        ...base.release,
        provider: 'static',
        channel: 'beta',
        artifactBaseUrl: 'https://cdn.example.com/{channel}/host/{version}',
        manifestUrl: 'https://cdn.example.com/{channel}/{manifestFile}',
        sourceBaseUrl: 'https://cdn.example.com/install/{branch}',
      },
    };

    expect(releaseDownloadBaseUrl('v2.0.0', config)).toBe('https://cdn.example.com/beta/host/2.0.0');
    expect(appDownloadUrl('2.0.0', 'mac-arm64', config)).toBe(
      'https://cdn.example.com/beta/host/2.0.0/zleap-runtime-2.0.0-mac-arm64.tar.gz',
    );
    expect(updaterManifestUrl(config)).toBe('https://cdn.example.com/beta/latest.json');
    expect(installScriptUrl('install.ps1', config)).toBe('https://cdn.example.com/install/main/scripts/install.ps1');
  });

  it('derives local URLs from webPort', () => {
    resetDistributionConfigCache();
    expect(webPort()).toBe(4789);
    expect(onboardingUrl()).toBe('http://127.0.0.1:4789/onboarding');
    expect(healthLiveUrl()).toBe('http://127.0.0.1:4789/api/health/live');
  });
});
