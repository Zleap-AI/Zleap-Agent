import { describe, expect, it } from 'vitest';

describe('@zleap/agent import smoke', () => {
  it('keeps engine exports free of host bootstrap symbols', async () => {
    const engine = await import('@zleap/agent/engine');

    expect(engine.ChatEngine).toBeTypeOf('function');
    expect('ensurePostgres' in engine).toBe(false);
    expect('runServe' in engine).toBe(false);
    expect('resolveRuntime' in engine).toBe(false);
  });
});
