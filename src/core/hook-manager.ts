import type { ActorRole } from "../types";
import { Repositories } from "../db/repositories";

export type RuntimeHook =
  | "beforeAgentTurn"
  | "afterAgentTurn"
  | "beforeWorkspaceEnter"
  | "afterWorkspaceEnter"
  | "beforeToolCall"
  | "afterToolCall"
  | "beforeWorkspaceExit"
  | "afterWorkspaceExit"
  | "afterConversationWindow"
  | "afterEventExtracted"
  | "afterSkillExtracted";

export class HookManager {
  constructor(private readonly repos: Repositories) {}

  record(input: {
    hook: RuntimeHook;
    actorId?: string;
    actorRole?: ActorRole;
    resourceKind?: string;
    resourceId?: string;
    metadata?: Record<string, unknown>;
  }): void {
    this.repos.audit(
      input.actorId,
      input.actorRole ?? "system",
      `hook.${input.hook}`,
      input.resourceKind ?? "runtime_hook",
      input.resourceId,
      {
        hook: input.hook,
        ...(input.metadata ?? {})
      }
    );
  }
}
