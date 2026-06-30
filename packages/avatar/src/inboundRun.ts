import { CANONICAL_MAIN_SPACE_ID } from '@zleap/core';
import { normalizeAvatarRunInput, type AvatarRunAssembly } from './runAssembly.js';

export type InboundRunInput = {
  avatarId?: string;
  actorId: string;
  spaceId?: string;
  eventId: string;
  prompt: string;
};

export function buildInboundRunInput(input: InboundRunInput): AvatarRunAssembly {
  return normalizeAvatarRunInput({
    channel: 'gateway',
    avatarId: input.avatarId,
    actorId: input.actorId,
    spaceId: input.spaceId ?? CANONICAL_MAIN_SPACE_ID,
    messageId: input.eventId,
    prompt: input.prompt,
  });
}
