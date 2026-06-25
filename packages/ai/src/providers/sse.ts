/**
 * Yield the payload of each `data:` line from a Server-Sent-Events body.
 * Shared by the OpenAI-compatible and Anthropic providers — both stream SSE; the
 * event type lives inside each JSON payload, so we only need the data lines.
 */
export async function* sseChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('data:')) {
          yield line.slice(5).trim();
        }
      }
    }
    const rest = buffer.trim();
    if (rest.startsWith('data:')) {
      yield rest.slice(5).trim();
    }
  } finally {
    reader.releaseLock();
  }
}
