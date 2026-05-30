# Multi-tenant Isolation

## 2026-05-31 update: direct memory update policy

Direct Memory Web UI/API updates must validate the patched final row, not only the original row. A user-owned impression cannot be edited into another user's impression, an impression cannot become workspace-scoped or ambiguous, events must still carry valid current-user/workspace structure, and skills must still pass shared-skill quality and desensitization policy before the update is persisted.

Creator actors are allowed to maintain scoped user impression and event records for debugging or migration, but the patched result must still pass the same final-row policy. Ordinary users remain limited to their own user impressions and events.

## 2026-05-31 update: shared skill management boundary

Direct Memory Web UI/API shared skill creation, update, and delete are creator-only management operations. Ordinary users do not directly edit shared workspace knowledge from the debug table/API. They may still cause skill memory to be generated through runtime, but only by asking from inside the active workspace; runtime injects the workspace scope, applies the workspace memory policy, checks reusable/desensitized quality metadata, and records audit evidence.

## 2026-05-31 update: no implicit creator for workspace deletion

Workspace deletion removes a capability boundary and soft-deletes scoped event/skill memory, so it must never be authorized by a default creator identity. Repository and HTTP delete paths must receive actor identity; missing actor identity is treated as an ordinary user request and rejected by creator-only policy.

## 2026-05-31 update: atomic workspace tool binding

Workspace creation and editing are capability installation operations. They must bind only registered tools and must be atomic: if any requested tool id is unknown, the repository rejects the request before mutating the workspace row or workspace-tool links. A failed workspace edit must not leave a half-installed workspace visible to main orchestration.

Like deletion, workspace creation and editing must not infer creator authority from missing actor fields. Repository and HTTP upsert paths must receive explicit actor identity; an omitted actor is treated as non-creator and cannot install or mutate capability boundaries.

## 2026-05-31 update: explicit actor for conversation trace

Conversation trace is sensitive debug data: it can include final LLM messages, context stack segments, tool arguments/results, approval requests, and audit logs. Trace reads must receive explicit actor identity and then enforce owner-or-creator access. Missing actor identity must not default to creator.

Sensitive/debug/admin HTTP endpoints must not silently invent an actor identity. LLM request logs, approval list/resolve, agent update, workspace create/update/delete, direct memory list/create/update/delete, conversation trace, and conversation deletion all require explicit `actorId` and `actorRole`. Missing or invalid actor fields are rejected at the HTTP boundary before repository policy is reached.

If the conversation row has already been deleted, ordinary user ownership can no longer be verified. Any preserved audit-only trace for that deleted conversation is therefore creator-only.

Workspace sessions and approval requests are part of the same tenant-scoped trace surface as tool calls and LLM calls. When a conversation row exists, repository writes must reject a workspace session or approval request whose `userId` does not match the conversation owner. Ordinary trace reads also filter workspace sessions and approval requests to the requesting owner; creators can still inspect all rows for debugging.

Memory metadata can also link rows back into a conversation trace. For non-creator writes, `metadataJson.conversationId` must reference an existing conversation owned by the writing actor before the memory is persisted or before a rejection audit is linked to that conversation. This prevents an ordinary user from polluting another user's Web UI trace by forging a conversation id in memory metadata.

Direct Memory Web UI/API operations have a second trace-linking surface: the request-level `conversationId` used for operation audit logs. For non-creator create/update/delete operations, that `conversationId` must also reference an existing conversation owned by the actor before the operation continues. If it points at another user, the operation is rejected before memory mutation and before `memory_api_create`, `memory_api_update`, or `memory_api_delete` audits are written to the forged trace.

## 为什么多租户是底层设计

Zleap 从第一天开始就需要考虑多租户。

原因是 agent 的 memory 会长期积累。如果后期才补 userid 隔离，很容易出现：

- 用户 A 的事件被用户 B 召回。
- 用户 A 的偏好影响用户 B 的回答。
- 某个用户的私密任务被总结成共享 skill。
- 管理员、创建者和普通用户的权限混淆。

因此，userid 不是业务层可选字段，而是 runtime、memory、workspace session 的基础字段。

## User ID

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
| Conversation | 是 | 不一定 | 否 | 原始对话属于用户 |
| Workspace Session | 是 | 是 | 否 | 每次进入 workspace 的执行记录 |
| User Impression | 是 | 否 | 否 | 跨 workspace 的用户记忆 |
| Agent Self Impression | 由创建者控制 | 否 | 是 | agent 自我认知 |
| Event Memory | 是 | 是 | 否 | 某用户在某 workspace 的事情 |
| Skill Memory | 否 | 是 | 是 | workspace 经验，需脱敏 |
| Tool Call Log | 是 | 是 | 默认否 | 审计和调试用 |

## Creator 与普通用户

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

## Memory 写入边界

### User Impression

只能写入当前 `userId` 下。

```text
allowed:
  userId = current user

not allowed:
  userId = another user
```

### Event

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

### Skill

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

## Workspace 权限隔离

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
- CLI workspace 的危险命令需要确认。
- 跨用户 memory 调试查询只能通过 creator 的直接 Memory Web UI/API 管理层进行；runtime 中不存在独立 Memory workspace。
- Shared skill 管理需要较高权限。

## Tool 权限

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
