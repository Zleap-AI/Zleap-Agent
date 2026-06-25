import type { ChatImageRequestAttachment } from './chatAttachments';

export const RUN_MODES = ['normal', 'plan', 'goal'] as const;

export type RunMode = (typeof RUN_MODES)[number];

export type ChatSendOptions = {
  targetSpace?: string;
  runMode?: RunMode;
  skillId?: string;
  skillLabel?: string;
  attachments?: ChatImageRequestAttachment[];
};

export function normalizeRunMode(value: unknown): RunMode {
  return RUN_MODES.includes(value as RunMode) ? (value as RunMode) : 'normal';
}
