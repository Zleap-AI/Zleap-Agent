import type {
  AssistantStreamEvent,
  Message,
  Model,
  ProviderCacheBreakpoint,
  ProviderAdapter,
  ProviderOptions,
  ProviderRequest,
  Usage,
} from '../types.js';
import { sseChunks } from './sse.js';

export const ANTHROPIC_PROVIDER_ID = 'anthropic';

const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 8192;

/**
 * Native Anthropic Messages API provider. Unlike routing Claude through the
 * OpenAI-compatible shim, this speaks Anthropic's wire format directly —
 * `system` top-level, `tools: [{name, description, input_schema}]`, tool calls
 * as `tool_use` content blocks, results as `tool_result` — so Claude uses the
 * exact tool names we provide (no Bash/Read/mcp_* fallbacks) and tool-use is
 * reliable. Streams Anthropic SSE into our internal AssistantStreamEvent.
 */
export class AnthropicProvider implements ProviderAdapter {
  id = ANTHROPIC_PROVIDER_ID;
  capabilities = {
    toolCalling: true,
    cacheBreakpoints: true,
    thinking: true,
    tokenizer: 'anthropic',
  };

  async *stream(
    model: Model,
    request: ProviderRequest,
    options?: ProviderOptions,
  ): AsyncIterable<AssistantStreamEvent> {
    const apiKey = options?.apiKey ?? model.apiKey;
    const baseUrl = normalizeBaseUrl(options?.baseUrl ?? model.baseUrl) ?? DEFAULT_BASE_URL;
    if (!apiKey) {
      yield { type: 'error', error: { code: 'missing_api_key', message: 'Anthropic apiKey is required' } };
      return;
    }

    const tools =
      request.tools && request.tools.length > 0
        ? request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }))
        : undefined;

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/messages`, {
        method: 'POST',
        signal: options?.signal,
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: model.model,
          max_tokens: options?.maxOutputTokens ?? model.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
          system: toAnthropicSystem(request),
          messages: toAnthropicMessages(request.messages, request.cacheBreakpoints),
          tools,
          temperature: options?.temperature,
          stream: true,
        }),
      });
    } catch (cause) {
      yield { type: 'error', error: { code: 'provider_error', message: 'Anthropic request failed', cause } };
      return;
    }
    if (!response.ok) {
      yield { type: 'error', error: { code: `http_${response.status}`, message: await response.text() } };
      return;
    }
    if (!response.body) {
      yield { type: 'error', error: { code: 'no_response_body', message: 'Anthropic response had no body' } };
      return;
    }

    const id = `anthropic_${Date.now()}`;
    // content block index → its accumulating state (tool_use args / kind).
    const blocks = new Map<number, { kind: 'text' | 'tool_use' | 'thinking'; id?: string; name?: string; json: string }>();
    let textStarted = false;
    let thinkingStarted = false;
    let usage: Usage | undefined;
    let finishReason: string | undefined;

    try {
      for await (const data of sseChunks(response.body)) {
        let json: AnthropicEvent;
        try {
          json = JSON.parse(data) as AnthropicEvent;
        } catch {
          continue;
        }

        if (json.type === 'message_start') {
          const u = json.message?.usage;
          if (u) {
            usage = { inputTokens: u.input_tokens, outputTokens: u.output_tokens };
          }
        } else if (json.type === 'content_block_start') {
          const index = json.index ?? 0;
          const cb = json.content_block;
          if (cb?.type === 'tool_use') {
            blocks.set(index, { kind: 'tool_use', id: cb.id, name: cb.name, json: '' });
            yield { type: 'toolcall_start', id: cb.id ?? `${id}_${index}`, name: cb.name ?? '' };
          } else if (cb?.type === 'thinking') {
            blocks.set(index, { kind: 'thinking', json: '' });
            if (!thinkingStarted) {
              yield { type: 'thinking_start', id };
              thinkingStarted = true;
            }
          } else {
            blocks.set(index, { kind: 'text', json: '' });
            if (!textStarted) {
              yield { type: 'text_start', id };
              textStarted = true;
            }
          }
        } else if (json.type === 'content_block_delta') {
          const index = json.index ?? 0;
          const d = json.delta;
          if (d?.type === 'text_delta') {
            if (!textStarted) {
              yield { type: 'text_start', id };
              textStarted = true;
            }
            yield { type: 'text_delta', id, text: d.text ?? '' };
          } else if (d?.type === 'thinking_delta') {
            if (!thinkingStarted) {
              yield { type: 'thinking_start', id };
              thinkingStarted = true;
            }
            yield { type: 'thinking_delta', id, text: d.thinking ?? '' };
          } else if (d?.type === 'input_json_delta') {
            const block = blocks.get(index);
            if (block) {
              const chunk = d.partial_json ?? '';
              block.json += chunk;
              if (block.kind === 'tool_use' && chunk) {
                yield { type: 'toolcall_delta', id: block.id ?? `${id}_${index}`, argumentsText: chunk };
              }
            }
          }
        } else if (json.type === 'content_block_stop') {
          const index = json.index ?? 0;
          const block = blocks.get(index);
          if (block?.kind === 'tool_use') {
            const parsedArguments = safeJson(block.json || '{}');
            yield {
              type: 'toolcall_end',
              id: block.id ?? `${id}_${index}`,
              name: block.name ?? '',
              arguments: parsedArguments.value,
              rawArguments: block.json || '{}',
              argumentsParseError: parsedArguments.error,
            };
          }
        } else if (json.type === 'message_delta') {
          if (json.delta?.stop_reason) {
            finishReason = json.delta.stop_reason;
          }
          if (json.usage?.output_tokens != null) {
            usage = { ...usage, outputTokens: json.usage.output_tokens };
          }
        } else if (json.type === 'error') {
          yield {
            type: 'error',
            error: { code: json.error?.type ?? 'anthropic_error', message: json.error?.message ?? 'Anthropic stream error' },
          };
          return;
        }
      }

      if (thinkingStarted) {
        yield { type: 'thinking_end', id };
      }
      if (textStarted) {
        yield { type: 'text_end', id };
      }
      yield { type: 'done', usage, finishReason };
    } catch (cause) {
      yield { type: 'error', error: { code: 'provider_error', message: 'Anthropic stream failed', cause } };
    }
  }
}

type AnthropicBlock = { type?: string; id?: string; name?: string };
type AnthropicDelta = {
  type?: string;
  text?: string;
  thinking?: string;
  partial_json?: string;
  stop_reason?: string;
};
type AnthropicEvent = {
  type: string;
  index?: number;
  content_block?: AnthropicBlock;
  delta?: AnthropicDelta;
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  usage?: { output_tokens?: number };
  error?: { type?: string; message?: string };
};

type AnthropicContentBlock =
  | { type: 'text'; text: string; cache_control?: AnthropicCacheControl }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string }; cache_control?: AnthropicCacheControl }
  | { type: 'tool_use'; id: string; name: string; input: unknown; cache_control?: AnthropicCacheControl }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean; cache_control?: AnthropicCacheControl };

type AnthropicMessage = { role: 'user' | 'assistant'; content: string | AnthropicContentBlock[] };
type AnthropicCacheControl = { type: 'ephemeral' };
type AnthropicSystem = string | Array<{ type: 'text'; text: string; cache_control?: AnthropicCacheControl }> | undefined;

function toAnthropicSystem(request: ProviderRequest): AnthropicSystem {
  if (!request.systemPrompt) {
    return undefined;
  }
  if (!hasBreakpoint(request.cacheBreakpoints, 'stable')) {
    return request.systemPrompt;
  }
  return [{ type: 'text', text: request.systemPrompt, cache_control: { type: 'ephemeral' } }];
}

/**
 * Map our internal Message[] to Anthropic's. Assistant `toolCall`s become
 * `tool_use` blocks; our standalone `toolResult` messages become `tool_result`
 * blocks inside a user message — consecutive ones are merged into a single user
 * message, as Anthropic requires tool results to follow the tool_use turn.
 */
function toAnthropicMessages(messages: Message[], breakpoints: ProviderCacheBreakpoint[] | undefined): AnthropicMessage[] {
  const semiStableMessageIndex = breakpointMessageIndex(breakpoints, 'semiStable');
  const out: AnthropicMessage[] = [];
  for (const [index, msg] of messages.entries()) {
    const cacheThisMessage = semiStableMessageIndex != null && index === semiStableMessageIndex - 1;
    if (msg.role === 'toolResult') {
      const block: AnthropicContentBlock = {
        type: 'tool_result',
        tool_use_id: msg.toolCallId,
        content: msg.content,
        ...(msg.isError ? { is_error: true } : {}),
      };
      const last = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        last.content.push(block);
        if (cacheThisMessage) {
          markLastBlockCacheable(last);
        }
      } else {
        out.push({ role: 'user', content: cacheThisMessage ? [withCacheControl(block)] : [block] });
      }
    } else if (msg.role === 'user') {
      out.push({
        role: 'user',
        content:
          typeof msg.content === 'string'
            ? cacheThisMessage
              ? [{ type: 'text' as const, text: msg.content, cache_control: { type: 'ephemeral' as const } }]
              : msg.content
            : msg.content.flatMap((part): AnthropicContentBlock[] => {
              if (part.type === 'text') return part.text ? [{ type: 'text', text: part.text }] : [];
              if (part.type === 'image') {
                return [{
                  type: 'image',
                  source: { type: 'base64', media_type: part.mimeType, data: part.data },
                }];
              }
              return [];
            }),
      });
      if (cacheThisMessage && typeof msg.content !== 'string') {
        markLastBlockCacheable(out[out.length - 1]!);
      }
    } else {
      // assistant: text + tool_use blocks (thinking blocks are dropped on the
      // way back — Anthropic requires signed thinking, not needed for context).
      const blocks: AnthropicContentBlock[] = [];
      for (const part of msg.content) {
        if (part.type === 'text' && part.text) {
          blocks.push({ type: 'text', text: part.text });
        } else if (part.type === 'toolCall') {
          blocks.push({ type: 'tool_use', id: part.id, name: part.name, input: part.arguments ?? {} });
        }
      }
      if (cacheThisMessage) {
        const target = blocks.length > 0 ? blocks : [{ type: 'text' as const, text: '' }];
        markLastBlockCacheable({ role: 'assistant', content: target });
        out.push({ role: 'assistant', content: target });
        continue;
      }
      out.push({ role: 'assistant', content: blocks.length > 0 ? blocks : [{ type: 'text', text: '' }] });
    }
  }
  return out;
}

function hasBreakpoint(breakpoints: ProviderCacheBreakpoint[] | undefined, after: ProviderCacheBreakpoint['after']): boolean {
  return breakpoints?.some((breakpoint) => breakpoint.after === after) ?? false;
}

function breakpointMessageIndex(
  breakpoints: ProviderCacheBreakpoint[] | undefined,
  after: ProviderCacheBreakpoint['after'],
): number | undefined {
  const value = breakpoints?.find((breakpoint) => breakpoint.after === after)?.messageIndex;
  return typeof value === 'number' && value > 0 ? value : undefined;
}

function markLastBlockCacheable(message: AnthropicMessage): void {
  if (!Array.isArray(message.content) || message.content.length === 0) {
    return;
  }
  const last = message.content[message.content.length - 1];
  if (last) {
    last.cache_control = { type: 'ephemeral' };
  }
}

function withCacheControl(block: AnthropicContentBlock): AnthropicContentBlock {
  return { ...block, cache_control: { type: 'ephemeral' } };
}

function safeJson(input: string): { value: unknown; error?: string } {
  try {
    return { value: JSON.parse(input) };
  } catch (error) {
    return { value: input, error: error instanceof Error ? error.message : String(error) };
  }
}

function normalizeBaseUrl(baseUrl: string | undefined): string | undefined {
  return baseUrl ? baseUrl.replace(/\/+$/, '') : undefined;
}
