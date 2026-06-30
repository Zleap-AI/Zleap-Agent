import { DEFAULT_AVATAR_ID } from '@zleap/core';

export type AvatarRunChannel = 'web' | 'scheduled-task' | 'gateway';

export type AvatarRunPermissionMode = 'default' | 'read-only' | 'trusted';

export type AvatarRunInput = {
  channel: AvatarRunChannel;
  avatarId?: string;
  actorId: string;
  spaceId: string;
  conversationId?: string;
  messageId?: string;
  prompt: string;
  permissionMode?: AvatarRunPermissionMode;
};

export type AvatarRunAssembly = {
  channel: AvatarRunChannel;
  avatarId: string;
  actorId: string;
  spaceId: string;
  conversationId?: string;
  messageId?: string;
  prompt: string;
  permissionMode: AvatarRunPermissionMode;
};

export class AvatarRunInputError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'AvatarRunInputError';
  }
}

export function normalizeAvatarRunInput(input: AvatarRunInput): AvatarRunAssembly {
  return {
    channel: input.channel,
    avatarId: cleanOptionalString(input.avatarId) ?? DEFAULT_AVATAR_ID,
    actorId: cleanRequiredString('actor_id_required', input.actorId),
    spaceId: cleanRequiredString('space_id_required', input.spaceId),
    ...optionalStringField('conversationId', input.conversationId),
    ...optionalStringField('messageId', input.messageId),
    prompt: cleanRequiredString('prompt_required', input.prompt),
    permissionMode: input.permissionMode ?? 'default',
  };
}

function optionalStringField<K extends 'conversationId' | 'messageId'>(key: K, value: string | undefined): Pick<AvatarRunAssembly, K> | {} {
  const cleaned = cleanOptionalString(value);
  return cleaned ? { [key]: cleaned } : {};
}

function cleanOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function cleanRequiredString(code: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new AvatarRunInputError(code);
  }
  return trimmed;
}
