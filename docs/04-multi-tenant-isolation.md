# 多租户隔离

## 为什么多租户是底层设计

Zleap 从第一天开始就需要考虑多租户。

原因是 agent 的 memory 会长期积累。如果后期才补 userid 隔离，很容易出现：

- 用户 A 的事件被用户 B 召回。
- 用户 A 的偏好影响用户 B 的回答。
- 某个用户的私密任务被总结成共享 skill。
- 管理员、创建者和普通用户的权限混淆。

因此，userid 不是业务层可选字段，而是 runtime、memory、workspace session 的基础字段。

## 直接记忆 Web UI/API 的更新边界

直接 Memory Web UI/API 更新必须校验最终 patched row，而不是只校验原始 row。用户自己的 impression 不能被编辑成另一个用户的 impression；impression 不能变成 workspace-scoped 或 scope 歧义；event 仍然必须携带合法的当前用户/工作空间结构；skill 在持久化前仍然必须通过共享 skill 质量和脱敏策略。

creator actor 可以为了调试或迁移维护 scoped user impression 和 event 记录，但 patched result 仍然必须通过同一套 final-row policy。普通用户仍然只能操作自己的 user impression 和 event。

直接 Memory Web UI/API 的 shared skill 创建、更新和删除属于 creator-only 管理操作。普通用户不能从调试表/API 直接编辑共享工作空间知识。他们仍然可以通过 runtime 触发 skill memory 生成，但必须发生在 active workspace 内；runtime 注入 workspace scope，应用工作空间记忆策略，检查可复用/脱敏质量 metadata，并记录审计证据。

## 工作空间管理权限

工作空间删除会移除能力边界，并软删除 scoped event/skill memory，所以它绝不能由默认 creator identity 授权。Repository 和 HTTP delete 路径必须收到 actor identity；缺失 actor identity 时应当按普通用户请求处理，并被 creator-only policy 拒绝。

工作空间创建和编辑是能力安装操作。它们只能绑定已注册工具，并且必须是原子操作：如果任何请求的 tool id 未知，repository 必须在修改 workspace row 或 workspace-tool links 之前拒绝请求。失败的工作空间编辑不能让一个半安装的工作空间暴露给主编排流程。

和删除一样，工作空间创建和编辑不能从缺失 actor 字段推断 creator 权限。Repository 和 HTTP upsert 路径必须接收显式 actor identity；省略 actor 时视为 non-creator，不能安装或修改能力边界。

## Trace 和调试端点权限

Conversation trace 是敏感调试数据：它可能包含 final LLM messages、context stack segments、工具参数/结果、approval requests 和 audit logs。Trace 读取必须接收显式 actor identity，并执行 owner-or-creator 访问控制。缺失 actor identity 不能默认成 creator。

敏感/调试/管理 HTTP 端点不能静默虚构 actor identity。LLM request logs、approval list/resolve、agent update、workspace create/update/delete、direct memory list/create/update/delete、conversation trace 和 conversation deletion 都需要显式 `actorId` 和 `actorRole`。缺失或非法 actor 字段应在 HTTP 边界被拒绝，而不是进入 repository policy 后才处理。

如果 conversation row 已经被删除，普通用户 ownership 不再可验证。因此，已删除 conversation 保留下来的 audit-only trace 只能由 creator 查看。

Workspace sessions 和 approval requests 与 tool calls、LLM calls 一样，都是 tenant-scoped trace surface 的一部分。当 conversation row 存在时，repository writes 必须拒绝 `userId` 与 conversation owner 不匹配的 workspace session 或 approval request。普通 trace 读取也要把 workspace sessions 和 approval requests 过滤到请求 owner；creator 仍可为了调试查看所有行。

Memory metadata 也可能把 row 链回 conversation trace。对于 non-creator 写入，`metadataJson.conversationId` 必须在 memory 持久化前或 rejection audit 链接到该 conversation 前，引用一个属于写入 actor 的已有 conversation。这样可以避免普通用户伪造 conversation id，把自己的失败或恶意 memory 操作污染进其他用户的 Web UI trace。

直接 Memory Web UI/API 操作还有第二个 trace-linking surface：用于 operation audit logs 的 request-level `conversationId`。对于 non-creator create/update/delete 操作，这个 `conversationId` 也必须在操作继续前引用一个属于 actor 的已有 conversation。如果它指向另一个用户，则必须在 memory mutation 之前、在 `memory_api_create`、`memory_api_update` 或 `memory_api_delete` audit 写入伪造 trace 之前拒绝该操作。

## 用户 ID

每次用户与 agent 交互时，调用方都必须传入 `userId`。

```ts
type AgentInput = {
  userId: string;
  conversationId: string;
  message: string;
  metadata?: Record<string, unknown>;
};
```

如果没有 `userId`，runtime 应该拒绝写入长期记忆。

可以支持匿名用户，但匿名用户也应该有临时 id：

```text
anonymous:{sessionId}
```

匿名用户的记忆策略应更保守：

- 默认不写入长期 impression。
- event 可以短期保存。
- skill 提取需要额外脱敏。

## 隔离矩阵

| 数据 | userId 隔离 | workspaceId 隔离 | 可跨用户共享 | 说明 |
| --- | --- | --- | --- | --- |
| 对话 | 是 | 不一定 | 否 | 原始对话属于用户 |
| 工作空间会话 | 是 | 是 | 否 | 每次进入 workspace 的执行记录 |
| 用户印象 | 是 | 否 | 否 | 跨 workspace 的用户记忆 |
| Agent 自我印象 | 由创建者控制 | 否 | 是 | agent 自我认知 |
| 事件记忆 | 是 | 是 | 否 | 某用户在某 workspace 的事情 |
| 经验记忆 | 否 | 是 | 是 | workspace 经验，需脱敏 |
| 工具调用日志 | 是 | 是 | 默认否 | 审计和调试用 |

上下文注入也必须遵守这张隔离矩阵。Impression 固定召回当前 user / agent scope 的最新有效记录；event 只召回当前 user + active workspace 的 result/process 投影视图；skill 只召回 active workspace 的共享脱敏经验。原始 `final_messages` provider payload 是调试日志，不参与跨用户或跨 workspace memory 召回。

## 创建者与普通用户

框架需要区分 agent creator 和普通 user。

creator 是 agent 的创建者或管理员。

creator 可以：

- 修改 agent self impression。
- 安装或删除 workspace。
- 修改 workspace manifest。
- 管理共享 skill。
- 查看系统级审计日志。

普通 user 可以：

- 与 agent 对话。
- 触发自己的 user impression 写入。
- 产生自己的 event memory。
- 在权限允许时请求总结 skill。
- 创建个人 workspace，具体取决于产品策略。

## 记忆写入边界

### 用户印象

只能写入当前 `userId` 下。

```text
allowed:
  userId = current user

not allowed:
  userId = another user
```

### 事件

必须同时绑定：

```text
userId
workspaceId
conversationId
taskId
```

查询 event 时必须至少包含：

```text
userId
workspaceId
```

不能只靠向量相似度跨用户召回。

`relationId + version` 也必须在这个隔离边界内解释。另一个用户或另一个 workspace 即使写入了相同 `relationId` 且 version 更高，也不能让当前用户当前 workspace 的 event 被视为过期。
直接按 relation 查询或写入去重时也必须带上同样的分区键。全局 `memoryType + relationId` 查询只能作为 creator 调试辅助，不能用于 runtime 判断某条 scoped memory 是否已经存在。

### 经验

skill 是共享的，但共享前必须脱敏。

不能把下面内容直接写入 skill：

- 用户姓名、账号、邮箱、手机号。
- 用户项目的私有路径。
- 用户业务数据。
- 用户未公开代码或文档细节。
- 某个用户的具体错误日志，除非已经泛化。

正确做法是把 event 中的经验抽象成通用方法。

例如，不应该写：

```text
用户 jomy 的 G:\Jomy\Documents\Zleap-Agent 项目需要先运行 pnpm install。
```

应该写：

```text
在 Node 项目中，如果存在 pnpm-lock.yaml，优先使用 pnpm 安装依赖和运行脚本。
```

## 工作空间权限隔离

不同 workspace 有不同风险级别。

```ts
type WorkspacePermission = {
  workspaceId: string;
  canEnter: boolean;
  canUseTools: string[];
  requiresApprovalForTools: string[];
  canWriteMemory: boolean;
  canWriteSharedSkill: boolean;
};
```

例如：

- 普通用户可以进入低风险且已授权的 workspace。
- Dev workspace 的高风险命令工具需要确认。
- 跨用户 memory 调试查询只能通过 creator 的直接 Memory Web UI/API 管理层进行；runtime 中不存在独立 Memory workspace。
- Shared skill 管理需要较高权限。

## 工具权限

tool 调用也必须带上上下文：

```ts
type ToolCallContext = {
  userId: string;
  conversationId: string;
  taskId: string;
  workspaceId: string;
  toolName: string;
  permissions: string[];
};
```

这样 runtime 可以检查：

- 当前 workspace 是否允许这个 tool。
- 当前 user 是否有权限。
- 是否需要人工确认。
- tool 调用结果是否允许写入 memory。

## 审计日志

多租户 agent 必须有审计日志。

至少记录：

- 用户消息。
- workspace 切换。
- tool 调用。
- memory 写入。
- skill 生成。
- 权限拒绝。
- 创建者级操作。

审计日志不等于 memory。

审计日志用于追踪系统行为，默认不注入模型上下文。

```ts
type AuditLog = {
  id: string;
  userId?: string;
  actorRole: "user" | "creator" | "system" | "agent";
  action: string;
  resourceKind: string;
  resourceId?: string;
  workspaceId?: string;
  conversationId?: string;
  taskId?: string;
  createdAt: string;
  metadata: Record<string, unknown>;
};
```

## 数据删除

多租户系统需要考虑删除。

至少应该支持：

- 删除某个用户的 user impression。
- 删除某个用户的 event memory。
- 删除某个 conversation 的记录。
- 删除或禁用某条 skill。
- 删除 workspace 时处理其 event 和 skill。

首版没有独立 vector 记录；删除 memory 时需要软删除 SQLite row，并确保普通 list/get/recall 和 FTS 查询排除 deleted 记录。未来如果引入 vector store，必须在 master plan 中新增同步删除策略。

推荐使用软删除：

```ts
type Deletable = {
  deletedAt?: string;
  deletedBy?: string;
  deleteReason?: string;
};
```

## 安全原则

1. userid 是所有用户数据查询的硬约束。
2. workspaceId 是 event 和 skill 查询的硬约束。
3. skill 可以跨用户共享，但必须脱敏和泛化。
4. agent self impression 只能由 creator 修改。
5. tool 调用和 memory 写入都要经过 runtime policy。
6. 审计日志独立于模型 memory。
