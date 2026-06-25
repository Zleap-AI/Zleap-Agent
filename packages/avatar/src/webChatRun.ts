import { CANONICAL_MAIN_SPACE_ID } from '@zleap/core';
import { normalizeAvatarRunInput, type AvatarRunAssembly } from './runAssembly.js';

export type WebChatRunInput = {
  avatarId?: string;
  actorId: string;
  spaceId?: string;
  conversationId?: string;
  messageId?: string;
  prompt: string;
};

export function buildWebChatRunInput(input: WebChatRunInput): AvatarRunAssembly {
  return normalizeAvatarRunInput({
    channel: 'web',
    avatarId: input.avatarId,
    actorId: input.actorId,
    spaceId: input.spaceId ?? CANONICAL_MAIN_SPACE_ID,
    conversationId: input.conversationId,
    messageId: input.messageId,
    prompt: input.prompt,
  });
}
