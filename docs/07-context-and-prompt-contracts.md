# Context and Prompt Contracts

## 2026-05-31 update: context stack categories

Context stack should be clear to inspect in the Web UI. The top-level categories are intentionally few:

```text
1. system
2. workspace
3. memory
4. history
5. user
6. tool_result for follow-up calls
```

Second-level sections live inside those categories:

- `system`: base system prompt, personality prompt, and internal runtime strategy. Runtime policy is not a separate top-level context category.
- `workspace`: active workspace description, instructions, tool instructions, manifest, memory policy, current callable tool definitions, and for `main` only the available workspace manifest list.
- `memory`: cross-workspace impression memory, current-workspace result events, current-workspace relevant process events, and current-workspace skill memory.
- `history`: local conversation messages, current structured task, completed workspace results, and recent local tool evidence.
- `user`: the clean current user message.

`WorkspaceSession.localContext` remains an internal persisted trace object, but it should not be shown or injected as its own top-level context category. Its parts are distributed into the clearer categories above: recalled memory goes to `memory`, available tools go to `workspace`, and current task / recent tool evidence / completed workspace results go to `history`.

The synthetic tool results follow the same simplified structure: `runtime_context.memory` mirrors the `memory` category, and `runtime_context.local_conversation` mirrors the `history` category. The model still receives a clean final user message.

`final_messages` is not a real context stack category. It is a raw trace/debug snapshot of the exact messages payload sent to the provider after prompt assembly. The Chat UI should hide it from the normal structured stack. A subtle raw-log control such as `显示原始日志` switches the context inspector into raw provider-log mode; in that mode, the UI hides the numbered structured stack entirely and directly displays only the saved `final_messages` raw JSON/text, without a click-to-expand wrapper, JSON table formatting, or horizontal scrolling. Long raw lines must wrap inside the inspector panel.

The Web UI should render parseable context JSON as structured inspection views, not raw blobs. Arrays of records, especially the callable `tools` snapshot, should become table-like views with readable columns for names, descriptions, schemas, bindings, risk, and workspace metadata. Raw JSON remains useful for provider payload logs and parse failures, but the normal context stack should make runtime partitions easy to verify at a glance.

Provider messages must keep the same boundary. The system message contains only system/personality/runtime rules; it must not contain the serialized `tools` segment and should not carry large workspace JSON dumps. Workspace context is injected as a synthetic `runtime_context.workspace` tool result, memory as `runtime_context.memory`, and local task/history/tool evidence as `runtime_context.local_conversation`. Callable function schemas are sent only through the OpenAI-compatible top-level `tools` array.

## 2026-05-30 更新：子 workspace 上下文交付契约

子 workspace 不是把内部上下文整包交还给 main workspace 的分支 agent。进入子 workspace 后，active context 应围绕 `WorkspaceTask`、workspace manifest、当前 workspace 工具、局部 memory 和局部 tool evidence 重建；退出时模型只通过 `exitWorkspace` 交付结构化 `WorkspaceResult`，runtime 再自动附加有上限的结果型 `handoffContext`。

main workspace 可以看到的返回内容包括完整 `WorkspaceResult`：`status`、`summary`、`artifacts`、`observations`、`errors`、`suggestedNextSteps`，以及 runtime 生成的结果上下文尾巴：最后助手结论和关键工具结果。这些字段用于继续编排、决定是否进入下一个 workspace、向用户提问，或生成最终答复。main 必须忠于这些结果上下文，不能随意再做一层删减导致事实损耗。

子 workspace 内部保留的内容包括完整 tool call 参数、冗长中间过程、召回的 event/skill、局部 scratch/evidence、审计日志和 memory 提取证据。这些内容进入 trace/debug UI，而不是默认进入 main workspace 的 prompt。这样 main workspace 得到的是可决策的交付物和必要结果上下文，不会被子 workspace 的全部执行噪声污染。

完整 workspace registry 是跨 workspace 共享的能力地图。main 和子 workspace 都可以知道有哪些 sibling workspace 存在；区别是只有 main 拥有 `enterWorkspace` 调度权。子 workspace 如果判断需要其他 workspace，应该把这个判断写进 `suggestedNextSteps`，由 main workspace 决定下一次切换。

`running` 只能表示一个 `WorkspaceSession` 仍在执行中。它不能作为 `exitWorkspace` 的交付状态；runtime 必须拒绝这种退出请求，并把失败作为 tool result 记录在当前子 workspace 里。

`exitWorkspace` 还必须绑定当前 active child session 的运行状态：只有仍处于 `running` 的 session 可以被提交。重复退出已经 completed/failed/blocked/needs_user_input/needs_approval 的 child session 时，runtime 只能返回 failed tool result，不能覆盖第一次提交的 `WorkspaceResult`。

子 workspace 直接生成 assistant content 也不是合法交付。runtime 应把这段文字作为内部 trace 保留，追加内部退出提醒，并继续要求模型调用 `exitWorkspace`。只有 main workspace 在收到结构化 `WorkspaceResult` 后才能生成最终面向用户的回答。

`exitWorkspace` 的生命周期副作用必须按成功 tool call 去重。同一条 assistant message 里即使还带有其他 tool calls，也只能对该次成功退出运行一次 `afterWorkspaceExit`、一次 skill usage feedback 和一组退出审计/提取事件。

After a successful `exitWorkspace` in an assistant tool-call batch, later child workspace tool calls in that same batch are invalid post-exit calls. Runtime should keep a failed tool-call trace for debugging, but it must not execute those calls or append them into the completed session's local evidence.

Workspace-exit memory evidence belongs to the committed child session, not to every historical record with the same workspace id. Exit event metadata may reference the task-start user message, messages inside that session interval, exact `workspaceSessionId`/`taskId` tool calls, and legacy unbound tool calls inside the interval. Raw evidence from older sessions remains inspectable through trace, but it is not copied into the new exit event.

`enterWorkspace`, `askUser`, and `finishTask` belong only to main workspace. This is a code boundary, not a prompt preference: child workspaces must not see these tools in their callable list, and runtime must reject child calls even if a workspace was misconfigured to bind them. Child workspaces should return `status` and `suggestedNextSteps` through `exitWorkspace`; main decides whether to ask the user, finish, or enter another workspace.

`WorkspaceSession.localContext.availableTools` is a trace/debug snapshot of the same visibility rule. It must include runtime-mounted tools that the model can actually call, such as universal memory tools and child-only `exitWorkspace`, and it must hide main-only tools from child workspaces. The Web UI should not show a tool as locally available if the runtime callable list would reject it.

Main workspace has two terminal orchestration tools: `askUser` and `finishTask`. These are not ordinary intermediate tool results. A successful `askUser` call commits the main session as `needs_user_input` and returns the question directly to the user; a successful `finishTask` call commits the main session as `completed` and returns the provided final response directly. The committed result, tool call, and final message must remain inspectable in trace/context, but runtime should not ask the LLM for another pass merely to restate the terminal tool result.

The active `WorkspaceSession.localContext` remains the authoritative persisted runtime snapshot for a workspace LLM call, but it is not exposed as a top-level prompt category. After `WorkspaceRuntime` recalls impressions/events/skills for a session, `ContextBuilder` and `PromptAssembler` must inject those exact partitions into the `memory` segment and the synthetic `runtime_context.memory` tool result. Runtime must not perform a second independent recall during prompt assembly, because that would make the persisted session trace differ from what the model actually saw.

Runtime memory tools use the same code-bound context contract. Event and skill writes receive active workspace scope from runtime. `readSkill` also receives active workspace scope from runtime and accepts only `skillId`, so it can reveal full details only for the current workspace's shared skill. Impression writes receive user/agent scope from runtime and stay cross-workspace, but still persist origin workspace/session/task evidence when available. Skill and impression trace metadata can include `activeWorkspaceId`, `workspaceSessionId`, `taskId`, `workspaceSessionIds`, and `taskIds`; these fields are trace/debug evidence, not model-controlled arguments.

Final user-facing language is also a system contract: the assistant should answer in the primary language of the user's current message unless the user explicitly asks for translation or a different language. This prevents accidental Chinese/English switching when internal prompts, tool names, or runtime context contain mixed-language text.

## 为什么需要契约

Zleap 的核心不是让模型获得更多上下文，而是让模型获得正确上下文。

因此，prompt 和 context 不能临时拼接。runtime 必须明确每一层内容的来源、顺序、作用和隔离边界。

如果没有契约，workspace 设计会退化成普通大上下文 agent：

```text
所有 system rules
所有 personality
所有 tools
所有 memory
所有 history
全部塞给模型
```

这正是 Zleap 要避免的设计。

## Context 层级

推荐将一次模型调用的上下文分为以下层级：

```text
1. Base System Contract
2. Agent Personality Contract
3. Runtime Policy Contract
4. Cross-workspace Impression Context
5. Active Workspace Contract
6. Recalled Workspace Memory
7. Active Task Context
8. Local Conversation Slice
9. Tool Results
```

不是每一层都必须很长，但每一层都必须有清晰边界。

## 1. Base System Contract

Base system contract 是 agent 最底层规则。

它定义：

- agent 的基本行为边界。
- 如何遵守 runtime。
- 如何处理工具调用。
- 如何处理不确定性。
- 如何遵守权限和安全规则。

这个层级在 workspace 切换时不变。

示意：

```text
You are an agent running inside Zleap runtime.
You must only use tools available in the active workspace.
You must not assume access to tools outside the active workspace.
You must follow runtime memory and permission policies.
Memory scope is bound by runtime state: userId, agentId, and workspaceId are not model-controlled routing fields.
```

## 2. Agent Personality Contract

personality contract 定义 agent 的人格、沟通风格和长期定位。

它可以来自 agent 创建者配置。

这个层级在 workspace 切换时不变。

示意：

```text
You are pragmatic, precise, and task-oriented.
You keep the user informed without unnecessary verbosity.
You prefer structured progress over vague suggestions.
```

personality 不应该包含具体 workspace 的工具说明。

## 3. Runtime Policy Contract

runtime policy contract 是当前运行环境的规则。

它可能包含：

- 当前 userId。
- 当前 conversationId。
- 当前 active workspace。
- memory 写入限制。
- tool 调用限制。
- 需要用户确认的风险操作。

示意：

```text
Current userId: user_123
Current workspace: cli
You may only call tools registered to cli workspace.
You may request memory writes, but runtime may reject them.
```

## 4. Cross-workspace Impression Context

impression 是跨 workspace 的。

它包括：

- 当前用户的长期偏好。
- 当前用户的长期背景。
- agent self impression。

注意：impression 不按当前 query 做选择性召回，也不全部注入。runtime 固定注入当前 user / agent scope 下最新有效的前 20 条 compact projection。

推荐格式：

```text
Relevant user impressions:
- User prefers Chinese for architectural discussions.
- User wants documentation confirmed before implementation.

Agent self impressions:
- This agent follows workspace-based capability separation.
- This agent treats userId isolation as a core invariant.
```

## 5. Active Workspace Contract

active workspace contract 是当前 workspace 的说明。

它定义：

- workspace id。
- workspace 目标。
- workspace 能力边界。
- 可用工具。
- 工具调用说明。
- workspace-specific constraints。

例如 CLI workspace：

```text
Active workspace: cli
Purpose: execute shell commands and inspect terminal output.
You should use CLI tools only for command-line tasks.
Do not edit files directly in this workspace unless a tool explicitly supports it.
```

主 workspace 的 contract 则应该强调编排：

```text
Active workspace: main
Purpose: understand user goals, choose workspaces, and integrate results.
You can see workspace manifests.
You cannot directly use child workspace tools.
```

## 6. Recalled Workspace Memory

workspace memory 包含三类：

```text
Result Event Memory:
  scoped by userId + workspaceId
  latest effective results, about 50 rows

Relevant Process Event Memory:
  scoped by userId + workspaceId
  selected by current task/query through SQLite FTS

Skill Memory:
  scoped by workspaceId
  injected as recent title/summary/id projections
  full procedure loaded only through readSkill(skillId)
```

注入时应分开呈现，避免模型混淆事实和方法。

推荐格式：

```text
Result event memories:
- [event/result] Last time in this workspace, this user needed pnpm test instead of npm test.

Relevant process event memories:
- [event/process] Prior related run found command setup issues before using the file tool.

Relevant skill memories:
- [skill] In Node projects, inspect package.json and lockfiles before choosing package manager commands.
```

`runtime_context.memory` must be a projected view, not a raw `MemoryRow[]` dump. Do not inject full `detail`, full `metadataJson`, raw evidence arrays, or source transcript windows; those remain in SQLite, workspace sessions, tool calls, and audit/debug views.

## 7. Active Task Context

active task context 是当前任务包。

进入子 workspace 时，主 workspace 应构造结构化任务，而不是直接传完整对话。

```text
Task objective:
  Run the project test suite and report failures.

Constraints:
  - Do not modify files.
  - Use the current project directory.

Expected output:
  A structured summary of command results and next suggested workspace.
```

这个 task context 是子 workspace 的主要目标来源。

## 8. Local Conversation Slice

local conversation slice 是当前 workspace 内与本任务直接相关的对话片段。

它不等于完整 conversation history。

选择策略：

- 当前用户请求必须包含。
- 主 workspace 给子 workspace 的任务包必须包含。
- 当前 workspace 内最近 tool call 和模型回复可以包含。
- 其他 workspace 的细节应通过 workspace result summary 传递。

## 9. Tool Results

tool result 是 workspace-local context 的一部分。

原则：

- tool result 不应无限累积。
- 长输出需要摘要。
- 原始输出可以保存在 artifact 或 audit log。
- 注入模型的应该是与下一步决策相关的结果。

## Prompt 装配顺序

推荐装配顺序：

```text
system:
  Base System Contract
  Agent Personality Contract
  Runtime Policy Contract

developer/runtime:
  Active Workspace Contract
  Tool Usage Instructions

context:
  Cross-workspace Impression Context
  Recalled Workspace Memory
  Active Task Context
  Local Conversation Slice
  Tool Results
```

不同 LLM provider 的消息角色可能不同，但逻辑层级应该保持一致。

## 注意力预算

Zleap 应该把上下文窗口当成预算，而不是仓库。

可以定义一个 attention budget：

```ts
type AttentionBudget = {
  system: number;
  personality: number;
  policy: number;
  impression: number;
  workspaceInstructions: number;
  eventMemory: number;
  skillMemory: number;
  taskContext: number;
  localHistory: number;
  toolResults: number;
};
```

推荐原则：

1. system 和 personality 稳定但尽量短。
2. workspace instructions 必须准确，不能过长。
3. impression memory 固定注入最新有效 20 条投影，不做 query 选择性召回。
4. event memory 分层注入：约 50 条 result event 保留旧结果时间线，少量 process event 按当前任务相关性召回。
5. skill memory 数量要少，默认只注入最近 N 条名称和简介；高度相关时用 `readSkill` 渐进读取完整步骤。
6. tool result 长输出必须摘要。
7. local history 只保留当前 workspace 的必要片段。

## Runtime 不变量

这些规则后续应该写成测试。

### Invariant 1: identity stable

workspace 切换不能改变：

- LLM model identity。
- system prompt。
- personality prompt。
- agent self impression。

### Invariant 2: tools scoped

模型只能调用 active workspace 中注册的 tools。

即使模型输出了其他 tool call，runtime 也必须拒绝。

### Invariant 3: event memory scoped

event memory 召回必须满足：

```text
event.userId == currentUserId
event.workspaceId == activeWorkspaceId
```

### Invariant 4: skill memory workspace scoped

skill memory 召回必须满足：

```text
skill.workspaceId == activeWorkspaceId
```

skill 不按普通 userId 隔离，但必须经过脱敏和泛化。

### Invariant 5: main workspace is not all-tools workspace

main workspace 只能看到 workspace manifest。

它不能直接拥有所有子 workspace 的 tools。

### Invariant 6: child workspace returns structured result

子 workspace 退出时必须返回 `WorkspaceResult`。

主 workspace 不应该依赖解析大段自然语言来理解子任务状态。

### Invariant 7: memory writes are policy-gated

模型可以提出写 memory 的请求，但最终写入必须由 runtime policy 决定。

## 模型循环

每个 workspace 内可以采用统一的执行循环：

```text
Observe
  - read task
  - read local memory
  - read tool results

Decide
  - answer directly
  - call tool
  - request memory write
  - ask user
  - return workspace result

Act
  - execute tool through runtime
  - update local context

Verify
  - inspect tool result
  - check task status
  - decide next step
```

这个循环属于 runtime 能力，不等于让模型无限自主运行。

runtime 需要控制：

- 最大循环次数。
- 最大 tool call 次数。
- 最大 token 使用。
- 是否允许高风险 tool。
- blocked 条件。

## Workspace 切换契约

主 workspace 进入子 workspace 时：

```text
Input:
  WorkspaceTask

Runtime loads:
  WorkspaceDefinition
  Workspace tools
  Event memory
  Skill memory
  Local context

Output:
  WorkspaceResult
```

主 workspace 只能通过 `WorkspaceResult` 继续编排。

子 workspace 不应该直接修改主 workspace 的内部 planning state，除非通过明确 result 字段返回。

## 失败和阻塞

workspace 可以返回五类可交付状态：

```text
completed
failed
blocked
needs_user_input
needs_approval
```

语义：

- completed：子任务完成。
- failed：子任务失败，但已经有明确失败原因。
- blocked：缺少权限、环境或必要信息，无法继续。
- needs_user_input：需要用户决策。
- needs_approval：需要 creator/operator 审批后才能继续。

主 workspace 根据状态决定下一步。

## 文档到代码的映射

这份文档后续应该映射为：

- `ContextBuilder`
- `PromptAssembler`
- `AttentionBudgetManager`
- `WorkspaceSession`
- `RuntimeInvariantTests`

尤其是 runtime invariants 应该在实现时写成单元测试，避免框架逐渐变成普通大上下文 agent。
