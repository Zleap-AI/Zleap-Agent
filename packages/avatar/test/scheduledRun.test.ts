import { describe, expect, it } from 'vitest';
import { buildScheduledRunInput } from '../src/scheduledRun.js';

describe('buildScheduledRunInput', () => {
  it('uses the task id as the run message id', () => {
    expect(
      buildScheduledRunInput({
        actorId: 'u1',
        taskId: 'task-1',
        prompt: 'Run report',
      }),
    ).toMatchObject({
      channel: 'scheduled-task',
      actorId: 'u1',
      spaceId: 'main',
      messageId: 'task-1',
      prompt: 'Run report',
    });
  });

  it('defaults unattended scheduled runs to trusted permission mode', () => {
    expect(
      buildScheduledRunInput({
        actorId: 'task-worker',
        taskId: 'task-1',
        prompt: 'Run report',
      }).permissionMode,
    ).toBe('trusted');
  });
});
