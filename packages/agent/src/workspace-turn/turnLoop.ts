export type WorkspaceTurnStopReason = 'completed' | 'max-tool-calls' | 'model-stopped';

export type WorkspaceTurnInput = {
  prompt: string;
  actorId: string;
  spaceId: string;
  maxToolCalls: number;
};

export type WorkspaceTurnResult = {
  assistantText: string;
  toolCallCount: number;
  stopReason: WorkspaceTurnStopReason;
};

export type WorkspaceTurnRuntime<TResult extends WorkspaceTurnResult = WorkspaceTurnResult> = {
  runModelTurn(input: WorkspaceTurnInput): Promise<TResult>;
};

export async function runWorkspaceTurn<TResult extends WorkspaceTurnResult>(
  runtime: WorkspaceTurnRuntime<TResult>,
  input: WorkspaceTurnInput,
): Promise<TResult> {
  const result = await runtime.runModelTurn(input);
  if (workspaceTurnHitToolLimit(result.toolCallCount, input.maxToolCalls)) {
    return { ...result, stopReason: 'max-tool-calls' };
  }
  return result;
}

export function workspaceTurnHitToolLimit(toolCallCount: number, maxToolCalls: number): boolean {
  return toolCallCount >= maxToolCalls;
}

export function isWorkspaceTurnTruncated(reason: string | undefined): boolean {
  return reason === 'length' || reason === 'max_tokens';
}

export function expectedWorkspaceToolCall(reason: string | undefined): boolean {
  return reason === 'tool_calls' || reason === 'tool_use';
}
