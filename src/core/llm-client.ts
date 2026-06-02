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
  rawRequest?: unknown;
  normalizedRequest?: NormalizedProviderRequest;
  normalizedResponse?: NormalizedProviderResponse;
  usage?: NormalizedUsage;
};

export type NormalizedContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mimeType?: string; url?: string; detail?: "auto" | "low" | "high" };

export type ProviderContentPart =
  | { type: "text"; text: string }
  | { type: "image_url" | "input_image"; image_url: { url: string; detail?: "auto" | "low" | "high" } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export type NormalizedProviderMessage = {
  role: LLMMessage["role"];
  content: NormalizedContentPart[];
  toolCallId?: string;
  name?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: string;
  }>;
};

export type NormalizedProviderTool = {
  name: string;
  description: string;
  parameters: unknown;
  executionMode: ToolDefinition["executionMode"];
  riskLevel: ToolDefinition["riskLevel"];
};

export type NormalizedSyntheticToolResult = {
  toolCallId: string;
  toolName: string;
  insertedAfterAssistantIndex: number;
  reason: string;
};

export type NormalizedUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  providerUsage?: Record<string, unknown>;
};

export type NormalizedProviderRequest = {
  provider: "openai-compatible";
  endpoint: string;
  model: string;
  stream: boolean;
  temperature?: number;
  messages: NormalizedProviderMessage[];
  tools: NormalizedProviderTool[];
  syntheticToolResults?: NormalizedSyntheticToolResult[];
};

export type NormalizedProviderResponse = {
  provider: "openai-compatible";
  message?: NormalizedProviderMessage;
  usage?: NormalizedUsage;
  finishReason?: string;
  rawChoiceIndex?: number;
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

function parseToolParameters(tool: ToolDefinition): unknown {
  try {
    return JSON.parse(tool.parametersJson);
  } catch {
    return { type: "object", properties: {}, additionalProperties: true };
  }
}

function normalizeMessageContent(content: LLMMessage["content"] | ProviderContentPart[]): NormalizedContentPart[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (Array.isArray(content)) {
    const parts: NormalizedContentPart[] = [];
    for (const part of content) {
      if (part.type === "text") {
        if (part.text) parts.push({ type: "text", text: part.text });
        continue;
      }
      const url = part.image_url?.url;
      if (!url) continue;
      const dataUrlMatch = url.match(/^data:([^;,]+)[;,]/);
      parts.push({
        type: "image",
        mimeType: dataUrlMatch?.[1],
        url,
        detail: part.image_url.detail
      });
    }
    return parts;
  }
  return [];
}

function toolResultImageContent(content: LLMMessage["content"]): ProviderContentPart[] | undefined {
  if (typeof content !== "string" || !content.trim().startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.imageContent)) return undefined;
    const imageContent = parsed.imageContent;
    if (imageContent.type !== "input_image" && imageContent.type !== "image_url") return undefined;
    if (!isRecord(imageContent.image_url) || typeof imageContent.image_url.url !== "string") return undefined;
    const detail = imageContent.image_url.detail;
    const imagePart: ProviderContentPart = {
      type: imageContent.type,
      image_url: {
        url: imageContent.image_url.url,
        detail: detail === "auto" || detail === "low" || detail === "high" ? detail : undefined
      }
    };
    const textPayload = {
      ...parsed,
      imageContent: {
        type: imageContent.type,
        routedToProviderImagePart: true
      }
    };
    return [
      { type: "text", text: JSON.stringify(textPayload) },
      imagePart
    ];
  } catch {
    return undefined;
  }
}

function providerMessageContent(message: LLMMessage): LLMMessage["content"] | ProviderContentPart[] {
  if (message.role === "tool") {
    return toolResultImageContent(message.content) ?? message.content;
  }
  return message.content as LLMMessage["content"] | ProviderContentPart[];
}

function normalizeProviderMessage(message: LLMMessage): NormalizedProviderMessage {
  const content = providerMessageContent(message);
  return {
    role: message.role,
    content: normalizeMessageContent(content),
    toolCallId: message.tool_call_id,
    name: message.name,
    toolCalls: message.tool_calls?.map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.function.name,
      arguments: toolCall.function.arguments
    }))
  };
}

function normalizeProviderTool(tool: ToolDefinition): NormalizedProviderTool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: parseToolParameters(tool),
    executionMode: tool.executionMode,
    riskLevel: tool.riskLevel
  };
}

function toOpenAIMessage(message: LLMMessage): Record<string, unknown> {
  const content = providerMessageContent(message);
  return {
    role: message.role,
    content: Array.isArray(content)
      ? content.map((part) => {
        if (part.type === "text") return part;
        return {
          type: "image_url",
          image_url: part.image_url
        };
      })
      : message.content,
    name: message.name,
    tool_call_id: message.tool_call_id,
    tool_calls: message.tool_calls
  };
}

function toOpenAITool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: parseToolParameters(tool)
    }
  };
}

function syntheticMissingToolMessage(toolCall: NonNullable<LLMMessage["tool_calls"]>[number]): LLMMessage {
  return {
    role: "tool",
    tool_call_id: toolCall.id,
    name: toolCall.function.name,
    content: JSON.stringify({
      error: `Synthetic tool result inserted by ProviderFacade because tool call ${toolCall.id} (${toolCall.function.name}) had no matching tool result message.`,
      synthetic: true,
      toolCallId: toolCall.id,
      toolName: toolCall.function.name
    })
  };
}

function normalizeMessagesForProvider(inputMessages: LLMMessage[]): { messages: LLMMessage[]; syntheticToolResults: NormalizedSyntheticToolResult[] } {
  const messages: LLMMessage[] = [];
  const syntheticToolResults: NormalizedSyntheticToolResult[] = [];
  let pending: Array<{ call: NonNullable<LLMMessage["tool_calls"]>[number]; assistantIndex: number }> = [];

  const flushPending = () => {
    for (const item of pending) {
      messages.push(syntheticMissingToolMessage(item.call));
      syntheticToolResults.push({
        toolCallId: item.call.id,
        toolName: item.call.function.name,
        insertedAfterAssistantIndex: item.assistantIndex,
        reason: "missing_tool_result"
      });
    }
    pending = [];
  };

  for (let index = 0; index < inputMessages.length; index += 1) {
    const message = inputMessages[index];
    if (pending.length > 0 && message.role !== "tool") {
      flushPending();
    }

    messages.push(message);
    if (message.role === "assistant" && message.tool_calls?.length) {
      pending = message.tool_calls.map((call) => ({ call, assistantIndex: index }));
      continue;
    }
    if (message.role === "tool" && pending.length > 0 && message.tool_call_id) {
      pending = pending.filter((item) => item.call.id !== message.tool_call_id);
    }
  }
  flushPending();
  return { messages, syntheticToolResults };
}

function normalizeAssistantToolCallsForRuntime(message: LLMMessage): LLMMessage {
  if (!message.tool_calls?.length) return message;
  return {
    ...message,
    tool_calls: message.tool_calls.map((toolCall, index) => ({
      id: typeof toolCall.id === "string" && toolCall.id.trim() ? toolCall.id : `tool_call_${index}`,
      type: "function",
      function: {
        name: typeof toolCall.function?.name === "string" ? toolCall.function.name : "",
        arguments: typeof toolCall.function?.arguments === "string" ? toolCall.function.arguments : "{}"
      }
    }))
  };
}

function normalizeUsage(raw: unknown): NormalizedUsage | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const usage = (raw as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const record = usage as Record<string, unknown>;
  const inputTokens = numberValue(record.prompt_tokens) ?? numberValue(record.input_tokens);
  const outputTokens = numberValue(record.completion_tokens) ?? numberValue(record.output_tokens);
  const totalTokens = numberValue(record.total_tokens) ?? (
    inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined
  );
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    providerUsage: record
  };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function buildOpenAICompatiblePayload(input: ChatCompletionInput, options: { stream: boolean }): {
  endpoint: string;
  body: Record<string, unknown>;
  normalizedRequest: NormalizedProviderRequest;
} {
  const endpoint = normalizeChatCompletionsEndpoint(input.baseUrl);
  const normalizedTools = input.tools.map(normalizeProviderTool);
  const normalizedMessages = normalizeMessagesForProvider(input.messages);
  const body: Record<string, unknown> = {
    model: input.model,
    messages: normalizedMessages.messages.map(toOpenAIMessage),
    temperature: input.temperature ?? 0.2,
    tools: input.tools.map(toOpenAITool)
  };
  if (options.stream) body.stream = true;
  return {
    endpoint,
    body,
    normalizedRequest: {
      provider: "openai-compatible",
      endpoint,
      model: input.model,
      stream: options.stream,
      temperature: input.temperature ?? 0.2,
      messages: normalizedMessages.messages.map(normalizeProviderMessage),
      tools: normalizedTools,
      syntheticToolResults: normalizedMessages.syntheticToolResults
    }
  };
}

type StreamResponseState = {
  content: string;
  toolCalls: Map<number, { id?: string; name?: string; arguments: string }>;
  finishReason?: string;
  rawChoiceIndex?: number;
  usage?: NormalizedUsage;
};

function createStreamResponseState(): StreamResponseState {
  return {
    content: "",
    toolCalls: new Map()
  };
}

function updateStreamResponseState(state: StreamResponseState, parsed: Record<string, any>): void {
  const usage = normalizeUsage(parsed);
  if (usage) state.usage = usage;
  const choice = parsed.choices?.[0];
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) return;
  if (typeof choice.index === "number" && state.rawChoiceIndex === undefined) state.rawChoiceIndex = choice.index;
  if (typeof choice.finish_reason === "string") state.finishReason = choice.finish_reason;
  const delta = choice.delta;
  if (!delta || typeof delta !== "object" || Array.isArray(delta)) return;
  if (typeof delta.content === "string") state.content += delta.content;
  if (!Array.isArray(delta.tool_calls)) return;
  for (const toolCall of delta.tool_calls) {
    if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) continue;
    const index = typeof toolCall.index === "number" ? toolCall.index : 0;
    const current = state.toolCalls.get(index) ?? { arguments: "" };
    if (typeof toolCall.id === "string" && toolCall.id.trim()) current.id = toolCall.id;
    const fn = toolCall.function;
    if (fn && typeof fn === "object" && !Array.isArray(fn)) {
      if (typeof fn.name === "string" && fn.name.trim()) {
        current.name = current.name ? `${current.name}${fn.name}` : fn.name;
      }
      if (typeof fn.arguments === "string") current.arguments += fn.arguments;
    }
    state.toolCalls.set(index, current);
  }
}

function normalizedStreamResponseFromState(state: StreamResponseState): NormalizedProviderResponse {
  const toolCalls = [...state.toolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, toolCall]) => ({
      id: toolCall.id ?? `tool_call_${index}`,
      type: "function" as const,
      function: {
        name: toolCall.name ?? "",
        arguments: toolCall.arguments || "{}"
      }
    }));
  const message: LLMMessage = normalizeAssistantToolCallsForRuntime({
    role: "assistant",
    content: state.content || null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
  });
  return {
    provider: "openai-compatible",
    message: normalizeProviderMessage(message),
    usage: state.usage,
    finishReason: state.finishReason,
    rawChoiceIndex: state.rawChoiceIndex
  };
}

function streamDoneRaw(providerPayload: ReturnType<typeof buildOpenAICompatiblePayload>, rawEvents: unknown[], state: StreamResponseState): Record<string, unknown> {
  const normalizedResponse = normalizedStreamResponseFromState(state);
  return {
    rawRequest: {
      endpoint: providerPayload.endpoint,
      body: providerPayload.body
    },
    normalizedRequest: providerPayload.normalizedRequest,
    normalizedResponse,
    usage: normalizedResponse.usage,
    rawEvents
  };
}

function previewStreamData(data: string, maxLength = 240): string {
  const normalized = data.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}...`;
}

function parseProviderStreamJson(data: string, input: { endpoint: string; eventIndex: number }): Record<string, any> {
  try {
    const parsed = JSON.parse(data) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, any>;
    throw new Error("parsed data is not an object");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Malformed OpenAI-compatible stream event JSON at event ${input.eventIndex} for ${input.endpoint}: ${detail}. data=${previewStreamData(data)}`);
  }
}

function normalizeOpenAICompatibleResponse(raw: unknown, message?: LLMMessage): NormalizedProviderResponse {
  const rawRecord = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const choices = Array.isArray(rawRecord.choices) ? rawRecord.choices : [];
  const firstChoice = choices[0] && typeof choices[0] === "object" && !Array.isArray(choices[0])
    ? choices[0] as Record<string, unknown>
    : undefined;
  return {
    provider: "openai-compatible",
    message: message ? normalizeProviderMessage(message) : undefined,
    usage: normalizeUsage(raw),
    finishReason: typeof firstChoice?.finish_reason === "string" ? firstChoice.finish_reason : undefined,
    rawChoiceIndex: numberValue(firstChoice?.index)
  };
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

export interface ProviderFacade {
  complete(input: ChatCompletionInput): Promise<ChatCompletionOutput>;
  streamEvents?(input: ChatCompletionInput): AsyncGenerator<LLMStreamEvent>;
}

export interface LLMClient extends ProviderFacade {
  stream?(input: ChatCompletionInput): AsyncGenerator<string>;
}

export class OpenAICompatibleProviderAdapter implements ProviderFacade {
  async complete(input: ChatCompletionInput): Promise<ChatCompletionOutput> {
    const providerPayload = buildOpenAICompatiblePayload(input, { stream: false });
    const response = await fetchWithProviderRetry({
      endpoint: providerPayload.endpoint,
      apiKey: input.apiKey,
      body: providerPayload.body,
      signal: input.signal,
      maxProviderAttempts: input.maxProviderAttempts,
      providerFetchTimeoutMs: input.providerFetchTimeoutMs
    });

    if (!response.ok) {
      const text = await readProviderError(response);
      throw new Error(`LLM 请求失败（${response.status}）：${text}`);
    }

    const raw = await response.json() as any;
    const rawMessage = raw.choices?.[0]?.message as LLMMessage | undefined;
    if (!rawMessage) throw new Error("LLM response did not contain choices[0].message");
    const message = normalizeAssistantToolCallsForRuntime(rawMessage);
    const normalizedResponse = normalizeOpenAICompatibleResponse(raw, message);
    return {
      message,
      raw,
      rawRequest: {
        endpoint: providerPayload.endpoint,
        body: providerPayload.body
      },
      normalizedRequest: providerPayload.normalizedRequest,
      normalizedResponse,
      usage: normalizedResponse.usage
    };
  }

  async *streamEvents(input: ChatCompletionInput): AsyncGenerator<LLMStreamEvent> {
    const providerPayload = buildOpenAICompatiblePayload(input, { stream: true });
    const response = await fetchWithProviderRetry({
      endpoint: providerPayload.endpoint,
      apiKey: input.apiKey,
      body: providerPayload.body,
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
    const rawEvents: unknown[] = [];
    const responseState = createStreamResponseState();

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
            if (data === "[DONE]") {
              yield { type: "done", raw: streamDoneRaw(providerPayload, rawEvents, responseState) };
              return;
            }
            if (!data) continue;
            const parsed = parseProviderStreamJson(data, {
              endpoint: providerPayload.endpoint,
              eventIndex: rawEvents.length + 1
            });
            rawEvents.push(parsed);
            updateStreamResponseState(responseState, parsed);
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
    yield {
      type: "done",
      raw: streamDoneRaw(providerPayload, rawEvents, responseState)
    };
  }
}

export class OpenAICompatibleClient extends OpenAICompatibleProviderAdapter implements LLMClient {
  async *stream(input: ChatCompletionInput): AsyncGenerator<string> {
    for await (const event of this.streamEvents(input)) {
      if (event.type === "content") yield event.text;
    }
  }
}
