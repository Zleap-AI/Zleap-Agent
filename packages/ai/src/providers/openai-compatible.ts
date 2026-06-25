import { gunzipSync } from 'node:zlib';
import type {
  AssistantStreamEvent,
  Message,
  Model,
  ProviderAdapter,
  ProviderOptions,
  ProviderRequest,
  Usage,
} from '../types.js';
import { sseChunks } from './sse.js';

export const OPENAI_COMPATIBLE_PROVIDER_ID = 'openai-compatible';
export const DEFAULT_OPENAI_COMPATIBLE_MAX_OUTPUT_TOKENS = 32_000;

export class OpenAiCompatibleProvider implements ProviderAdapter {
  id = OPENAI_COMPATIBLE_PROVIDER_ID;
  capabilities = {
    toolCalling: true,
    cacheBreakpoints: false,
    thinking: true,
    tokenizer: 'openai-compatible',
  };

  async *stream(
    model: Model,
    request: ProviderRequest,
    options?: ProviderOptions,
  ): AsyncIterable<AssistantStreamEvent> {
    const apiKey = options?.apiKey ?? model.apiKey;
    const baseUrl = normalizeBaseUrl(options?.baseUrl ?? model.baseUrl);

    if (!baseUrl) {
      yield { type: 'error', error: { code: 'missing_base_url', message: 'OpenAI-compatible baseUrl is required' } };
      return;
    }
    if (!apiKey) {
      yield { type: 'error', error: { code: 'missing_api_key', message: 'OpenAI-compatible apiKey is required' } };
      return;
    }

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        signal: options?.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: model.model,
          messages: toOpenAiMessages(request),
          // Omit `tools` entirely when empty — many endpoints reject `tools: []`.
          tools:
            request.tools && request.tools.length > 0
              ? request.tools.map((tool) => ({ type: 'function', function: tool }))
              : undefined,
          temperature: options?.temperature,
          max_tokens: options?.maxOutputTokens ?? model.maxOutputTokens ?? DEFAULT_OPENAI_COMPATIBLE_MAX_OUTPUT_TOKENS,
          stream: true,
          stream_options: { include_usage: true },
        }),
      });
    } catch (cause) {
      yield { type: 'error', error: { code: 'provider_error', message: 'OpenAI-compatible request failed', cause } };
      return;
    }

    if (!response.ok) {
      yield { type: 'error', error: { code: `http_${response.status}`, message: await responseErrorText(response) } };
      return;
    }
    if (!response.body) {
      yield { type: 'error', error: { code: 'no_response_body', message: 'OpenAI-compatible response had no body' } };
      return;
    }

    const id = `openai_compatible_${Date.now()}`;
    // Tool calls accumulate across fragments. We use `index` when the endpoint
    // provides it (spec-compliant); when it does NOT (some gateways omit it),
    // every fragment would collapse to index 0 and concatenate two calls into a
    // garbage name (`lsglob`). So in the no-index case a fragment carrying
    // a function name starts a NEW call; arg-only fragments continue the last.
    const toolCalls: Array<{ id: string; name: string; args: string }> = [];
    let lastSlot = -1;
    let textStarted = false;
    let thinkingStarted = false;
    let usage: Usage | undefined;
    let finishReason: string | undefined;

    try {
      for await (const data of sseChunks(response.body)) {
        if (data === '[DONE]') {
          break;
        }
        let json: OpenAiStreamChunk;
        try {
          json = JSON.parse(data) as OpenAiStreamChunk;
        } catch {
          continue; // ignore keep-alives / malformed lines
        }

        if (json.usage) {
          usage = {
            inputTokens: json.usage.prompt_tokens,
            outputTokens: json.usage.completion_tokens,
            totalTokens: json.usage.total_tokens,
          };
        }

        const choice = json.choices?.[0];
        if (choice?.finish_reason) {
          finishReason = choice.finish_reason;
        }
        const delta = choice?.delta;
        if (!delta) {
          continue;
        }

        // Reasoning/thinking tokens (qwen/deepseek-style) → thinking events.
        if (delta.reasoning_content) {
          if (!thinkingStarted) {
            yield { type: 'thinking_start', id };
            thinkingStarted = true;
          }
          yield { type: 'thinking_delta', id, text: delta.reasoning_content };
        }

        if (typeof delta.content === 'string' && delta.content.length > 0) {
          if (!textStarted) {
            yield { type: 'text_start', id };
            textStarted = true;
          }
          yield { type: 'text_delta', id, text: delta.content };
        }

        for (const call of delta.tool_calls ?? []) {
          let slot: number;
          if (typeof call.index === 'number') {
            // Spec path: `index` addresses the slot (handles split names too).
            slot = call.index;
            while (toolCalls.length <= slot) {
              toolCalls.push({ id: `${id}_tool_${toolCalls.length}`, name: '', args: '' });
            }
          } else {
            // No-index path: a named fragment (when the last call is already
            // named) starts a new call; otherwise continue the last.
            const startNew = toolCalls.length === 0 || (Boolean(call.function?.name) && toolCalls[lastSlot]!.name.length > 0);
            if (startNew) {
              toolCalls.push({ id: `${id}_tool_${toolCalls.length}`, name: '', args: '' });
              lastSlot = toolCalls.length - 1;
            }
            slot = lastSlot;
          }
          const current = toolCalls[slot]!;
          if (call.id) {
            current.id = call.id;
          }
          if (call.function?.name) {
            current.name += call.function.name;
          }
          if (call.function?.arguments) {
            current.args += call.function.arguments;
            yield { type: 'toolcall_delta', id: current.id, argumentsText: call.function.arguments };
          }
        }
      }

      if (thinkingStarted) {
        yield { type: 'thinking_end', id };
      }
      if (textStarted) {
        yield { type: 'text_end', id };
      }
      for (const call of toolCalls) {
        if (!call.name) {
          continue; // skip a slot that never received a tool name (malformed)
        }
        const parsedArguments = safeJson(call.args || '{}');
        yield { type: 'toolcall_start', id: call.id, name: call.name };
        yield {
          type: 'toolcall_end',
          id: call.id,
          name: call.name,
          arguments: parsedArguments.value,
          rawArguments: call.args || '{}',
          argumentsParseError: parsedArguments.error,
        };
      }

      yield { type: 'done', usage, finishReason };
    } catch (cause) {
      yield { type: 'error', error: { code: 'provider_error', message: 'OpenAI-compatible stream failed', cause } };
    }
  }
}

async function responseErrorText(response: Response): Promise<string> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  const encoding = response.headers.get('content-encoding')?.toLowerCase() ?? '';
  let body = bytes;
  if (encoding.includes('gzip') || isGzip(bytes)) {
    try {
      body = gunzipSync(bytes);
    } catch {
      body = bytes;
    }
  }
  const text = new TextDecoder().decode(body).trim();
  return sanitizeProviderErrorText(text || response.statusText || `HTTP ${response.status}`);
}

function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function sanitizeProviderErrorText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '�').slice(0, 8000);
}

type OpenAiStreamChunk = {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};


function toOpenAiMessages(request: ProviderRequest): Array<Record<string, unknown>> {
  return [
    { role: 'system', content: request.systemPrompt },
    ...request.messages.map((message) => {
      if (message.role === 'toolResult') {
        return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
      }
      if (message.role === 'assistant') {
        const text = stringifyMessageContent(message);
        const toolCalls = message.content
          .filter((part) => part.type === 'toolCall')
          .map((part) => ({
            id: part.id,
            type: 'function',
            function: {
              name: part.name,
              arguments: stringifyToolArguments(part.arguments),
            },
          }));
        if (toolCalls.length > 0) {
          return { role: 'assistant', content: text || null, tool_calls: toolCalls };
        }
        return { role: 'assistant', content: text };
      }
      return { role: message.role, content: toOpenAiUserContent(message) };
    }),
  ];
}

type OpenAiUserContent =
  | string
  | Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
  >;

function toOpenAiUserContent(message: Extract<Message, { role: 'user' }>): OpenAiUserContent {
  if (typeof message.content === 'string') return message.content;
  const parts = message.content.flatMap((part): Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> => {
    if (part.type === 'text') return part.text ? [{ type: 'text', text: part.text }] : [];
    if (part.type === 'image') return [{ type: 'image_url', image_url: { url: imageDataUrl(part.mimeType, part.data) } }];
    return [];
  });
  return parts.length ? parts : '';
}

function imageDataUrl(mimeType: string, data: string): string {
  return `data:${mimeType};base64,${data}`;
}

function stringifyMessageContent(message: Message): string {
  if (message.role === 'user') {
    return typeof message.content === 'string'
      ? message.content
      : message.content.map((part) => (part.type === 'text' ? part.text : '')).filter(Boolean).join('\n');
  }
  if (message.role === 'assistant') {
    return message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
  }
  return message.content;
}

function safeJson(input: string): { value: unknown; error?: string } {
  try {
    return { value: JSON.parse(input) };
  } catch (error) {
    return { value: input, error: error instanceof Error ? error.message : String(error) };
  }
}

function stringifyToolArguments(input: unknown): string {
  if (typeof input === 'string') {
    const parsed = safeJson(input);
    return isJsonObject(parsed.value) ? JSON.stringify(parsed.value) : '{}';
  }
  if (!isJsonObject(input)) {
    return '{}';
  }
  try {
    return JSON.stringify(input);
  } catch {
    return '{}';
  }
}

function isJsonObject(input: unknown): input is Record<string, unknown> {
  return Boolean(input && typeof input === 'object' && !Array.isArray(input));
}

function normalizeBaseUrl(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) {
    return undefined;
  }
  return baseUrl.replace(/\/+$/, '');
}
