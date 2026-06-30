import { CANONICAL_MAIN_SPACE_ID } from '@zleap/core';
import { normalizeAvatarRunInput, type AvatarRunAssembly } from './runAssembly.js';

export type ScheduledRunInput = {
  avatarId?: string;
  actorId: string;
  spaceId?: string;
  taskId: string;
  prompt: string;
};

export function buildScheduledRunInput(input: ScheduledRunInput): AvatarRunAssembly {
  return normalizeAvatarRunInput({
    channel: 'scheduled-task',
    avatarId: input.avatarId,
    actorId: input.actorId,
    spaceId: input.spaceId ?? CANONICAL_MAIN_SPACE_ID,
    messageId: input.taskId,
    prompt: input.prompt,
    permissionMode: 'trusted',
  });
}
