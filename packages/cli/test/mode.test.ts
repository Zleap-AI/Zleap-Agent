import { describe, expect, it } from 'vitest';
import { parseChatArgs, resolveCustomModel } from '../src/chat/mode.js';
import type { CliContext } from '../src/cli/context.js';

describe('parseChatArgs', () => {
  it('parses boolean and value flags', () => {
    const options = parseChatArgs(['--fresh', '--model-config-id', 'abc-123', '--model', 'gpt-4', 'hello']);
    expect(options.fresh).toBe(true);
    expect(options.modelConfigId).toBe('abc-123');
    expect(options.model).toBe('gpt-4');
    expect(options.prompt).toBe('hello');
  });

  it('treats --resume and --continue as aliases', () => {
    expect(parseChatArgs(['--resume']).resume).toBe(true);
    expect(parseChatArgs(['--continue']).resume).toBe(true);
  });

  it('starts a fresh session by default', () => {
    expect(parseChatArgs([]).resume).toBe(false);
    expect(parseChatArgs(['--fresh']).resume).toBe(false);
  });
});

describe('resolveCustomModel', () => {
  const ctx: CliContext = {
    config: {},
    persistence: {},
    modelSource: 'config',
    dbReachable: false,
    model: {
      baseUrl: 'https://api.example/v1',
      apiKey: 'sk-test',
      model: 'base-model',
      id: 'base-model',
      displayName: 'Base',
    },
  };

  it('overrides model name on top of resolved context', () => {
    const resolved = resolveCustomModel({ ...parseChatArgs(['--model', 'override-model']), systemPrompt: '', resume: false, fresh: false, yes: false }, ctx);
    expect(resolved?.model).toBe('override-model');
    expect(resolved?.baseUrl).toBe('https://api.example/v1');
    expect(resolved?.apiKey).toBe('sk-test');
  });

  it('uses full flag credentials when all three are provided', () => {
    const resolved = resolveCustomModel(
      {
        systemPrompt: '',
        resume: false,
        fresh: false,
        yes: false,
        baseUrl: 'https://other/v1',
        apiKey: 'sk-other',
        model: 'other-model',
      },
      ctx,
    );
    expect(resolved?.baseUrl).toBe('https://other/v1');
    expect(resolved?.model).toBe('other-model');
  });
});
