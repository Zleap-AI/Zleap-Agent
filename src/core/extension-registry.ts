import type { AgentRunInput, ToolDefinition, UserRole } from "../types";

export type SafeExtensionToolExecutor = (input: {
  args: Record<string, unknown>;
  run: AgentRunInput;
  workspaceId: string;
  toolName: string;
}) => Promise<unknown> | unknown;

export type SafeExtensionTool = {
  name: string;
  workspaceId: string;
  description: string;
  parametersJson: string;
  riskLevel?: ToolDefinition["riskLevel"];
  promptSnippet?: string;
  promptGuidelinesJson?: string;
  executionMode?: ToolDefinition["executionMode"];
  execute: SafeExtensionToolExecutor;
};

export type SafeExtensionPromptTemplate = {
  name: string;
  description?: string;
  argumentHint?: string;
};

export type SafeExtensionFilesystemSkill = {
  name: string;
  description?: string;
};

export type SafeExtensionContext = {
  title: string;
  content: string;
  workspaceId?: string;
};

export type SafeExtensionLifecycleEvent = Readonly<{
  hook: "beforeAgentTurn" | "afterAgentTurn";
  conversationId: string;
  workspaceId?: string;
  userId: string;
  userRole: UserRole;
  metadata: Readonly<Record<string, unknown>>;
}>;

export type SafeExtensionCustomSessionEntry = {
  workspaceId?: string;
  title?: string;
  payload: Record<string, unknown>;
};

export type SafeExtensionLifecycleResult = void | SafeExtensionCustomSessionEntry | SafeExtensionCustomSessionEntry[];

export type SafeExtensionRegistration = {
  id: string;
  name: string;
  tools?: SafeExtensionTool[];
  promptTemplates?: SafeExtensionPromptTemplate[];
  filesystemSkills?: SafeExtensionFilesystemSkill[];
  safeContext?: SafeExtensionContext[];
  onLifecycleEvent?: (event: SafeExtensionLifecycleEvent) => SafeExtensionLifecycleResult;
};

export type SafeExtensionResourceIndex = {
  promptTemplates: Array<SafeExtensionPromptTemplate & { extensionId: string; scope: "extension" }>;
  filesystemSkills: Array<SafeExtensionFilesystemSkill & { extensionId: string; scope: "extension" }>;
  safeContext: Array<SafeExtensionContext & { extensionId: string }>;
};

export type SafeExtensionLifecycleFailure = {
  extensionId: string;
  error: string;
};

export type SafeExtensionLifecycleEmission = {
  failures: SafeExtensionLifecycleFailure[];
  customSessionEntries: Array<SafeExtensionCustomSessionEntry & { extensionId: string }>;
};

const RESERVED_TOOL_NAMES = new Set([
  "read",
  "write",
  "edit",
  "bash",
  "enterWorkspace",
  "exitWorkspace",
  "askUser",
  "finishTask",
  "searchMemory",
  "readMemory",
  "readSkill",
  "writeUserImpression",
  "writeAgentSelfImpression",
  "writeSkillMemory"
]);

export class SafeExtensionRegistry {
  private readonly extensions = new Map<string, SafeExtensionRegistration>();

  register(extension: SafeExtensionRegistration): void {
    this.validateExtension(extension);
    this.extensions.set(extension.id, {
      ...extension,
      tools: extension.tools ? [...extension.tools] : [],
      promptTemplates: extension.promptTemplates ? [...extension.promptTemplates] : [],
      filesystemSkills: extension.filesystemSkills ? [...extension.filesystemSkills] : [],
      safeContext: extension.safeContext ? [...extension.safeContext] : []
    });
  }

  listTools(workspaceId: string): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    for (const extension of this.extensions.values()) {
      for (const tool of extension.tools ?? []) {
        if (tool.workspaceId !== workspaceId) continue;
        tools.push({
          id: `extension:${extension.id}:tool:${tool.name}`,
          name: tool.name,
          workspaceId,
          description: tool.description,
          parametersJson: tool.parametersJson,
          promptSnippet: tool.promptSnippet ?? tool.description.replace(/\s+/g, " ").trim(),
          promptGuidelinesJson: tool.promptGuidelinesJson ?? "[]",
          executionMode: tool.executionMode ?? "parallel",
          riskLevel: tool.riskLevel ?? "low",
          bindingType: "runtime",
          bindingJson: JSON.stringify({ source: "extension", extensionId: extension.id }),
          createdAt: "",
          updatedAt: ""
        });
      }
    }
    return tools.sort((a, b) => a.name.localeCompare(b.name));
  }

  getTool(workspaceId: string, toolName: string): { extensionId: string; tool: SafeExtensionTool } | undefined {
    for (const extension of this.extensions.values()) {
      const tool = (extension.tools ?? []).find((item) => item.workspaceId === workspaceId && item.name === toolName);
      if (tool) return { extensionId: extension.id, tool };
    }
    return undefined;
  }

  resources(workspaceId: string): SafeExtensionResourceIndex {
    const promptTemplates: SafeExtensionResourceIndex["promptTemplates"] = [];
    const filesystemSkills: SafeExtensionResourceIndex["filesystemSkills"] = [];
    const safeContext: SafeExtensionResourceIndex["safeContext"] = [];
    for (const extension of this.extensions.values()) {
      for (const template of extension.promptTemplates ?? []) {
        promptTemplates.push({ ...template, extensionId: extension.id, scope: "extension" });
      }
      for (const skill of extension.filesystemSkills ?? []) {
        filesystemSkills.push({ ...skill, extensionId: extension.id, scope: "extension" });
      }
      for (const context of extension.safeContext ?? []) {
        if (context.workspaceId && context.workspaceId !== workspaceId) continue;
        safeContext.push({ ...context, extensionId: extension.id });
      }
    }
    return { promptTemplates, filesystemSkills, safeContext };
  }

  emitLifecycleEvent(event: SafeExtensionLifecycleEvent): SafeExtensionLifecycleEmission {
    const failures: SafeExtensionLifecycleFailure[] = [];
    const customSessionEntries: SafeExtensionLifecycleEmission["customSessionEntries"] = [];
    const immutableEvent = Object.freeze({
      ...event,
      metadata: Object.freeze({ ...event.metadata })
    });
    for (const extension of this.extensions.values()) {
      if (!extension.onLifecycleEvent) continue;
      try {
        const result = extension.onLifecycleEvent(immutableEvent);
        const entries = Array.isArray(result) ? result : result ? [result] : [];
        for (const entry of entries) {
          if (!entry.payload || typeof entry.payload !== "object" || Array.isArray(entry.payload)) {
            failures.push({
              extensionId: extension.id,
              error: "Extension custom session entry payload must be a JSON object."
            });
            continue;
          }
          if (entry.workspaceId && entry.workspaceId !== event.workspaceId) {
            failures.push({
              extensionId: extension.id,
              error: "Extension custom session entry workspaceId must match the lifecycle event workspace."
            });
            continue;
          }
          customSessionEntries.push({
            extensionId: extension.id,
            workspaceId: entry.workspaceId,
            title: typeof entry.title === "string" ? entry.title : undefined,
            payload: { ...entry.payload }
          });
        }
      } catch (error) {
        failures.push({
          extensionId: extension.id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return { failures, customSessionEntries };
  }

  private validateExtension(extension: SafeExtensionRegistration): void {
    if (!/^[A-Za-z0-9_.-]+$/.test(extension.id)) throw new Error("Extension id must contain only letters, numbers, dots, underscores, and hyphens.");
    for (const tool of extension.tools ?? []) {
      if (!/^[A-Za-z0-9_.-]+$/.test(tool.name)) throw new Error(`Invalid extension tool name: ${tool.name}`);
      if (tool.name.startsWith("runtime_context.")) throw new Error("Extension tools cannot use runtime_context.* names.");
      if (RESERVED_TOOL_NAMES.has(tool.name)) throw new Error(`Extension tool cannot override reserved runtime tool: ${tool.name}`);
      if (!tool.workspaceId) throw new Error(`Extension tool requires workspaceId: ${tool.name}`);
      try {
        JSON.parse(tool.parametersJson);
      } catch {
        throw new Error(`Extension tool parametersJson must be valid JSON: ${tool.name}`);
      }
    }
  }
}
