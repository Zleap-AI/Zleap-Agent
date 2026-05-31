import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import type { LLMMessage, ToolDefinition } from "../types";

export type ChatCompletionInput = {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: LLMMessage[];
  tools: ToolDefinition[];
  temperature?: number;
  signal?: AbortSignal;
  maxProviderAttempts?: number;
  providerFetchTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
};

export type ChatCompletionOutput = {
  message: LLMMessage;
  raw: unknown;
};

const MAX_PROVIDER_ATTEMPTS = 5;
const DEFAULT_PROVIDER_FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 45_000;

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

function runStoppedError(): Error {
  return new Error("运行已被用户停止。");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw runStoppedError();
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(runStoppedError());
      return;
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(runStoppedError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function positiveEnvInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function providerFetchTimeoutMs(): number {
  return positiveEnvInt("ZLEAP_LLM_FETCH_TIMEOUT_MS", DEFAULT_PROVIDER_FETCH_TIMEOUT_MS);
}

function streamIdleTimeoutMs(): number {
  return positiveEnvInt("ZLEAP_LLM_STREAM_IDLE_TIMEOUT_MS", DEFAULT_STREAM_IDLE_TIMEOUT_MS);
}

async function readStreamChunkWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`LLM 流式响应超时：${Math.round(timeoutMs / 1000)} 秒没有收到新数据。`));
    }, timeoutMs);
  });
  const abortPromise = new Promise<never>((_, reject) => {
    if (!signal) return;
    if (signal.aborted) {
      reject(runStoppedError());
      return;
    }
    onAbort = () => reject(runStoppedError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), timeoutPromise, abortPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
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
  signal?: AbortSignal;
  maxProviderAttempts?: number;
  providerFetchTimeoutMs?: number;
}): Promise<Response> {
  let lastNetworkError: unknown;
  const maxAttempts = Math.max(1, Math.floor(input.maxProviderAttempts ?? MAX_PROVIDER_ATTEMPTS));
  const fetchTimeoutMs = Math.max(1, Math.floor(input.providerFetchTimeoutMs ?? providerFetchTimeoutMs()));
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfAborted(input.signal);
    let response: Response;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
    try {
      response = await fetch(input.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${input.apiKey}`
        },
        body: JSON.stringify(input.body),
        signal: controller.signal
      });
    } catch (error) {
      if (input.signal?.aborted) throw runStoppedError();
      lastNetworkError = error;
      if (attempt < maxAttempts) {
        await delay(retryDelayMs(attempt), input.signal);
        continue;
      }
      throw formatFetchError(error, input.endpoint);
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", onAbort);
    }

    if (response.ok || !isRetryableStatus(response.status) || attempt === maxAttempts) {
      return response;
    }

    await response.arrayBuffer().catch(() => undefined);
    await delay(retryDelayMs(attempt), input.signal);
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
      },
      signal: input.signal,
      maxProviderAttempts: input.maxProviderAttempts,
      providerFetchTimeoutMs: input.providerFetchTimeoutMs
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
      },
      signal: input.signal,
      maxProviderAttempts: input.maxProviderAttempts,
      providerFetchTimeoutMs: input.providerFetchTimeoutMs
    });

    if (!response.ok) {
      const text = await readProviderError(response);
      throw new Error(`LLM 流式请求失败（${response.status}）：${text}`);
    }
    if (!response.body) throw new Error("LLM 流式响应没有返回 body。");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const idleTimeoutMs = Math.max(1, Math.floor(input.streamIdleTimeoutMs ?? streamIdleTimeoutMs()));

    try {
      while (true) {
        const { done, value } = await readStreamChunkWithIdleTimeout(reader, idleTimeoutMs, input.signal);
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
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
    yield { type: "done" };
  }
}
