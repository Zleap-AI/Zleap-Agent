# 上下文与 Prompt 契约

## 上下文窗口堆栈类别

上下文窗口堆栈应该能在 Web UI 中清晰验收。顶层类别有意保持少而稳定：

```text
1. system：系统提示词
2. workspace：工作空间信息
3. tools：可调用工具
4. memory：记忆投影
5. history：本地对话片段
6. user：干净用户消息
7. tool_result：工具执行后的返回消息
```

二级内容放在这些类别内部：

- `system`：base system prompt、personality prompt 和内部 runtime strategy。Runtime policy 不是单独的顶层 context 类别。
- `workspace`：当前工作空间说明、instructions、manifest、memory policy 和可用工作空间 manifest 清单。
- `tools`：本次 LLM 请求实际暴露的 OpenAI-compatible callable tool array，包括 schemas、active workspace metadata、bindings 和 risk flags。这是 provider `tools` 数组的可检查快照，不是复制进 system prompt 的文本。
- `memory`：跨工作空间 impression memory、当前工作空间 result events、当前工作空间相关 process events，以及当前工作空间 skill memory。
- `history`：当前工作空间本地对话消息、当前结构化任务、同工作空间已完成结果、交接上下文引用，以及最近本地工具证据。
- `user`：干净的当前用户消息。
- `tool_result`：function execution 后的 follow-up LLM calls 使用，包含累积的 assistant function-call protocol messages 和实际返回循环的 tool-result messages。

每次工具执行后的 follow-up LLM call 都必须再次持久化完整 active base stack：`system`、`workspace`、`tools`、`memory`、`history` 和干净 `user`，后面再接 `tool_result` 和原始 `final_messages` 日志。只显示 callable tools 加 tool results 的 follow-up call 是不完整的；模型也需要 active task、workspace contract、memory、history 和干净用户请求，才能避免意图丢失和无意义循环。

`WorkspaceSession.localContext` 仍然是内部持久化 trace object，但不应作为独立顶层 context category 展示或注入。它的内容应分散到更清晰的类别中：recalled memory 进入 `memory`，available tools 进入 `tools`，current task / recent tool evidence / completed workspace results 进入 `history`。

合成工具结果遵循同样的简化结构：`runtime_context.memory` 映射 `memory` 类别，`runtime_context.local_conversation` 映射 `history` 类别。模型仍然收到干净的最终用户消息。

`final_messages` 不是真实 context stack category。它是 prompt assembly 后实际发给 provider 的 messages payload 的原始 trace/debug snapshot。Chat UI 应该在正常结构化堆栈中隐藏它。一个低调的 `显示原始日志` 控制可以把 context inspector 切换到原始 provider-log 模式；在这个模式里，UI 要完整隐藏编号结构化堆栈，并直接展示当前选中 `llmCallId` 对应的原始 LLM 调用日志：`messagesJson`、`toolsJson`、response/status metadata 和必要的 endpoint/model 信息。它必须和结构化堆栈使用同一个 `llmCallId`，不加 click-to-expand wrapper，不做 JSON 表格格式化，也不出现横向滚动。长行必须在 inspector 面板内自动换行。

工具调用和工具结果在 UI 中对应的是两次不同的 LLM 视角：工具调用块绑定到发出 function call 的 LLM call；工具结果块绑定到收到 tool result 后继续推理的 follow-up LLM call。这样用户点击工具结果时，看到的上下文堆栈和原始日志里必须包含 `tool_result` segment 与真实 tool message，而不是上一轮只包含 tool call 的请求。

Web UI 应把可解析的 context JSON 渲染成结构化 inspection views，而不是原始 blob。记录数组，尤其是 callable `tools` snapshot，应该显示成表格化视图，用易读列展示名称、说明、schema、binding、risk 和 workspace metadata。Raw JSON 对 provider payload logs 和解析失败仍然有用，但正常 context stack 应该让 runtime partitions 一眼就能验收。

Provider messages 必须保持同样边界。System message 只包含 system/personality/runtime rules；不能包含序列化的 `tools` segment，也不应该携带大型 workspace JSON dump。工作空间上下文作为合成 `runtime_context.workspace` tool result 注入，记忆作为 `runtime_context.memory` 注入，本地 task/history/tool evidence 作为 `runtime_context.local_conversation` 注入。Callable function schemas 只通过 OpenAI-compatible 顶层 `tools` 数组发送。

## 子工作空间上下文交付契约

子 workspace 不是把内部上下文整包交还给 main workspace 的分支 agent。进入子 workspace 后，active context 应围绕 `WorkspaceTask`、workspace manifest、当前 workspace 工具、局部 memory 和局部 tool evidence 重建；退出时模型只通过 `exitWorkspace` 交付结构化 `WorkspaceResult`，runtime 再自动附加有上限的结果型 `handoffContext`。

main workspace 可以看到的返回内容包括完整 `WorkspaceResult`：`status`、`summary`、`artifacts`、`observations`、`errors`、`suggestedNextSteps`，以及 runtime 生成的结果上下文尾巴：最后助手结论和关键工具结果。这些字段用于继续编排、决定是否进入下一个 workspace、向用户提问，或生成最终答复。main 必须忠于这些结果上下文，不能随意再做一层删减导致事实损耗。

子 workspace 内部保留的内容包括完整 tool call 参数、冗长中间过程、召回的 event/skill、局部 scratch/evidence、审计日志和 memory 提取证据。这些内容进入 trace/debug UI，而不是默认进入 main workspace 的 prompt。这样 main workspace 得到的是可决策的交付物和必要结果上下文，不会被子 workspace 的全部执行噪声污染。

反过来也成立：子 workspace 的 `history` 不能把 main planning 对话、sibling workspace 对话、或 main-only 编排工具协议消息当成本地对话回放。子 workspace 可以看到共享 workspace manifest 以理解能力地图，也可以通过 `crossWorkspaceHandoffContext` 获得 runtime 程序化交付的总体要求、当前请求和少量用户原话参考。这里的用户原话是相对原始的任务参考，不是当前子 workspace 的本地对话；进入子 workspace 的交接包不得包含 `enterWorkspace` 原始 tool result、父 workspace recent tool evidence、父级 assistant 执行记录或 sibling workspace 记录。普通 `messages`、`completedWorkspaceResults`、`recentToolEvidence` 必须按当前 workspace 隔离。`completedWorkspaceResults` 在 main 中用于编排整合；在子 workspace 中只表示同一 workspace 的持续本地记录。

完整 workspace registry 是跨 workspace 共享的能力地图。main 和子 workspace 都可以知道有哪些 sibling workspace 存在；区别是只有 main 拥有 `enterWorkspace` 调度权。子 workspace 如果判断需要其他 workspace，应该把这个判断写进 `suggestedNextSteps`，由 main workspace 决定下一次切换。

对话入口需要区分“新任务”和“续跑任务”。默认情况下，新的用户请求先进入 main workspace，由 main 决定是否切换能力工作空间；但如果同一 conversation 里最后还有未完成、失败、阻塞、待用户输入或待审批的子 workspace session，下一条用户消息应直接恢复这个子 workspace。这样用户可以在任意工作空间暂停、停止、失败后继续输入，或者中途纠正任务方向，而不会因为 UI 中断或用户说“继续”就丢失子 workspace 的本地上下文。恢复后的上下文仍然使用当前子 workspace 的 `WorkspaceTask`、manifest、memory、local history、tool evidence 和可调用工具；main 只有在子 workspace 调用 `exitWorkspace` 交付结构化结果后才重新接管。

子 workspace 的 prompt 还必须有产物责任边界。当前 workspace 只能交付自己工具真实产生或自身说明明确支持的结果，不能因为理解用户最终目标就越界生成下游产物。搜索类 workspace 应在完成检索后通过 `exitWorkspace` 返回搜索结果、来源、可信度、缺口和建议下一步；生成网页、写文件、运行本地命令等属于其他 workspace 的任务，应放在 `suggestedNextSteps` 里交给 main 调度。`artifacts` 只能声明当前 workspace 工具实际创建、修改或导出的产物；否则只能写入 `observations` 或 `suggestedNextSteps`。

`running` 只能表示一个 `WorkspaceSession` 仍在执行中。它不能作为 `exitWorkspace` 的交付状态；runtime 必须拒绝这种退出请求，并把失败作为 tool result 记录在当前子 workspace 里。

`exitWorkspace` 还必须绑定当前 active child session 的运行状态：只有仍处于 `running` 的 session 可以被提交。重复退出已经 completed/failed/blocked/needs_user_input/needs_approval 的 child session 时，runtime 只能返回 failed tool result，不能覆盖第一次提交的 `WorkspaceResult`。

子 workspace 直接生成 assistant content 也不是合法交付。runtime 应把这段文字作为内部 trace 保留，追加内部退出提醒，并继续要求模型调用 `exitWorkspace`。只有 main workspace 在收到结构化 `WorkspaceResult` 后才能生成最终面向用户的回答。

`exitWorkspace` 的生命周期副作用必须按成功 tool call 去重。同一条 assistant message 里即使还带有其他 tool calls，也只能对该次成功退出运行一次 `afterWorkspaceExit`、一次 skill usage feedback 和一组退出审计/提取事件。

同一个 assistant tool-call batch 中，`exitWorkspace` 成功之后出现的后续 child workspace tool calls 都是无效的 post-exit calls。Runtime 应该保留 failed tool-call trace 便于调试，但不能执行这些调用，也不能把它们追加进已完成 session 的 local evidence。

工作空间退出记忆证据属于已提交的 child session，而不是所有同 workspace id 的历史记录。Exit event metadata 可以引用 task-start user message、该 session interval 内的 messages、精确匹配 `workspaceSessionId`/`taskId` 的 tool calls，以及该 interval 内的 legacy unbound tool calls。更早 session 的 raw evidence 仍可通过 trace 检查，但不会复制进新的 exit event。

`enterWorkspace`、`askUser` 和 `finishTask` 只属于 main workspace。这是代码边界，不是 prompt 偏好：child workspaces 不能在 callable list 中看到这些工具；即使某个 workspace 被错误配置为绑定这些工具，runtime 也必须拒绝 child calls。Child workspaces 应通过 `exitWorkspace` 返回 `status` 和 `suggestedNextSteps`；main 决定是否询问用户、结束任务或进入另一个工作空间。

`WorkspaceSession.localContext.availableTools` 是同一可见性规则的 trace/debug snapshot。它必须包含模型实际能调用的 runtime-mounted tools，比如通用 memory tools 和 child-only `exitWorkspace`，同时必须对 child workspaces 隐藏 main-only tools。如果 runtime callable list 会拒绝某个工具，Web UI 就不应该把它显示成本地可用工具。

主工作空间有两个终止型编排工具：`askUser` 和 `finishTask`。它们不是普通中间工具结果。成功的 `askUser` 调用会把 main session 提交为 `needs_user_input`，并把问题直接返回给用户；成功的 `finishTask` 调用会把 main session 提交为 `completed`，并直接返回提供的最终答复。已提交结果、工具调用和最终消息必须仍可在 trace/context 中检查，但 runtime 不应该仅为了复述终止型工具结果而再请求一次 LLM。

当前 `WorkspaceSession.localContext` 仍然是 workspace LLM call 的权威持久化 runtime snapshot，但不会作为顶层 prompt category 暴露。`WorkspaceRuntime` 为 session 召回 impressions/events/skills 后，`ContextBuilder` 和 `PromptAssembler` 必须把这些精确分区注入 `memory` segment 和 synthetic `runtime_context.memory` tool result。Runtime 不能在 prompt assembly 阶段做第二次独立召回，否则持久化 session trace 会和模型实际看到的内容不一致。

Runtime memory tools 使用同一套 code-bound context contract。Event 和 skill writes 从 runtime 接收 active workspace scope。`readMemory` 只接受 `memoryId`，用于按需读取当前 runtime scope 可见的 impression/event 详情；event/skill 记录仍受 active workspace 限制，其他用户的 event/impression 和 agent self impression 不通过 runtime tool 暴露。自动注入的普通记忆只是一层 `summary_only` 投影，必须带有 `detailInjected=false`、`detailAvailable=true` 和 `readMemory` 提示；当用户追问“详细说说”“展开讲讲”“具体一点”这类详情问题时，模型应先调用 `readMemory`，不能把摘要扩写成详情。`readSkill` 也从 runtime 接收 active workspace scope，并且只接受 `skillId`，因此只能读取当前 workspace shared skill 的完整详情。Impression writes 从 runtime 接收 user/agent scope，保持跨工作空间，但在可用时仍然持久化 origin workspace/session/task evidence。Skill 和 impression trace metadata 可以包含 `activeWorkspaceId`、`workspaceSessionId` 和 `taskId`；这些字段是 trace/debug evidence，不是 model-controlled arguments，也不应该再重复保存同义数组。

Memory metadata 的证据字段必须是引用，不是原始 payload。允许保存 `conversationId`、`eventKind`、`outcome`、`workspaceSessionId`、`taskId` 和 `sourceRefs: [{ table, ids }]`，用于回查 `messages`、`llm_calls`、`context_segments`、`tool_calls`、`workspace_sessions`、`audit_logs` 等原始表。同一批证据 id 不应该既保存在 `sourceRefs` 中，又以 `evidenceMessageIds`、`workspaceSessionIds`、`toolCallIds` 等顶层数组重复保存；除非某类 memory 有独立语义字段，例如 skill 的 `evidenceEventIds`。禁止把 `windowMessages`、`toolCalls`、`workspaceSessions`、`argumentsJson`、`resultJson`、`messagesJson`、`responseJson`、`rawJson` 或 `finalMessages` 复制进 memory，因为这会让 memory 退化成第二份原始日志，也会破坏长对话压缩目标。

最终面向用户的语言也是系统契约：除非用户明确要求翻译或指定其他语言，assistant 应使用用户当前消息的主要语言回答。这可以避免内部 prompts、tool names 或 runtime context 混合语言时，回复在中文和英文之间意外切换。

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

## 上下文层级

推荐将一次模型调用的上下文分为以下层级：

```text
1. 基础系统契约
2. Agent 人格契约
3. Runtime 策略契约
4. 跨工作空间 Impression 上下文
5. 当前工作空间契约
6. 已召回工作空间记忆
7. 当前任务上下文
8. 本地对话切片
9. 工具结果
```

不是每一层都必须很长，但每一层都必须有清晰边界。

## 1. 基础系统契约

基础系统契约是 agent 最底层规则。

它定义：

- agent 的基本行为边界。
- 如何遵守 runtime。
- 如何处理工具调用。
- 如何处理不确定性。
- 如何遵守权限和安全规则。

这个层级在 workspace 切换时不变。

示意：

```text
你运行在 Zleap runtime 中。
你只能使用当前 active workspace 中暴露的工具。
你不能假设自己可以访问当前工作空间之外的工具。
你必须遵守 runtime 的 memory 和权限策略。
Memory scope 由 runtime state 绑定；userId、agentId 和 workspaceId 不是模型可控制的路由字段。
```

## 2. Agent 人格契约

人格契约定义 agent 的人格、沟通风格和长期定位。

它可以来自 agent 创建者配置。

这个层级在 workspace 切换时不变。

示意：

```text
你务实、精确，并且以任务为中心。
你会让用户知道关键进展，但不做不必要的冗长解释。
你偏好结构化推进，而不是给出模糊建议。
```

personality 不应该包含具体 workspace 的工具说明。

## 3. Runtime 策略契约

Runtime 策略契约是当前运行环境的规则。

它可能包含：

- 当前 userId。
- 当前 conversationId。
- 当前 active workspace。
- memory 写入限制。
- tool 调用限制。
- 需要用户确认的风险操作。

示意：

```text
当前 userId: user_123
当前 workspace: dev
你只能调用注册到 dev workspace 的工具。
你可以请求写入 memory，但 runtime 可能拒绝。
```

## 4. 跨工作空间印象上下文

impression 是跨 workspace 的。

它包括：

- 当前用户的长期偏好。
- 当前用户的长期背景。
- agent self impression。

注意：impression 不按当前 query 做选择性召回，也不全部注入。runtime 固定注入当前 user / agent scope 下最新有效的前 20 条 compact projection。

推荐格式：

```text
相关用户印象：
- 用户偏好用中文讨论架构。
- 用户希望先确认文档再进入实现。

Agent 自我印象：
- 这个 agent 遵循基于 workspace 的能力分离。
- 这个 agent 把 userId 隔离视为核心不变量。
```

## 5. 当前工作空间契约

当前工作空间契约是当前 workspace 的说明。

它定义：

- workspace id。
- workspace 目标。
- workspace 能力边界。
- 可用工具。
- 工具调用说明。
- workspace-specific constraints。

例如 dev workspace：

```text
当前 workspace: dev
目标: 检查项目文件、读取代码上下文，并运行必要的最小命令。
你可以使用 searchFiles 定位候选文件或关键词证据，使用 readFile 读取仓库内文件片段，使用 writeFile 覆盖写入仓库内 UTF-8 文件，使用 runCommand 执行测试、构建、脚本、终端诊断或用户明确要求的命令行任务。
不要用 runCommand 代替普通文件读写，也不要为了写文件绕到 echo、Python heredoc 或其他 shell 拼接；这些应由 writeFile 处理。
每次工具调用都要在参数里填写 reason，说明为什么这次调用必要、预期获得什么证据或产物。reason 是调试字段，不进入最终用户回答。
高风险命令执行可能需要 creator 审批。
```

主 workspace 的 contract 则应该强调编排：

```text
当前 workspace: main
目标: 理解用户目标、选择工作空间并整合结果。
你可以看到 workspace manifests。
你不能直接使用子工作空间工具。
```

## 6. 已召回工作空间记忆

workspace memory 包含三类：

```text
结果事件记忆：
  按 userId + workspaceId 隔离
  最新有效结果，约 50 条

相关过程事件记忆：
  按 userId + workspaceId 隔离
  通过 SQLite FTS 按当前 task/query 选择

经验记忆：
  按 workspaceId 隔离
  只注入最近 title/summary/id 投影
  完整 procedure 只能通过 readSkill(skillId) 读取
```

注入时应分开呈现，避免模型混淆事实和方法。

推荐格式：

```text
结果事件记忆：
- [event/result] 上次在这个工作空间中，当前用户需要使用 pnpm test，而不是 npm test。

相关过程事件记忆：
- [event/process] 之前的相关运行先发现命令配置问题，再继续处理文件。

相关经验记忆：
- [skill] 在 Node 项目中，选择包管理命令前先检查 package.json 和 lockfile。
```

`runtime_context.memory` 必须是投影视图，而不是原始 `MemoryRow[]` dump。不要注入完整 `detail`、完整 `metadataJson`、原始 evidence arrays 或 source transcript windows；这些内容留在 SQLite、workspace sessions、tool calls 和 audit/debug views 中。

## 7. 当前任务上下文

当前任务上下文是当前任务包。

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

## 8. 本地对话切片

本地对话切片是当前 workspace 内与本任务直接相关的对话片段。

它不等于完整 conversation history。

选择策略：

- 当前用户请求必须包含。
- 主 workspace 给子 workspace 的任务包必须包含。
- 当前 workspace 内最近 tool call 和模型回复可以包含。
- 其他 workspace 的细节应通过 workspace result summary 传递。

## 9. 工具结果

工具结果是 workspace-local context 的一部分。

原则：

- tool result 不应无限累积。
- 长输出需要摘要。
- 原始输出可以保存在 artifact 或 audit log。
- 注入模型的应该是与下一步决策相关的结果。

## Prompt 装配顺序

推荐装配顺序：

```text
system:
  基础系统契约
  Agent 人格契约
  Runtime 策略契约

developer/runtime:
  当前工作空间契约
  工具使用说明

context:
  跨工作空间 Impression 上下文
  已召回工作空间记忆
  当前任务上下文
  本地对话切片
  工具结果
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

### 不变量 1：身份稳定

workspace 切换不能改变：

- LLM model identity。
- system prompt。
- personality prompt。
- agent self impression。

### 不变量 2：工具按工作空间隔离

模型只能调用 active workspace 中注册的 tools。

即使模型输出了其他 tool call，runtime 也必须拒绝。

### 不变量 3：事件记忆按 scope 隔离

event memory 召回必须满足：

```text
event.userId == currentUserId
event.workspaceId == activeWorkspaceId
```

### 不变量 4：经验记忆按工作空间隔离

skill memory 召回必须满足：

```text
skill.workspaceId == activeWorkspaceId
```

skill 不按普通 userId 隔离，但必须经过脱敏和泛化。

### 不变量 5：主工作空间不是万能工具空间

main workspace 只能看到 workspace manifest。

它不能直接拥有所有子 workspace 的 tools。

### 不变量 6：子工作空间返回结构化结果

子 workspace 退出时必须返回 `WorkspaceResult`。

主 workspace 不应该依赖解析大段自然语言来理解子任务状态。

### 不变量 7：记忆写入必须经过策略检查

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

## 工作空间切换契约

主 workspace 进入子 workspace 时：

```text
输入:
  WorkspaceTask

Runtime 加载:
  WorkspaceDefinition
  工作空间工具
  事件记忆
  经验记忆
  本地上下文

输出:
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
