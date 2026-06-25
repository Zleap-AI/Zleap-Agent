export type MessageRole = 'user' | 'assistant' | 'toolResult';

export type TextContent = {
  type: 'text';
  text: string;
};

export type ThinkingContent = {
  type: 'thinking';
  text: string;
  signature?: string;
};

export type ToolCallContent = {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: unknown;
};

export type ImageContent = {
  type: 'image';
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  /** Base64 payload without the data URL prefix. */
  data: string;
};

export type MessageContent = TextContent | ThinkingContent | ToolCallContent | ImageContent;

export type UserMessage = {
  id?: string;
  role: 'user';
  content: string | MessageContent[];
};

export type AssistantMessage = {
  id?: string;
  role: 'assistant';
  content: MessageContent[];
  usage?: Usage;
  status?: 'completed' | 'error' | 'aborted';
};

export type ToolResultMessage = {
  id?: string;
  role: 'toolResult';
  toolCallId: string;
  toolName: string;
  content: string;
  isError?: boolean;
  details?: unknown;
};

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export type ToolSchema = {
  name: string;
  description: string;
  parameters: unknown;
};

export type ProviderCacheBreakpoint = {
  after: 'stable' | 'semiStable';
  /** Number of provider messages included at this boundary. */
  messageIndex: number;
};

export type Model = {
  id: string;
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsTools?: boolean;
  supportsThinking?: boolean;
  supportsCache?: boolean;
  tokenizer?: string;
};

export type ProviderCapabilities = {
  /** Whether this provider accepts native tool call / tool result replay. */
  toolCalling: boolean;
  /** Whether ProviderCacheBreakpoint should be translated into provider request metadata. */
  cacheBreakpoints: boolean;
  /** Whether this provider can stream reasoning/thinking events. */
  thinking: boolean;
  /** Tokenizer identifier used by higher layers for budgeting/eval. */
  tokenizer: string;
  /** Optional provider-level output cap; model config may further override it. */
  maxOutputTokens?: number;
};

export type Usage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  costUsd?: number;
};

export type ProviderRequest = {
  systemPrompt: string;
  messages: Message[];
  tools?: ToolSchema[];
  cacheBreakpoints?: ProviderCacheBreakpoint[];
};

export type ProviderOptions = {
  signal?: AbortSignal;
  temperature?: number;
  maxOutputTokens?: number;
  apiKey?: string;
  baseUrl?: string;
  metadata?: Record<string, unknown>;
};

export type AssistantStreamEvent =
  | { type: 'text_start'; id: string }
  | { type: 'text_delta'; id: string; text: string }
  | { type: 'text_end'; id: string }
  | { type: 'thinking_start'; id: string }
  | { type: 'thinking_delta'; id: string; text: string }
  | { type: 'thinking_end'; id: string }
  | { type: 'toolcall_start'; id: string; name: string }
  | { type: 'toolcall_delta'; id: string; argumentsText: string }
  | {
      type: 'toolcall_end';
      id: string;
      name: string;
      arguments: unknown;
      rawArguments?: string;
      argumentsParseError?: string;
    }
  | { type: 'done'; usage?: Usage; finishReason?: string }
  | { type: 'error'; error: ProviderError };

export type ProviderError = {
  code: string;
  message: string;
  cause?: unknown;
};

export interface ProviderAdapter {
  id: string;
  capabilities: ProviderCapabilities;
  stream(
    model: Model,
    request: ProviderRequest,
    options?: ProviderOptions,
  ): AsyncIterable<AssistantStreamEvent>;
}
