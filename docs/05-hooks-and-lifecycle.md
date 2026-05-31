# 生命周期钩子

## 总览

Zleap 的 agent runtime 需要通过 hook 把对话、workspace、tool 和 memory 串起来。

hook 的目标不是让模型自己负责所有生命周期，而是由程序在关键节点自动做结构化处理。

核心生命周期：

```text
用户消息
  -> 加载全局上下文
  -> 主工作空间规划
  -> 进入工作空间
  -> 执行工作空间任务
  -> 退出工作空间
  -> 生成事件记忆
  -> 视情况生成经验记忆
  -> 返回主工作空间
  -> 最终回复
```

## 钩子类型

推荐的 hook：

```ts
type RuntimeHook =
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
```

## 对话入口流程

用户输入时：

```text
1. runtime 接收 userId、conversationId、message。
2. 加载 agent identity。
3. 加载 user impression。
4. 加载 agent self impression。
5. 进入 main workspace。
6. main workspace 查看 workspace registry。
7. main workspace 决定直接回答、询问用户或进入某个 workspace。
```

## beforeAgentTurn

这个 hook 在模型响应前运行。

职责：

- 校验 userId。
- 加载跨 workspace impression。
- 生成当前轮 context。
- 检查 conversation 是否超过窗口。
- 注入必要的系统规则。

不应该做：

- 不应该召回所有 event。
- 不应该把所有 workspace 的 memory 塞进上下文。
- 不应该写入长期记忆。

## afterAgentTurn

这个 hook 在模型响应后运行。

职责：

- 保存 assistant message。
- 记录 token 使用情况。
- 判断是否需要触发对话窗口级 event 提取。
- 判断 agent 是否调用了记忆写入工具。
- 保守检查本轮是否出现明确稳定的 user impression 候选；有则写入紧凑投影，没有则跳过。

user impression hook 是防漏机制，不是强制总结器。它只处理姓名/称呼、稳定身份背景、长期偏好、长期约束、工作习惯或长期项目这类信息；短期任务事实、一次性素材、未经确认的猜测、敏感隐私和 scope 不清的信息不能写入。hook 写入必须沿用当前 run 的 `userId`，不能设置 `workspaceId`，metadata 只能保存 compact sourceRefs 和少量来源字段。

## beforeWorkspaceEnter

进入 workspace 前运行。

职责：

- 检查当前 user 是否有权限进入 workspace。
- 构造 `WorkspaceTask`。
- 根据 task 检索 workspace event memory。
- 根据 task 检索 workspace skill memory。
- 创建 workspace session。
- 组装 workspace-local context。

示意：

```text
input:
  userId
  workspaceId
  objective
  parent context summary

load:
  user impression
  agent self impression
  workspace instructions
  result event memory scoped by userId + workspaceId
  relevant process event memory scoped by userId + workspaceId
  skill memory scoped by workspaceId
```

这里召回的记忆分区会成为该工作空间下一次 LLM 调用的权威 `WorkspaceSession.localContext`。后续 prompt assembly 必须复用这份已持久化的 local context，而不是用另一个 query 再做一次独立召回；这样 trace/debug UI 和 final LLM messages 才能保持一致。

召回使用长对话投影策略：最新 20 条 impression projection 不做 query 筛选直接载入；result events 提供更早的结果时间线；process events 按当前任务相关性搜索，但只注入 id/title/summary/readMemory 等索引投影，不注入 `detail` 或 `detailSnippet`。skill memory 保持 workspace-scoped，并且只注入最近的标题/简介/索引投影。完整 process detail 必须通过 `readMemory(memoryId)` 读取，完整 skill detail/procedure 只有在 agent 判断某条 skill 高度相关时，才通过 `readSkill` 读取。`final_messages` 只是用于检查的原始 provider-payload log，不能成为 hook 或后续 prompt assembly 的输入。

## afterWorkspaceEnter

进入 workspace 后运行。

职责：

- 记录 audit log。
- 保存 workspace session start。
- 告知主 workspace 当前已进入的 workspace。

## beforeToolCall

tool 调用前运行。

职责：

- 检查 tool 是否属于当前 workspace。
- 检查 user 权限。
- 检查是否需要人工确认。
- 对参数做基本校验。
- 记录待执行 tool call。

这个 hook 是安全边界的一部分。

## afterToolCall

tool 调用后运行。

职责：

- 保存 tool result。
- 标记成功或失败。
- 将关键信息加入 workspace local context。
- 判断是否出现值得记录的 event 片段。

不建议每次 tool call 都立刻生成长期 memory。可以先积累到 workspace session，再由 event extraction 统一处理。

## beforeWorkspaceExit

退出 workspace 前运行。

职责：

- 要求 workspace 产出结构化 `WorkspaceResult`。
- 对结果做基本校验。
- 生成给主 workspace 的摘要。
- 判断是否 blocked 或需要用户输入。

## afterWorkspaceExit

退出 workspace 后运行。

职责：

- 保存 workspace result。
- 触发 event extraction。
- 触发 skill candidate extraction。
- 将结果返回 main workspace。

### 单次退出 hook 执行

`afterWorkspaceExit` 绑定一次成功的 `exitWorkspace` function call。如果模型在同一条 assistant message 里同时发出 `exitWorkspace` 和其他 tool calls，runtime 不能对已经提交的 workspace session 重复运行退出生命周期工作。这样可以避免同一个 handoff 出现重复的 `skill_usage_recorded` counters、重复的 `hook.afterWorkspaceExit` audit logs 和重复的退出 hook memory extraction。

如果 `exitWorkspace` 成功后，同一个 assistant tool-call batch 里还出现后续 tool calls，这些后续子工作空间调用都属于 post-exit calls。Runtime 应把它们记录为 failed trace records，但不能执行它们，也不能修改已经提交的 `WorkspaceResult` 或 local tool evidence。

### session-scoped 退出证据

Workspace-exit event extraction 必须把 evidence 绑定到已提交的 child `WorkspaceSession`。它可以包含创建任务的用户消息、session interval 内创建的消息、精确匹配 `workspaceSessionId`/`taskId` 的 tool calls，以及同一 interval 内的 legacy unbound tool calls。它不能附加同 workspace 的更早消息，也不能附加另一个 session 的 tool calls。

## afterConversationWindow

这是一个自动触发的 hook。

触发条件可以是：

- 每隔 N 条对话。
- 每隔 N 个 tool call。
- workspace session 结束。
- conversation token 超过阈值。
- 用户显式结束一个任务。

职责：

- 从近期对话中提取 event。
- 生成对话摘要。
- 压缩 context。
- 维护 relationId。
- 判断是否需要提炼 skill。

### 绝对对话窗口

Conversation-window event extraction 必须使用完整已存消息数量和绝对 message-window indexes，不能从受限 recent-history slice 推导 window number。如果一个 conversation 有 520 条已存消息，窗口大小为 20，runtime 必须能够生成 `window:26` 的 process/result events，并且 evidence 精确对应消息 501-520。

### 可信 memory trace 链接

`metadataJson.conversationId` 是 trace-linking 字段。Non-creator memory writes 只能使用已经存在并属于写入 actor 的 conversation id。如果某次 memory write 因 metadata 指向另一个用户的 conversation 而被拒绝，rejection audit 不能包含这个伪造 conversation id，否则另一个用户的 Web UI trace 会被这次失败尝试污染。

直接 Memory Web UI/API create/update/delete 请求也可以携带 operation-level `conversationId` 做 trace linking。这个请求字段对普通用户不是可信输入：在任何 memory mutation 或 operation audit 写入前，它必须解析到 actor 自己的某个已有 conversation。Runtime tool calls 不使用这个外部请求字段，而是使用当前 run 的 code-bound `conversationId`。

### 自动 memory 写入审计身份

conversation-window event extraction 写入的是当前用户在当前 workspace 里的 event memory，因此落库时必须沿用当前 run 的 userId 和 userRole 做 policy 检查，不能伪装成 creator 手动写入。hook 本身的生命周期记录仍然以 system action 写入 audit log。

memory `create` audit 必须尽量携带 `conversationId`、`workspaceId`、`relationId`、`source`、`userId`、`agentId` 和版本信息。这样 Web UI trace 才能把一条 memory row 精确连回产生它的对话窗口、workspace session 或 memory tool call。

## 事件提取

event 提取主要由程序 hook 自动触发。

输入：

- workspace session。
- 最近 N 条消息。
- tool call history。
- workspace result。
- 已召回 memory。

输出：

- process event。
- result event。
- relationId。
- SQLite FTS 文本索引。
- 是否建议提取 skill。

流程：

```text
1. 收集 workspace session 过程。
2. 判断是否有值得保存的事情。
3. 生成 process event 和 result event。
4. 更新 SQLite FTS 文本索引。
5. 在 userId + workspaceId 内召回相似 event。
6. 在同一 scope 分区内决定 relationId/version。
7. 写入 SQLite。
8. 触发 skill 判断。
```

## 经验提取

skill 提取有三种触发来源：

1. event hook 自动判断。
2. 用户明确要求。
3. agent 主动调用 skill 生成工具。

skill 提取应该更克制。

适合生成 skill 的情况：

- 同类问题重复出现。
- 某次失败带来明确教训。
- 失败后找到可复用的稳定替代路径，能减少未来同类任务失败率。
- 某个能力工具流程被验证有效，并能脱离具体用户、项目和任务内容复用。
- 某个 workspace 的工具使用方式有稳定规律。

不适合生成 skill 的情况：

- 只是一条普通事实。
- 只适用于某个用户的私密上下文。
- 结果不确定。
- 没有验证过。
- 只是 workspace 完成了任务或返回了任务结果，但没有可复用 procedure。
- 与已有 skill 只是换了用户内容或任务内容的近似重复。
- 需要复制原始 function call 参数、工具输出、用户身份、任务原文、私有路径或账号才能成立。
- 只是“认真检查”“合理使用工具”“保持上下文”这类空泛建议。

Hook 自动提取时，runtime 只能把工具类别、状态、失败恢复信号和泛化 procedure 写进 skill。完整过程证据通过 event id、tool_calls、audit_logs、workspace_sessions 追溯，不能直接进入共享 skill 的 `detail`。同一 workspace 内相似 skill 必须通过稳定 fingerprint 和 relation/version 去重。

## Agent 主动记忆工具

除了 hook，agent 也可以主动调用记忆工具。

例如：

```text
writeUserImpression
writeAgentSelfImpression
readMemory
readSkill
writeSkillMemory
searchMemory
```

模型可见的记忆工具面必须保持很小：`readMemory` 只按 id 读取当前 runtime scope 可见的 impression/event 详情；`readSkill` 只读取当前 active workspace 的某条 skill 详情；没有 `writeEventMemory`，也没有模型可调用的 `updateMemory` / `deleteMemory`。事件记忆由生命周期 hook 程序化写入；更新和删除属于 Web UI/API 管理层调试能力。

### readMemory

适用：

- 当前 prompt 或 `searchMemory` 已经看到某条 impression/event 的 id、标题、摘要或片段。
- 用户主动要求回忆，或者摘要不足以支撑回答。
- 用户在一次基于召回摘要的回答后追问“详细说说”“展开讲讲”“具体一点”“还有哪些细节”等，且上下文里已有相关 memory id。
- Agent 需要核对某条普通记忆的完整 detail，而不是凭摘要脑补。

限制：

- 只接受 `memoryId`。
- userId、workspaceId、memoryType、relationId、version 都由 runtime 代码绑定或检查。
- 不能读取其他用户的 impression/event，不能跨 active workspace 读取 event/skill，也不能读取 creator 控制的 agent self impression。
- 没有 `readMemory` 返回的 detail 时，只能基于摘要简述，不能把紧凑投影扩写成看似完整的事实。

### readSkill

适用：

- 当前 prompt 已经看到某条 skill 的名称和简介。
- 该简介与当前任务高度相关，或者能明显减少工具失败/重试。
- Agent 准备按这条经验执行前，需要读取完整 procedure、appliesWhen 和 avoidWhen。

限制：

- 只接受 `skillId`。
- workspaceId 由当前 active workspace 代码绑定。
- 不能读取其他 workspace 的 skill，也不能用作全局 memory debugger。

### writeUserImpression

适用：

- 用户表达长期偏好。
- 用户告诉 agent 未来都要遵守某个习惯。
- 用户介绍长期身份或背景。

限制：

- 只能写当前 userId。
- 只记录当前用户的稳定长期偏好、背景、身份、称呼或约束；不要记录 agent 自己的名字、身份、职责或人格。
- 不应记录敏感信息，除非用户明确要求。
- runtime 可以把产生这条 impression 的 `activeWorkspaceId`、`workspaceSessionId`、`taskId` 写入 metadata/audit 作为调试证据；这些字段不是 scope，也不能由模型传入。

### writeAgentSelfImpression

适用：

- agent 创建者明确要求 agent 更新自我认知。
- 只记录 agent 自己的名字、身份、职责边界、长期行为原则或 creator 授权的自我设定；不要记录用户偏好或用户身份。

限制：

- 普通用户不能使用。
- 必须写到当前 agentId scope，不能由模型传入 agentId。
- 需要审计。

### writeSkillMemory

适用：

- 用户要求总结经验。
- agent 发现某个方法论可以复用。
- 触发文本只用于提炼经验内容，不用于选择 workspace。

限制：

- 需要脱敏。
- 需要绑定 workspace，且 workspace 只能由 runtime 从当前 active workspace 注入。
- 不允许根据自然语言关键词猜测另一个 workspace。
- 应保存 evidence event。

Runtime 请求的 `writeSkillMemory` 也必须保留来自 code-bound runtime state 的 trace evidence。可用时，metadata 包含 `activeWorkspaceId`、`workspaceSessionId` 和 `taskId`，让 Web UI 可以把共享 skill 连接到请求它的具体 workspace execution。模型不能提供或覆盖这些 id，也不应该为了调试再保存等价的重复数组。

## 工作空间生命周期示例

以“修改项目代码并验证”为例：

```text
1. 用户请求：帮我修复测试失败。
2. 主工作空间判断需要 `dev` 工作空间。
3. 进入 `dev` 工作空间。
4. `dev` 工作空间运行测试，发现失败。
5. `dev` 工作空间搜索相关文件并修改。
6. `dev` 工作空间再次运行测试并验证通过。
7. 退出 `dev` 工作空间，返回结构化结果。
8. hook 提取 event：
   - 过程：先测试失败，再定位文件，再修改，再验证。
   - 结果：测试通过。
9. hook 判断是否生成 skill：
   - 如果发现项目测试命令规律或稳定失败恢复路径，生成 `dev` skill。
10. 主工作空间给用户最终结果。
```

## 生命周期设计原则

1. 模型负责判断和行动，runtime 负责边界和生命周期。
2. workspace 进入时召回局部 memory，退出时沉淀局部 event。
3. event 以事实为主，skill 以方法为主。
4. hook 自动化常规记忆生成，agent 工具用于主动记忆。
5. 所有写入都经过 userid、workspaceId 和权限检查。
