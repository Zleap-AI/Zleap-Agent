# TypeScript Implementation Roadmap

## 最终目标

Zleap Agent Framework 的最终目标是：

1. 有一个可以完整跑起来的 TypeScript agent runtime。
2. runtime 支持 workspace 编排和切换。
3. runtime 支持 impression、event、skill 三类 memory。
4. runtime 原生支持 userid 多租户隔离。
5. 提供一组基础 workspace，例如 main、cli、file；memory 不是独立 workspace，而是挂载到每个 workspace 的工具能力。
6. 提供一个基于该框架的 Web UI，可以实际体验 agent。

## 技术方向

推荐把项目拆成几个包或模块：

```text
packages/
  core/
    agent runtime
    workspace runtime
    context builder
    hook manager
    policy engine

  memory/
    memory interfaces
    SQL store
    SQLite FTS recall
    memory extraction
    prompt projection for impression/result-event/process-event/skill

  tools/
    tool interface
    tool registry
    built-in tools

  workspaces/
    main workspace
    cli workspace
    file workspace
    memory tools mounted in every workspace

  web/
    Web UI
    chat interface
    workspace view
    memory inspector
    context overview and raw final_messages log toggle
```

也可以先用单仓单包实现 MVP，等概念稳定后再拆包。

## 核心模块

### AgentRuntime

负责一次 agent 对话的总入口。

职责：

- 接收用户消息。
- 校验 userId。
- 加载 agent 配置。
- 调用 main workspace。
- 管理 workspace 切换。
- 返回最终响应。

接口草案：

```ts
interface AgentRuntime {
  run(input: AgentInput): Promise<AgentOutput>;
}
```

### WorkspaceRuntime

负责执行某个 workspace session。

职责：

- 构造 workspace context。
- 绑定 workspace tools。
- 召回 projected memory：固定 impression、result event timeline、相关 process event、workspace skill。
- 执行模型循环。
- 生成 workspace result。

接口草案：

```ts
interface WorkspaceRuntime {
  run(task: WorkspaceTask): Promise<WorkspaceResult>;
}
```

### WorkspaceRegistry

负责注册和查询 workspace。

职责：

- 注册内置 workspace。
- 注册 creator/operator 创建的 workspace。
- 提供 main workspace 可见的 manifest。
- 根据 workspaceId 获取完整配置。

接口草案：

```ts
interface WorkspaceRegistry {
  list(): Promise<WorkspaceManifest[]>;
  get(id: string): Promise<WorkspaceDefinition>;
  register(definition: WorkspaceDefinition): Promise<void>;
}
```

### ToolRegistry

负责管理 tools。

职责：

- 注册工具。
- 根据 workspace 获取工具集合。
- 执行 tool call。
- 触发 beforeToolCall 和 afterToolCall。

接口草案：

```ts
interface ToolRegistry {
  getToolsForWorkspace(workspaceId: string): Promise<ToolDefinition[]>;
  call(context: ToolCallContext, args: unknown): Promise<ToolResult>;
}
```

### MemoryService

负责 memory 的统一接口。

职责：

- impression 读写。
- event 读写。
- skill 读写。
- SQLite FTS recall。
- relationId 维护。
- memory 权限检查。

接口草案：

```ts
interface MemoryService {
  getUserImpressions(userId: string): Promise<ImpressionMemory[]>;
  getAgentSelfImpressions(agentId: string): Promise<ImpressionMemory[]>;

  recallEvents(query: EventRecallQuery): Promise<EventMemory[]>;
  writeEvent(input: WriteEventInput): Promise<EventMemory>;

  recallSkills(query: SkillRecallQuery): Promise<SkillMemory[]>;
  writeSkill(input: WriteSkillInput): Promise<SkillMemory>;
}
```

### HookManager

负责运行生命周期 hook。

职责：

- 注册 hook。
- 按顺序执行 hook。
- 允许 hook 读取和修改 runtime context。
- 记录 hook 错误。

接口草案：

```ts
interface HookManager {
  run<TContext>(name: RuntimeHook, context: TContext): Promise<TContext>;
}
```

### PolicyEngine

负责权限、安全和隔离。

职责：

- 校验 userId。
- 校验 workspace 权限。
- 校验 tool 权限。
- 校验 memory 写入权限。
- 判断是否需要人工确认。

接口草案：

```ts
interface PolicyEngine {
  canEnterWorkspace(input: EnterWorkspacePolicyInput): Promise<PolicyDecision>;
  canCallTool(input: ToolPolicyInput): Promise<PolicyDecision>;
  canWriteMemory(input: MemoryPolicyInput): Promise<PolicyDecision>;
}
```

## 基础数据结构

```ts
type AgentInput = {
  userId: string;
  conversationId: string;
  message: string;
  metadata?: Record<string, unknown>;
};

type AgentOutput = {
  conversationId: string;
  message: string;
  workspaceTrace: WorkspaceResult[];
  memoryWrites: string[];
};
```

```ts
type WorkspaceDefinition = {
  manifest: WorkspaceManifest;
  instructions: string;
  tools: ToolDefinition[];
  memoryPolicy: WorkspaceMemoryPolicy;
};
```

```ts
type WorkspaceMemoryPolicy = {
  eventRecallEnabled: boolean;
  skillRecallEnabled: boolean;
  eventWriteEnabled: boolean;
  skillWriteEnabled: boolean;
  maxEventMemories: number;
  maxSkillMemories: number;
};
```

## MVP 范围

第一阶段不要一次实现所有理想功能。

推荐 MVP：

1. 单进程 TypeScript runtime。
2. main workspace。
3. file workspace。
4. cli workspace。
5. memory service 的接口和 SQLite 实现。
6. event memory 支持 SQL 存储。
7. recall 第一版使用 SQLite FTS + relation/version，不引入 mock vector 或真实 vector store。
8. skill memory 支持手动写入和检索。
9. Web UI 支持：
   - 聊天。
   - 当前 workspace 显示。
   - workspace trace。
   - memory 查看。

MVP 可以暂时简化：

- 不做复杂多 agent。
- 不做完全自动 skill 进化。
- 不做分布式任务调度。
- 不做高级权限系统。

但必须保留接口边界，避免后续重构。

## 后续阶段

### Stage 1: 文档确认

目标：

- 确认 agent/workspace/memory 理念。
- 确认术语。
- 确认 MVP 边界。

产物：

- 当前 docs。

### Stage 2: Core Runtime Skeleton

目标：

- 搭建 TypeScript 项目。
- 实现 AgentRuntime。
- 实现 WorkspaceRegistry。
- 实现 WorkspaceRuntime 的最小循环。
- 实现 main workspace 到 child workspace 的切换。

### Stage 3: Tool System

目标：

- 定义 ToolDefinition。
- 实现 tool registry。
- 实现 CLI 和 File 基础工具。
- 为 tool call 加入 policy hook。

### Stage 4: Memory MVP

目标：

- 定义 impression、event、skill schema。
- SQLite 存储。
- event 写入和查询。
- skill 写入和查询。
- impression 写入和查询。
- 实现 SQLite FTS + relation/version 召回，并保证按 memoryType、userId、agentId、workspaceId 分区去重。
- 实现 prompt projection：impression 固定最新 20 条，result event 约 50 条，process event 少量相关召回，skill 按 workspace 策略召回；原始 `final_messages` 只作为日志查看。

### Stage 5: Hook System

目标：

- 实现 hook manager。
- 实现 workspace exit 后 event extraction。
- 实现 event 后 skill candidate 判断。
- 实现 conversation window 压缩。

### Stage 6: Web UI

目标：

- 聊天界面。
- workspace 列表。
- 当前 workspace 状态。
- tool call trace。
- memory inspector。
- skill inspector。

### Stage 7: Production Hardening

目标：

- 视产品需要再评估 embedding/vector store；除非 `ZLEAP_MASTER_PLAN.md` 更新，否则它不是首版目标。
- 完善权限和审计。
- 支持 creator/operator 自定义 workspace。
- 支持 workspace package/manifest。

## Web UI 体验目标

Web UI 不应该只是普通聊天框。

它应该让用户看到 Zleap 的核心差异：

1. 当前 agent 在哪个 workspace。
2. 主 workspace 为什么选择这个 workspace。
3. 当前 workspace 有哪些工具。
4. agent 调用了哪些工具。
5. 本次任务生成了哪些 event。
6. 是否提炼了 skill。
7. 用户可以查看和管理自己的 impression。
8. 创建者可以查看和管理 workspace 与 shared skill。

当前 Web UI 结构以三栏 + 三 tab 为准：

```text
Top Tabs:
  - 对话
  - 工作空间
  - 记忆

Chat:
  Left Panel:
    - agent/LLM/prompt settings
  Center Panel:
    - streaming Markdown chat
    - retry / clear current conversation
  Right Panel:
    - active workspace
    - context stack
    - LLM logs
    - tool/memory/audit trace

Workspace:
  - workspace manifests
  - registered tools
  - MCP/runtime/placeholder binding status

Memory:
  - database-like memory table
  - filter/add/edit/delete
  - policy and trace diagnostics
```

## 已确认决策

这些问题已经由当前 master plan 固化，旧问题不再作为阻塞项：

1. agent self impression 需要 creator role。
2. workspace 创建/编辑/删除是 creator/operator 级能力安装操作，普通模型 tool call 不能做。
3. shared skill 由 workspace policy、质量门槛、脱敏和 creator/API 管理边界控制。
4. event memory 首版永久保留，删除走 soft delete 和 audit；后续保留周期需先更新 master plan。
5. main workspace 可以直接回答简单问题，也可以通过 `askUser`/`finishTask` 终止当前轮；不是所有任务都必须进入子 workspace。
6. 产品路径使用真实 OpenAI-compatible LLM；测试可以 fake provider。
7. Web UI 使用 React + Vite + TypeScript。

## 当前建议

后续工程实现应持续对齐这些固定边界：

- workspace 不是子 agent。
- main workspace 只负责编排。
- impression/event/skill 的边界。
- event 的 SQLite FTS + relation/version 最新版本机制。
- skill 跨用户共享但 workspace 隔离。
- TypeScript MVP 的范围。
