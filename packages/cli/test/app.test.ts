import { describe, expect, it } from 'vitest';
import { formatStatus, resolveNumberedSelection } from '../src/app.js';
import type { EngineStatus } from '../src/engine.js';
import type { CliContext } from '../src/cli/context.js';

function ctx(overrides: Partial<CliContext> = {}): CliContext {
  return {
    config: {},
    persistence: {},
    modelSource: 'config',
    dbReachable: false,
    ...overrides,
  };
}

function status(overrides: Partial<EngineStatus['persistence']> = {}): EngineStatus {
  return {
    model: { id: 'test-model', label: 'Test Model', custom: true },
    persistence: {
      enabled: true,
      reachable: true,
      writeFailureCount: 0,
      ...overrides,
    },
    context: {
      extractedCount: 0,
      itemHistoryActive: false,
      triggerMessages: 30,
      triggerTokens: 10000,
      refreshThreshold: 0.8,
    },
  };
}

describe('CLI status formatting', () => {
  it('keeps persistence write health quiet when there are no failures', () => {
    const output = formatStatus(status(), 3, ctx());

    expect(output).toContain('记忆       开');
    expect(output).not.toContain('写入失败');
  });

  it('surfaces persistence write failures with a recovery hint', () => {
    const output = formatStatus(
      status({
        writeFailureCount: 2,
        lastWriteFailure: {
          phase: 'runtime_save_session',
          operation: 'saveSession',
          code: 'ESINK',
          message: 'session mirror failed',
          occurredAt: new Date('2026-06-13T01:02:03.000Z'),
        },
      }),
      3,
      ctx({ persistence: { databaseUrl: 'postgres://x' }, dbReachable: true }),
    );

    expect(output).toContain('写入失败   2 次');
    expect(output).toContain('runtime_save_session/saveSession');
    expect(output).toContain('/doctor');
  });
});

describe('picker submit selection', () => {
  it('uses the highlighted item when Enter submits an empty input', () => {
    expect(resolveNumberedSelection('', 2, 1)).toBe(3);
    expect(resolveNumberedSelection('   ', 2, 0)).toBe(2);
  });

  it('uses typed numbers when provided', () => {
    expect(resolveNumberedSelection('1', 2, 1)).toBe(1);
  });
});
