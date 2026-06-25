import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelConfigRecord } from '@zleap/core';
import { toEngineModelResolved } from '../src/conversation/model.js';
import { DEFAULT_302_MODEL_BASE_URL, setIntegration302Store } from '../src/integration302.js';

const model302: ModelConfigRecord = {
  id: '302-qwen3-6-flash',
  providerId: '302',
  model: 'qwen3.6-flash',
  purpose: 'main',
  config: { providerKey: '302ai', displayName: 'qwen3.6-flash' },
};

beforeEach(() => {
  vi.stubEnv('ZLEAP_MODEL_BASE_URL', '');
  vi.stubEnv('LLM_BASE_URL', '');
  vi.stubEnv('ZLEAP_MODEL_API_KEY', '');
  vi.stubEnv('LLM_API_KEY', '');
});

afterEach(() => {
  setIntegration302Store(undefined);
  vi.unstubAllEnvs();
});

describe('model resolution', () => {
  it('uses the persisted 302 integration key for 302 model configs', async () => {
    setIntegration302Store({
      integrations: {
        getIntegration: async () => ({ config: { apiKey: 'sk-db-302' } }),
      },
    });

    const model = await toEngineModelResolved(model302);

    expect(model).toMatchObject({
      id: '302-qwen3-6-flash',
      model: 'qwen3.6-flash',
      baseUrl: DEFAULT_302_MODEL_BASE_URL,
      apiKey: 'sk-db-302',
    });
  });

  it('keeps non-302 configs without credentials unrunnable', async () => {
    const model = await toEngineModelResolved({
      id: 'plain-model',
      providerId: 'openai-compatible',
      model: 'plain',
      purpose: 'main',
      config: {},
    });

    expect(model).toBeUndefined();
  });
});
