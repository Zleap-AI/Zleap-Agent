import { describe, expect, it, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import { OpenAiCompatibleProvider } from '../src/providers/openai-compatible.js';
import type { AssistantStreamEvent, Model, ProviderOptions, ProviderRequest, ToolSchema } from '../src/types.js';

const model: Model = {
  id: 'm',
  provider: 'openai-compatible',
  model: 'm',
  baseUrl: 'http://example.test/v1',
  apiKey: 'k',
};

/** Build a streaming Response body from SSE data payloads. */
function sseResponse(payloads: string[]): Response {
  const text = payloads.map((p) => `data: ${p}\n\n`).join('');
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
  options?: ProviderOptions,
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
  for await (const event of new OpenAiCompatibleProvider().stream(model, request, options)) {
    events.push(event);
  }
  vi.unstubAllGlobals();
  return { events, body };
}

const baseReq = (tools: ToolSchema[] = []): ProviderRequest => ({
  systemPrompt: 's',
  messages: [{ role: 'user', content: 'x' }],
  tools,
});

describe('OpenAiCompatibleProvider request body', () => {
  it('decodes compressed error bodies into JSON-safe text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(gzipSync('{"error":"bad request"}'), { status: 400 })),
    );
    const events: AssistantStreamEvent[] = [];
    for await (const event of new OpenAiCompatibleProvider().stream(model, baseReq([]))) {
      events.push(event);
    }
    vi.unstubAllGlobals();

    expect(events).toEqual([
      { type: 'error', error: { code: 'http_400', message: expect.stringContaining('bad request') } },
    ]);
    expect(JSON.stringify(events)).not.toContain('\\u0000');
  });

  it('omits `tools` when empty and streams', async () => {
    const { body } = await collect(baseReq([]), ['[DONE]']);
    expect('tools' in body).toBe(false);
    expect(body.stream).toBe(true);
  });

  it('includes `tools` when present', async () => {
    const { body } = await collect(baseReq([{ name: 't', description: 'd', parameters: { type: 'object' } }]), ['[DONE]']);
    expect((body.tools as unknown[]).length).toBe(1);
  });

  it('uses a 32000 max_tokens default when no output cap is configured', async () => {
    const { body } = await collect(baseReq([]), ['[DONE]']);
    expect(body.max_tokens).toBe(32_000);
  });

  it('keeps explicit maxOutputTokens overrides', async () => {
    const { body } = await collect(baseReq([]), ['[DONE]'], { maxOutputTokens: 12_345 });
    expect(body.max_tokens).toBe(12_345);
  });

  it('does not leak provider cache breakpoint metadata into OpenAI-compatible bodies', async () => {
    const { body } = await collect(
      {
        ...baseReq([]),
        cacheBreakpoints: [
          { after: 'stable', messageIndex: 0 },
          { after: 'semiStable', messageIndex: 1 },
        ],
      },
      ['[DONE]'],
    );
    expect('cacheBreakpoints' in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain('semiStable');
  });

  it('preserves assistant tool_calls before tool results', async () => {
    const { body } = await collect(
      {
        systemPrompt: 's',
        messages: [
          { role: 'user', content: 'read it' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'I will read it.' },
              { type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: 'README.md' } },
            ],
          },
          { role: 'toolResult', toolCallId: 'call_1', toolName: 'read', content: 'README body' },
        ],
        tools: [{ name: 'read', description: 'Read file', parameters: { type: 'object' } }],
      },
      ['[DONE]'],
    );

    expect(body.messages).toEqual([
      { role: 'system', content: 's' },
      { role: 'user', content: 'read it' },
      {
        role: 'assistant',
        content: 'I will read it.',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'read', arguments: '{"path":"README.md"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'README body' },
    ]);
  });

  it('normalizes replayed string tool-call arguments to JSON object strings', async () => {
    const { body } = await collect(
      {
        systemPrompt: 's',
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'toolCall', id: 'call_bad', name: 'read', arguments: 'historical preview, not JSON' },
              { type: 'toolCall', id: 'call_ok', name: 'write', arguments: '{"path":"notes.md"}' },
            ],
          },
        ],
        tools: [{ name: 'read', description: 'Read file', parameters: { type: 'object' } }],
      },
      ['[DONE]'],
    );

    expect(body.messages).toEqual([
      { role: 'system', content: 's' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_bad',
            type: 'function',
            function: { name: 'read', arguments: '{}' },
          },
          {
            id: 'call_ok',
            type: 'function',
            function: { name: 'write', arguments: '{"path":"notes.md"}' },
          },
        ],
      },
    ]);
  });

  it('maps user image content to OpenAI-compatible image_url blocks', async () => {
    const { body } = await collect(
      {
        systemPrompt: 's',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'describe this' },
              { type: 'image', mimeType: 'image/png', data: 'abc123' },
            ],
          },
        ],
      },
      ['[DONE]'],
    );

    expect(body.messages).toEqual([
      { role: 'system', content: 's' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe this' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
        ],
      },
    ]);
  });

  it('maps webp user image content to OpenAI-compatible image_url blocks', async () => {
    const { body } = await collect(
      {
        systemPrompt: 's',
        messages: [
          {
            role: 'user',
            content: [{ type: 'image', mimeType: 'image/webp', data: 'webp456' }],
          },
        ],
      },
      ['[DONE]'],
    );

    expect(body.messages).toEqual([
      { role: 'system', content: 's' },
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'data:image/webp;base64,webp456' } }],
      },
    ]);
  });
});

describe('OpenAiCompatibleProvider SSE streaming', () => {
  it('emits token-by-token text deltas', async () => {
    const { events } = await collect(baseReq(), [
      '{"choices":[{"delta":{"content":"Hel"}}]}',
      '{"choices":[{"delta":{"content":"lo"}}]}',
      '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}',
      '[DONE]',
    ]);
    const text = events
      .filter((e): e is Extract<AssistantStreamEvent, { type: 'text_delta' }> => e.type === 'text_delta')
      .map((e) => e.text)
      .join('');
    expect(text).toBe('Hello');
    const done = events.find((e) => e.type === 'done');
    expect(done && 'usage' in done ? done.usage?.totalTokens : undefined).toBe(4);
  });

  it('accumulates streamed tool-call fragments into one call', async () => {
    const { events } = await collect(baseReq(), [
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"get_time","arguments":""}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}',
      '[DONE]',
    ]);
    const end = events.find((e): e is Extract<AssistantStreamEvent, { type: 'toolcall_end' }> => e.type === 'toolcall_end');
    expect(end?.name).toBe('get_time');
    expect(end?.arguments).toEqual({});
  });

  it('maps reasoning_content to thinking events', async () => {
    const { events } = await collect(baseReq(), [
      '{"choices":[{"delta":{"reasoning_content":"hmm"}}]}',
      '{"choices":[{"delta":{"content":"ok"}}]}',
      '[DONE]',
    ]);
    expect(events.some((e) => e.type === 'thinking_delta')).toBe(true);
    expect(events.some((e) => e.type === 'text_delta')).toBe(true);
  });

  // Regression: an endpoint that OMITS `index` used to collapse parallel calls
  // to slot 0 and concatenate their names into garbage ("lsfind").
  it('keeps parallel tool calls separate when the endpoint omits `index`', async () => {
    const { events } = await collect(baseReq(), [
      '{"choices":[{"delta":{"tool_calls":[{"id":"a","function":{"name":"ls","arguments":"{}"}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"id":"b","function":{"name":"find","arguments":"{}"}}]}}]}',
      '[DONE]',
    ]);
    const names = events
      .filter((e): e is Extract<AssistantStreamEvent, { type: 'toolcall_end' }> => e.type === 'toolcall_end')
      .map((e) => e.name);
    expect(names).toEqual(['ls', 'find']);
  });

  it('separates parallel tool calls addressed by `index`', async () => {
    const { events } = await collect(baseReq(), [
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"read","arguments":""}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":1,"id":"b","function":{"name":"find","arguments":"{}"}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"p\\":1}"}}]}}]}',
      '[DONE]',
    ]);
    const ends = events.filter((e): e is Extract<AssistantStreamEvent, { type: 'toolcall_end' }> => e.type === 'toolcall_end');
    expect(ends.map((e) => e.name)).toEqual(['read', 'find']);
    expect(ends[0]?.arguments).toEqual({ p: 1 });
  });

  it('surfaces finish_reason on the done event', async () => {
    const { events } = await collect(baseReq(), [
      '{"choices":[{"delta":{"content":"hi"},"finish_reason":"length"}]}',
      '[DONE]',
    ]);
    const done = events.find((e) => e.type === 'done');
    expect(done && 'finishReason' in done ? done.finishReason : undefined).toBe('length');
  });
});
