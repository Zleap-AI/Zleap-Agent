import { describe, expect, it } from 'vitest';
import { epochConversationId } from '@zleap/agent/conversation';

/**
 * Mirror of RunPersistenceBridge.sanitizeId. The effective conversation id must
 * be a fixed point of this function, otherwise the session id beginReply writes
 * to (sanitized) diverges from the one loadHistory reads (unsanitized), and
 * /new would silently orphan the conversation history.
 */
function sanitizeId(value: string): string {
  return value.trim().replace(/[^\w:.-]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
}

describe('epochConversationId', () => {
  it('returns the base id unchanged at epoch 0', () => {
    expect(epochConversationId('oc_chat', 0)).toBe('oc_chat');
  });

  it('appends a sanitize-safe suffix for later epochs', () => {
    const id = epochConversationId('oc_chat', 2);
    expect(id).toBe('oc_chat.e2');
    // The key invariant: persistence sanitize must not rewrite the suffix.
    expect(sanitizeId(id)).toBe(id);
  });

  it('stays a sanitize fixed point across many epochs', () => {
    for (let epoch = 1; epoch <= 50; epoch += 1) {
      const id = epochConversationId('feishu-chat_123', epoch);
      expect(sanitizeId(id)).toBe(id);
    }
  });
});
