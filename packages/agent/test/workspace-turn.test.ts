import { describe, expect, it } from 'vitest';
import {
  expectedWorkspaceToolCall,
  isWorkspaceTurnTruncated,
  runWorkspaceTurn,
  workspaceTurnHitToolLimit,
  type WorkspaceTurnRuntime,
} from '../src/workspace-turn/index.js';

describe('workspace turn policy', () => {
  it('returns a completed model turn unchanged', async () => {
    const runtime: WorkspaceTurnRuntime = {
      runModelTurn: async () => ({
        assistantText: 'done',
        toolCallCount: 0,
        stopReason: 'completed',
      }),
    };

    await expect(runWorkspaceTurn(runtime, {
      prompt: 'finish',
      actorId: 'u1',
      spaceId: 'cli',
      maxToolCalls: 3,
    })).resolves.toEqual({
      assistantText: 'done',
      toolCallCount: 0,
      stopReason: 'completed',
    });
  });

  it('marks the turn as max-tool-calls when the runtime reaches the limit', async () => {
    const runtime: WorkspaceTurnRuntime = {
      runModelTurn: async () => ({
        assistantText: 'still working',
        toolCallCount: 3,
        stopReason: 'model-stopped',
      }),
    };

    await expect(runWorkspaceTurn(runtime, {
      prompt: 'finish',
      actorId: 'u1',
      spaceId: 'cli',
      maxToolCalls: 3,
    })).resolves.toMatchObject({
      toolCallCount: 3,
      stopReason: 'max-tool-calls',
    });
  });

  it('classifies provider stop reasons used by CLI turnLoop', () => {
    expect(isWorkspaceTurnTruncated('length')).toBe(true);
    expect(isWorkspaceTurnTruncated('max_tokens')).toBe(true);
    expect(isWorkspaceTurnTruncated('stop')).toBe(false);

    expect(expectedWorkspaceToolCall('tool_calls')).toBe(true);
    expect(expectedWorkspaceToolCall('tool_use')).toBe(true);
    expect(expectedWorkspaceToolCall('stop')).toBe(false);
    expect(workspaceTurnHitToolLimit(4, 4)).toBe(true);
    expect(workspaceTurnHitToolLimit(3, 4)).toBe(false);
  });
});
