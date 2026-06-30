import { describe, expect, it } from 'vitest';
import { isConfiguredLlmModel } from '../lib/models';

describe('model helpers', () => {
  it('does not treat preset models without API keys as configured', () => {
    expect(
      isConfiguredLlmModel({
        model: 'qwen3.6-flash',
        purpose: 'main',
        config: { baseUrl: 'https://api.302.ai/v1', isDefault: true },
      }),
    ).toBe(false);
  });

  it('treats redacted LLM configs with an API key as configured', () => {
    expect(
      isConfiguredLlmModel({
        model: 'gpt-4o-mini',
        purpose: 'main',
        config: { baseUrl: 'https://api.openai.com/v1', hasApiKey: true },
      }),
    ).toBe(true);
  });

  it('ignores embedding models when checking onboarding completion', () => {
    expect(
      isConfiguredLlmModel({
        model: 'text-embedding-3-small',
        purpose: 'embedding',
        config: { hasApiKey: true },
      }),
    ).toBe(false);
  });
});
