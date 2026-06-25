import { describe, expect, it } from 'vitest';
import { WorkspaceExecutionInputError, prepareWorkspaceExecution } from '../src/workspace-execution/index.js';

describe('prepareWorkspaceExecution', () => {
  it('normalizes workspace execution input without CLI objects', () => {
    expect(
      prepareWorkspaceExecution({
        workspaceId: ' cli ',
        actorId: ' u1 ',
        prompt: ' write a file ',
        contextText: ' previous workspace result ',
      }),
    ).toEqual({
      workspaceId: 'cli',
      actorId: 'u1',
      prompt: 'write a file',
      modelContext: ['previous workspace result'],
    });
  });

  it('omits empty context text from model context', () => {
    expect(
      prepareWorkspaceExecution({
        workspaceId: 'cli',
        actorId: 'u1',
        prompt: 'write a file',
        contextText: ' ',
      }).modelContext,
    ).toEqual([]);
  });

  it('fails with stable codes for missing required facts', () => {
    expect(() =>
      prepareWorkspaceExecution({
        workspaceId: ' ',
        actorId: 'u1',
        prompt: 'write a file',
      }),
    ).toThrow(new WorkspaceExecutionInputError('workspace_id_required'));
  });
});
