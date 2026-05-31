import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import type { LLMMessage, ToolDefinition } from "../types";

export type ChatCompletionInput = {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: LLMMessage[];
  tools: ToolDefinition[];
  temperature?: number;
};

export type ChatCompletionOutput = {
  message: LLMMessage;
  raw: unknown;
};

const MAX_PROVIDER_ATTEMPTS = 5;

export type LLMStreamEvent =
  | { type: "content"; text: string }
  | { type: "tool_call_delta"; index: number; id?: string; name?: string; arguments?: string }
  | { type: "done"; raw?: unknown };

export function normalizeProviderBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl
    .trim()
    .replace(/^http:\/\/api\.302\.ai(?=[:/]|$)/i, "https://api.302ai.com")
    .replace(/^https:\/\/api\.302\.ai(?=[:/]|$)/i, "https://api.302ai.com")
    .replace(/^api\.302\.ai(?=[:/]|$)/i, "https://api.302ai.com")
    .replace(/\/+$/, "");
  if (!trimmed) return trimmed;
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withProtocol);
    if (url.hostname.toLowerCase() === "api.302.ai") {
      url.protocol = "https:";
      url.hostname = "api.302ai.com";
      return url.toString().replace(/\/+$/, "");
    }
    if (trimmed !== withProtocol) return url.toString().replace(/\/+$/, "");
  } catch {
    // Keep non-URL values unchanged; the provider request will surface the error.
  }
  return trimmed;
}

export function normalizeChatCompletionsEndpoint(baseUrl: string): string {
  const trimmed = normalizeProviderBaseUrl(baseUrl);
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  if (trimmed.endsWith("/v1")) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

function formatFetchError(error: unknown, endpoint: string): Error {
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  const causeParts: string[] = [];
  if (cause && typeof cause === "object") {
    const record = cause as Record<string, unknown>;
    if (record.code) causeParts.push(`code=${String(record.code)}`);
    if (record.hostname) causeParts.push(`host=${String(record.hostname)}`);
    if (record.message) causeParts.push(String(record.message));
  }
  const detail = error instanceof Error ? error.message : String(error);
  const causeText = causeParts.length > 0 ? `；底层原因：${causeParts.join("，")}` : "";
  return new Error(`无法连接到 LLM 服务：${endpoint}。请检查接口地址、网络/代理和 API 服务可用性。原始错误：${detail}${causeText}`);
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function retryDelayMs(attempt: number): number {
  return Math.min(1600, 200 * 2 ** Math.max(0, attempt - 1));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeCompressedBytes(bytes: Uint8Array, contentEncoding: string): Uint8Array {
  const encoding = contentEncoding.toLowerCase();
  const isGzip = encoding.includes("gzip") || (bytes[0] === 0x1f && bytes[1] === 0x8b);
  const isBrotli = encoding.includes("br");
  const isDeflate = encoding.includes("deflate");
  try {
    if (isGzip) return gunzipSync(bytes);
    if (isBrotli) return brotliDecompressSync(bytes);
    if (isDeflate) return inflateSync(bytes);
  } catch {
    return bytes;
  }
  return bytes;
}

function extractProviderError(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "服务商没有返回错误详情。";
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const error = record.error;
      if (typeof error === "string") return error;
      if (error && typeof error === "object") {
        const errorRecord = error as Record<string, unknown>;
        if (typeof errorRecord.message === "string") return errorRecord.message;
        if (typeof errorRecord.type === "string" || typeof errorRecord.code === "string") {
          return JSON.stringify(errorRecord);
        }
      }
      if (typeof record.message === "string") return record.message;
    }
  } catch {
    // Non-JSON provider errors are still useful after decompression.
  }
  return trimmed;
}

async function readProviderError(response: Response): Promise<string> {
  const contentEncoding = response.headers.get("content-encoding") ?? "";
  const rawBytes = new Uint8Array(await response.arrayBuffer());
  const decodedBytes = decodeCompressedBytes(rawBytes, contentEncoding);
  const text = new TextDecoder("utf-8").decode(decodedBytes);
  return extractProviderError(text);
}

async function fetchWithProviderRetry(input: {
  endpoint: string;
  apiKey: string;
  body: unknown;
}): Promise<Response> {
  let lastNetworkError: unknown;
  for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(input.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${input.apiKey}`
        },
        body: JSON.stringify(input.body)
      });
    } catch (error) {
      lastNetworkError = error;
      if (attempt < MAX_PROVIDER_ATTEMPTS) {
        await delay(retryDelayMs(attempt));
        continue;
      }
      throw formatFetchError(error, input.endpoint);
    }

    if (response.ok || !isRetryableStatus(response.status) || attempt === MAX_PROVIDER_ATTEMPTS) {
      return response;
    }

    await response.arrayBuffer().catch(() => undefined);
    await delay(retryDelayMs(attempt));
  }

  throw formatFetchError(lastNetworkError ?? new Error("Provider retry attempts exhausted."), input.endpoint);
}

export interface LLMClient {
  complete(input: ChatCompletionInput): Promise<ChatCompletionOutput>;
  stream?(input: ChatCompletionInput): AsyncGenerator<string>;
  streamEvents?(input: ChatCompletionInput): AsyncGenerator<LLMStreamEvent>;
}

export class OpenAICompatibleClient implements LLMClient {
  async complete(input: ChatCompletionInput): Promise<ChatCompletionOutput> {
    const endpoint = normalizeChatCompletionsEndpoint(input.baseUrl);
    const response = await fetchWithProviderRetry({
      endpoint,
      apiKey: input.apiKey,
      body: {
        model: input.model,
        messages: input.messages,
        temperature: input.temperature ?? 0.2,
        tools: input.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: JSON.parse(tool.parametersJson)
          }
        }))
      }
    });

    if (!response.ok) {
      const text = await readProviderError(response);
      throw new Error(`LLM 请求失败（${response.status}）：${text}`);
    }

    const raw = await response.json() as any;
    const message = raw.choices?.[0]?.message as LLMMessage | undefined;
    if (!message) throw new Error("LLM response did not contain choices[0].message");
    return { message, raw };
  }

  async *stream(input: ChatCompletionInput): AsyncGenerator<string> {
    for await (const event of this.streamEvents(input)) {
      if (event.type === "content") yield event.text;
    }
  }

  async *streamEvents(input: ChatCompletionInput): AsyncGenerator<LLMStreamEvent> {
    const endpoint = normalizeChatCompletionsEndpoint(input.baseUrl);
    const response = await fetchWithProviderRetry({
      endpoint,
      apiKey: input.apiKey,
      body: {
        model: input.model,
        messages: input.messages,
        temperature: input.temperature ?? 0.2,
        stream: true,
        tools: input.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: JSON.parse(tool.parametersJson)
          }
        }))
      }
    });

    if (!response.ok) {
      const text = await readProviderError(response);
      throw new Error(`LLM 流式请求失败（${response.status}）：${text}`);
    }
    if (!response.body) throw new Error("LLM 流式响应没有返回 body。");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const event of events) {
        for (const line of event.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") return;
          if (!data) continue;
          const parsed = JSON.parse(data) as any;
          const delta = parsed.choices?.[0]?.delta;
          const content = delta?.content;
          if (content) yield { type: "content", text: content };
          const toolCalls = delta?.tool_calls;
          if (Array.isArray(toolCalls)) {
            for (const toolCall of toolCalls) {
              yield {
                type: "tool_call_delta",
                index: Number(toolCall.index ?? 0),
                id: toolCall.id,
                name: toolCall.function?.name,
                arguments: toolCall.function?.arguments
              };
            }
          }
        }
      }
    }
    yield { type: "done" };
  }
}
