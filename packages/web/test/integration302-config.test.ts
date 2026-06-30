import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSharedStore } from '../lib/server/sharedStore';
import { read302IntegrationConfig, resolve302ApiKey, resolve302ModelBaseUrl } from '../lib/server/integration302Config';

vi.mock('../lib/server/sharedStore', () => ({
  getSharedStore: vi.fn(),
}));

const getSharedStoreMock = vi.mocked(getSharedStore);

beforeEach(() => {
  getSharedStoreMock.mockReset();
  vi.stubEnv('ZLEAP_302_CONFIG_PATH', '/tmp/zleap-missing-302-config.json');
  vi.stubEnv('ZLEAP_302_API_KEY', '');
  vi.stubEnv('302_API_KEY', '');
  vi.stubEnv('ZLEAP_302_API_BASE_URL', '');
  vi.stubEnv('ZLEAP_302_MODEL_BASE_URL', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('302 integration config', () => {
  it('uses a stored 302 model key when the integration row is missing', async () => {
    getSharedStoreMock.mockResolvedValue({
      integrations: {
        getIntegration: async () => undefined,
      },
      models: {
        listModelConfigs: async () => [
          {
            config: {
              providerKey: '302ai',
              apiKey: 'sk-model-302',
              baseUrl: 'https://model.example/v1',
            },
          },
        ],
      },
    } as never);

    const config = await read302IntegrationConfig();

    expect(resolve302ApiKey(config)).toBe('sk-model-302');
    expect(resolve302ModelBaseUrl(config)).toBe('https://model.example/v1');
  });
});
