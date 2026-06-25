import { describe, expect, it } from 'vitest';
import {
  ModelRegistry,
  prepareProviderMessages,
  prepareProviderRequest,
  ProviderRegistry,
  stream,
  type AssistantStreamEvent,
  type ProviderAdapter,
  type ProviderRequest,
} from '../src/index.js';

const baseRequest = (messages: ProviderRequest['messages']): ProviderRequest => ({
  systemPrompt: 'sys',
  messages,
});

class ScriptedProvider implements ProviderAdapter {
  id = 'test-scripted';
  capabilities = {
    toolCalling: true,
    cacheBreakpoints: false,
    thinking: false,
    tokenizer: 'approx-char4',
  };

  constructor(private readonly handler: (request: ProviderRequest) => string) {}

  async *stream(_model: Parameters<ProviderAdapter['stream']>[0], request: ProviderRequest): AsyncIterable<AssistantStreamEvent> {
    const text = this.handler(request);
    if (text) {
      yield { type: 'text_start', id: 'scripted' };
      yield { type: 'text_delta', id: 'scripted', text };
      yield { type: 'text_end', id: 'scripted' };
    }
    yield { type: 'done' };
  }
}

describe('provider replay transform', () => {
  it('drops aborted/error assistant turns and orphan tool results', () => {
    const messages = prepareProviderMessages([
      { role: 'user', content: 'start' },
      { role: 'assistant', status: 'aborted', content: [{ type: 'text', text: 'partial output' }] },
      { role: 'toolResult', toolCallId: 'missing', toolName: 'read', content: 'orphan result' },
      { role: 'assistant', status: 'error', content: [{ type: 'text', text: 'failed output' }] },
      { role: 'user', content: 'continue' },
    ]);

    expect(messages).toEqual([
      { role: 'user', content: 'start' },
      { role: 'user', content: 'continue' },
    ]);
  });

  it('synthesizes error tool results when replay continues past an unresolved tool call', () => {
    const messages = prepareProviderMessages([
      { role: 'user', content: 'inspect' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will inspect.' },
          { type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: 'a.ts' } },
        ],
      },
      { role: 'user', content: 'next question' },
    ]);

    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'toolResult', 'user']);
    expect(messages[2]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'call_1',
      toolName: 'read',
      isError: true,
    });
    expect(messages[2]?.role === 'toolResult' ? messages[2].content : '').toContain('did not produce a result');
  });

  it('preserves paired tool results and strips provider-unsafe metadata', () => {
    const messages = prepareProviderMessages([
      { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'toolCall', id: 'bad', name: 'bad', arguments: {} }] },
      {
        id: 'assistant-1',
        role: 'assistant',
        usage: { totalTokens: 10 },
        status: 'completed',
        content: [
          { type: 'thinking', text: 'internal thought' },
          { type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: 'a.ts' } },
        ],
      },
      {
        id: 'result-1',
        role: 'toolResult',
        toolCallId: 'call_1',
        toolName: 'read',
        content: 'body',
        details: { secret: 'not provider context' },
      },
    ]);

    expect(messages).toEqual([
      { role: 'user', content: 'hello' },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: 'a.ts' } }],
      },
      {
        id: 'result-1',
        role: 'toolResult',
        toolCallId: 'call_1',
        toolName: 'read',
        content: 'body',
      },
    ]);
  });

  it('legalizes out-of-order tool results by filling earlier missing calls first', () => {
    const messages = prepareProviderMessages([
      { role: 'user', content: 'inspect' },
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'call_a', name: 'read', arguments: { path: 'a.ts' } },
          { type: 'toolCall', id: 'call_b', name: 'find', arguments: { pattern: '*.ts' } },
        ],
      },
      { role: 'toolResult', toolCallId: 'call_b', toolName: 'wrong_name', content: 'find result' },
    ]);

    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'toolResult', 'toolResult']);
    expect(messages[2]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'call_a',
      toolName: 'read',
      isError: true,
    });
    expect(messages[3]).toEqual({
      role: 'toolResult',
      toolCallId: 'call_b',
      toolName: 'find',
      content: 'find result',
    });
  });

  it('strips tool schema and replayed tool state for providers without native tool calling', () => {
    const request = prepareProviderRequest(
      {
        ...baseRequest([
          { role: 'user', content: 'inspect' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'I tried a tool.' },
              { type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: 'a.ts' } },
            ],
          },
          { role: 'toolResult', toolCallId: 'call_1', toolName: 'read', content: 'body' },
        ]),
        tools: [{ name: 'read', description: 'read', parameters: { type: 'object' } }],
        cacheBreakpoints: [{ after: 'semiStable', messageIndex: 2 }],
      },
      {
        capabilities: {
          toolCalling: false,
          cacheBreakpoints: false,
          thinking: false,
          tokenizer: 'none',
        },
      },
    );

    expect(request.tools).toBeUndefined();
    expect(request.cacheBreakpoints).toBeUndefined();
    expect(request.messages).toEqual([
      { role: 'user', content: 'inspect' },
      { role: 'assistant', content: [{ type: 'text', text: 'I tried a tool.' }] },
    ]);
  });

  it('remaps semi-stable cache breakpoints after filtering messages', () => {
    const request = prepareProviderRequest({
      ...baseRequest([
        { role: 'assistant', status: 'aborted', content: [{ type: 'text', text: 'partial' }] },
        { role: 'user', content: 'semi-stable memory' },
        { role: 'user', content: 'current turn' },
      ]),
      cacheBreakpoints: [
        { after: 'stable', messageIndex: 0 },
        { after: 'semiStable', messageIndex: 2 },
      ],
    });

    expect(request.messages).toEqual([
      { role: 'user', content: 'semi-stable memory' },
      { role: 'user', content: 'current turn' },
    ]);
    expect(request.cacheBreakpoints).toEqual([
      { after: 'stable', messageIndex: 0 },
      { after: 'semiStable', messageIndex: 1 },
    ]);
  });

  it('runs automatically at the stream facade boundary', async () => {
    const providers = new ProviderRegistry();
    let seen: ProviderRequest | undefined;
    providers.register(new ScriptedProvider((request) => {
      seen = request;
      return 'ok';
    }));
    const models = new ModelRegistry();
    models.register({ id: 'm', provider: 'test-scripted', model: 'm' });

    for await (const _event of stream(
      { providers, models },
      'm',
      baseRequest([
        { role: 'assistant', status: 'aborted', content: [{ type: 'text', text: 'partial' }] },
        { role: 'toolResult', toolCallId: 'orphan', toolName: 'read', content: 'orphan' },
        { role: 'user', content: 'hi' },
      ]),
    )) {
      // drain stream
    }

    expect(seen?.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('uses provider and model capabilities at the stream facade boundary', async () => {
    const providers = new ProviderRegistry();
    let seen: ProviderRequest | undefined;
    const provider: ProviderAdapter = {
      id: 'no-tools',
      capabilities: {
        toolCalling: false,
        cacheBreakpoints: false,
        thinking: false,
        tokenizer: 'none',
      },
      async *stream(_model, request) {
        seen = request;
        yield { type: 'done' };
      },
    };
    providers.register(provider);
    const models = new ModelRegistry();
    models.register({ id: 'm', provider: 'no-tools', model: 'm' });

    for await (const _event of stream(
      { providers, models },
      'm',
      {
        ...baseRequest([
          {
            role: 'assistant',
            content: [{ type: 'toolCall', id: 'call_1', name: 'read', arguments: {} }],
          },
          { role: 'toolResult', toolCallId: 'call_1', toolName: 'read', content: 'body' },
          { role: 'user', content: 'hi' },
        ]),
        tools: [{ name: 'read', description: 'read', parameters: {} }],
        cacheBreakpoints: [{ after: 'semiStable', messageIndex: 2 }],
      },
    )) {
      // drain stream
    }

    expect(seen?.tools).toBeUndefined();
    expect(seen?.cacheBreakpoints).toBeUndefined();
    expect(seen?.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });
});
