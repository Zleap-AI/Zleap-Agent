import { createHash } from "node:crypto";
import type { AgentRunInput, MemoryRow, PolicyDecision, StoredMessage, UserRole, WorkspaceSession } from "../types";
import { Repositories } from "../db/repositories";
import { PolicyEngine } from "./policy-engine";
import { nowIso } from "./id";

const DEFAULT_EVENT_WINDOW_SIZE = 20;

type MemoryWriteInput = Partial<MemoryRow> & Pick<MemoryRow, "memoryType" | "title" | "summary" | "detail">;

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function stableId(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

function compactMessages(messages: StoredMessage[]): string {
  return messages
    .map((message) => `${message.role}: ${truncate(message.content.replace(/\s+/g, " ").trim(), 500)}`)
    .join("\n");
}

function summarizeJson(value: unknown, maxLength = 900): string {
  return truncate(JSON.stringify(value, null, 2), maxLength);
}

function containsPrivateLeak(value: string): boolean {
  return /([A-Za-z]:\\|\/Users\/|\/home\/|[\w.+-]+@[\w.-]+\.\w+|\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b|api[_-]?key|secret|token|password)/i.test(value);
}

function numberFromMetadata(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

const skillTriggerPattern = /(?:请|帮我|请帮我)?(?:总结(?:一下)?经验|沉淀(?:一下)?经验|记成经验|生成经验|写入经验|保存经验|提炼(?:一下)?经验|经验记忆|把(?:这个|这条)?经验(?:记下来|保存下来|沉淀下来)|skill memory|write skill|save skill|lesson learned)[:：]?\s*/i;

function isSkillTrigger(message: string, assistantMessage: string): boolean {
  return skillTriggerPattern.test(`${message}\n${assistantMessage}`);
}

function skillSeedFromTrigger(message: string, assistantMessage: string, workspaceId: string): {
  title: string;
  summary: string;
  detail: string;
  procedure: string[];
  appliesWhen: string[];
  avoidWhen: string[];
} {
  const combined = `${message}\n${assistantMessage}`.trim();
  const rawSeed = message.replace(skillTriggerPattern, "").trim() || assistantMessage.replace(skillTriggerPattern, "").trim() || combined;
  const normalized = truncate(rawSeed.replace(/\s+/g, " "), 360);
  const titleSeed = normalized
    .replace(/[。.!！?？].*$/, "")
    .replace(/^(在|当|如果|对于)\s*/, "")
    .trim();
  const title = truncate(titleSeed || `${workspaceId} 可复用经验`, 80);
  const procedure = [
    `识别任务是否符合这条经验：${normalized}`,
    `执行前先确认当前任务属于 ${workspaceId} workspace 的能力边界。`,
    `按经验执行并记录结果；如果结果不符合预期，更新或废弃这条经验。`
  ];
  return {
    title,
    summary: normalized,
    detail: [
      "触发来源：用户或 agent 主动要求沉淀经验。",
      `经验内容：${normalized}`,
      assistantMessage ? `当轮助手结果：${truncate(assistantMessage, 1000)}` : ""
    ].filter(Boolean).join("\n"),
    procedure,
    appliesWhen: [
      `${workspaceId} workspace 遇到相似任务时。`,
      `任务描述包含或等价于：${truncate(normalized, 160)}`
    ],
    avoidWhen: [
      "该经验依赖某个用户、私有项目、私密路径、账号或未脱敏数据时。",
      "当前任务不属于该 workspace 的工具和能力边界时。",
      "最近事件证据显示这条经验已经失败或过时。"
    ]
  };
}

function skillSeedFromEventBatch(workspaceId: string, processMemory: MemoryRow, resultMemory: MemoryRow): {
  title: string;
  summary: string;
  detail: string;
  procedure: string[];
  appliesWhen: string[];
  avoidWhen: string[];
} {
  const workspaceLabel = `${workspaceId} workspace`;
  const workspaceAdvice: Record<string, string[]> = {
    cli: [
      "先确认命令目标、风险级别和最小可执行命令。",
      "执行命令后记录退出状态、关键输出和错误摘要。",
      "把命令结果结构化返回给 main workspace，再决定是否进入其他 workspace。"
    ],
    file: [
      "先搜索或读取相关文件证据，确认修改/检查范围。",
      "只处理当前任务需要的最小文件集合，并保留关键观察。",
      "把产物、观察和后续建议结构化返回给 main workspace。"
    ],
    memory: [
      "先按 memory 类型、userId 和 workspaceId 过滤目标记录。",
      "执行新增、更新或删除前确认权限边界和审计原因。",
      "把变更结果和被拒绝原因结构化记录，便于后续调试。"
    ],
    browser: [
      "先明确页面目标、视口和需要验证的交互状态。",
      "执行交互或截图后记录可观察结果，而不是只依赖 DOM 判断。",
      "把验证结论、异常和建议下一步结构化返回。"
    ]
  };
  const procedure = workspaceAdvice[workspaceId] ?? [
    `先确认任务属于 ${workspaceLabel} 的能力边界。`,
    "执行最小必要操作并记录关键观察。",
    "用结构化结果返回状态、产物、错误和建议下一步。"
  ];
  const summary = `在 ${workspaceLabel} 处理类似任务时，采用已验证的 workspace 流程：${procedure.join(" ")}`;
  return {
    title: `${workspaceLabel} 可复用执行流程`,
    summary,
    detail: [
      "触发来源：event hook 自动候选。",
      `过程事件：${processMemory.title} - ${truncate(processMemory.summary, 260)}`,
      `结果事件：${resultMemory.title} - ${truncate(resultMemory.summary, 260)}`,
      "该 skill 只保留泛化流程和事件 id，不写入用户私有路径、账号或原始日志。"
    ].join("\n"),
    procedure,
    appliesWhen: [
      `${workspaceLabel} 后续遇到相似目标、工具集合和返回状态时。`,
      "已有 process/result event 证明该流程至少完成过一次。"
    ],
    avoidWhen: [
      "任务细节依赖某个用户、私有项目路径、账号或未脱敏日志时。",
      `当前任务不属于 ${workspaceLabel} 的工具和能力边界时。`,
      "最近事件证据显示该流程失败、过时或需要人工审批时。"
    ]
  };
}

export class MemoryService {
  private readonly policy = new PolicyEngine();
  private readonly eventWindowSize: number;

  constructor(private readonly repos: Repositories, eventWindowSize = Number(process.env.ZLEAP_EVENT_MEMORY_WINDOW ?? DEFAULT_EVENT_WINDOW_SIZE)) {
    this.eventWindowSize = Math.max(2, eventWindowSize || DEFAULT_EVENT_WINDOW_SIZE);
  }

  afterAgentTurn(input: {
    run: AgentRunInput;
    activeWorkspaceId: string;
    assistantMessage: string;
  }): MemoryRow[] {
    const writes: MemoryRow[] = [];
    const eventWrites = this.maybeWriteConversationWindowEvent(input.run, input.activeWorkspaceId);
    writes.push(...eventWrites);
    const eventSkill = this.maybeWriteSkillFromEventBatch(input.run, input.activeWorkspaceId, eventWrites, "afterConversationWindow");
    if (eventSkill) writes.push(eventSkill);
    const skill = this.maybeWriteSkillMemory(input.run, input.activeWorkspaceId, input.assistantMessage);
    if (skill) writes.push(skill);
    this.auditMemoryHooks(input.run, input.activeWorkspaceId, writes);
    return writes;
  }

  afterWorkspaceExit(input: {
    run: AgentRunInput;
    session: WorkspaceSession;
  }): MemoryRow[] {
    if (input.session.workspaceId === "main") return [];
    this.recordRecalledSkillUsage(input.run, input.session);
    const metadataBase = this.workspaceExitEvidence(input.run, input.session);
    const processRelationId = `event:${input.run.userId}:${input.session.workspaceId}:session:${input.session.taskId}:process`;
    const resultRelationId = `event:${input.run.userId}:${input.session.workspaceId}:session:${input.session.taskId}:result`;
    const writes: MemoryRow[] = [];

    const eventRelationScope = this.memoryRelationScope({
      memoryType: "event",
      userId: input.run.userId,
      workspaceId: input.session.workspaceId,
      title: "",
      summary: "",
      detail: ""
    });
    if (!this.repos.getMemoryByRelation("event", processRelationId, eventRelationScope)) {
      const processMemory = this.createOrSkip({
        memoryType: "event",
        userId: input.run.userId,
        workspaceId: input.session.workspaceId,
        relationId: processRelationId,
        version: 1,
        title: `${input.session.workspaceId} 工作空间过程`,
        summary: truncate(input.session.objective, 220),
        detail: [
          `任务目标：${input.session.task.objective}`,
          `父级上下文：${input.session.task.parentContextSummary}`,
          input.session.localContext.recalledEventMemories.length
            ? `召回的事件记忆：${summarizeJson(input.session.localContext.recalledEventMemories.map((memory) => ({ id: memory.id, title: memory.title, summary: memory.summary })))}`
            : "",
          input.session.localContext.recalledSkillMemories.length
            ? `召回的经验记忆：${summarizeJson(input.session.localContext.recalledSkillMemories.map((memory) => ({ id: memory.id, title: memory.title, summary: memory.summary })))}`
            : "",
          input.session.localContext.recentToolCalls.length
            ? `工作空间工具调用：${summarizeJson(input.session.localContext.recentToolCalls)}`
            : "",
          input.session.observations.length ? `过程观察：${input.session.observations.join("\n")}` : ""
        ].filter(Boolean).join("\n"),
        metadataJson: JSON.stringify({
          ...metadataBase,
          eventKind: "process",
          outcome: input.session.status === "completed" ? "success" : input.session.status
        })
      }, input.run.userId, input.run.userRole);
      if (processMemory) writes.push(processMemory);
    }

    if (!this.repos.getMemoryByRelation("event", resultRelationId, eventRelationScope)) {
      const resultMemory = this.createOrSkip({
        memoryType: "event",
        userId: input.run.userId,
        workspaceId: input.session.workspaceId,
        relationId: resultRelationId,
        version: 1,
        title: `${input.session.workspaceId} 工作空间结果`,
        summary: truncate(input.session.result.summary || input.session.summary, 220),
        detail: [
          `状态：${input.session.result.status}`,
          `结果摘要：${input.session.result.summary}`,
          input.session.result.artifacts.length ? `产物：${summarizeJson(input.session.result.artifacts)}` : "",
          input.session.result.observations.length ? `结果观察：${input.session.result.observations.join("\n")}` : "",
          input.session.result.errors.length ? `错误：${input.session.result.errors.join("\n")}` : "",
          input.session.result.suggestedNextSteps.length ? `建议下一步：${input.session.result.suggestedNextSteps.join("\n")}` : ""
        ].filter(Boolean).join("\n"),
        metadataJson: JSON.stringify({
          ...metadataBase,
          eventKind: "result",
          outcome: input.session.result.status === "completed" ? "success" : input.session.result.status,
          pairedProcessRelationId: processRelationId
        })
      }, input.run.userId, input.run.userRole);
      if (resultMemory) writes.push(resultMemory);
    }

    const eventSkill = this.maybeWriteSkillFromEventBatch(input.run, input.session.workspaceId, writes, "afterWorkspaceExit");
    if (eventSkill) writes.push(eventSkill);
    this.auditMemoryHooks(input.run, input.session.workspaceId, writes);
    return writes;
  }

  private recordRecalledSkillUsage(run: AgentRunInput, session: WorkspaceSession): void {
    const recalledSkills = session.localContext.recalledSkillMemories.filter((memory) =>
      memory.memoryType === "skill"
      && memory.workspaceId === session.workspaceId
      && !memory.userId
    );
    for (const skill of recalledSkills) {
      let current: MemoryRow;
      try {
        current = this.repos.getMemory(skill.id);
      } catch {
        continue;
      }
      const metadata = this.parseMetadata(current.metadataJson);
      const usageCount = numberFromMetadata(metadata.usageCount) + 1;
      const successCount = numberFromMetadata(metadata.successCount) + (session.result.status === "completed" ? 1 : 0);
      const failureCount = numberFromMetadata(metadata.failureCount) + (session.result.status === "failed" ? 1 : 0);
      const blockedCount = numberFromMetadata(metadata.blockedCount)
        + (session.result.status === "blocked" || session.result.status === "needs_user_input" || session.result.status === "needs_approval" || session.result.status === "running" ? 1 : 0);
      const nextMetadata = {
        ...metadata,
        usageCount,
        successCount,
        failureCount,
        blockedCount,
        lastUsedAt: nowIso(),
        lastOutcome: session.result.status,
        lastConversationId: session.conversationId,
        lastWorkspaceSessionId: session.id,
        lastTaskId: session.taskId
      };
      this.repos.updateMemory(current.id, { metadataJson: JSON.stringify(nextMetadata) }, run.userId, "system");
      this.repos.audit(run.userId, "system", "skill_usage_recorded", "memory", current.id, {
        conversationId: session.conversationId,
        workspaceId: session.workspaceId,
        workspaceSessionId: session.id,
        taskId: session.taskId,
        status: session.result.status,
        usageCount,
        successCount,
        failureCount,
        blockedCount
      });
    }
  }

  writeMemory(input: {
    run: AgentRunInput;
    actorRole: UserRole | "system" | "agent";
    memory: MemoryWriteInput;
  }): MemoryRow | undefined {
    if (input.actorRole === "system" || input.actorRole === "agent") {
      return this.createOrSkip(input.memory, input.run.userId, input.run.userRole);
    }
    return this.createOrSkip(input.memory, input.run.userId, input.actorRole);
  }

  createMemoryRecord(input: {
    actorId: string;
    actorRole: UserRole;
    memory: MemoryWriteInput;
    conversationId?: string;
  }): MemoryRow {
    const conversationId = this.checkedApiConversationId(input.actorId, input.actorRole, input.conversationId);
    if (input.memory.memoryType === "skill" && input.actorRole !== "creator") {
      throw new Error("Direct shared skill memory management requires creator role.");
    }
    const persisted = this.persistMemory(input.memory, input.actorId, input.actorRole);
    if (!persisted.memory) throw new Error(persisted.reason ?? "Memory create rejected by runtime policy.");
    this.repos.audit(input.actorId, input.actorRole, "memory_api_create", "memory", persisted.memory.id, {
      conversationId,
      memoryType: persisted.memory.memoryType,
      workspaceId: persisted.memory.workspaceId
    });
    return persisted.memory;
  }

  listMemoryRecords(input: {
    actorId: string;
    actorRole: UserRole;
    filters?: { query?: string; memoryType?: string; userId?: string; agentId?: string; workspaceId?: string };
  }): MemoryRow[] {
    const filters = input.filters ?? {};
    const records = this.repos.listMemories(filters);
    if (input.actorRole === "creator") return records;
    return records.filter((memory) => this.canReadMemoryRecord(input.actorId, memory));
  }

  updateMemoryRecord(input: {
    actorId: string;
    actorRole: UserRole;
    memoryId: string;
    patch: Partial<MemoryRow>;
    conversationId?: string;
  }): MemoryRow {
    const conversationId = this.checkedApiConversationId(input.actorId, input.actorRole, input.conversationId);
    const result = this.executeUpdateMemoryTool(this.apiRun(input.actorId, input.actorRole, conversationId), {
      id: input.memoryId,
      ...input.patch
    });
    if (!result.ok || !result.memory) {
      const error = result.result && typeof result.result === "object" && "error" in result.result
        ? String((result.result as { error?: unknown }).error)
        : "Memory update rejected by runtime policy.";
      throw new Error(error);
    }
    this.repos.audit(input.actorId, input.actorRole, "memory_api_update", "memory", result.memory.id, {
      conversationId,
      memoryType: result.memory.memoryType,
      workspaceId: result.memory.workspaceId,
      updatedFields: Object.keys(input.patch)
    });
    return result.memory;
  }

  deleteMemoryRecord(input: {
    actorId: string;
    actorRole: UserRole;
    memoryId: string;
    deleteReason?: string;
    conversationId?: string;
  }): void {
    const conversationId = this.checkedApiConversationId(input.actorId, input.actorRole, input.conversationId);
    const result = this.executeDeleteMemoryTool(this.apiRun(input.actorId, input.actorRole, conversationId), {
      id: input.memoryId,
      deleteReason: input.deleteReason
    });
    if (!result.ok) {
      const error = result.result && typeof result.result === "object" && "error" in result.result
        ? String((result.result as { error?: unknown }).error)
        : "Memory delete rejected by runtime policy.";
      throw new Error(error);
    }
    this.repos.audit(input.actorId, input.actorRole, "memory_api_delete", "memory", input.memoryId, {
      conversationId,
      deleteReason: input.deleteReason
    });
  }

  executeMemoryTool(input: {
    run: AgentRunInput;
    activeWorkspaceId?: string;
    activeWorkspaceSessionId?: string;
    activeTaskId?: string;
    toolName: string;
    argumentsJson: string;
  }): { ok: boolean; result: unknown; memory?: MemoryRow } {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(input.argumentsJson || "{}") as Record<string, unknown>;
    } catch (error) {
      return { ok: false, result: { error: "Invalid JSON arguments." } };
    }

    const textArg = (name: string) => typeof args[name] === "string" ? args[name] as string : "";
    const boolArg = (name: string) => typeof args[name] === "boolean" ? args[name] as boolean : false;
    const numberArg = (name: string, fallback: number) => typeof args[name] === "number" && Number.isFinite(args[name]) ? args[name] as number : fallback;
    const stringArrayArg = (name: string) => Array.isArray(args[name])
      ? (args[name] as unknown[]).filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    const base = {
      title: textArg("title"),
      summary: textArg("summary"),
      detail: textArg("detail")
    };

    if (input.toolName === "searchMemory") {
      const scopeError = this.rejectRuntimeScopeArguments(args, ["userId", "agentId", "workspaceId"]);
      if (scopeError) return { ok: false, result: { error: scopeError } };
      const memoryType = textArg("memoryType");
      const memories = this.listMemoryRecords({
        actorId: input.run.userId,
        actorRole: "user",
        filters: {
          query: textArg("query") || undefined,
          memoryType: ["impression", "event", "skill"].includes(memoryType) ? memoryType : undefined
        }
      }).filter((memory) => this.isVisibleInActiveWorkspace(memory, input.activeWorkspaceId));
      return {
        ok: true,
        result: {
          memories
        }
      };
    }

    let memory: MemoryWriteInput | undefined;
    if (input.toolName === "writeUserImpression") {
      const scopeError = this.rejectRuntimeScopeArguments(args, ["userId", "agentId", "workspaceId"]);
      if (scopeError) return { ok: false, result: { error: scopeError } };
      const runtimeEvidence = this.runtimeMemoryEvidence(input.activeWorkspaceSessionId, input.activeTaskId);
      memory = {
        ...base,
        memoryType: "impression",
        userId: input.run.userId,
        relationId: `impression:user:${input.run.userId}:${stableId(`${base.title}:${base.summary}`)}`,
        metadataJson: JSON.stringify({
          source: "memoryToolCall",
          impressionKind: "userImpression",
          conversationId: input.run.conversationId,
          activeWorkspaceId: input.activeWorkspaceId,
          ...runtimeEvidence
        })
      };
    }
    if (input.toolName === "writeAgentSelfImpression") {
      const scopeError = this.rejectRuntimeScopeArguments(args, ["userId", "agentId", "workspaceId"]);
      if (scopeError) return { ok: false, result: { error: scopeError } };
      const runtimeEvidence = this.runtimeMemoryEvidence(input.activeWorkspaceSessionId, input.activeTaskId);
      memory = {
        ...base,
        memoryType: "impression",
        agentId: input.run.agentId,
        relationId: `impression:agent:${input.run.agentId}:${stableId(`${base.title}:${base.summary}`)}`,
        metadataJson: JSON.stringify({
          source: "memoryToolCall",
          impressionKind: "agentSelf",
          conversationId: input.run.conversationId,
          activeWorkspaceId: input.activeWorkspaceId,
          ...runtimeEvidence
        })
      };
    }
    if (input.toolName === "writeSkillMemory") {
      const scopeError = this.rejectRuntimeScopeArguments(args, ["userId", "agentId", "workspaceId"]);
      if (scopeError) return { ok: false, result: { error: scopeError } };
      const workspaceScope = this.requireActiveWorkspaceScope(input.activeWorkspaceId);
      if (!workspaceScope.allowed) return { ok: false, result: { error: workspaceScope.reason } };
      const workspaceId = workspaceScope.workspaceId;
      const procedure = stringArrayArg("procedure");
      const appliesWhen = stringArrayArg("appliesWhen");
      const avoidWhen = stringArrayArg("avoidWhen");
      const evidenceEventIds = stringArrayArg("evidenceEventIds");
      const confidence = Math.max(0, Math.min(1, numberArg("confidence", evidenceEventIds.length > 0 ? 0.7 : 0.5)));
      const runtimeEvidence = this.runtimeMemoryEvidence(input.activeWorkspaceSessionId, input.activeTaskId);
      memory = {
        ...base,
        memoryType: "skill",
        workspaceId,
        relationId: `skill:${workspaceId}:${stableId(`${base.title}:${base.summary}`)}`,
        metadataJson: JSON.stringify({
          source: "memoryToolCall",
          conversationId: input.run.conversationId,
          requestedBy: "agent",
          activeWorkspaceId: input.activeWorkspaceId,
          ...runtimeEvidence,
          desensitized: boolArg("desensitized"),
          evidenceEventIds,
          confidence,
          qualityGate: {
            reusable: procedure.length > 0,
            userPrivateDetailRemoved: boolArg("desensitized"),
            workspaceScoped: Boolean(workspaceId),
            evidenceCount: evidenceEventIds.length
          },
          procedure,
          appliesWhen,
          avoidWhen
        })
      };
    }
    if (!memory) return { ok: false, result: { error: `Unsupported memory tool: ${input.toolName}` } };
    if (!memory.title || !memory.summary || !memory.detail) return { ok: false, result: { error: "title, summary, and detail are required." } };

    const existing = memory.relationId ? this.repos.getMemoryByRelation(memory.memoryType, memory.relationId, this.memoryRelationScope(memory)) : undefined;
    const persisted = existing
      ? { memory: existing }
      : this.persistMemory(memory, input.run.userId, input.run.userRole);
    if (!persisted.memory) return { ok: false, result: { error: persisted.reason ?? "Memory write rejected by runtime policy." } };
    return { ok: true, result: { memory: persisted.memory }, memory: persisted.memory };
  }

  private runtimeMemoryEvidence(activeWorkspaceSessionId?: string, activeTaskId?: string): Record<string, unknown> {
    return {
      ...(activeTaskId ? { taskId: activeTaskId, taskIds: [activeTaskId] } : {}),
      ...(activeWorkspaceSessionId ? { workspaceSessionId: activeWorkspaceSessionId, workspaceSessionIds: [activeWorkspaceSessionId] } : {})
    };
  }

  private memoryRelationScope(memory: Partial<MemoryRow> & Pick<MemoryRow, "memoryType">): { userId?: string | null; agentId?: string | null; workspaceId?: string | null } {
    return {
      userId: memory.userId ?? null,
      agentId: memory.agentId ?? null,
      workspaceId: memory.workspaceId ?? null
    };
  }

  private rejectRuntimeScopeArguments(args: Record<string, unknown>, names: string[]): string | undefined {
    const provided = names.filter((name) => Object.prototype.hasOwnProperty.call(args, name));
    if (provided.length === 0) return undefined;
    return `Runtime memory scope is code-bound; do not pass ${provided.join(", ")} in function-call arguments.`;
  }

  private requireActiveWorkspaceScope(activeWorkspaceId: string | undefined): { allowed: true; workspaceId: string } | { allowed: false; reason: string } {
    if (activeWorkspaceId) return { allowed: true, workspaceId: activeWorkspaceId };
    return { allowed: false, reason: "Runtime memory writes require an active workspace supplied by runtime." };
  }

  private isVisibleInActiveWorkspace(memory: MemoryRow, activeWorkspaceId?: string): boolean {
    if (!activeWorkspaceId) return true;
    if (memory.memoryType !== "event" && memory.memoryType !== "skill") return true;
    return memory.workspaceId === activeWorkspaceId;
  }

  private maybeWriteConversationWindowEvent(run: AgentRunInput, workspaceId: string): MemoryRow[] {
    const messageCount = this.repos.countMessages(run.conversationId);
    const sessions = this.repos.listWorkspaceSessions(run.conversationId);
    const toolCalls = this.repos.listToolCalls(run.conversationId);
    const completedWindows = Math.floor(messageCount / this.eventWindowSize);
    if (completedWindows < 1) return [];

    const writes: MemoryRow[] = [];
    for (let windowIndex = 1; windowIndex <= completedWindows; windowIndex += 1) {
      const start = (windowIndex - 1) * this.eventWindowSize;
      const end = windowIndex * this.eventWindowSize;
      const windowRelationScope = `event:${run.userId}:${workspaceId}:${run.conversationId}:window:${windowIndex}`;
      const processRelationId = `${windowRelationScope}:process`;
      const resultRelationId = `${windowRelationScope}:result`;
      const eventRelationScope = this.memoryRelationScope({
        memoryType: "event",
        userId: run.userId,
        workspaceId,
        title: "",
        summary: "",
        detail: ""
      });
      if (this.repos.getMemoryByRelation("event", processRelationId, eventRelationScope) && this.repos.getMemoryByRelation("event", resultRelationId, eventRelationScope)) continue;

      const windowMessages = this.repos.listMessagesWindow(run.conversationId, start, this.eventWindowSize);
      if (windowMessages.length < this.eventWindowSize) continue;

      const firstUser = windowMessages.find((message) => message.role === "user")?.content ?? run.message;
      const lastAssistant = [...windowMessages].reverse().find((message) => message.role === "assistant")?.content ?? "";
      const evidenceMessageIds = windowMessages.map((message) => message.id);
      const windowStartAt = windowMessages[0]?.createdAt ?? "";
      const windowEndAt = windowMessages.at(-1)?.createdAt ?? windowStartAt;
      const windowToolCalls = toolCalls.filter((toolCall) =>
        (toolCall.workspaceId === workspaceId || toolCall.workspaceId === "main")
        && isTimestampInRange(toolCall.createdAt, windowStartAt, windowEndAt)
      );
      const relatedSessions = sessions.filter((session) =>
        (session.workspaceId === workspaceId || session.workspaceId === "main")
        && sessionOverlapsRange(session, windowStartAt, windowEndAt)
      );
      const evidenceBase = {
        source: "afterConversationWindow",
        conversationId: run.conversationId,
        workspaceId,
        messageFrom: windowMessages[0]?.id,
        messageTo: windowMessages.at(-1)?.id,
        windowStartAt,
        windowEndAt,
        evidenceMessageIds,
        workspaceSessionIds: relatedSessions.map((session) => session.id),
        taskIds: relatedSessions.map((session) => session.taskId),
        toolCallIds: windowToolCalls.map((toolCall) => toolCall.id),
        messageCount: windowMessages.length,
        autoGenerated: true
      };

      if (!this.repos.getMemoryByRelation("event", processRelationId, eventRelationScope)) {
        const processMemory = this.createOrSkip({
          memoryType: "event",
          userId: run.userId,
          workspaceId,
          relationId: processRelationId,
          version: 1,
          title: `过程事件 ${windowIndex}`,
          summary: truncate(`过程：${firstUser}`, 220),
          detail: [
            `窗口范围：第 ${start + 1}-${end} 条消息`,
            "窗口消息：",
            compactMessages(windowMessages),
            relatedSessions.length ? `相关 workspace session：${summarizeJson(relatedSessions.map((session) => session.result))}` : "",
            windowToolCalls.length ? `相关工具调用：${summarizeJson(windowToolCalls)}` : ""
          ].filter(Boolean).join("\n"),
          metadataJson: JSON.stringify({
            ...evidenceBase,
            eventKind: "process",
            outcome: "partial"
          })
        }, run.userId, run.userRole);
        if (processMemory) writes.push(processMemory);
      }

      if (!this.repos.getMemoryByRelation("event", resultRelationId, eventRelationScope)) {
        const resultMemory = this.createOrSkip({
          memoryType: "event",
          userId: run.userId,
          workspaceId,
          relationId: resultRelationId,
          version: 1,
          title: `结果事件 ${windowIndex}`,
          summary: truncate(lastAssistant || `用户请求：${firstUser}`, 220),
          detail: [
            `窗口范围：第 ${start + 1}-${end} 条消息`,
            `用户起始请求：${truncate(firstUser, 700)}`,
            lastAssistant ? `最近助手结果：${truncate(lastAssistant, 1000)}` : "",
            relatedSessions.length ? `workspace result evidence：${summarizeJson(relatedSessions.map((session) => session.result))}` : ""
          ].filter(Boolean).join("\n"),
          metadataJson: JSON.stringify({
            ...evidenceBase,
            eventKind: "result",
            outcome: lastAssistant ? "success" : "partial",
            pairedProcessRelationId: processRelationId
          })
        }, run.userId, run.userRole);
        if (resultMemory) writes.push(resultMemory);
      }
    }
    return writes;
  }

  private workspaceExitEvidence(run: AgentRunInput, session: WorkspaceSession): Record<string, unknown> {
    const sessionEndAt = session.completedAt ?? session.startedAt;
    const messages = dedupeById([
      ...this.repos.listMessagesBefore(run.conversationId, session.startedAt, 1),
      ...this.repos.listMessagesInRange(run.conversationId, session.startedAt, sessionEndAt, this.eventWindowSize)
    ]).slice(-this.eventWindowSize);
    const toolCalls = this.repos
      .listToolCalls(run.conversationId)
      .filter((toolCall) =>
        toolCall.workspaceSessionId === session.id
        || toolCall.taskId === session.taskId
        || (
          toolCall.workspaceId === session.workspaceId
          && !toolCall.workspaceSessionId
          && !toolCall.taskId
          && isTimestampInRange(toolCall.createdAt, session.startedAt, sessionEndAt)
        )
      );
    return {
      source: "afterWorkspaceExit",
      conversationId: run.conversationId,
      workspaceId: session.workspaceId,
      workspaceSessionId: session.id,
      workspaceSessionIds: [session.id],
      taskId: session.taskId,
      taskIds: [session.taskId],
      workspaceSessionStartedAt: session.startedAt,
      workspaceSessionCompletedAt: session.completedAt,
      evidenceMessageFrom: messages[0]?.id,
      evidenceMessageTo: messages.at(-1)?.id,
      evidenceMessageIds: messages.map((message) => message.id),
      toolCallIds: toolCalls.map((toolCall) => toolCall.id),
      status: session.status,
      autoGenerated: true
    };
  }

  private maybeWriteSkillMemory(run: AgentRunInput, activeWorkspaceId: string, assistantMessage: string): MemoryRow | undefined {
    if (!isSkillTrigger(run.message, assistantMessage)) return undefined;
    const workspaceId = activeWorkspaceId;
    const seed = skillSeedFromTrigger(run.message, assistantMessage, workspaceId);
    const relationId = `skill:${workspaceId}:${stableId(seed.summary)}`;
    if (this.repos.getMemoryByRelation("skill", relationId, this.memoryRelationScope({ memoryType: "skill", workspaceId, title: "", summary: "", detail: "" }))) return undefined;
    const evidenceEvents = this.repos.listMemories({
      memoryType: "event",
      userId: run.userId,
      workspaceId
    }).filter((memory) => {
      const metadata = this.parseMetadata(memory.metadataJson);
      return metadata.conversationId === run.conversationId;
    }).slice(0, 5);
    const evidenceEventIds = evidenceEvents.map((memory) => memory.id);
    return this.createOrSkip({
      memoryType: "skill",
      workspaceId,
      relationId,
      title: seed.title,
      summary: truncate(seed.summary, 220),
      detail: seed.detail,
      metadataJson: JSON.stringify({
        source: "activeSkillTrigger",
        conversationId: run.conversationId,
        requestedBy: "user_or_agent",
        desensitized: true,
        evidenceEventIds,
        confidence: evidenceEventIds.length > 0 ? 0.68 : 0.45,
        qualityGate: {
          reusable: true,
          userPrivateDetailRemoved: true,
          workspaceScoped: true,
          evidenceCount: evidenceEventIds.length
        },
        procedure: seed.procedure,
        appliesWhen: seed.appliesWhen,
        avoidWhen: seed.avoidWhen
      })
    }, run.userId, run.userRole);
  }

  private maybeWriteSkillFromEventBatch(
    run: AgentRunInput,
    workspaceId: string,
    eventWrites: MemoryRow[],
    triggerSource: "afterConversationWindow" | "afterWorkspaceExit"
  ): MemoryRow | undefined {
    if (workspaceId === "main") return undefined;
    const eventMemories = eventWrites.filter((memory) => memory.memoryType === "event" && memory.workspaceId === workspaceId);
    if (eventMemories.length < 2) return undefined;
    const processMemory = eventMemories.find((memory) => this.parseMetadata(memory.metadataJson).eventKind === "process");
    const resultMemory = eventMemories.find((memory) => this.parseMetadata(memory.metadataJson).eventKind === "result");
    if (!processMemory || !resultMemory) return undefined;

    const resultMetadata = this.parseMetadata(resultMemory.metadataJson);
    const outcome = typeof resultMetadata.outcome === "string" ? resultMetadata.outcome : "";
    if (outcome !== "success" && outcome !== "completed") return undefined;

    const seed = skillSeedFromEventBatch(workspaceId, processMemory, resultMemory);
    const relationId = `skill:${workspaceId}:event-hook:${stableId(seed.summary)}`;
    if (this.repos.getMemoryByRelation("skill", relationId, this.memoryRelationScope({ memoryType: "skill", workspaceId, title: "", summary: "", detail: "" }))) return undefined;

    const evidenceEventIds = eventMemories.map((memory) => memory.id);
    return this.createOrSkip({
      memoryType: "skill",
      workspaceId,
      relationId,
      title: seed.title,
      summary: truncate(seed.summary, 220),
      detail: seed.detail,
      metadataJson: JSON.stringify({
        source: "eventSkillCandidate",
        triggerSource,
        conversationId: run.conversationId,
        requestedBy: "runtime_hook",
        desensitized: true,
        evidenceEventIds,
        confidence: triggerSource === "afterWorkspaceExit" ? 0.62 : 0.52,
        qualityGate: {
          reusable: true,
          userPrivateDetailRemoved: true,
          workspaceScoped: true,
          evidenceCount: evidenceEventIds.length
        },
        procedure: seed.procedure,
        appliesWhen: seed.appliesWhen,
        avoidWhen: seed.avoidWhen
      })
    }, run.userId, run.userRole);
  }

  private createOrSkip(memory: MemoryWriteInput, actorId: string, actorRole: UserRole): MemoryRow | undefined {
    return this.persistMemory(memory, actorId, actorRole).memory;
  }

  private persistMemory(memory: MemoryWriteInput, actorId: string, actorRole: UserRole): { memory?: MemoryRow; reason?: string } {
    const decision = this.memoryWriteDecision(memory, actorId, actorRole);
    if (!decision.allowed) {
      const metadata = this.parseMetadata(memory.metadataJson ?? "{}");
      this.repos.audit(actorId, actorRole, "memory_write_rejected", "memory", undefined, {
        reason: decision.reason,
        memoryType: memory.memoryType,
        workspaceId: memory.workspaceId,
        conversationId: this.safeAuditConversationId(metadata, actorId, actorRole)
      });
      return { reason: decision.reason };
    }
    return { memory: this.repos.createMemory(memory, actorId, actorRole) };
  }

  private memoryWriteDecision(memory: MemoryWriteInput, actorId: string, actorRole: UserRole): PolicyDecision {
    if (memory.metadataJson && !this.hasValidMetadataJson(memory.metadataJson)) {
      return { allowed: false, reason: "metadataJson must be valid JSON." };
    }
    const baseDecision = this.policy.canWriteMemory({ role: actorRole, userId: actorId, memory });
    if (!baseDecision.allowed) return baseDecision;
    const conversationDecision = this.canUseMetadataConversation(memory, actorId, actorRole);
    if (!conversationDecision.allowed) return conversationDecision;

    if (memory.memoryType !== "event" && memory.memoryType !== "skill") return baseDecision;
    if (!memory.workspaceId) return { allowed: false, reason: `${memory.memoryType} memory requires a target workspace.` };

    let workspace;
    try {
      workspace = this.repos.getWorkspace(memory.workspaceId);
    } catch {
      return { allowed: false, reason: `Memory target workspace does not exist: ${memory.workspaceId}` };
    }

    if (memory.memoryType === "event" && !workspace.memoryPolicy.eventWriteEnabled) {
      return { allowed: false, reason: `Event memory writes are disabled for workspace: ${memory.workspaceId}` };
    }
    if (memory.memoryType === "event") {
      const eventStructureDecision = this.canWriteEventStructure(memory);
      if (!eventStructureDecision.allowed) return eventStructureDecision;
    }
    if (memory.memoryType === "skill" && !workspace.memoryPolicy.skillWriteEnabled) {
      return { allowed: false, reason: `Skill memory writes are disabled for workspace: ${memory.workspaceId}` };
    }
    if (memory.memoryType === "skill") {
      const skillQualityDecision = this.canWriteSkillQuality(memory);
      if (!skillQualityDecision.allowed) return skillQualityDecision;
      const skillEvidenceDecision = this.canUseSkillEvidence(memory, actorId, actorRole);
      if (!skillEvidenceDecision.allowed) return skillEvidenceDecision;
    }
    return baseDecision;
  }

  private canUseMetadataConversation(memory: MemoryWriteInput, actorId: string, actorRole: UserRole): PolicyDecision {
    const metadata = this.parseMetadata(memory.metadataJson ?? "{}");
    const conversationId = typeof metadata.conversationId === "string" ? metadata.conversationId.trim() : "";
    if (!conversationId || actorRole === "creator") return { allowed: true };
    const conversation = this.repos.getConversation(conversationId);
    if (!conversation) {
      return { allowed: false, reason: "Memory metadata.conversationId must reference an existing conversation for non-creator writes." };
    }
    if (conversation.userId !== actorId) {
      return { allowed: false, reason: "Memory metadata.conversationId belongs to a different user." };
    }
    return { allowed: true };
  }

  private safeAuditConversationId(metadata: Record<string, unknown>, actorId: string, actorRole: UserRole): string | undefined {
    const conversationId = typeof metadata.conversationId === "string" ? metadata.conversationId.trim() : "";
    if (!conversationId) return undefined;
    if (actorRole === "creator") return conversationId;
    const conversation = this.repos.getConversation(conversationId);
    return conversation?.userId === actorId ? conversationId : undefined;
  }

  private checkedApiConversationId(actorId: string, actorRole: UserRole, conversationId?: string): string | undefined {
    const trimmed = typeof conversationId === "string" ? conversationId.trim() : "";
    if (!trimmed) return undefined;
    if (actorRole === "creator") return trimmed;
    const conversation = this.repos.getConversation(trimmed);
    if (!conversation) {
      throw new Error("Memory API conversationId must reference an existing conversation for non-creator operations.");
    }
    if (conversation.userId !== actorId) {
      throw new Error("Memory API conversationId belongs to a different user.");
    }
    return trimmed;
  }

  private canWriteEventStructure(memory: MemoryWriteInput): PolicyDecision {
    const metadata = this.parseMetadata(memory.metadataJson ?? "{}");
    const conversationId = typeof metadata.conversationId === "string" ? metadata.conversationId.trim() : "";
    if (!conversationId) {
      return { allowed: false, reason: "Event memory requires metadata.conversationId for audit and tenant isolation." };
    }
    const eventKind = typeof metadata.eventKind === "string" ? metadata.eventKind.trim() : "";
    const allowedKinds = new Set(["process", "result", "manual", "agent_requested"]);
    if (!allowedKinds.has(eventKind)) {
      return { allowed: false, reason: "Event memory requires metadata.eventKind to be process, result, manual, or agent_requested." };
    }
    return { allowed: true };
  }

  private canWriteSkillQuality(memory: MemoryWriteInput): PolicyDecision {
    const metadata = this.parseMetadata(memory.metadataJson ?? "{}");
    const procedure = Array.isArray(metadata.procedure) ? metadata.procedure : [];
    const appliesWhen = Array.isArray(metadata.appliesWhen) ? metadata.appliesWhen : [];
    const avoidWhen = Array.isArray(metadata.avoidWhen) ? metadata.avoidWhen : [];
    const qualityGate = metadata.qualityGate && typeof metadata.qualityGate === "object"
      ? metadata.qualityGate as Record<string, unknown>
      : {};

    if (metadata.desensitized !== true || qualityGate.userPrivateDetailRemoved !== true) {
      return { allowed: false, reason: "Skill memory requires explicit desensitized=true and userPrivateDetailRemoved=true." };
    }
    if (procedure.length === 0) return { allowed: false, reason: "Skill memory requires at least one reusable procedure step." };
    if (appliesWhen.length === 0) return { allowed: false, reason: "Skill memory requires appliesWhen conditions." };
    if (avoidWhen.length === 0) return { allowed: false, reason: "Skill memory requires avoidWhen conditions." };
    const confidence = typeof metadata.confidence === "number" ? metadata.confidence : 0;
    if (confidence < 0.4) return { allowed: false, reason: "Skill memory confidence is too low to share." };
    if (containsPrivateLeak(`${memory.title}\n${memory.summary}\n${memory.detail}\n${JSON.stringify(metadata)}`)) {
      return { allowed: false, reason: "Skill memory appears to contain private user/project details and must be generalized before sharing." };
    }
    return { allowed: true };
  }

  private canUseSkillEvidence(memory: MemoryWriteInput, actorId: string, actorRole: UserRole): PolicyDecision {
    const metadata = this.parseMetadata(memory.metadataJson ?? "{}");
    if (metadata.evidenceEventIds === undefined) return { allowed: true };
    if (!Array.isArray(metadata.evidenceEventIds)) {
      return { allowed: false, reason: "Skill evidenceEventIds must be an array of event memory ids." };
    }

    const evidenceEventIds = metadata.evidenceEventIds;
    const conversationId = typeof metadata.conversationId === "string" && metadata.conversationId.trim()
      ? metadata.conversationId
      : undefined;
    for (const value of evidenceEventIds) {
      if (typeof value !== "string" || !value.trim()) {
        return { allowed: false, reason: "Skill evidenceEventIds must contain only non-empty event memory ids." };
      }

      let evidence: MemoryRow;
      try {
        evidence = this.repos.getMemory(value);
      } catch {
        return { allowed: false, reason: `Skill evidence event not found: ${value}` };
      }

      if (evidence.memoryType !== "event") {
        return { allowed: false, reason: `Skill evidence must reference event memory: ${value}` };
      }
      if (evidence.workspaceId !== memory.workspaceId) {
        return { allowed: false, reason: `Skill evidence event must belong to the same workspace: ${value}` };
      }
      if (actorRole !== "creator" && evidence.userId !== actorId) {
        return { allowed: false, reason: `Skill evidence event belongs to another user: ${value}` };
      }
      if (conversationId) {
        const evidenceMetadata = this.parseMetadata(evidence.metadataJson);
        if (evidenceMetadata.conversationId !== conversationId) {
          return { allowed: false, reason: `Skill evidence event must belong to the same conversation: ${value}` };
        }
      }
    }
    return { allowed: true };
  }

  private executeUpdateMemoryTool(run: AgentRunInput, args: Record<string, unknown>, activeWorkspaceId?: string, codeBoundRuntimeScope = false): { ok: boolean; result: unknown; memory?: MemoryRow } {
    const id = typeof args.id === "string" ? args.id : "";
    if (!id) return { ok: false, result: { error: "id is required." } };
    if (codeBoundRuntimeScope) {
      const scopeError = this.rejectRuntimeScopeArguments(args, ["memoryType", "userId", "agentId", "workspaceId", "relationId", "version"]);
      if (scopeError) return { ok: false, result: { error: scopeError } };
    }

    let current: MemoryRow;
    try {
      current = this.repos.getMemory(id);
    } catch (error) {
      return { ok: false, result: { error: error instanceof Error ? error.message : String(error) } };
    }

    const decision = this.memoryManageDecision({ run, memory: current, action: "update" });
    if (!decision.allowed) {
      this.auditMemoryManagementRejected(run, current, "update", decision.reason);
      return { ok: false, result: { error: decision.reason ?? "Memory update rejected by runtime policy." } };
    }
    const activeWorkspaceDecision = this.canUseMemoryRecordInActiveWorkspace(current, activeWorkspaceId);
    if (!activeWorkspaceDecision.allowed) {
      this.auditMemoryManagementRejected(run, current, "update", activeWorkspaceDecision.reason);
      return { ok: false, result: { error: activeWorkspaceDecision.reason ?? "Memory update rejected by active workspace policy." } };
    }

    const patch: Partial<MemoryRow> = {};
    for (const key of ["userId", "agentId", "workspaceId", "relationId", "title", "summary", "detail", "metadataJson"] as const) {
      if (typeof args[key] === "string") patch[key] = args[key];
    }
    if (typeof args.memoryType === "string") {
      if (!["impression", "event", "skill"].includes(args.memoryType)) {
        return { ok: false, result: { error: "memoryType must be impression, event, or skill." } };
      }
      patch.memoryType = args.memoryType as MemoryRow["memoryType"];
    }
    if (typeof args.version === "number" && Number.isFinite(args.version)) patch.version = Math.max(1, Math.floor(args.version));
    if (Object.keys(patch).length === 0) return { ok: false, result: { error: "At least one editable memory field is required." } };
    if (patch.metadataJson) {
      try {
        JSON.parse(patch.metadataJson);
      } catch {
        return { ok: false, result: { error: "metadataJson must be valid JSON." } };
      }
    }
    const nextMemory = { ...current, ...patch };
    const nextWorkspaceDecision = this.canUseMemoryRecordInActiveWorkspace(nextMemory, activeWorkspaceId);
    if (!nextWorkspaceDecision.allowed) {
      this.auditMemoryManagementRejected(run, current, "update", nextWorkspaceDecision.reason);
      return { ok: false, result: { error: nextWorkspaceDecision.reason ?? "Memory update rejected by active workspace policy." } };
    }
    const writeDecision = this.memoryWriteDecision(nextMemory, run.userId, run.userRole);
    if (!writeDecision.allowed) {
      this.auditMemoryManagementRejected(run, current, "update", writeDecision.reason);
      return { ok: false, result: { error: writeDecision.reason ?? "Memory update rejected by runtime policy." } };
    }

    const updated = this.repos.updateMemory(id, patch, run.userId, run.userRole);
    this.repos.audit(run.userId, run.userRole, "memory_tool_update", "memory", updated.id, {
      conversationId: run.conversationId,
      workspaceId: updated.workspaceId,
      memoryType: updated.memoryType,
      updatedFields: Object.keys(patch)
    });
    return { ok: true, result: { memory: updated }, memory: updated };
  }

  private executeDeleteMemoryTool(run: AgentRunInput, args: Record<string, unknown>, activeWorkspaceId?: string): { ok: boolean; result: unknown } {
    const id = typeof args.id === "string" ? args.id : "";
    if (!id) return { ok: false, result: { error: "id is required." } };

    let current: MemoryRow;
    try {
      current = this.repos.getMemory(id);
    } catch (error) {
      return { ok: false, result: { error: error instanceof Error ? error.message : String(error) } };
    }

    const decision = this.memoryManageDecision({ run, memory: current, action: "delete" });
    if (!decision.allowed) {
      this.auditMemoryManagementRejected(run, current, "delete", decision.reason);
      return { ok: false, result: { error: decision.reason ?? "Memory delete rejected by runtime policy." } };
    }
    const activeWorkspaceDecision = this.canUseMemoryRecordInActiveWorkspace(current, activeWorkspaceId);
    if (!activeWorkspaceDecision.allowed) {
      this.auditMemoryManagementRejected(run, current, "delete", activeWorkspaceDecision.reason);
      return { ok: false, result: { error: activeWorkspaceDecision.reason ?? "Memory delete rejected by active workspace policy." } };
    }

    const deleteReason = typeof args.deleteReason === "string" && args.deleteReason.trim()
      ? args.deleteReason.trim()
      : "workspace memory delete tool";
    this.repos.deleteMemory(id, run.userId, run.userRole, deleteReason);
    this.repos.audit(run.userId, run.userRole, "memory_tool_delete", "memory", id, {
      conversationId: run.conversationId,
      workspaceId: current.workspaceId,
      memoryType: current.memoryType,
      deleteReason
    });
    return { ok: true, result: { deleted: true, id } };
  }

  private canUseMemoryRecordInActiveWorkspace(memory: MemoryRow, activeWorkspaceId?: string): PolicyDecision {
    if (!activeWorkspaceId) return { allowed: true };
    if (memory.memoryType !== "event" && memory.memoryType !== "skill") return { allowed: true };
    if (memory.workspaceId === activeWorkspaceId) return { allowed: true };
    return {
      allowed: false,
      reason: `Workspace memory tools can only manage event/skill records in the active workspace (${activeWorkspaceId}).`
    };
  }

  private memoryManageDecision(input: { run: AgentRunInput; memory: MemoryRow; action: "update" | "delete" }): PolicyDecision {
    const { run, memory } = input;
    if (run.userRole === "creator") return { allowed: true };
    if (memory.memoryType === "impression" && memory.agentId) {
      return { allowed: false, reason: "Agent self impression management requires creator role." };
    }
    if (memory.memoryType === "impression") {
      return memory.userId === run.userId
        ? { allowed: true }
        : { allowed: false, reason: "User impression can only be managed by the current user." };
    }
    if (memory.memoryType === "event") {
      return memory.userId === run.userId
        ? { allowed: true }
        : { allowed: false, reason: "Event memory can only be managed by the current user." };
    }
    if (memory.memoryType === "skill") {
      return { allowed: false, reason: "Shared skill memory management requires creator role." };
    }
    return { allowed: false, reason: `Unsupported memory type: ${memory.memoryType}` };
  }

  private auditMemoryManagementRejected(run: AgentRunInput, memory: MemoryRow, action: "update" | "delete", reason?: string): void {
    this.repos.audit(run.userId, run.userRole, "memory_management_rejected", "memory", memory.id, {
      conversationId: run.conversationId,
      workspaceId: memory.workspaceId,
      memoryType: memory.memoryType,
      action,
      reason
    });
  }

  private canReadMemoryRecord(actorId: string, memory: MemoryRow): boolean {
    if (memory.memoryType === "event") return memory.userId === actorId;
    if (memory.memoryType === "skill") return Boolean(memory.workspaceId) && !memory.userId;
    if (memory.memoryType === "impression") {
      const metadata = this.parseMetadata(memory.metadataJson);
      if (metadata.impressionKind === "agentSelf") return false;
      return memory.userId === actorId;
    }
    return false;
  }

  private auditMemoryHooks(run: AgentRunInput, activeWorkspaceId: string, writes: MemoryRow[]): void {
    for (const memory of writes) {
      const metadata = this.parseMetadata(memory.metadataJson);
      const base = {
        conversationId: run.conversationId,
        workspaceId: memory.workspaceId ?? activeWorkspaceId,
        memoryId: memory.id,
        memoryType: memory.memoryType,
        source: metadata.source
      };
      if (metadata.source === "afterConversationWindow" || metadata.source === "afterWorkspaceExit") {
        const extractionHook = metadata.source === "afterConversationWindow"
          ? "hook.afterConversationWindow"
          : "hook.afterWorkspaceExitEventExtraction";
        this.repos.audit(run.userId, "system", extractionHook, "memory", memory.id, {
          ...base,
          hook: metadata.source,
          eventKind: metadata.eventKind,
          evidenceMessageIds: metadata.evidenceMessageIds,
          workspaceSessionIds: metadata.workspaceSessionIds,
          toolCallIds: metadata.toolCallIds
        });
        this.repos.audit(run.userId, "system", "hook.afterEventExtracted", "memory", memory.id, {
          ...base,
          hook: "afterEventExtracted",
          relationId: memory.relationId,
          version: memory.version,
          eventKind: metadata.eventKind,
          outcome: metadata.outcome
        });
      }
      if (memory.memoryType === "skill") {
        this.repos.audit(run.userId, "system", "hook.afterSkillExtracted", "memory", memory.id, {
          ...base,
          hook: "afterSkillExtracted",
          relationId: memory.relationId,
          version: memory.version,
          evidenceEventIds: metadata.evidenceEventIds,
          confidence: metadata.confidence,
          qualityGate: metadata.qualityGate
        });
      }
    }
  }

  private parseMetadata(value: string): Record<string, unknown> {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private hasValidMetadataJson(value: string): boolean {
    try {
      JSON.parse(value);
      return true;
    } catch {
      return false;
    }
  }

  private apiRun(actorId: string, actorRole: UserRole, conversationId = "memory-api"): AgentRunInput {
    return {
      agentId: "default-agent",
      userId: actorId,
      userRole: actorRole,
      conversationId,
      message: "memory api operation"
    };
  }
}

function isTimestampInRange(value: string | undefined, start: string, end: string): boolean {
  if (!value || !start || !end) return false;
  return value >= start && value <= end;
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  return Array.from(new Map(items.map((item) => [item.id, item])).values());
}

function sessionOverlapsRange(session: WorkspaceSession, start: string, end: string): boolean {
  if (!start || !end) return false;
  const sessionEnd = session.completedAt ?? session.startedAt;
  return session.startedAt <= end && sessionEnd >= start;
}
