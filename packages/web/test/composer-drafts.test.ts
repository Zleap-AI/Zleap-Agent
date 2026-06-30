import { describe, expect, it } from 'vitest';
import {
  clearAllComposerDrafts,
  clearComposerDraft,
  composerDraftIdForConversation,
  initialComposerDraftsForHydration,
  readComposerDraft,
  TRANSIENT_NEW_CHAT_DRAFT_ID,
  writeComposerDraft,
} from '../lib/composerDrafts';

describe('composer drafts', () => {
  it('stores and reads drafts per conversation', () => {
    const storage = memoryStorage();

    writeComposerDraft('conv-a', 'hello', storage);
    writeComposerDraft('conv-b', 'world', storage);

    expect(readComposerDraft('conv-a', storage)).toBe('hello');
    expect(readComposerDraft('conv-b', storage)).toBe('world');
  });

  it('uses one stable draft id for unstarted new chats', () => {
    const storage = memoryStorage();
    const firstNewChatDraftId = composerDraftIdForConversation('temp-a', false);
    const nextNewChatDraftId = composerDraftIdForConversation('temp-b', false);

    expect(firstNewChatDraftId).toBe(TRANSIENT_NEW_CHAT_DRAFT_ID);
    expect(nextNewChatDraftId).toBe(TRANSIENT_NEW_CHAT_DRAFT_ID);
    expect(composerDraftIdForConversation('conv-a', true)).toBe('conv-a');

    writeComposerDraft(firstNewChatDraftId, 'unfinished prompt', storage);

    expect(readComposerDraft(nextNewChatDraftId, storage)).toBe('unfinished prompt');
  });

  it('starts hydration with no drafts so server and client first render match', () => {
    const storage = memoryStorage();
    writeComposerDraft(TRANSIENT_NEW_CHAT_DRAFT_ID, 'unfinished prompt', storage);

    expect(initialComposerDraftsForHydration()).toEqual({});
  });

  it('removes an empty or cleared draft', () => {
    const storage = memoryStorage();
    writeComposerDraft('conv-a', 'hello', storage);

    writeComposerDraft('conv-a', '', storage);
    expect(readComposerDraft('conv-a', storage)).toBe('');

    writeComposerDraft('conv-a', 'hello again', storage);
    clearComposerDraft('conv-a', storage);
    expect(readComposerDraft('conv-a', storage)).toBe('');
  });

  it('clears all composer drafts without touching unrelated keys', () => {
    const storage = memoryStorage();
    writeComposerDraft('conv-a', 'hello', storage);
    writeComposerDraft('conv-b', 'world', storage);
    storage.setItem('other-key', 'keep');

    clearAllComposerDrafts(storage);

    expect(readComposerDraft('conv-a', storage)).toBe('');
    expect(readComposerDraft('conv-b', storage)).toBe('');
    expect(storage.getItem('other-key')).toBe('keep');
  });
});

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}
