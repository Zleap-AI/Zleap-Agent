import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_302_API_BASE_URL,
  DEFAULT_302_MODEL_BASE_URL,
  resolveIntegration302Detailed,
  setIntegration302Store,
} from '../src/integration302.js';

beforeEach(() => {
  setIntegration302Store(undefined);
  vi.stubEnv('ZLEAP_302_CONFIG_PATH', join(tmpdir(), `zleap-302-${randomUUID()}.json`));
  vi.stubEnv('ZLEAP_302_API_KEY', '');
  vi.stubEnv('302_API_KEY', '');
  vi.stubEnv('ZLEAP_302_API_BASE_URL', '');
  vi.stubEnv('ZLEAP_302_MODEL_BASE_URL', '');
});

afterEach(() => {
  setIntegration302Store(undefined);
  vi.unstubAllEnvs();
});

describe('302 integration resolution', () => {
  it('reports defaults when no DB/env/file config exists', async () => {
    const resolved = await resolveIntegration302Detailed();

    expect(resolved).toEqual({
      apiKey: undefined,
      apiBaseUrl: DEFAULT_302_API_BASE_URL,
      modelBaseUrl: DEFAULT_302_MODEL_BASE_URL,
      source: {
        apiKey: 'none',
        apiBaseUrl: 'default',
        modelBaseUrl: 'default',
      },
    });
  });

  it('prefers DB values over env values', async () => {
    vi.stubEnv('ZLEAP_302_API_KEY', 'sk-env');
    vi.stubEnv('ZLEAP_302_API_BASE_URL', 'https://env.example');
    vi.stubEnv('ZLEAP_302_MODEL_BASE_URL', 'https://env.example/v1');
    setIntegration302Store({
      integrations: {
        getIntegration: async () => ({
          config: {
            apiKey: 'sk-db',
            apiBaseUrl: 'https://db.example',
            modelBaseUrl: 'https://db.example/v1',
          },
        }),
      },
    });

    const resolved = await resolveIntegration302Detailed();

    expect(resolved).toMatchObject({
      apiKey: 'sk-db',
      apiBaseUrl: 'https://db.example',
      modelBaseUrl: 'https://db.example/v1',
      source: {
        apiKey: 'db',
        apiBaseUrl: 'db',
        modelBaseUrl: 'db',
      },
    });
  });
});
