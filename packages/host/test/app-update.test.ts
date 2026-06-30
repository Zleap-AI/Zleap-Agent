import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchRuntimeReleaseManifest: vi.fn(),
  readAppMetadata: vi.fn(),
  runUpdate: vi.fn(),
}));

vi.mock('../src/release-manifest.js', async () => {
  const actual = await vi.importActual<typeof import('../src/release-manifest.js')>('../src/release-manifest.js');
  return {
    ...actual,
    fetchRuntimeReleaseManifest: mocks.fetchRuntimeReleaseManifest,
  };
});

vi.mock('../src/upgrade.js', async () => {
  const actual = await vi.importActual<typeof import('../src/upgrade.js')>('../src/upgrade.js');
  return {
    ...actual,
    readAppMetadata: mocks.readAppMetadata,
  };
});

vi.mock('../src/update-engine.js', () => ({
  runUpdate: mocks.runUpdate,
}));

describe('ensureAppUpToDate', () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it('uses the guarded update pipeline for desktop auto update', async () => {
    mocks.readAppMetadata.mockResolvedValue({ version: '0.2.0' });
    mocks.fetchRuntimeReleaseManifest.mockResolvedValue({ runtime: { version: '0.3.0', platforms: {} } });
    mocks.runUpdate.mockResolvedValue({ previousVersion: '0.2.0', newVersion: '0.3.0', restarted: true });

    const { ensureAppUpToDate } = await import('../src/app-update.js');
    const result = await ensureAppUpToDate({ autoUpdate: true });

    expect(mocks.runUpdate).toHaveBeenCalledWith({ version: '0.3.0' });
    expect(result).toMatchObject({ upToDate: true, latestVersion: '0.3.0', updated: true });
  });

  it('returns blocked instead of throwing when guarded update is refused', async () => {
    mocks.readAppMetadata.mockResolvedValue({ version: '0.2.0' });
    mocks.fetchRuntimeReleaseManifest.mockResolvedValue({ runtime: { version: '0.3.0', platforms: {} } });
    mocks.runUpdate.mockRejectedValue(new Error('scheduled tasks are active'));

    const { ensureAppUpToDate } = await import('../src/app-update.js');
    const result = await ensureAppUpToDate({ autoUpdate: true });

    expect(result).toMatchObject({
      upToDate: false,
      latestVersion: '0.3.0',
      updated: false,
      blocked: true,
      error: 'scheduled tasks are active',
    });
  });
});
