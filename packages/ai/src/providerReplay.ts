import type {
  AssistantMessage,
  Message,
  MessageContent,
  ProviderCacheBreakpoint,
  ProviderCapabilities,
  ProviderRequest,
  ToolResultMessage,
  UserMessage,
} from './types.js';

type PreparedMessages = {
  messages: Message[];
  countAfterOriginal: number[];
};

type PendingToolCall = {
  id: string;
  name: string;
};

type PrepareProviderRequestOptions = {
  capabilities?: ProviderCapabilities;
};

const DEFAULT_REPLAY_CAPABILITIES: ProviderCapabilities = {
  toolCalling: true,
  cacheBreakpoints: true,
  thinking: true,
  tokenizer: 'generic',
};

/**
 * Legalize replayed conversation history before a provider sees it.
 *
 * Product/runtime layers can persist partial turns, aborted assistant messages,
 * or orphaned tool results. Providers are stricter: assistant tool calls must be
 * paired with tool results, and aborted/error assistant turns should not be
 * replayed as valid model context.
 */
export function prepareProviderRequest(request: ProviderRequest, options: PrepareProviderRequestOptions = {}): ProviderRequest {
  const capabilities = options.capabilities ?? DEFAULT_REPLAY_CAPABILITIES;
  const prepared = prepareMessages(request.messages, capabilities);
  return {
    ...request,
    tools: capabilities.toolCalling ? request.tools : undefined,
    messages: prepared.messages,
    cacheBreakpoints: capabilities.cacheBreakpoints
      ? remapCacheBreakpoints(request.cacheBreakpoints, prepared.countAfterOriginal)
      : undefined,
  };
}

export function prepareProviderMessages(messages: Message[], options: PrepareProviderRequestOptions = {}): Message[] {
  return prepareMessages(messages, options.capabilities ?? DEFAULT_REPLAY_CAPABILITIES).messages;
}

function prepareMessages(messages: Message[], capabilities: ProviderCapabilities): PreparedMessages {
  const out: Message[] = [];
  const countAfterOriginal = [0];
  const pendingToolCalls: PendingToolCall[] = [];

  const flushMissingToolResults = (count = pendingToolCalls.length): void => {
    for (const call of pendingToolCalls.splice(0, count)) {
      out.push(missingToolResult(call.id, call.name));
    }
  };

  for (const [index, message] of messages.entries()) {
    if (message.role === 'toolResult') {
      if (capabilities.toolCalling) {
        const pendingIndex = pendingToolCalls.findIndex((call) => call.id === message.toolCallId);
        if (pendingIndex >= 0) {
          flushMissingToolResults(pendingIndex);
          const expected = pendingToolCalls.shift();
          if (expected) {
            out.push(sanitizeToolResult(message, expected));
          }
        }
      }
      countAfterOriginal[index + 1] = out.length;
      continue;
    }

    flushMissingToolResults();

    if (message.role === 'assistant') {
      const sanitized = sanitizeAssistantMessage(message, capabilities);
      if (sanitized) {
        out.push(sanitized);
        for (const part of sanitized.content) {
          if (part.type === 'toolCall') {
            pendingToolCalls.push({ id: part.id, name: part.name });
          }
        }
      }
    } else {
      out.push(sanitizeUserMessage(message));
    }
    countAfterOriginal[index + 1] = out.length;
  }

  flushMissingToolResults();
  countAfterOriginal[messages.length] = out.length;
  return { messages: out, countAfterOriginal };
}

function sanitizeAssistantMessage(
  message: AssistantMessage,
  capabilities: ProviderCapabilities,
): AssistantMessage | undefined {
  if (message.status && message.status !== 'completed') {
    return undefined;
  }

  const content: MessageContent[] = [];
  for (const part of message.content) {
    if (part.type === 'text' && typeof part.text === 'string' && part.text) {
      content.push({ type: 'text', text: part.text });
    } else if (capabilities.toolCalling && part.type === 'toolCall' && part.id?.trim() && part.name?.trim()) {
      content.push({ type: 'toolCall', id: part.id.trim(), name: part.name.trim(), arguments: part.arguments ?? {} });
    }
  }
  if (content.length === 0) {
    return undefined;
  }
  return {
    ...(message.id ? { id: message.id } : {}),
    role: 'assistant',
    content,
  };
}

function sanitizeUserMessage(message: UserMessage): UserMessage {
  if (typeof message.content === 'string') {
    return message;
  }
  const text = message.content
    .flatMap((part) => (part.type === 'text' && part.text ? [part.text] : []))
    .join('\n');
  if (!message.content.some((part) => part.type === 'image')) {
    return {
      ...(message.id ? { id: message.id } : {}),
      role: 'user',
      content: text,
    };
  }
  const content = message.content.flatMap((part): MessageContent[] => {
    if (part.type === 'text' && part.text) {
      return [{ type: 'text', text: part.text }];
    }
    if (part.type === 'image') {
      return [part];
    }
    return [];
  });
  return {
    ...(message.id ? { id: message.id } : {}),
    role: 'user',
    content: content.length ? content : '',
  };
}

function sanitizeToolResult(message: ToolResultMessage, expected: PendingToolCall): ToolResultMessage {
  return {
    ...(message.id ? { id: message.id } : {}),
    role: 'toolResult',
    toolCallId: expected.id,
    toolName: expected.name,
    content: stringifyToolResultContent(message.content),
    ...(message.isError ? { isError: true } : {}),
  };
}

function stringifyToolResultContent(input: unknown): string {
  if (typeof input === 'string') {
    return input;
  }
  try {
    return JSON.stringify(input) ?? '';
  } catch {
    return String(input ?? '');
  }
}

function missingToolResult(toolCallId: string, toolName: string): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName,
    content: `Tool "${toolName}" did not produce a result before the conversation continued.`,
    isError: true,
  };
}

function remapCacheBreakpoints(
  breakpoints: ProviderCacheBreakpoint[] | undefined,
  countAfterOriginal: number[],
): ProviderCacheBreakpoint[] | undefined {
  if (!breakpoints?.length) {
    return undefined;
  }
  return breakpoints.map((breakpoint) => {
    if (breakpoint.after === 'stable') {
      return breakpoint;
    }
    const originalIndex = Math.max(0, Math.min(breakpoint.messageIndex, countAfterOriginal.length - 1));
    return {
      ...breakpoint,
      messageIndex: countAfterOriginal[originalIndex] ?? 0,
    };
  });
}
