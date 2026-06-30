'use client';

import type { ArtifactView, DisplayMessage } from './types';
import { normalizeAssistantDisplayText } from './messageText';
import { dedupeArtifactViews } from './workspaceArtifacts';

export function normalizeDisplayMessages(messages: DisplayMessage[]): DisplayMessage[] {
  let normalized: DisplayMessage[] = [];
  for (const message of messages) {
    normalized = appendNormalizedDisplayMessage(normalized, message);
  }
  return normalized;
}

export function appendNormalizedDisplayMessage(messages: DisplayMessage[], message: DisplayMessage): DisplayMessage[] {
  const normalizedMessage = message.role === 'assistant'
    ? { ...message, text: normalizeAssistantDisplayText(message.text) }
    : message;
  const previousIndex = findPreviousAssistantIndexInCurrentTurn(messages);
  const previous = previousIndex >= 0 ? messages[previousIndex] : undefined;
  if (
    normalizedMessage.role === 'assistant' &&
    previous?.role === 'assistant' &&
    normalizeAssistantText(previous.text) === normalizeAssistantText(normalizedMessage.text)
  ) {
    const next = [...messages];
    next[previousIndex] = {
      ...previous,
      text: normalizedMessage.text ?? previous.text,
      ts: normalizedMessage.ts ?? previous.ts,
      artifacts: dedupeArtifacts([...(previous.artifacts ?? []), ...(normalizedMessage.artifacts ?? [])]),
    };
    return next;
  }
  return [...messages, normalizedMessage];
}

function findPreviousAssistantIndexInCurrentTurn(messages: DisplayMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const role = messages[index]?.role;
    if (role === 'user' || role === 'system') return -1;
    if (role === 'assistant') return index;
  }
  return -1;
}

function normalizeAssistantText(text: string | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function dedupeArtifacts(artifacts: ArtifactView[]): ArtifactView[] | undefined {
  if (!artifacts.length) return undefined;
  const result = dedupeArtifactViews(artifacts);
  return result.length ? result : undefined;
}
