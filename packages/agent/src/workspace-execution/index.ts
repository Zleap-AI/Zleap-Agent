export type WorkspaceExecutionInput = {
  workspaceId: string;
  actorId: string;
  prompt: string;
  contextText?: string;
};

export type WorkspaceExecutionPlan = {
  workspaceId: string;
  actorId: string;
  prompt: string;
  modelContext: string[];
};

export class WorkspaceExecutionInputError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'WorkspaceExecutionInputError';
  }
}

export function prepareWorkspaceExecution(input: WorkspaceExecutionInput): WorkspaceExecutionPlan {
  const contextText = cleanOptionalString(input.contextText);
  return {
    workspaceId: cleanRequiredString('workspace_id_required', input.workspaceId),
    actorId: cleanRequiredString('actor_id_required', input.actorId),
    prompt: cleanRequiredString('prompt_required', input.prompt),
    modelContext: contextText ? [contextText] : [],
  };
}

function cleanOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function cleanRequiredString(code: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new WorkspaceExecutionInputError(code);
  }
  return trimmed;
}
