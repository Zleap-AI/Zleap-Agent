import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatDelta } from '../lib/engine';
import { sseEngine } from '../lib/sseEngine';

describe('sseEngine approvals', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('posts image bytes for the model and display thumbnails for history separately', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse([{ type: 'done' }]));

    const events: ChatDelta[] = [];
    for await (const event of sseEngine([
      { role: 'user', text: '' },
    ], new AbortController().signal, {
      conversationId: 'conversation-1',
      confirm: async () => true,
      attachments: [{
        id: 'img_1',
        kind: 'image',
        name: 'shot.png',
        mimeType: 'image/png',
        sizeBytes: 5,
        thumbnailDataUrl: 'data:image/png;base64,thumb',
        previewDataUrl: 'data:image/png;base64,preview',
        dataUrl: 'data:image/png;base64,aGVsbG8=',
      }],
    })) {
      events.push(event);
    }

    expect(events).toEqual([{ type: 'done' }]);
    const chatCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/api/chat'));
    const chatBody = JSON.parse(String(chatCall?.[1]?.body));
    expect(chatBody.attachments).toEqual([{
      id: 'img_1',
      kind: 'image',
      name: 'shot.png',
      mimeType: 'image/png',
      sizeBytes: 5,
      dataUrl: 'data:image/png;base64,aGVsbG8=',
    }]);
    expect(chatBody.displayAttachments).toEqual([{
      id: 'img_1',
      kind: 'image',
      name: 'shot.png',
      mimeType: 'image/png',
      sizeBytes: 5,
      thumbnailDataUrl: 'data:image/png;base64,thumb',
      previewDataUrl: 'data:image/png;base64,preview',
    }]);
    expect(JSON.stringify(chatBody.attachments)).not.toContain('thumbnailDataUrl');
    expect(JSON.stringify(chatBody.attachments)).not.toContain('previewDataUrl');
    expect(JSON.stringify(chatBody.displayAttachments)).not.toContain('dataUrl');
    expect(chatBody.history).toEqual([{ role: 'user', text: '' }]);
  });

  it('asks for live approval and posts the decision without ending the stream', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/chat/approval')) {
        return new Response('{}', { status: 200 });
      }
      return sseResponse([
        {
          type: 'needs_approval',
          approvalId: 'approval_1',
          name: 'write',
          args: '{"path":"report.md"}',
          preview: 'Write report.md (12 lines)',
          message: 'Tool "write" requires approval before execution. No action was taken.',
        },
        { type: 'tool', name: 'write', phase: 'start', detail: '{"path":"report.md"}' },
        { type: 'tool', name: 'write', phase: 'end', detail: 'Wrote report.md', isError: false },
        { type: 'done' },
      ]);
    });

    const approvals: Array<{ approvalId: string; name: string; preview?: string }> = [];
    const events: ChatDelta[] = [];
    for await (const event of sseEngine([
      { role: 'user', text: 'earlier turn' },
      { role: 'assistant', text: 'earlier reply' },
      { role: 'user', text: 'write report' },
    ], new AbortController().signal, {
      conversationId: 'conversation-1',
      permissionMode: 'request_approval',
      runMode: 'goal',
      skillId: 'research',
      skillLabel: '研究',
      confirm: async (request) => {
        approvals.push(request);
        return true;
      },
    })) {
      events.push(event);
    }

    expect(approvals).toEqual([
      expect.objectContaining({ approvalId: 'approval_1', name: 'write', preview: 'Write report.md (12 lines)' }),
    ]);
    expect(events.map((event) => event.type)).toEqual(['tool', 'tool', 'done']);
    const chatCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/api/chat'));
    const chatBody = JSON.parse(String(chatCall?.[1]?.body));
    expect(chatBody).toMatchObject({
      conversationId: 'conversation-1',
      permissionMode: 'request_approval',
      runMode: 'goal',
      skillId: 'research',
      skillLabel: '研究',
    });
    // History is server-owned: the client sends only this turn's new user message.
    expect(chatBody.history).toEqual([{ role: 'user', text: 'write report' }]);
    const approvalCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/api/chat/approval'));
    expect(JSON.parse(String(approvalCall?.[1]?.body))).toMatchObject({
      conversationId: 'conversation-1',
      approvalId: 'approval_1',
      toolName: 'write',
      approved: true,
      preview: 'Write report.md (12 lines)',
    });
  });
});

function sseResponse(events: ChatDelta[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}
