import type { Message, MessageContent } from '@zleap/ai';
import type { InboundImageAttachment, InboundMessage } from '@zleap/core';

export function messageFromInbound(inbound: InboundMessage): Message {
  const attachments = inbound.attachments ?? [];
  if (attachments.length === 0) {
    return { role: 'user', content: inbound.text };
  }

  const content: MessageContent[] = [];
  const text = inbound.text.trim();
  if (text) {
    content.push({ type: 'text', text });
  }
  for (const attachment of attachments) {
    content.push(imageContentFromInboundAttachment(attachment));
  }
  return { role: 'user', content };
}

function imageContentFromInboundAttachment(attachment: InboundImageAttachment): MessageContent {
  return {
    type: 'image',
    mimeType: attachment.mimeType,
    data: attachment.data,
  };
}
