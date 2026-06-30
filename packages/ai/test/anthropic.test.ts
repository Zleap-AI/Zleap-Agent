import { describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import type { AssistantStreamEvent, Message, Model, ProviderRequest } from '../src/types.js';

const model: Model = {
  id: 'm',
  provider: 'anthropic',
  model: 'claude-x',
  baseUrl: 'http://example.test/v1',
  apiKey: 'k',
};

/** Build a streaming Response body from Anthropic SSE data payloads. */
function sseResponse(payloads: string[]): Response {
  const text = payloads.map((p) => `event: x\ndata: ${p}\n\n`).join('');
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

async function collect(
  request: ProviderRequest,
  payloads: string[],
): Promise<{ events: AssistantStreamEvent[]; body: Record<string, unknown> }> {
  let body: Record<string, unknown> = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      body = JSON.parse(init.body) as Record<string, unknown>;
      return sseResponse(payloads);
    }),
  );
  const events: AssistantStreamEvent[] = [];
  for await (const event of new AnthropicProvider().stream(model, request)) {
    events.push(event);
  }
  vi.unstubAllGlobals();
  return { events, body };
}

const req = (messages: Message[], tools = []): ProviderRequest => ({ systemPrompt: 'sys', messages, tools });

describe('AnthropicProvider request body', () => {
  it('puts system top-level and maps tools to {name, description, input_schema}', async () => {
    const { body } = await collect(
      req([{ role: 'user', content: 'hi' }], [{ name: 't', description: 'd', parameters: { type: 'object' } }] as never),
      ['{"type":"message_stop"}'],
    );
    expect(body.system).toBe('sys');
    expect(body.stream).toBe(true);
    expect((body.tools as Array<Record<string, unknown>>)[0]).toMatchObject({ name: 't', description: 'd', input_schema: { type: 'object' } });
  });

  it('maps declared cache breakpoints to Anthropic cache_control blocks', async () => {
    const { body } = await collect(
      {
        systemPrompt: 'stable system',
        messages: [
          { role: 'user', content: 'semi-stable memory' },
          { role: 'user', content: 'current turn' },
        ],
        cacheBreakpoints: [
          { after: 'stable', messageIndex: 0 },
          { after: 'semiStable', messageIndex: 1 },
        ],
      },
      ['{"type":"message_stop"}'],
    );

    expect(body.system).toEqual([
      { type: 'text', text: 'stable system', cache_control: { type: 'ephemeral' } },
    ]);
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    expect(messages[0]?.content).toEqual([
      { type: 'text', text: 'semi-stable memory', cache_control: { type: 'ephemeral' } },
    ]);
    expect(messages[1]?.content).toBe('current turn');
  });

  it('converts a standalone toolResult into a user tool_result block', async () => {
    const { body } = await collect(
      req([
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'toolCall', id: 'tu1', name: 'read', arguments: { path: 'a' } }] },
        { role: 'toolResult', toolCallId: 'tu1', toolName: 'read', content: 'FILE BODY' },
      ]),
      ['{"type":"message_stop"}'],
    );
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    // assistant tool_use is preserved; the toolResult becomes a user tool_result.
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(JSON.stringify(assistant?.content)).toContain('tool_use');
    const last = messages[messages.length - 1];
    expect(last.role).toBe('user');
    expect(JSON.stringify(last.content)).toContain('tool_result');
    expect(JSON.stringify(last.content)).toContain('FILE BODY');
  });

  it('maps user image content to Anthropic image source blocks', async () => {
    const { body } = await collect(
      req([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'describe this' },
            { type: 'image', mimeType: 'image/jpeg', data: 'abc123' },
          ],
        },
      ]),
      ['{"type":"message_stop"}'],
    );

    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe this' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: 'abc123' },
          },
        ],
      },
    ]);
  });

  it('maps webp user image content to Anthropic image source blocks', async () => {
    const { body } = await collect(
      req([
        {
          role: 'user',
          content: [{ type: 'image', mimeType: 'image/webp', data: 'webp456' }],
        },
      ]),
      ['{"type":"message_stop"}'],
    );

    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/webp', data: 'webp456' },
          },
        ],
      },
    ]);
  });
});

describe('AnthropicProvider SSE streaming', () => {
  it('streams text deltas', async () => {
    const { events } = await collect(req([{ role: 'user', content: 'hi' }]), [
      '{"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0}}}',
      '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}',
      '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}',
      '{"type":"content_block_stop","index":0}',
      '{"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
      '{"type":"message_stop"}',
    ]);
    const text = events
      .filter((e): e is Extract<AssistantStreamEvent, { type: 'text_delta' }> => e.type === 'text_delta')
      .map((e) => e.text)
      .join('');
    expect(text).toBe('Hello');
  });

  it('parses a tool_use block into start + end with accumulated input', async () => {
    const { events } = await collect(req([{ role: 'user', content: 'hi' }]), [
      '{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu1","name":"read","input":{}}}',
      '{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}',
      '{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"a.ts\\"}"}}',
      '{"type":"content_block_stop","index":0}',
      '{"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
      '{"type":"message_stop"}',
    ]);
    const start = events.find((e): e is Extract<AssistantStreamEvent, { type: 'toolcall_start' }> => e.type === 'toolcall_start');
    const end = events.find((e): e is Extract<AssistantStreamEvent, { type: 'toolcall_end' }> => e.type === 'toolcall_end');
    expect(start?.name).toBe('read');
    expect(end?.arguments).toEqual({ path: 'a.ts' });
    const done = events.find((e) => e.type === 'done');
    expect(done && 'finishReason' in done ? done.finishReason : undefined).toBe('tool_use');
  });
});
