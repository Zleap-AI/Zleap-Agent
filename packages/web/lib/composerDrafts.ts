const DRAFT_PREFIX = 'zleap-composer-draft:';
export const TRANSIENT_NEW_CHAT_DRAFT_ID = '__zleap-new-chat__';

type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;
export type ComposerDraftMap = Record<string, string>;

export function initialComposerDraftsForHydration(): ComposerDraftMap {
  return {};
}

export function readComposerDraft(conversationId: string, storage: DraftStorage | undefined = browserStorage()): string {
  if (!conversationId || !storage) return '';
  try {
    return storage.getItem(draftKey(conversationId)) ?? '';
  } catch {
    return '';
  }
}

export function composerDraftIdForConversation(conversationId: string, started: boolean): string {
  return started ? conversationId : TRANSIENT_NEW_CHAT_DRAFT_ID;
}

export function writeComposerDraft(conversationId: string, text: string, storage: DraftStorage | undefined = browserStorage()): void {
  if (!conversationId || !storage) return;
  try {
    const key = draftKey(conversationId);
    if (text) {
      storage.setItem(key, text);
    } else {
      storage.removeItem(key);
    }
  } catch {
    // Drafts are best-effort; private mode / full storage should not block chat.
  }
}

export function clearComposerDraft(conversationId: string, storage: DraftStorage | undefined = browserStorage()): void {
  if (!conversationId || !storage) return;
  try {
    storage.removeItem(draftKey(conversationId));
  } catch {
    // best-effort
  }
}

export function clearAllComposerDrafts(storage: DraftStorage | undefined = browserStorage()): void {
  if (!storage) return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(DRAFT_PREFIX)) keys.push(key);
    }
    for (const key of keys) {
      storage.removeItem(key);
    }
  } catch {
    // best-effort
  }
}

function draftKey(conversationId: string): string {
  return `${DRAFT_PREFIX}${conversationId}`;
}

function browserStorage(): DraftStorage | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
