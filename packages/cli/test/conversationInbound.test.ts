import { describe, expect, it } from 'vitest';
import type { InboundMessage } from '@zleap/core';
import { messageFromInbound } from '../src/conversation/inboundMessage.js';

function inbound(input: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channel: 'web',
    conversationId: 'c1',
    kind: 'user',
    text: 'describe this',
    ...input,
  };
}

describe('messageFromInbound', () => {
  it('returns plain text when there are no image attachments', () => {
    expect(messageFromInbound(inbound())).toEqual({ role: 'user', content: 'describe this' });
  });

  it('maps current inbound image attachments to image content parts', () => {
    expect(messageFromInbound(inbound({
      attachments: [{
        id: 'img_1',
        kind: 'image',
        name: 'shot.png',
        mimeType: 'image/png',
        sizeBytes: 6,
        data: 'abc123',
      }],
    }))).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'describe this' },
        { type: 'image', mimeType: 'image/png', data: 'abc123' },
      ],
    });
  });

  it('preserves multiple current inbound image attachments in order', () => {
    expect(messageFromInbound(inbound({
      attachments: [
        {
          id: 'img_1',
          kind: 'image',
          name: 'first.png',
          mimeType: 'image/png',
          sizeBytes: 6,
          data: 'first-image',
        },
        {
          id: 'img_2',
          kind: 'image',
          name: 'second.jpeg',
          mimeType: 'image/jpeg',
          sizeBytes: 7,
          data: 'second-image',
        },
      ],
    }))).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'describe this' },
        { type: 'image', mimeType: 'image/png', data: 'first-image' },
        { type: 'image', mimeType: 'image/jpeg', data: 'second-image' },
      ],
    });
  });

  it('allows image-only messages', () => {
    expect(messageFromInbound(inbound({
      text: '',
      attachments: [{
        id: 'img_1',
        kind: 'image',
        name: 'shot.png',
        mimeType: 'image/png',
        sizeBytes: 6,
        data: 'abc123',
      }],
    }))).toEqual({
      role: 'user',
      content: [{ type: 'image', mimeType: 'image/png', data: 'abc123' }],
    });
  });
});
