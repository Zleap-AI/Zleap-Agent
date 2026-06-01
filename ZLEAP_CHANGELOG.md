# Zleap 变更日志

本文档用本地时间记录有意义的项目改动，方便之后把 Git 历史、实现目的、涉及区域和验证结果对应起来。

## 2026-06-01 09:59 +08:00

目的：
- 清理设计文档中残留的旧 File/CLI workspace 示例，避免与首版统一 `dev` workspace 决策冲突。

变更：
- 更新 `docs/01-agent-philosophy.md`：将子 workspace 示例改为 Dev workspace、MCP workspace 和未来 Browser workspace。
- 更新 `docs/03-memory-model.md`：将 event/skill 隔离示例从 File/CLI workspace 改为 Dev workspace 和未来 Browser workspace。
- 更新 `docs/04-multi-tenant-isolation.md`：将危险命令示例改为 Dev workspace 的高风险命令工具。
- 更新 `IMPLEMENTATION_AUDIT.md`：确认本轮审计修改均已运行测试和构建验证。

验证：
- `PATH=/opt/homebrew/bin:$PATH npm test` 通过。
- `PATH=/opt/homebrew/bin:$PATH npm run typecheck` 通过。
- `PATH=/opt/homebrew/bin:$PATH npm run build` 通过。
- `git diff --check` 通过。

Git：
- `3ff24cd` 清理旧工作空间示例。

## 2026-06-01 09:57 +08:00

目的：
- 完成剩余总览、理念、路线图和 framework 文档的首轮细项拆分，并消除与主计划冲突的旧 UI/workspace 表述。

变更：
- 更新 `IMPLEMENTATION_AUDIT.md`：将 `docs/README.md`、`docs/01-agent-philosophy.md`、`docs/06-typescript-implementation-roadmap.md` 和 `zleap-agent-framework.md` 拆成 N1-N2、O1-O3、P1-P3。
- 修正 `docs/06-typescript-implementation-roadmap.md`：Web UI 路线图从旧“三 tab”和 Chat 右栏日志/trace，改为主计划要求的七页签、Chat 右栏只展示 workspace/context/memory writes，日志进入独立页。
- 修正 `zleap-agent-framework.md`：首版 MVP 从旧 File/CLI workspace 表述改为统一 Dev workspace，并补齐 `readFile`/`writeFile` 作为 Dev runtime 工具。

验证：
- `PATH=/opt/homebrew/bin:$PATH npm test` 通过。
- `PATH=/opt/homebrew/bin:$PATH npm run typecheck` 通过。
- `PATH=/opt/homebrew/bin:$PATH npm run build` 通过。
- `git diff --check` 通过。

Git：
- `6b3e496` 对齐剩余设计文档审计。

## 2026-06-01 09:53 +08:00

目的：
- 完成 `ZLEAP_MASTER_PLAN.md` 的首轮细项拆分，并把主计划里的 UI/stream 易回退约束补成测试证据。

变更：
- 更新 `IMPLEMENTATION_AUDIT.md`：将主计划总纲拆成 M1-M8，覆盖流程总纲、Web UI 会话体验、trace/context/memory/debug 面、runtime workspace 编排、context/prompt/LLM 协议、SQLite/tenant/security 生命周期、memory strategy、MCP/workspace tools/config。
- 新增 `src/tests/run-tests.ts::testWebUiMasterPlanContracts`，静态校验七页签常驻、浏览器缓存、失败请求清理/重试、停止流 abort、server disconnect cancellation、conversation DELETE、Markdown 安全渲染、context raw log 切换和 Memory evidence 语义视图等主计划 UI 契约。

验证：
- `PATH=/opt/homebrew/bin:$PATH npm test` 通过。
- `PATH=/opt/homebrew/bin:$PATH npm run typecheck` 通过。
- `PATH=/opt/homebrew/bin:$PATH npm run build` 通过。
- `git diff --check` 通过。

Git：
- `2c836e3` 拆分主计划审计并补强 UI 契约。

## 2026-06-01 09:46 +08:00

目的：
- 完成 `docs/07-context-and-prompt-contracts.md` 的首轮细项拆分，明确 context stack、prompt、tool loop 和 UI inspector 契约证据。

变更：
- 更新 `IMPLEMENTATION_AUDIT.md`：将 docs/07 拆成 L1-L8，覆盖稳定 context stack 类别、provider prompt 装配边界、follow-up tool loop 完整上下文、UI context/raw log inspector、workspace handoff/resume、memory disclosure prompt、attention budget 和 runtime invariants。
- 本次只更新审计记录，不改运行时代码。

验证：
- `PATH=/opt/homebrew/bin:$PATH npm test` 通过。
- `PATH=/opt/homebrew/bin:$PATH npm run typecheck` 通过。
- `PATH=/opt/homebrew/bin:$PATH npm run build` 通过。
- `git diff --check` 通过。

Git：
- `8453290` 拆分上下文契约审计。

## 2026-06-01 09:43 +08:00

目的：
- 完成 `docs/04-multi-tenant-isolation.md` 的首轮细项拆分，明确多租户隔离、权限和删除生命周期证据。

变更：
- 更新 `IMPLEMENTATION_AUDIT.md`：将 docs/04 拆成 K1-K7，覆盖 direct memory final-row policy、workspace 管理显式 actor 和原子性、trace/debug endpoint 权限、tenant-scoped trace writes、context 注入隔离矩阵、workspace/tool approval gates、audit/delete 生命周期。
- 本次只更新审计记录，不改运行时代码。

验证：
- `PATH=/opt/homebrew/bin:$PATH npm test` 通过。
- `PATH=/opt/homebrew/bin:$PATH npm run typecheck` 通过。
- `PATH=/opt/homebrew/bin:$PATH npm run build` 通过。
- `git diff --check` 通过。

Git：
- `00478bb` 拆分多租户隔离审计。

## 2026-06-01 09:40 +08:00

目的：
- 完成 `docs/03-memory-model.md` 的首轮细项拆分，明确 memory 模型各项要求已有的代码与测试证据。

变更：
- 更新 `IMPLEMENTATION_AUDIT.md`：将 docs/03 拆成 J1-J7，覆盖 memory recall 可观察性、impression scope、event metadata、SQLite FTS relation/version、skill 渐进披露与质量门禁、memory 注入策略、runtime tools 与 direct API 分层。
- 本次只更新审计记录，不改运行时代码。

验证：
- `PATH=/opt/homebrew/bin:$PATH npm test` 通过。
- `PATH=/opt/homebrew/bin:$PATH npm run typecheck` 通过。
- `PATH=/opt/homebrew/bin:$PATH npm run build` 通过。
- `git diff --check` 通过。

Git：
- `9a9d141` 拆分记忆模型审计。

## 2026-06-01 09:37 +08:00

目的：
- 完成 `docs/02-workspace-runtime.md` 的首轮细项拆分，并补齐 dev 工具 reason 契约的测试证据。

变更：
- 更新 `IMPLEMENTATION_AUDIT.md`：将 docs/02 拆成 I1-I6，覆盖中断子工作空间恢复、main 终止型编排工具、manifest/tool 可见性、MCP server-first、handoff/WorkspaceResult 和 dev 工具契约。
- 补强 `testToolBindingsAndMcpReadiness`：明确断言 `searchFiles` schema 与其他 dev 工具一样要求 `reason`。

验证：
- `PATH=/opt/homebrew/bin:$PATH npm test` 通过。
- `PATH=/opt/homebrew/bin:$PATH npm run typecheck` 通过。
- `PATH=/opt/homebrew/bin:$PATH npm run build` 通过。
- `git diff --check` 通过。

Git：
- `97be45e` 拆分工作空间运行时审计。

## 2026-06-01 09:33 +08:00

目的：
- 完成 `docs/05-hooks-and-lifecycle.md` 的首轮细项拆分，避免已有实现证据散落在 A/B/C/D 项里。

变更：
- 更新 `IMPLEMENTATION_AUDIT.md`：将 docs/05 拆成 H1-H8，补齐 memory tool 面、conversation window、workspace enter local context、workspace exit evidence 和 skill extraction 的证据映射。
- 将 docs/05 待办标记为已完成首轮拆分；本次只更新审计记录，不改运行时代码。

验证：
- `PATH=/opt/homebrew/bin:$PATH npm test` 通过。
- `PATH=/opt/homebrew/bin:$PATH npm run typecheck` 通过。
- `PATH=/opt/homebrew/bin:$PATH npm run build` 通过。
- `git diff --check` 通过。

Git：
- `2e8993a` 拆分生命周期审计证据。

## 2026-06-01 09:23 +08:00

目的：
- 对齐 `docs/05-hooks-and-lifecycle.md` 中 runtime trace evidence 只能由代码绑定的要求。

变更：
- `writeUserImpression`、`writeAgentSelfImpression`、`writeSkillMemory` 显式拒绝模型传入 `activeWorkspaceId`、`workspaceSessionId`、`taskId`。
- 补强 `testSkillMemoryToolQualityGate`：验证模型伪造 skill trace id 会失败，不会写入共享 skill，真实成功路径仍由 runtime metadata 写入 active workspace/session/task。
- 更新 `IMPLEMENTATION_AUDIT.md`，新增 H3 验证记录。

验证：
- `PATH=/opt/homebrew/bin:$PATH npm test` 通过。
- `PATH=/opt/homebrew/bin:$PATH npm run typecheck` 通过。
- `PATH=/opt/homebrew/bin:$PATH npm run build` 通过。
- `git diff --check` 通过。

Git：
- `257014b` 拒绝模型伪造记忆追踪字段。

## 2026-06-01 09:19 +08:00

目的：
- 对齐 `docs/05-hooks-and-lifecycle.md` 中 `afterAgentTurn` 记录 token 使用情况的要求。

变更：
- 新增 `llmTokenUsage`，从 provider raw response 的 `usage` 字段提取 token 使用情况。
- `hook.afterAgentTurn` 审计 metadata 记录 `tokenUsage`，与 `llm_calls.responseJson` raw 记录形成明确生命周期证据。
- 补强 `testRuntimeContextAndTools`，用带 `prompt_tokens` / `completion_tokens` / `total_tokens` 的 LLM fixture 验证 afterAgentTurn audit。
- 更新 `IMPLEMENTATION_AUDIT.md`，新增 H2 验证记录。

验证：
- `PATH=/opt/homebrew/bin:$PATH npm test` 通过。
- `PATH=/opt/homebrew/bin:$PATH npm run typecheck` 通过。
- `PATH=/opt/homebrew/bin:$PATH npm run build` 通过。
- `git diff --check` 通过。

Git：
- `7056b2e` 记录回合结束 token 用量。

## 2026-06-01 09:14 +08:00

目的：
- 对齐 `docs/05-hooks-and-lifecycle.md` 中 tool call lifecycle 的 pending 记录要求。

变更：
- `ToolCallLog.status` 增加 `pending` 状态。
- Runtime 执行工具前先创建 `tool_calls` pending 行，`hook.beforeToolCall` 绑定该 `toolCallId`；工具执行后更新同一行的 `resultJson` 和最终状态。
- 新增 repository `updateToolCallResult`，并补测试覆盖 pending -> completed，以及 runtime before pending / after blocked 审计链。
- Web UI 工具日志支持 pending / blocked 状态标签。
- 更新 `IMPLEMENTATION_AUDIT.md`，新增 H1 验证记录，并将 `docs/05-hooks-and-lifecycle.md` 标为进行中。

验证：
- `PATH=/opt/homebrew/bin:$PATH npm test` 通过。
- `PATH=/opt/homebrew/bin:$PATH npm run typecheck` 通过。
- `PATH=/opt/homebrew/bin:$PATH npm run build` 通过。
- `git diff --check` 通过。

Git：
- `4d9ca30` 落实工具调用待执行记录。

## 2026-06-01 09:07 +08:00

目的：
- 完成 Web UI 顶层结构、概念介绍和 SQLite schema 的文档对齐验证。

变更：
- 使用 in-app browser 实测七个顶层页签：对话、工作空间、记忆、日志、数据表、配置、概念介绍。
- 补强 `testDatabaseAndMemory`：断言核心数据库表存在，并验证 agents/workspaces/mcp_servers/tool_definitions/tool_calls/memories/runtime_config/llm_calls/context_segments/workspace_sessions 的关键字段。
- 更新 `IMPLEMENTATION_AUDIT.md`，将 F1、F2、G1 标记为已验证。

验证：
- `PATH=/opt/homebrew/bin:$PATH npm test` 通过。
- `PATH=/opt/homebrew/bin:$PATH npm run typecheck` 通过。
- `PATH=/opt/homebrew/bin:$PATH npm run build` 通过。
- `git diff --check` 通过。

Git：
- `6386e64` 验证 Web UI 与数据库结构。

## 2026-06-01 09:02 +08:00

目的：
- 完成 MCP server-first 和 placeholder 工具执行边界验证。

变更：
- 补强 `testBuiltInToolsAreSeededAndWorkspaceScoped`：注册一个 workspace placeholder 工具，确认 runtime 返回 structured failed result，而不是静默执行。
- 确认现有 stdio MCP fixture 覆盖 server 保存、工具发现、选中导入、MCP binding metadata 和 runtime `callTool` 执行。
- 更新 `IMPLEMENTATION_AUDIT.md`，将 E1 标记为已验证。

验证：
- `PATH=/opt/homebrew/bin:$PATH npm test` 通过。
- `PATH=/opt/homebrew/bin:$PATH npm run typecheck` 通过。
- `PATH=/opt/homebrew/bin:$PATH npm run build` 通过。
- `git diff --check` 通过。

Git：
- `20e0852` 验证 MCP 服务优先绑定。

## 2026-06-01 08:59 +08:00

目的：
- 完成 LLM 协议和 tool loop 上下文契约验证。

变更：
- 补强 OpenAI-compatible client 测试，确认 non-streaming/streaming 请求体使用顶层 `tools` array，streaming 请求设置 `stream=true`。
- 验证 API key 只进入 Authorization header，不出现在 provider request body，也不出现在 `llm_calls`、`context_segments`、`audit_logs` trace 数据里。
- 更新 `IMPLEMENTATION_AUDIT.md`，将 D1/D2 标记为已验证。

验证：
- `PATH=/opt/homebrew/bin:$PATH npm test` 通过。
- `PATH=/opt/homebrew/bin:$PATH npm run typecheck` 通过。
- `PATH=/opt/homebrew/bin:$PATH npm run build` 通过。
- `git diff --check` 通过。

Git：
- `9bfb330` 验证 LLM 协议与工具循环。

## 2026-06-01 08:56 +08:00

目的：
- 完成 `docs/01-agent-philosophy.md` / `docs/07-context-and-prompt-contracts.md` 中稳定 Agent 身份不变量的验证。

变更：
- 新增 prompt section 测试 helper，用于从 system message 中精确抽取基础系统提示词和人格提示词。
- 补强 `testRuntimeContextAndTools`：验证 main、child、返回 main 三次 LLM call 的基础 system prompt 和 personality prompt 与 persisted agent 配置一致。
- 更新 `IMPLEMENTATION_AUDIT.md`，将 A1 标记为已验证。

验证：
- `PATH=/opt/homebrew/bin:$PATH npm test` 通过。
- `PATH=/opt/homebrew/bin:$PATH npm run typecheck` 通过。
- `PATH=/opt/homebrew/bin:$PATH npm run build` 通过。
- `git diff --check` 通过。

Git：
- `f898eb3` 验证工作空间身份稳定。

## 2026-06-01 08:54 +08:00

目的：
- 完成 workspace handoff、child 直接答复拦截和 `exitWorkspace` 结构校验的文档对齐验证。

变更：
- 补强 malformed exit 测试：同一 child session 内分别验证 `running` status 和缺少 required arrays 的 `WorkspaceResult` 都会失败。
- 确认失败退出不会提交 child session，不触发 before/after exit hook，也不会写入 event memory。
- 更新 `IMPLEMENTATION_AUDIT.md`，将 A4/A5/A6 标记为已验证，并记录 handoff 隔离、直接答复 guard、重复退出和 post-exit tool call 证据。

验证：
- `PATH=/opt/homebrew/bin:$PATH npm test` 通过。
- `PATH=/opt/homebrew/bin:$PATH npm run typecheck` 通过。
- `PATH=/opt/homebrew/bin:$PATH npm run build` 通过。
- `git diff --check` 通过。

Git：
- `161d52b` 补强工作空间退出契约验证。

## 2026-06-01 08:52 +08:00

目的：
- 完成 `docs/03-memory-model.md` 中 event hook-only 写入和 memory metadata 禁止 raw payload 的验证。

变更：
- 补强 `testEventMemoryIsHookGenerated`：确认 hook 生成的 event metadata 不包含文档列出的 raw payload key。
- direct Memory API create 测试逐项覆盖 `messages`、`windowMessages`、`toolCalls`、`argumentsJson`、`resultJson`、`messagesJson`、`responseJson`、`rawJson`、`finalMessages` 等 raw key。
- 增加 update 路径的嵌套 raw payload 拒绝测试，避免先创建合法 memory 后再通过 metadata patch 塞入原始载荷。
- 更新 `IMPLEMENTATION_AUDIT.md`，将 B3/B4 标记为已验证。

验证：
- `PATH=/opt/homebrew/bin:$PATH npm test` 通过。
- `PATH=/opt/homebrew/bin:$PATH npm run typecheck` 通过。
- `PATH=/opt/homebrew/bin:$PATH npm run build` 通过。
- `git diff --check` 通过。

Git：
- `33cc0bf` 补强记忆原始载荷验证。

## 2026-06-01 08:49 +08:00

目的：
- 对齐 `docs/03-memory-model.md` 中 FTS + relation/version 召回必须按完整 scope 分区判断的要求。

变更：
- `getMemoryByRelation` 不再允许省略 scope，避免 repository 层退回到全局 `memoryType + relationId` 查询。
- 更新直接 relation lookup 测试，所有正常查询都显式传入 `userId`、`agentId`、`workspaceId` 分区 scope。
- 补充无 scope 调用会被拒绝的断言，并保留已有跨 user/workspace/type 同名 relation、FTS 安全 token 和 soft delete 回落验证。
- 更新 `IMPLEMENTATION_AUDIT.md`，将 B5 标记为已验证。

验证：
- `PATH=/opt/homebrew/bin:$PATH npm test` 通过。
- `PATH=/opt/homebrew/bin:$PATH npm run typecheck` 通过。
- `PATH=/opt/homebrew/bin:$PATH npm run build` 通过。
- `git diff --check` 通过。

Git：
- `cd94923` 收紧记忆关系查询分区。

## 2026-06-01 08:46 +08:00

目的：
- 补齐 `docs/04-multi-tenant-isolation.md` 数据删除要求的测试证据和审计记录。

变更：
- 在 `testDirectMemoryApiUsesPolicyLayer` 中增加 creator 直接删除 shared skill 的验证。
- 确认删除后的 shared skill 在 direct memory list、runtime recall 和 `readSkill` 中均不可见，同时保留 `deletedBy` 和 `deleteReason`。
- 更新 `IMPLEMENTATION_AUDIT.md`，新增 C5 数据删除条目，记录 memory soft delete、conversation deletion、workspace deletion 和 deleted 记录排除证据。

验证：
- `PATH=/opt/homebrew/bin:$PATH npm test` 通过。
- `PATH=/opt/homebrew/bin:$PATH npm run typecheck` 通过。
- `PATH=/opt/homebrew/bin:$PATH npm run build` 通过。
- `git diff --check` 通过。

Git：
- `f91d162` 补强共享经验删除验证。

## 2026-06-01 08:43 +08:00

目的：
- 完成 `docs/04-multi-tenant-isolation.md` 中审计日志覆盖和“audit 不注入模型上下文”的当前实现验证。

变更：
- 补强 `testToolPolicyGates`：确认 tool 调用 audit 可通过 `resourceId` 对应具体 `tool_calls.id`，metadata 包含 `toolName`、`status` 和 `taskId`。
- 新增 `testAuditLogsStayOutOfModelContext`：预置 audit-only marker，确认 trace audit 可见，但不会出现在 LLM messages 或 context segments 中。
- 更新 `IMPLEMENTATION_AUDIT.md`，将 C4 审计日志覆盖标记为已验证，并记录用户消息、workspace、tool、memory、skill、权限拒绝、creator 操作和 audit/context 隔离证据。

验证：
- `PATH=/opt/homebrew/bin:$PATH npm test` 通过。
- `PATH=/opt/homebrew/bin:$PATH npm run typecheck` 通过。
- `PATH=/opt/homebrew/bin:$PATH npm run build` 通过。
- `git diff --check` 通过。

Git：
- `578261e` 验证审计日志不入上下文。

## 2026-06-01 08:40 +08:00

目的：
- 对齐 `docs/04-multi-tenant-isolation.md` 中审计日志至少记录用户消息的要求。

变更：
- `AgentRuntime.prepare` 在写入 user message 后新增 `user_message_received` audit log。
- audit metadata 只保存 `conversationId`、`agentId`、`messageId` 和 `contentLength`，不复制用户消息正文，避免把 audit 变成另一份原始内容仓库。
- 补充 `testRuntimeContextAndTools` 断言，确认 trace 中存在用户消息 audit，且 metadata 不包含用户原文。
- 更新 `IMPLEMENTATION_AUDIT.md`，新增 C4 审计日志覆盖条目并记录用户消息 audit 偏差修复。

验证：
- `PATH=/opt/homebrew/bin:$PATH npm test` 通过。
- `PATH=/opt/homebrew/bin:$PATH npm run typecheck` 通过。
- `PATH=/opt/homebrew/bin:$PATH npm run build` 通过。
- `git diff --check` 通过。

Git：
- `87e9aa2` 补记用户消息审计。

## 2026-06-01 08:37 +08:00

目的：
- 补强 `docs/04-multi-tenant-isolation.md` 对敏感/调试/管理 HTTP 端点显式 actor 的验证，避免只测试 helper 而漏掉路由层。

变更：
- 将 `src/server/index.ts` 拆出 `createZleapServer` factory，生产入口仍直接启动原 server，测试可注入内存 repository、runtime、memory service 和 MCP executor。
- 新增 `testSensitiveHttpEndpointsRequireExplicitActor`，用临时 HTTP server 逐端点验证缺失 `actorId` 和非法 `actorRole=system` 都被拒绝。
- 覆盖端点包括 LLM logs、approval list/resolve、agent update、workspace create/update/delete、direct memory list/create/update/delete、conversation trace 和 conversation deletion。
- 更新 `IMPLEMENTATION_AUDIT.md`，将 C2 HTTP actor 显式要求标记为已验证。

验证：
- `PATH=/opt/homebrew/bin:$PATH npm test` 通过。
- `PATH=/opt/homebrew/bin:$PATH npm run typecheck` 通过。
- `PATH=/opt/homebrew/bin:$PATH npm run build` 通过。
- `git diff --check` 通过。

Git：
- `dff54da` 补强敏感端点身份边界测试。

## 2026-06-01 08:34 +08:00

目的：
- 记录 `docs/04-multi-tenant-isolation.md` 中 approval 权限隔离的实现审计结果。

变更：
- 更新 `IMPLEMENTATION_AUDIT.md`，将 C3 approval 权限标记为已验证。
- 记录现有证据：workspace entry 高风险审批、tool 高风险审批、普通用户列表隔离、普通用户不能 resolve approval、creator resolve 成功。

验证：
- 复用本轮 `PATH=/opt/homebrew/bin:$PATH npm test` 通过结果。

Git：
- `e70e693` 补记审批权限审计。

## 2026-06-01 08:30 +08:00

目的：
- 对齐 `docs/04-multi-tenant-isolation.md` 中 event memory 必须绑定 `userId + workspaceId + conversationId + taskId` 的多租户要求。

变更：
- `MemoryService` 的 event final-row policy 新增 `metadata.taskId` 强制校验，缺失时拒绝直接 Memory API 或 runtime memory 写入。
- conversation-window 自动 event 增加确定的 `taskId: conversation-window:{index}`，避免 hook 自己生成的 process/result event 缺少任务边界。
- 补充 `testEventMemoryIsHookGenerated` 和 `testDirectMemoryApiUsesPolicyLayer` 断言，覆盖 hook event 带 taskId、direct API event 缺少 taskId 被拒绝、现有手写 event fixture 带完整 trace metadata。
- 更新 `IMPLEMENTATION_AUDIT.md`，记录 `docs/04` 多租户隔离审计进展和 B1/C1 验证证据。

验证：
- `PATH=/opt/homebrew/bin:$PATH npm test` 通过。

Git：
- `7c71e5e` 补齐事件记忆任务边界。

## 2026-06-01 08:27 +08:00

目的：
- 修正 docs 审计发现的 `searchMemory` 渐进披露偏差，避免搜索结果默认暴露 event detail 片段。

变更：
- `projectMemorySearchResult` 统一返回 compact projection：`snippet=summary`、`disclosure=summary_only`、`detailAvailable=true`、`detailInjected=false`、`readTool` 和 `readInstruction`。
- 移除 event 搜索结果中的 `detailSnippet`，详情必须通过 `readMemory(memoryId)` 读取。
- 补充 `testSearchMemoryToolUsesPolicyLayer` 断言，确认 searchMemory 不包含 event/impression/skill 的 `detail` 或 `detailSnippet`，并保留正确读取工具提示。
- 更新 `IMPLEMENTATION_AUDIT.md`，将 B2 memory 渐进披露标记为已验证并记录偏差修复证据。

验证：
- `PATH=/opt/homebrew/bin:$PATH npm test` 通过。

Git：
- `c7570bc` 收紧记忆搜索渐进披露。

## 2026-06-01 08:20 +08:00

目的：
- 启动长期 docs 实现对齐审计，建立可追踪进度，并先补强 workspace 工具边界的测试证据。

变更：
- 新增 `IMPLEMENTATION_AUDIT.md`，记录文档范围、功能域清单、验证状态、历史记录来源和后续待办。
- 在 `testRuntimeContextAndTools` 中补充 child workspace manifest 可见性与 provider `toolsJson` 可调用工具边界断言。
- 在 `testWorkspaceBoundary` 中补充 main workspace 不暴露 `exitWorkspace` 的断言。
- 检索父级/桌面 markdown 记录，确认当前相关历史记录主要是 `ZLEAP_CHANGELOG.md`。

验证：
- `PATH=/opt/homebrew/bin:$PATH npm test` 通过。

Git：
- `14d1a17` 启动文档实现对齐审计。

## 2026-06-01 07:15 +08:00

目的：
- 把 `RESULT_EVENT_RECALL_LIMIT` 这类运行策略参数从代码常量迁移到 SQLite 配置表，并在 Web UI 增加可调节的 `配置` tab。

变更：
- 新增 `runtime_config` 表和默认配置定义，覆盖 agent 工具循环、memory 召回/事件窗口、LLM 重试/超时和关键上下文预算。
- 新增 `GET /api/config` 与 `PUT /api/config/:key`，仅 creator 可查看和更新，保存时写入 audit log。
- Runtime、WorkspaceRuntime、MemoryService 和 OpenAI-compatible LLM client 改为读取数据库配置，下一次调用即可使用最新值。
- Web UI 顶部在 `概念介绍` 左侧新增 `配置` tab，可按分类查看、编辑、保存或恢复默认值。
- 更新主计划，明确运行参数必须集中进入 `runtime_config`，不再长期依赖不可调代码常量。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- API 验证通过：`GET /api/config?actorId=creator&actorRole=creator` 返回 `runtime_config` 配置列表。
- 浏览器验证通过：刷新 `http://localhost:4173/`，顶部出现 `配置` tab，页面展示 `memory.resultEventRecallLimit` 和 `llm.maxProviderAttempts` 等配置项。
- `git diff --check` 通过，仅有 Windows 换行提示。

Git：
- `61a5564` 新增运行配置中心。

## 2026-06-01 07:03 +08:00

目的：
- 避免 LLM/provider 请求失败后，把失败的用户请求、助手错误占位或过程块长期留在普通对话记录里。

变更：
- 前端每次发送生成本地 `runId`，失败时移除本轮用户消息、过程块和助手占位，只保留临时错误条与重试按钮。
- 浏览器缓存加载时会清理旧版本留下的失败消息及其成对用户消息，避免刷新后继续恢复失败记录。
- 后端 `messages` 写入返回 message id；如果本轮在提交 assistant 回复前失败，runtime 会删除刚写入的用户消息，并把清理动作写入 `audit_logs`。
- 更新主计划，明确失败请求属于临时错误/日志，不属于普通对话历史。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- 浏览器验证通过：刷新 `http://localhost:4173/` 后，对话页、输入框和清空按钮正常出现。
- `git diff --check` 通过，仅有 Windows 换行提示。

Git：
- `8d0f7a1` 避免失败请求污染对话记录。

## 2026-06-01 06:58 +08:00

目的：
- 修复 `searchMemory` 或 Memory 搜索遇到 `302.AI`、域名、URL、文件名等带点号/标点文本时报 `fts5: syntax error near "."` 的问题。

变更：
- `buildFtsQuery` 统一把自然语言 query 转成安全的 FTS5 token 表达式，并对 token 做 quoting。
- `listMemories` 不再把原始 `filters.query` 直接传给 `memories_fts MATCH`，而是复用安全 FTS query。
- 增加测试，覆盖 `repos.listMemories`、自动 `recallMemories` 和模型工具 `searchMemory` 对 `302.AI` 这类带点号 query 的处理。
- 更新主计划和 memory/context 文档，明确所有进入 FTS5 `MATCH` 的 query 都必须在 repository 层安全构造。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- `git diff --check` 通过，仅有 Windows 换行提示。

Git：
- `1aa137e` 修复记忆搜索 FTS 查询转义。

## 2026-06-01 06:54 +08:00

目的：
- 让 agent 更主动地触发 `readMemory`，解决用户追问记忆详情时只根据摘要扩写、不读取完整记忆的问题。

变更：
- 强化系统运行策略和默认系统提示词，把“详细说说 / 展开讲讲 / 具体一点 / 还有哪些细节”等追问写成 `readMemory` 的明确触发场景。
- 在 `runtime_context.memory.memoryDisclosureProtocol` 中增加主动读取触发条件、正例和反例，明确“先简答、追问详情则读 memory detail”的渐进披露流程。
- 强化 `searchMemory` 与 `readMemory` 的工具 schema：要求填写 `reason`，并在参数说明里约束 `searchMemory` 不能作为普通搜索或默认动作。
- 更新主计划、框架概念文档和 memory/context docs，明确该策略依赖 agent 主动判断和提示词/tool schema，不通过 runtime 强制 `tool_choice`。
- 增加测试断言，覆盖主动读取提示词、正反例、`activeReadTriggers` 以及 memory 工具 reason 参数要求。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- `git diff --check` 通过，仅有 Windows 换行提示。

Git：
- `7e250d8` 强化记忆详情读取提示。

## 2026-06-01 06:44 +08:00

目的：
- 按用户要求把“当前工作空间结果事件”的旧结果时间线从约 50 条收紧为约 10 条，减少长对话上下文里旧结果投影占用。

变更：
- 将 runtime 的 `RESULT_EVENT_RECALL_LIMIT` 从 50 改为 10，并同步调整 `recallMemories` 的 result event 默认上限。
- 更新结果事件召回测试断言，确认批量结果事件最多注入 10 条。
- 更新 `概念介绍` 页面、主计划、框架概念文档和 docs 中的长对话 memory 召回说明，统一表达为约 10 条 result event 加少量相关 process event。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- 浏览器验证通过：刷新 `http://localhost:4173/` 并打开 `概念介绍`，页面出现 10 条结果事件说明，不再出现 50 条结果事件说明。
- `git diff --check` 通过，仅有 Windows 换行提示。

Git：
- `81498c3` 收紧结果事件召回上限。

## 2026-06-01 06:41 +08:00

目的：
- 移除 `概念介绍` 上下文窗口堆栈区域里不属于真实堆栈层的说明卡片，避免把 Provider request、Function calling 和 UI trace only 误解成上下文层。

变更：
- 删除概念页上下文窗口堆栈下方的 `Provider request`、`Function calling`、`UI trace only` 三张卡片。
- 删除同一区域里关于原始日志和 JSON 结构化渲染的附加说明，让该板块只展示真实上下文窗口堆栈。
- 清理对应 CSS，并更新主计划与框架概念文档，明确 provider 请求、function-calling 协议、原始日志和 UI trace metadata 不应作为堆栈图里的额外卡片出现。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- `git diff --check` 通过，仅有 Windows 换行提示。
- 浏览器验证通过：刷新 `http://localhost:4173/` 并打开 `概念介绍`，页面只保留 7 个真实上下文层卡片，`Provider request`、`Function calling`、`UI trace only` 和 `.prompt-assembly-lane` 均不存在，memory 子分区仍在第 4 层内部。

Git：
- `d53d0c3` 移除概念页非堆栈说明。

## 2026-06-01 06:38 +08:00

目的：
- 按用户要求把 `memory` 的展开分区直接放回上下文窗口堆栈内部，避免堆栈下方再出现一个分离的 memory 板块。

变更：
- 将 `概念介绍` 页面中独立的 `memory 分区展开` 面板移入第 4 层 `记忆投影` 堆栈卡片内部。
- 保留四个 memory 二级分区说明和渐进披露标签：`crossWorkspaceImpressionMemory`、`currentWorkspaceResultEvents`、`currentWorkspaceRelevantProcessEvents`、`currentWorkspaceSkillMemory`、`readMemory(memoryId)`、`readSkill(skillId)`。
- 更新主计划和 `zleap-agent-framework.md`，明确 memory 子层应直接嵌入上下文堆栈的 `memory` 层。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- `git diff --check` 通过，仅有 Windows 换行提示。
- 浏览器验证通过：刷新 `http://localhost:4173/` 并打开 `概念介绍`，`memory 分区展开` 已位于第 4 层 `记忆投影` 卡片内部，页面不存在独立的 `context-memory-detail` 面板，四个 memory 子分区无横向溢出。

Git：
- `a852225` 内嵌概念页记忆分区。

## 2026-06-01 06:20 +08:00

目的：
- 重做 `概念介绍` 里的上下文窗口堆栈说明，让它能清楚展示一级分区、二级内容和 memory 内部多层投影，而不是只用“上下文概览”粗略描述。

变更：
- 将概念介绍中的“上下文概览”改为更详细的“上下文窗口堆栈”，逐层展示 `system`、`workspace`、`tools`、`memory`、本地对话片段、`user` 和 `tool_result`。
- 在概念介绍中展开 `memory` 的二级分区：跨工作空间印象记忆、当前工作空间结果事件、相关过程事件、当前工作空间经验记忆，并标明 `summary_only`、`detailInjected=false`、`readMemory` 和 `readSkill` 的渐进披露路径。
- 将概念 UI 中面向人的“history”表达改为“本地对话片段”，只说明内部 `segmentType` 是 `history`，避免把英文内部字段当成产品概念。
- 更新 `zleap-agent-framework.md` 和主计划，使概念文档与 Web UI 的详细堆栈图保持一致。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- `git diff --check` 通过，仅有 Windows 换行提示。
- 浏览器验证通过：刷新 `http://localhost:4173/` 并打开 `概念介绍`，可见“上下文窗口堆栈”、`memory` 分区展开、`runtime_context.local_conversation`、`readMemory(memoryId)` 和 `readSkill(skillId)`，页面不再出现“上下文概览”。

Git：
- `3f8dce2` 重做概念介绍上下文堆栈。

## 2026-06-01 06:17 +08:00

目的：
- 让子工作空间返回 main 的 `handoffContext` 不只包含结构化结果和工具证据，也包含 AI 已经在子工作空间里回复过的信息摘要，减少 main 继续编排时的信息损耗。

变更：
- `createChildToMainHandoff` 新增“子工作空间 AI 回复摘要”交接项，从同一子工作空间已保存的 assistant 内容和本次 `exitWorkspace` assistant message 中程序化整理有上限摘要。
- 调整 handoff 裁剪逻辑，保证 `WorkspaceResult` 和 AI 回复摘要不会被尾部工具证据挤掉。
- 更新系统运行策略提示词、主计划、工作空间 runtime 文档、上下文契约文档和概念框架文档，统一说明 AI 回复摘要属于结果型 handoff，不是完整本地历史或工具过程日志。
- 增加 runtime 测试，确认返回 main 的 `crossWorkspaceHandoffContext` 能看到子工作空间 AI 回复摘要。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- `git diff --check` 通过，仅有 Windows 换行提示。

Git：
- `06728d9` 补充 handoff context 助手回复摘要。

## 2026-06-01 06:09 +08:00

目的：
- 修正“当前工作空间相关过程事件记忆”自动注入过多细节的问题，确保过程事件只作为索引/摘要投影进入上下文，完整过程详情由 Agent 通过 `readMemory(memoryId)` 主动读取。

变更：
- 移除 `currentWorkspaceRelevantProcessEvents` 投影里的 `detailSnippet` 字段，新生成的 LLM 上下文不再把过程事件详情片段注入 prompt。
- `runtime_context.memory` 的披露协议改为明确说明 impression/event 只提供 id、标题、摘要和读取入口，过程事件也不注入 `detailSnippet`。
- 右侧结构化记忆视图对历史已保存的过程事件快照做展示过滤，不显示旧的 `detail`、`detailSnippet` 或 `metadataJson` 字段；原始日志模式仍保留真实历史 payload 供调试。
- 更新主计划、memory 模型、hook 生命周期、上下文契约、文档索引、框架概念文档和 Web UI 概念文案，统一“过程事件详情按需读取”的规则。
- 增加测试，确认相关过程事件仍可被召回，但投影中不包含 `detailSnippet` 或原始 detail。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- `git diff --check` 通过，仅有 Windows 换行提示。
- 浏览器验证通过：刷新 `http://localhost:4173/` 后，当前对话页可加载，上下文结构化视图中没有可见 `detailSnippet`。

Git：
- `2aeabbe` 移除过程事件记忆详情注入。

## 2026-06-01 06:02 +08:00

目的：
- 让右侧上下文堆栈的结构化表格单元格可点击查看完整内容，避免长文本被单行截断后无法确认细节。

变更：
- 调整 `JsonTableCell`：表格中所有非空单元格都以可点击预览呈现，点击后打开完整内容弹层。
- 保留单行省略和横向滚动的扫描体验，同时去掉每格额外的“查看”小字，避免表格行高被撑大。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- 浏览器验证通过：刷新 `http://localhost:4173/` 后，右侧上下文结构化表格出现可点击单元格，点击后能打开“完整内容”弹层。

Git：
- `897d0a2` 支持上下文表格单元格查看完整内容。

## 2026-06-01 05:58 +08:00

目的：
- 修复模型在用户追问“详细说说”等详情问题时，没有调用 `readMemory`，而是直接把自动召回的 impression 摘要扩写成回答的问题。

变更：
- 普通 impression/event 记忆投影增加 `disclosure=summary_only`、`detailAvailable=true`、`detailInjected=false` 和 `readInstruction`，明确告诉模型与 UI：当前只有摘要，没有注入完整详情。
- `runtime_context.memory` 增加 `memoryDisclosureProtocol`，标出默认不注入详情，并识别当前用户消息是否像详情追问。
- 强化 runtime 系统提示词和默认 seed 提示词：当用户基于召回摘要继续追问“详细说说”“展开讲讲”“具体一点”“还有哪些细节”等，且上下文里已有相关 memory id 时，必须先调用 `readMemory(memoryId)` 再展开回答。
- 强化 `readMemory` 工具说明和参数 reason 描述，明确它用于详情追问、主动回忆和摘要不足场景。
- 更新主计划、memory 模型、hook 生命周期、上下文契约、docs 索引、框架概念文档和 Web UI 概念介绍，统一“摘要不是详情，详情追问必须渐进读取”的设计准则。
- 增加测试，覆盖系统提示词、memory 上下文投影、披露协议和工具说明。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- `git diff --check` 通过，仅有 Windows 换行提示。

Git：
- `bc84cbf` 强化 readMemory 详情追问触发规则。

## 2026-06-01 05:45 +08:00

目的：
- 按新的记忆策略，让 user impression 除了 Agent 主动 `writeUserImpression` 外，也能由 `afterAgentTurn` hook 做保守防漏写入，避免明确稳定用户信息被遗漏。

变更：
- 新增 `afterAgentTurn` user impression hook 候选提取：识别用户明确陈述的姓名/称呼、稳定身份背景、长期偏好、长期约束、工作习惯或长期项目。
- hook 只写紧凑 user impression；遇到短期任务事实、一次性素材、scope 不清或没有稳定信息时直接跳过。
- hook 写入继续走当前 `userId` scope、relationId 去重、policy 检查和 metadata `sourceRefs`，不设置 `workspaceId`，不保存原始日志。
- 新增 `hook.afterUserImpressionExtracted` 审计记录，方便在日志里看到 hook 确实写入了 user impression。
- 更新主计划、memory 模型文档、hook 生命周期文档、概念介绍和 Web UI 概念 tab 文案。
- 增加测试：短期任务事实不写 impression；稳定姓名/长期偏好可被 hook 写入；重复候选不会重复写入。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- `git diff --check` 通过，仅有 Windows 换行提示。

Git：
- `636513e` 增加用户印象 hook 防漏写入。

## 2026-06-01 05:38 +08:00

目的：
- 修复点击不同消息或运行过程块时，右侧“显示原始日志”和结构化上下文堆栈可能不对应的问题。

变更：
- 原始日志改为按当前选中的 `llmCallId` 展示同一次 `llm_calls` 的 request/response 快照，包括 messages、tools、状态、endpoint/model 和 response，而不是只展示 `final_messages` segment。
- 流式运行过程中的工具结果块改为绑定到收到 tool result 后继续推理的 follow-up LLM call；工具调用块仍绑定到发起 function call 的 LLM call。
- 增加测试，验证工具调用事件和工具结果事件绑定到不同的 LLM call，且工具结果事件对应的上下文堆栈包含 `tool_result` 和 `final_messages`。
- 更新 `ZLEAP_MASTER_PLAN.md`、上下文契约文档、文档索引和概念说明，明确原始日志与结构化堆栈必须共用同一个 `llmCallId`。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- `git diff --check` 通过，仅有 Windows 换行提示。

Git：
- `37599ca` 修复上下文原始日志与消息选择对应。

## 2026-06-01 05:26 +08:00

目的：
- 为普通记忆增加 `readMemory` 渐进读取机制，避免召回和搜索阶段直接塞入完整详情，同时让 Agent 在用户主动要求回忆或摘要不足时能够按 id 读取具体记忆详情。

变更：
- 新增 runtime memory tool `readMemory(memoryId)`，只读取当前 runtime scope 可见的记忆详情，并拒绝模型传入 `userId`、`workspaceId`、`memoryType` 等 scope 字段。
- `searchMemory` 改为返回紧凑投影，只包含 id、标题、摘要、片段、类型、更新时间和读取工具提示，不再默认返回完整 `detail`。
- 自动召回的普通 memory 投影增加 `readTool: "readMemory"`，让上下文窗口和模型都能看到下一步读取详情的入口。
- 更新系统提示词：当用户主动要求回忆、摘要不足以回答、或需要核对某条 impression/event 详情时，应调用 `readMemory(memoryId)`，不要凭摘要脑补。
- 更新 Web UI 概念介绍和核心文档，把普通 memory 与 skill 的渐进式披露逻辑统一起来。
- 增加工具 schema、工作空间工具绑定、scope 隔离、搜索紧凑投影和详情读取的测试覆盖。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- `git diff --check` 通过，仅有 Windows 换行提示。

Git：
- `026639b` 新增 readMemory 渐进读取记忆详情。

## 2026-06-01 05:16 +08:00

目的：
- 提高 user impression 的主动写入倾向，避免用户身份/背景已经被对话或搜索确认后，Agent 仍然只回答不沉淀长期印象。

变更：
- 强化系统提示词里的 `writeUserImpression` 规则：用户问身份、纠正身份、授权搜索关于自己的信息，且当前上下文或工具/工作空间结果确认稳定用户信息时，应主动写入紧凑 user impression，不必等待“记住”指令。
- 明确禁止把原始搜索结果、网页原文、一次性任务细节、未经确认的猜测或敏感隐私写成 impression。
- 更新 `writeUserImpression` 工具说明和参数 schema 描述，让模型知道用户授权搜索确认的稳定公开信息也属于可写入范围。
- 更新 `ZLEAP_MASTER_PLAN.md`、`docs/03-memory-model.md` 和 `zleap-agent-framework.md`，把 user impression 的主动触发边界合并到概念文档。
- 增加系统提示词和工具 schema 断言，防止以后把主动写入规则删掉。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- `git diff --check` 通过，仅有 Windows 换行提示。

Git：
- `f21d3d2` 强化用户印象主动写入策略。

## 2026-06-01 05:12 +08:00

目的：
- 右侧上下文面板为了保持表格可扫读只显示短预览，但仍需要能点击查看完整文字、参数、结果或 JSON 对象。

变更：
- 结构化 JSON 表格中的长文本、数组和对象单元格改为可点击预览。
- 点击后打开“完整内容”弹层，展示完整文本或格式化 JSON，并自动换行，避免只靠 `title` 或横向滚动查看。
- 更新 `ZLEAP_MASTER_PLAN.md`，把“短预览必须可点击查看全文”纳入右侧上下文检查器准则。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- `git diff --check` 通过，仅有 Windows 换行提示。

Git：
- `419fd5b` 支持右栏预览查看全文。

## 2026-06-01 05:08 +08:00

目的：
- 修正子工作空间上下文隔离的边界：进入子空间需要有任务背景，但不能混入父级 assistant/tool 执行记录或 sibling workspace 记录。
- 让上下文窗口 UI 明确区分“当前工作空间本地对话”和“交接上下文”，避免把参考包误读为 Search/Dev 自己的本地历史。

变更：
- `AgentRuntime.createParentToChildHandoff` 改为生成受控参考包：总体要求与入口任务、少量用户原话参考、当前用户请求；不再传 `enterWorkspace` 原始结果、父级 recent tool evidence 或 assistant 执行记录。
- `ContextBuilder` 的 `runtime_context.local_conversation` 将跨空间包命名为 `crossWorkspaceHandoffContext`，同时更新系统提示词，说明用户原话只是交接参考，不是子工作空间本地对话。
- Chat 右侧结构化上下文标签改为“当前工作空间本地对话”“当前工作空间历史结果”“交接上下文（非本地对话）”，降低误判。
- 更新 `ZLEAP_MASTER_PLAN.md`、`docs/02-workspace-runtime.md`、`docs/07-context-and-prompt-contracts.md` 和 `zleap-agent-framework.md`，把进入子空间 handoff 的新边界合并进概念文档。
- 增加回归断言，验证子空间 handoff 保留用户原话参考，但不包含父级 assistant 回复、`enterWorkspace` 或父工作空间工具结果。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- `git diff --check` 通过，仅有 Windows 换行提示。

Git：
- `aee25a0` 修正子工作空间交接上下文隔离。

## 2026-06-01 04:40 +08:00

目的：
- 收紧 memory 存储边界，避免记忆行变成第二份原始 JSON 日志仓库。
- 降低 memory metadata 冗余，让原始消息、工具调用、LLM 请求和工作空间会话只保存在各自原始表里，memory 只保存语义投影和证据引用。

变更：
- 自动事件记忆不再重复保存 `evidenceMessageIds`、`workspaceSessionIds`、`toolCallIds`、`messageCount` 等顶层冗余字段，统一通过 `sourceRefs: [{ table, ids }]` 追溯原始表。
- runtime 写入 impression/skill 时只保留紧凑的 `activeWorkspaceId`、`workspaceSessionId`、`taskId` 来源字段，不再保存同义数组。
- `toolCallsForEventMemories` 改为从 `sourceRefs` 读取工具调用证据，保持 skill 自动候选仍能基于事件证据判断是否有可复用经验。
- Memory UI 移除可编辑的“元数据 JSON”大文本框，改为结构化“证据引用”视图，并明确提示原始数据在数据表中，记忆只保存语义投影和可追溯 ID。
- 更新 `ZLEAP_MASTER_PLAN.md`、`docs/03-memory-model.md`、`docs/05-hooks-and-lifecycle.md`、`docs/07-context-and-prompt-contracts.md` 和 `zleap-agent-framework.md`，把 `sourceRefs` 作为 memory 证据引用的规范入口，禁止为了调试重复保存原始 payload 或同义证据数组。
- 更新回归测试，验证事件记忆通过 `sourceRefs` 保留 20 条消息引用、排除旧窗口证据，并确认冗余字段不再写入。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- `git diff --check` 通过。

Git：
- 本轮待提交。

## 2026-06-01 04:20 +08:00

目的：
- 修复子工作空间上下文隔离问题，避免不同工作空间的对话记录、编排工具协议和已完成结果混进同一个本地 history。
- 将“跨工作空间只通过 handoffContext 交付结果，本地历史只属于当前 workspace”的契约写回核心文档。

变更：
- `ContextBuilder` 在生成 `history.completedWorkspaceResults` 时按当前 workspace 过滤：`main` 仍可看到已完成工作空间结果用于编排整合，子工作空间只能看到同一 workspace 的历史结果。
- `AgentRuntime.selectLocalHistory` 回放子工作空间本地记录时，只保留当前 workspace 可见工具产生的 function call / tool result，避免把 `enterWorkspace` 等 main-only 编排协议当成本地对话片段。
- `AgentRuntime.selectWorkspaceRawTail` 返回子空间 handoff 尾巴时，同样过滤非当前 workspace 工具结果，避免 `enterWorkspace` 从 raw tail 泄漏回 main 的结果包。
- 增加回归测试，验证子空间 handoff 不包含 `enterWorkspace`，第二次进入同一 `dev` 工作空间时本地 history 只含同空间 `exitWorkspace`，不含 main 编排消息。
- 更新 `ZLEAP_MASTER_PLAN.md`、`docs/07-context-and-prompt-contracts.md` 和 `zleap-agent-framework.md`，明确子 workspace 的普通 `messages`、`completedWorkspaceResults`、`recentToolEvidence` 必须按当前 workspace 隔离，跨空间内容只能作为受控 `handoffContext` 出现。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- `git diff --check` 通过。

Git：
- 本轮待提交。

## 2026-06-01 04:10 +08:00

目的：
- 修复 Chat 右侧上下文面板中的结构化表格可读性问题，避免长文本、数组和对象把表格行纵向撑得过高。
- 支持用户按需要调整 Chat 右侧上下文面板宽度。

变更：
- 结构化 JSON 表格中的复杂值改为单行短预览，长内容通过 `title` 保留悬停查看，避免 capabilities 等数组逐项竖排。
- 表格容器启用横向滚动，宽表不再挤压每一列或撑高整行。
- Chat 右侧上下文面板增加左侧拖拽把手，可调整宽度并写入浏览器缓存。
- 更新 `ZLEAP_MASTER_PLAN.md`，把右侧面板表格可读性和可调宽度纳入 UI 准则。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- 浏览器验证通过：右侧表格容器 `overflow-x=auto`，表格实际宽度大于容器宽度，单元格为 nowrap/hidden，右栏拖拽把手存在。

Git：
- 本轮待提交。

## 2026-05-31 22:44 +08:00

目的：
- 强化子工作空间的职责边界，避免搜索类工作空间完成搜索后继续代做生成网页、写文件等下游产物任务。

变更：
- 在 `ContextBuilder` 的内部 workspace 决策契约中加入“产物责任边界”：当前 workspace 只能交付自己工具和说明真实支持的结果，不能因为理解最终目标就越界生成文件、网页、报告或其他下游产物。
- 子工作空间 prompt 明确要求：完成当前能力切片后调用 `exitWorkspace`，搜索类 workspace 只返回搜索结果、来源、可信度、缺口和建议下一步；生成网页、写文件、运行命令等交给 main 再调度到对应 workspace。
- `WorkspaceRuntime` 为子工作空间任务增加持久化 constraints，要求只完成当前 workspace 能力范围内的任务切片，不声明当前工具没有真实产出的 artifacts。
- 更新默认 main workspace seed 说明，强调多阶段任务要按能力切片调度。
- 更新 `ZLEAP_MASTER_PLAN.md`、`docs/02-workspace-runtime.md`、`docs/07-context-and-prompt-contracts.md` 和 `zleap-agent-framework.md`，把产物责任边界融合到正式概念中。
- 增加测试断言，确保 system prompt 和 `WorkspaceTask.constraints` 中都能看到这条边界。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- `git diff --check` 通过。

Git：
- 本轮待提交。

## 2026-05-31 22:39 +08:00

目的：
- 支持子工作空间中断续跑：当任务在子工作空间失败、等待、被用户手动停止或需要补充信息后，下一条用户输入应自动回到原子工作空间继续，而不是丢回 main 重新调度。

变更：
- `AgentRuntime.prepare` 在新增用户消息前后检查同一会话中最后一个可续跑的非 `main` 工作空间 session，并优先恢复该 session。
- 可续跑状态包括 `running`、`failed`、`blocked`、`needs_user_input` 和 `needs_approval`。
- 恢复时把当前用户输入写入该子工作空间的 `WorkspaceTask.relevantUserRequest` 和 `WorkspaceLocalContext.parentContextSummary`，重建该子工作空间的 context stack 和可调用工具边界。
- 只有子工作空间通过 `exitWorkspace` 提交结构化 `WorkspaceResult` 后，runtime 才回到 `main`。
- `updateWorkspaceSessionLocalContext` 同步持久化 `taskJson`，避免二次中断续跑时读回旧任务文本。
- 更新 `ZLEAP_MASTER_PLAN.md`、`docs/02-workspace-runtime.md` 和 `docs/07-context-and-prompt-contracts.md`，把“新任务进 main、未完成子空间优先续跑”的规则融合进正式契约。
- 增加回归测试，覆盖失败的 `dev` session 被下一条用户消息直接恢复，并验证首次恢复调用暴露 `dev` 工具而不暴露 `enterWorkspace`。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。

Git：
- 本轮待提交。

## 2026-05-31 22:26 +08:00

目的：
- 修复右侧“当前工作空间”只显示整轮最终状态的问题，让它跟随当前点击的消息、过程块或 LLM 调用。

变更：
- 右侧工作空间状态优先读取选中消息自身的 `workspaceId`。
- 若选中项只有 `llmCallId`，则从该 LLM 调用对应的 `workspace`/`tools` context segment 解析真实 active workspace。
- 只有无法从选中项反查时，才回退到整轮最终 workspace 状态。
- 修复缓存消息判断里错误的中文角色字符串，避免用户消息上下文选择走错分支。

验证：
- `npm run typecheck` 通过。
- `npm run build` 通过。
- `git diff --check` 通过。

Git：
- 本轮待提交。

## 2026-05-31 22:13 +08:00

目的：
- 保留 tab 切换不中断对话运行的机制，但不要在顶层 tab 栏展示正在回复状态或全局停止按钮。

变更：
- 移除 `App` 顶层 `globalRun` 状态和导航旁的运行 banner。
- `ChatTab` 继续保持挂载，切换 tab 时不会卸载当前流式请求、消息状态或工具调用展示。
- 停止按钮只保留在 `对话` 页输入区内部，用户回到对话页后仍可停止当前运行。
- 更新 `ZLEAP_MASTER_PLAN.md`，明确顶层 tab 栏不显示“正在回复”状态。

验证：
- `npm run typecheck` 通过。
- `npm run build` 通过。
- `git diff --check` 通过。

Git：
- 本轮待提交。

## 2026-05-31 21:14 +08:00

目的：
- 让每一次模型工具调用的理由在运行过程 UI 和工具调用记录里可见。
- 减少 `dev` 工作空间对万能命令行的依赖，把文件搜索、读取、写入和命令执行拆成更可靠的基础能力。

变更：
- 参考 Claude Code 和 OpenCode 的公开工具/权限设计，把 `dev` 内置工具扩展为 `searchFiles`、`readFile`、`writeFile`、`runCommand`。
- `readFile` 读取仓库根目录内文件片段，带行数上限和大文件保护。
- `writeFile` 覆盖写入仓库根目录内 UTF-8 文件，支持按需创建父目录。
- `runCommand` 增加 `reason`、仓库内 `cwd` 和 `timeoutMs` 参数，继续作为高风险终端执行工具。
- 更新默认系统提示词和 `dev` 工作空间工具说明：每次 function call 都必须填写 `reason`；普通文件读写不要绕到 shell；命令只用于测试、构建、脚本、诊断或用户明确要求的终端任务。
- 更新前端运行过程展示：工具调用和工具结果的一行摘要会显示调用理由，展开详情也能看到理由、参数和结果。
- 更新主计划和相关 docs，将工具分层、调用理由和命令行使用边界融合进正文。
- 增加测试覆盖内置工具绑定、工具 schema 中的 `reason/cwd/timeoutMs`、`readFile/writeFile` 真实执行路径。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- `git diff --check` 通过。

Git：
- 本轮待提交。

## 2026-05-31 20:59 +08:00

目的：
- 让原始对话和运行证据可在 UI 中直接验收，同时确保 memory 不再复制原始 JSON，而是通过来源表和行 ID 追溯。
- 修复运行中切换 tab 后视觉上像任务停止的问题，让生成状态和停止动作跨 tab 可见。

变更：
- 新增 creator-only 的 `数据表` 顶层 tab，可切换查看 SQLite 中的应用表、分页浏览行、查看当前行结构化详情。
- 新增只读 HTTP API：`GET /api/db/tables` 和 `GET /api/db/tables/:table`，并在 repository 层校验表名、限制分页和 creator 权限。
- 明确现有原始数据表职责：`messages`、`llm_calls`、`context_segments`、`tool_calls`、`workspace_sessions`、`audit_logs` 保存原始对话与运行证据。
- 自动 event memory 的 metadata 增加 `sourceRefs: [{ table, ids }]`，继续保留 evidence id，但不复制原始消息、工具调用、workspace session 或 provider payload JSON。
- Memory 写入策略新增 raw payload metadata 拦截，拒绝 `windowMessages`、`toolCalls`、`argumentsJson`、`resultJson`、`messagesJson`、`responseJson`、`rawJson`、`finalMessages` 等字段。
- 更新 `ZLEAP_MASTER_PLAN.md`、框架概念文档和相关 docs，将“memory 只保存语义投影 + 来源引用，原始数据回查走原始表”融合进正文。
- 增加回归测试，覆盖数据表只读查看、creator 权限、event memory `sourceRefs` 和 raw payload metadata 拒绝。
- 将运行中的状态提升到顶栏全局提示：切换到任意 tab 时仍显示“对话正在生成”，并保留可点击的 `停止` 按钮。
- 更新 `ZLEAP_MASTER_PLAN.md`，把运行中全局状态和停止按钮跨 tab 可见写入 UI 契约。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- `git diff --check` 通过。
- 已用当前服务验证 `GET /api/db/tables?actorId=creator&actorRole=creator` 和 `GET /api/db/tables/messages?actorId=creator&actorRole=creator&limit=2&offset=0` 返回正常。

Git：
- 本轮待提交。

## 2026-05-31 20:41 +08:00

目的：
- 修复切换顶层 tab 后对话 UI 过程断掉的问题，保证 UI 切换不影响正在运行的流式对话和工具调用展示。

变更：
- 顶层 `App` 不再按当前 tab 条件卸载页面组件，改为一次挂载全部 tab 页面，并用 `.tab-panel` 隐藏非当前页面。
- `ChatTab` 因此在切换到工作空间、记忆、日志或概念介绍时保持挂载，当前 stream reader、消息列表、loading 状态和上下文选择不会被销毁。
- 只有点击 `停止` 才会主动 abort 当前流式请求；普通 UI tab 切换不会中断前端监听。
- 更新 `ZLEAP_MASTER_PLAN.md`，把 tab 切换不应中断对话流写入 UI 契约。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- `git diff --check` 通过。
- 当前环境没有暴露可操作 in-app browser 的浏览器控制工具；本轮通过代码结构确认 `ChatTab` 不再随 tab 切换卸载。

Git：
- 本轮待提交。

## 2026-05-31 20:32 +08:00

目的：
- 将变更日志整体中文化，并把“日志、更新、文档和后续 Git 提交信息默认使用中文”的规则写入主计划。

变更：
- 将 `ZLEAP_CHANGELOG.md` 的标题、栏目和历史条目改为中文叙述。
- 保留代码标识符、接口名、命令、路径、类型名和历史 commit title 的原文。
- 更新 `ZLEAP_MASTER_PLAN.md`，说明之后的日志、更新说明、文档叙述和 Git 提交信息都默认使用中文。

验证：
- 已扫描旧英文栏目名和常见英文状态描述，变更日志正文没有残留旧栏目格式。
- `git diff --check` 通过。

Git：
- 将由本次 Git 提交记录。

## 2026-05-31 20:25 +08:00

目的：
- 规范化 `docs/` 设计文档，让后续文档更新融入概念正文，而不是按日期追加 update 小节。

变更：
- 在 `ZLEAP_MASTER_PLAN.md` 和 `docs/README.md` 中加入文档维护规则。
- 移除受影响设计文档里的日期式 update 小节，并把内容合并进对应概念章节。
- 将主要文档叙述和标题中文化，同时保留代码标识符、API 名、类型名和协议字段。
- 将生命周期示例改为统一的 `dev` 工作空间，不再沿用旧的 File/CLI 分离流程。

验证：
- `rg -n "(^#{1,4} .*202[0-9]|2026-05|update:|Update:|更新：|clarification:)" docs` 没有命中。
- `git diff --check` 通过。

Git：
- 已由对应提交记录。

## 2026-05-31 20:17 +08:00

目的：
- 删除过时的实现验收总结，因为它是一次性验收材料，不属于当前事实来源文档。

变更：
- 删除 `ZLEAP_IMPLEMENTATION_ACCEPTANCE_SUMMARY.md`。
- `ZLEAP_MASTER_PLAN.md` 保持不变，因为这次清理不改变架构、runtime、UI、memory、LLM 协议或数据模型。

验证：
- 本工作会话中待验证。

Git：
- 待记录。

## 2026-05-31 20:13 +08:00

目的：
- 将默认 File 和 CLI 工作空间合并为一个统一的开发工作空间。

变更：
- 用 `dev` / 开发工作空间替换默认内置 `file` 和 `cli` 工作空间。
- 将内置 runtime 工具 `searchFiles` 和 `runCommand` 都挂载到 `dev`。
- 更新 runtime 工具保护逻辑，让两个工具只在 `dev` 中执行。
- 更新工作空间选择提示、UI 内置工作空间保护和概念指南里的工作空间地图。
- Seed 会把旧数据库中的 `file`/`cli` memory、approval、MCP server、workspace-tool 和 workspace 记录迁移到 `dev`，避免本地数据库继续显示分离的默认 File/CLI 工作空间。
- 更新主计划和 docs，让 prompt/concept 描述 `main + dev + MCP extensions`，而不是 `main/file/cli`。
- 更新测试，覆盖新的默认工作空间边界：main 不能直接调用 dev 工具，dev 可以同时使用文件搜索和命令执行。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- 已重启本地 Web 服务 `http://localhost:4173/`；`/api/health` 返回 `{"ok":true}`。
- 已验证 `/api/workspaces` 显示内置 `dev` 和 `main`，且 `dev` 暴露 `searchFiles` 和 `runCommand`。

Git：
- 待记录。

## 2026-05-31 19:56 +08:00

目的：
- 在聊天输入区加入停止按钮，让用户可以中断正在流式运行的 agent 回合。

变更：
- 在 Chat 回合生成中显示 `停止` 按钮。
- Web UI 现在会 abort 当前 stream fetch，并把流式消息标记为已停止，而不是失败/可重试。
- Streaming API 现在通过 `AbortSignal` 把客户端断开传递给 `AgentRuntime` 和 provider fetch/stream reads。
- 在主计划中记录停止运行行为。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- 已重启本地 Web 服务 `http://localhost:4173/`；`/api/health` 返回 `{"ok":true}`。
- 浏览器验证通过：流式请求运行中会出现 `停止` 按钮，点击后停止可见流并显示 `已停止运行。`。

Git：
- 待记录。

## 2026-05-31 19:48 +08:00

目的：
- 修复工具执行后的 follow-up LLM 上下文快照，避免模型和 UI 只剩可调用工具与工具结果，而丢失完整 active context。

变更：
- 工具循环中的 follow-up LLM 调用现在会先复制 active base context stack（`system`、`workspace`、`tools`、`memory`、`history` 和干净 `user`），再追加 function-call/tool-result evidence。
- follow-up `tool_result` segment 现在记录累积的 assistant function calls 和真实 tool result messages，并排除 synthetic runtime context tool messages。
- 增加非流式和流式多步工具循环回归测试，确保 follow-up context stack 保持完整。
- 更新主计划和上下文契约文档，记录完整 follow-up context snapshot 要求。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- 已重启本地 Web 服务 `http://localhost:4173/`；`/api/health` 返回 `{"ok":true}`。

Git：
- 已由 Git 提交 `fix: preserve follow-up context stack` 记录。

## 2026-05-31 19:41 +08:00

目的：
- 修复 Skill memory 提取，让它保存可复用、脱敏的经验，而不是任务结果或私有任务细节。

变更：
- 收紧 hook-based Skill candidate extraction：普通工作空间完成本身不再创建 Skill memory。
- Hook 生成的 Skill 现在必须有明确可复用证据，比如能力工具流程或失败恢复路径。
- Hook 生成的 Skill detail 不再复制 process/result event 文本、原始 function-call 参数、原始工具输出、用户身份、任务原文、路径、账号或源日志。
- 添加稳定 `skillFingerprint` 去重，让同一工作空间中的相似 Skill 复用已有记录，而不是创建近重复项。
- 扩展 Skill 质量检查，拒绝任务特定身份/原始对话泄漏和 event-hook 原始证据复制。
- 更新主计划、框架概念文档、memory model 文档和 lifecycle hook 文档，记录更严格的 Skill 提取契约。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- 已重启本地 Web 服务 `http://localhost:4173/`；`/api/health` 返回 `{"ok":true}`。

Git：
- 待记录。

## 2026-05-31 19:25 +08:00

目的：
- 防止 CLI/tool results 返回后，流式 LLM follow-up 调用永久停留在 `pending`。

变更：
- 给 OpenAI-compatible client 加入可配置 provider fetch timeout 和 stream idle timeout。
- 流式响应读取在 idle 窗口内没有新 provider 数据时，会用清晰 timeout diagnostic 失败。
- 添加回归测试，证明流式 tool-call follow-up 失败会在 `llm_calls` 中标记为 `failed`，而不是等到服务重启。
- 更新主计划，记录有界流式请求与失败终结要求。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- 已重启本地 Web 服务 `http://localhost:4173/`；`/api/health` 返回 `{"ok":true}`。

Git：
- 已由 Git 提交 `fix: timeout stalled llm streams` 记录。

## 2026-05-31 19:17 +08:00

目的：
- 通过 prompt 约束让 agent 不再过度调用 `searchMemory`，明确自动召回才是常规记忆路径，手动记忆搜索只是低频 fallback。

变更：
- 在系统 prompt 中增加 `searchMemory` 适用场景：自动上下文不足、用户询问过去记忆/历史、任务依赖旧记忆证据。
- 明确禁止把 `searchMemory` 当成普通搜索、工作空间/工具发现、泛化安全检查或反复模糊探测。
- 更新 seed 中 `searchMemory` 工具描述，把它定位为低频 scoped memory fallback search。
- 更新 `ZLEAP_MASTER_PLAN.md` 中的 `searchMemory` 使用边界。
- 添加 prompt contract 和工具描述测试。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- 已重启本地 Web UI 服务 `http://localhost:4173/`；`/api/health` 返回 `{ "ok": true }`。
- 已验证本地 SQLite seed 刷新了 `searchMemory` 工具描述和默认 agent system prompt。

Git：
- 已由提交 `099c37e fix: constrain search memory prompting` 记录。

## 2026-05-31 19:13 +08:00

目的：
- 收紧事件过程记忆，让它像紧凑记忆，而不是保存嘈杂 runtime trace payload。

变更：
- 将 workspace-exit hook 的 process-event detail 改为紧凑 task/status/observation/tool-overview 摘要。
- 将 conversation-window process-event detail 改为紧凑 window/user-intent/session/tool overview。
- 停止把 recalled memory dumps、raw message windows、`argumentsJson`、`resultJson` 和完整 tool/session JSON 写入 process memory detail。
- 添加测试，确保 process event detail 保持在紧凑限制内，且不包含原始 trace 字段。
- 更新 `ZLEAP_MASTER_PLAN.md`，记录 process event memory 边界。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- 已重启本地 Web UI 服务 `http://localhost:4173/`；`/api/health` 返回 `{ "ok": true }`。

Git：
- 已由提交 `b01d3e2 fix: compact process event memory` 记录。

## 2026-05-31 19:05 +08:00

目的：
- 在流式 400 响应被显示成压缩二进制乱码后，让 LLM provider 失败更可诊断、更具韧性。

变更：
- 对临时性 LLM 失败加入服务端 provider retry，最多 5 次：网络错误、408/409/425、429 和 5xx。
- 保持不可重试的 4xx 请求错误立即失败，避免盲目重复无效 payload。
- 保存/显示 provider error response 前，加入 gzip、brotli 和 deflate 解码。
- 添加测试，覆盖 5 次重试、流式 429 重试和压缩 400 error 解码。
- 更新 `ZLEAP_MASTER_PLAN.md`，记录 retry 和 error-decoding LLM contract。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- 已重启本地 Web UI 服务 `http://localhost:4173/`；`/api/health` 返回 `{ "ok": true }`。

Git：
- 已由提交 `27da167 fix: retry and decode llm provider errors` 记录。

## 2026-05-31 09:02 +08:00

目的：
- 澄清 Skill progressive disclosure 是否真的注入上下文堆栈，并让 UI 直接显示该状态。

变更：
- 通过本地 SQLite trace 验证 child workspace LLM calls 可以包含带 `summary_only` 和 `readSkill` 的 `currentWorkspaceSkillMemory`，而 `main` 调用可以正确显示 0 条 workspace-scoped Skill 记录。
- 在 Chat 右侧面板添加结构化 memory-context renderer。
- Skill memory 区域现在显示注入的 Skill title/summary、disclosure mode、`readSkill` tool hint、relation id、confidence 和 id，不需要阅读原始 JSON。
- 当选中 LLM call 没有 active-workspace Skill recall 时，增加空状态解释。
- 更新 `ZLEAP_MASTER_PLAN.md`，把 context-stack Skill disclosure 可见性纳入 UI contract。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- `http://localhost:4173/` 的 `/api/health` 返回 `{ "ok": true }`。

Git：
- 本工作会话中待记录。

## 2026-05-31 08:52 +08:00

目的：
- 通过 runtime 控制的 result handoff context 减少工作空间切换时的信息损失，并稳定面向用户的回复语言。

变更：
- 向 workspace local context 添加 `WorkspaceHandoffContext`。
- 进入子工作空间时，runtime 现在只携带当前用户请求、workspace-entry result 和有上限的 parent result evidence，而不是无关全局历史。
- 返回 main 时，runtime 现在携带完整 child `WorkspaceResult`、child workspace 的 final assistant context 和关键 tool results；tool-call 参数和冗长中间过程日志保留在 trace/debug storage。
- 更新 hidden runtime prompt，要求 main 把 child handoff results 当成权威证据，不得随意二次概括掉或遗漏关键事实。
- 增加系统级语言规则：面向用户的回复遵循用户当前消息语言，除非用户要求翻译或指定其他语言。
- 更新主计划和 context/workspace docs，记录软件 handoff 模型：传递完成结果，而不是完整编辑历史。
- 添加测试，证明 handoff context 存在于 child/main transitions 中，同时排除 `tool_call` process items；并测试 system prompt 中的语言规则。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- 已重启本地 Web UI 服务 `http://localhost:4173/`；`/api/health` 返回 `{ "ok": true }`。

Git：
- 已由 Git 提交 `feat: add workspace handoff context` 记录。

## 2026-05-31 08:39 +08:00

目的：
- 实现 Skill memory 渐进式披露，让 prompt 先看到最近 Skill 名称/简介，只有当某条 Skill 与当前任务明确相关时，agent 才读取完整 Skill 详情。

变更：
- 添加 runtime memory tool `readSkill`，并和 `searchMemory`、impression writes、`writeSkillMemory` 一起注册到每个 workspace。
- Skill recall 改为加载最近 active-workspace Skill summaries，不再使用 FTS 过滤；prompt projection 不再自动注入 Skill detail/procedure。
- 更新 hidden runtime prompt，教 agent 何时调用 `readSkill`，并收紧 `writeSkillMemory` 对具体可复用流程、失败恢复、已验证工具流程和非空泛经验的要求。
- 强化 Skill quality gates 和 hook extraction，让低置信度或空泛 Skill 记录被拒绝，同时保留具体 search/inspect/edit/tool workflows。
- 更新概念 tab 和 concept/master docs，解释 progressive Skill disclosure 与更严格的 Skill 生成标准。
- 添加 `readSkill` schema/binding/scope 隔离测试，以及 summary-only Skill prompt injection 测试。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- 已重启本地 Web UI 服务 `http://localhost:4173/`；`/api/health` 返回 `{ "ok": true }`。

Git：
- 本工作会话中待记录。

## 2026-05-31 08:27 +08:00

目的：
- 让已有和缓存的 function-call/tool-result 过程消息显示具体参数和结果摘要，而不是只显示工具名。

变更：
- 更新 `src/web/main.tsx`，当缓存消息没有结构化 process items 时，从关联 LLM response 和 `tool_calls` trace logs 重建 process preview items。
- 为常见 tool payload 增加参数/结果摘要器，例如搜索 query、shell command、stdout、summary、snippet 和 error。
- 更新 process previews/details 使用重建条目，让折叠行能显示 `metasoSearch` 搜了什么、每个工具大致返回了什么。
- 更新 `ZLEAP_MASTER_PLAN.md`，记录旧缓存 process messages 的 fallback trace reconstruction 要求。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- 已重启本地 Web 服务 `http://localhost:4173/`；`/api/health` 返回 `{"ok": true}`。

Git：
- 已由 Git 提交 `fix: recover process event details` 记录。

## 2026-05-31 08:23 +08:00

目的：
- 移除 Chat context inspector 原始 LLM 日志视图中的横向滚动。

变更：
- 更新 `src/web/styles.css`，让 raw `final_messages` logs 自动换行、打断长 token，并隐藏横向 overflow。
- 更新 `ZLEAP_MASTER_PLAN.md`、`docs/07-context-and-prompt-contracts.md`、`docs/README.md` 和 `zleap-agent-framework.md`，记录 raw provider logs 必须在面板内换行，而不是使用 X 轴滚动。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- 已重启本地 Web 服务 `http://localhost:4173/`；`/api/health` 返回 `{"ok": true}`。

Git：
- 已由 Git 提交 `fix: wrap raw llm logs` 记录。

## 2026-05-31 08:19 +08:00

目的：
- 让 function-call 和 tool-result 过程消息一眼可读，并把调用参数与返回结果分开。

变更：
- 给流式 workspace/tool events 添加 structured process items，让 tool calls 携带 `argumentsJson`，tool results 携带 `resultJson`。
- Chat process blocks 折叠时也显示一行工具调用/结果摘要。
- 展开的 process details 中，function-call blocks 显示真实参数，tool-result blocks 显示真实返回结果。
- 更新 `ZLEAP_MASTER_PLAN.md`，记录预期 process-message display contract。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- 已重启本地 Web 服务 `http://localhost:4173/`；`/api/health` 返回 `{"ok": true}`。

Git：
- 已由 Git 提交 `fix: summarize process tool events` 记录。

## 2026-05-31 08:14 +08:00

目的：
- 修复 Chat context inspector 的 raw-log UI，让 raw mode 只直接显示原始 LLM messages log，而不是显示编号 context stack 或要求再展开一次。

变更：
- 更新 `src/web/main.tsx`，structured mode 显示不含 `final_messages` 的编号 context stack；raw-log mode 隐藏该堆栈，并直接用 raw text view 渲染保存的 `final_messages` 内容。
- 更新 `src/web/styles.css`，支持直接 raw log panel。
- 更新 `ZLEAP_MASTER_PLAN.md`、`docs/07-context-and-prompt-contracts.md`、`docs/README.md` 和 `zleap-agent-framework.md`，明确 raw provider-log mode 会隐藏 structured stack 并直接显示 `final_messages`。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- 已重启本地 Web 服务 `http://localhost:4173/`；`/api/health` 返回 `{"ok": true}`。

Git：
- 已由 Git 提交 `fix: show raw llm log directly` 记录。

## 2026-05-31 08:06 +08:00

目的：
- 修复 Chat context inspection，点击某条用户消息时显示该消息自己的干净用户输入，而不是过期/更早回合，例如 `我是谁`。

变更：
- 更新 `src/web/main.tsx`，用户消息优先使用自己的 `turnOutput.contextSegments[0].llmCallId`，而不是缓存的 `inspectLlmCallId`。
- 发送新消息时清理 stale selected LLM call state。
- stream completion binding 改为从 `payload.output.contextSegments` 推导当前回合 first call，再只选择此后 LLM calls 作为 assistant final-call binding。
- 在流式 workspace/process events 中添加 `llmCallId`，并保存到可见 workspace/process chat messages，让模型主动产生的中间回复能检查生成它们的确切 LLM call。
- 更新 assistant-message fallback binding，让最终 assistant reply 解析到自己当前回合的 final LLM call，中间模型生成的 workspace messages 使用其 streamed `llmCallId`。
- 更新 `ZLEAP_MASTER_PLAN.md`，记录用户消息绑定自己的发送回合上下文，AI 回复绑定产生该可见响应的具体模型调用，包括模型主动多轮调用。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- 已重启本地 Web 服务 `http://localhost:4173/`；`/api/health` 返回 `{"ok": true}`。

Git：
- 已由 Git 提交 `fix: bind chat context to current turn` 记录。

## 2026-05-31 07:56 +08:00

目的：
- 修改 Chat context inspector 的 raw-log 行为，让 `显示原始日志` 将整个 context stack 切换为 raw text mode，而不是追加单独 raw-log block。

变更：
- 更新 `src/web/main.tsx`，context stack 使用一个 displayed segment list：structured mode 隐藏 `final_messages`，raw mode 显示完整 inspected stack，并把每个 segment 渲染为 raw text。
- 增加 raw stack renderer 和 `raw-json` 样式，让 raw mode 显示直接 JSON/text，而不是结构化 JSON 表格。
- 更新 `ZLEAP_MASTER_PLAN.md`、`docs/07-context-and-prompt-contracts.md`、`docs/README.md` 和 `zleap-agent-framework.md`，把 raw-log toggle 行为纳入设计契约。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- 已重启本地 Web 服务 `http://localhost:4173/`；`/api/health` 返回 `{"ok": true}`。

Git：
- 已由 Git 提交 `fix: toggle raw context stack` 记录。

## 2026-05-31 07:50 +08:00

目的：
- 修复 prompt assembly 边界，并保护当前用户 impression recall。

变更：
- Prompt assembly 改为 system message 只包含 system/personality/runtime policy 文本。
- Workspace manifest/context injection 从 system message 移到 synthetic `runtime_context.workspace` tool result。
- Memory 和 local conversation 保持为 synthetic tool results，callable schemas 只保留在 OpenAI-compatible 顶层 `tools` request array。
- 添加测试，证明 system message 不再包含 `## Callable Tools`、`toolCount` 或 workspace JSON，同时 workspace manifest 仍通过 `runtime_context.workspace` 可见。
- 添加 recall 覆盖，证明当前用户 impressions 和当前 agent self impressions 都会注入，其他用户 impressions 被排除。
- 更新 master/context/concept docs，记录修正后的 prompt assembly boundary。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。

Git：
- 已由 Git 提交 `feat: add progressive skill disclosure` 记录。

## 2026-05-31 07:43 +08:00

目的：
- 让 memory scope 可检查，并防止 user-impression 与 agent-self-impression 混淆。

变更：
- 强化 runtime system memory-write protocol：`writeUserImpression` 只用于当前用户长期事实，`writeAgentSelfImpression` 只用于 creator 授权的 agent identity/self-knowledge。
- 增加 conversation trace memory-write recovery，让 Chat 右侧面板即使 run output cache 漏掉记录，也能显示与 selected run 关联的 memory rows。
- 更新 Memory tab 表格和编辑器，显示 `agentId`、`relationId` 和可读 scope label。
- 更新右侧面板 memory write display，显示 scope、userId、agentId、workspaceId、relationId、summary 和结构化完整记录视图。
- 更新 master/concept/memory/lifecycle docs，明确 impression scope 规则，并移除过时的模型可调用 event/update memory 指引。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。

Git：
- 已由引入本日志条目的 Git 提交记录。

## 2026-05-31 07:38 +08:00

目的：
- 让 context stack 和 JSON-heavy debug views 足够可读，能验证 callable tools 和 runtime partitions，而不用扫原始 JSON blobs。

变更：
- 给 Web UI 增加可复用 structured JSON viewer。
- Context stack sections 改为把 parsed JSON 渲染成 field groups、nested lists 和 table-like arrays，而不是 raw `<pre>` dumps。
- LLM log message/tool/response payload details 使用同一 structured JSON view，同时保持 raw provider logs 与 normal context stack 分离。
- 更新 concept guide、master plan 和 context contract docs，要求 readable structured JSON views，尤其是 OpenAI-compatible callable `tools` array。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。

Git：
- 已由引入本日志条目的 Git 提交记录。

## 2026-05-31 07:33 +08:00

目的：
- 在概念指南中澄清 memory handling，并让 raw provider payload logs 不进入 normal context stack。

变更：
- 在 `概念介绍` tab 中加入专门的 memory-recall 说明：recent raw context、result/process event projections、fixed impression recall，以及长对话为什么不重新注入原始 source data。
- 将概念指南的 context section 改名为 `上下文概览`，并从 normal context stack illustration 中移除 `final_messages`。
- 更新 Chat 右侧 context panel，让 `final_messages` 从 stack 中隐藏，只通过 stack 标题旁边低调的 `显示原始日志` toggle 出现。
- 更新 `ZLEAP_MASTER_PLAN.md`、`zleap-agent-framework.md` 和 `docs/` 下所有文件，说明 `final_messages` 是 raw provider-payload log，不是 context layer，并重申当前 memory recall/injection strategy。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。

Git：
- 已记录在提交 `2153447 fix: show skill disclosure in context`。

## 2026-05-31 07:25 +08:00

目的：
- 实现已明确的长对话 memory recall 策略，并让 impression recall 固定加载而不是 query-selective。

变更：
- 自动 runtime recall 改为总是为当前 scope 加载最多 20 条最新有效 user/agent impressions，不做 SQLite FTS filtering。
- Event recall 拆成 active `userId + workspaceId` 下最多 50 条最新 result events，加最多 8 条 SQLite FTS-matched process events。
- 将 raw local conversation context 增加到 20 条 messages/records，并用 projected event memory 承接更早长对话连续性，而不是注入原始 transcript。
- `runtime_context.memory` 和 `memory` context segment 改为注入 compact projected memory views，而不是原始 `MemoryRow` records、完整 `detail`、完整 `metadataJson` 或 evidence arrays。
- 更新 Chat context labels 和概念介绍 UI，显示 result-event/process-event memory sections。
- 更新 `ZLEAP_MASTER_PLAN.md`、`zleap-agent-framework.md`、`docs/03-memory-model.md` 和 `docs/07-context-and-prompt-contracts.md`，记录 fixed-impression 和 long-conversation recall rules。
- 添加/更新测试，覆盖 fixed impression recall、result/process event recall、projection shape、audit partition counts 和 50-result-event behavior。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。

Git：
- 已由引入本日志条目的 Git 提交记录。
- 当时尚未配置 remote repository，因此无法 push。

## 2026-05-31 07:13 +08:00

目的：
- 简化 Chat 右侧栏，避免重复中央 timeline 中已有信息，只展示检查所需的核心内容。

变更：
- 移除右侧栏 `正在查看` block，因为 selected message/turn 已经在中间 conversation timeline 中清楚显示。
- 从 Chat sidebar 移除 raw `工作空间轨迹` 和 `LLM 调用检查点` blocks。
- 让 sidebar 聚焦于 `当前工作空间`、`上下文窗口堆栈` 和 `本轮记忆写入`。
- 更新 `ZLEAP_MASTER_PLAN.md`，将这个简化右侧面板结构作为 UI contract。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。

Git：
- 本工作会话中待记录。

## 2026-05-31 07:10 +08:00

目的：
- 澄清为什么 child workspaces 应该知道 sibling workspace 的存在：manifest list 是 shared environment memory / capability map，不是共享执行权限。

变更：
- 更新 runtime prompt contract，把 child workspace awareness 描述为跨工作空间共享能力地图，类似使用一个应用时仍知道其他软件存在。
- 更新 `ZLEAP_MASTER_PLAN.md` 和 `zleap-agent-framework.md`，区分 workspace awareness、tool access 和 direct switching authority。
- 更新 concept introduction UI labels/copy，让 workspace manifest 呈现为 shared capability map，而不是 main-only list。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。

Git：
- 本工作会话中待记录。

## 2026-05-31 07:04 +08:00

目的：
- 对齐已明确的 memory 写入策略：impression 是 agentic，event 是 hook/programmatic，skill 兼具 agentic 与保守 hook/manual，runtime memory 不暴露模型可调用 update/delete tools。

变更：
- 从模型可调用 runtime memory tool surface 移除 `writeEventMemory`、`updateMemory` 和 `deleteMemory`；seed cleanup 现在会从已有 SQLite 数据库中删除 legacy tool definitions/links。
- 保留 `searchMemory`、`writeUserImpression`、`writeAgentSelfImpression` 和 `writeSkillMemory` 作为工作空间内唯一可见的通用 memory tools。
- 更新 hidden runtime prompt contract，说明 event memory 由 lifecycle-hook 拥有，skill hook extraction 保守且脱敏，memory evolution 是 append/latest 而不是模型原地 mutation。
- 更新 `ZLEAP_MASTER_PLAN.md` 和 `zleap-agent-framework.md`，澄清三类 memory write sources，以及 agent freedom 与 code authority 的边界。
- 更新测试，断言 legacy memory mutation tools 不在 callable tools 中，同时 hook-generated event memory 仍可审计。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。

Git：
- 已由引入本日志条目的 Git 提交记录。
- 当时尚未配置 remote repository，因此无法 push。

## 2026-05-31 06:57 +08:00

目的：
- 让 child workspaces 知道 sibling workspace capabilities，但不允许它们直接切换工作空间，并在切换间保留 workspace-local continuity。

变更：
- Runtime 现在把 workspace manifest list 放入 child workspace context，让 child 可以通过 `exitWorkspace.suggestedNextSteps` 建议 sibling handoff。
- Child workspaces 仍不接收 `enterWorkspace`；只有 `main` 可以调度下一个 workspace。
- Child workspace local conversation context 现在会恢复同一 conversation 内相同 workspace 的有界 prior records，让返回某个 workspace 像切回同一个软件，而不是启动无记忆 sub-agent。
- LLM call completion snapshots 现在会把 assistant message 和 raw provider metadata 一起持久化，让 workspace-local history 能恢复之前的 tool-call decisions。
- 更新 `ZLEAP_MASTER_PLAN.md`、`zleap-agent-framework.md` 和 concept intro copy，反映这个 software-switching model。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。

Git：
- 本工作会话中待记录。

## 2026-05-31 06:53 +08:00

目的：
- 将 callable tool schemas 保持在 OpenAI-compatible `tools` request array 中，而不是复制进 system prompt。

变更：
- 更新 `PromptAssembler`，让 system message 只包含 `system` 和 `workspace` context segments。
- 保留 `tools` context segment 作为 Web UI 和 trace logs 的可检查快照。
- 增加回归覆盖，证明 child workspace tool schemas 出现在 request `tools` array 中，但不在 system message 内。
- 更新 `ZLEAP_MASTER_PLAN.md`、`zleap-agent-framework.md` 和 concept intro copy，澄清这个边界。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。

Git：
- 本工作会话中待记录。

## 2026-05-31 06:51 +08:00

目的：
- 将外部 Framework markdown 转成面向产品的概念介绍，并保持它与最新 Zleap runtime 决策一致。

变更：
- 重写 `zleap-agent-framework.md`，移除过时/冲突指引：`listWorkspaces` 不是工具，`exitWorkspace` 只属于 child，Browser workspace 是未来范围，vector recall 首版未启用，tools/context categories 遵循最新主计划。
- 添加顶层 `概念介绍` Web UI tab。
- 构建视觉概念指南，覆盖传统 agent 问题、Zleap stable identity + dynamic workspace state 模型、workspace routing、memory layers、context stack、lifecycle hooks、design principles 和 implementation modules。
- 更新 `ZLEAP_MASTER_PLAN.md`，让新 tab 和 Framework markdown 对齐规则继续作为项目方向的一部分。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。

Git：
- 本工作会话中待记录。

## 2026-05-31 06:46 +08:00

目的：
- 让 Chat context stack 编号像正常 UI 顺序，而不是暴露内部 sort weights。

变更：
- 更新 context stack summary labels，显示连续编号（`1`、`2`、`3` ...），同时继续只在内部使用 `sortOrder` 排序。

验证：
- `npm run typecheck` 通过。
- `npm run build` 通过。

Git：
- 本工作会话中待记录。

## 2026-05-31 06:40 +08:00

目的：
- 让每个可检查的 LLM context stack 都显示 callable tools，使每次请求都能看到实际暴露了哪些 function calls。

变更：
- 在 runtime prompt assembly 中增加第一层 `tools` context segment，包含 active workspace id、tool count、tool schemas、risk levels 和 runtime/MCP binding metadata。
- 从 `workspace` segment 移除 callable tool definitions，让 workspace information 和 tool exposure 不再混在一起。
- 将 `tools` segment 包含进 system message assembly，使 prompt 和存储的 context stack 保持一致。
- 更新 Chat context inspector，把 `tools` 标记/渲染为独立可展开类别，并为旧 LLM call records 从保存的 `toolsJson` 合成同样视图。
- 更新 `ZLEAP_MASTER_PLAN.md`，让未来 context-stack 工作把 tools 作为第一层类别。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。

Git：
- 本工作会话中待记录。

## 2026-05-31 06:35 +08:00

目的：
- 让 Chat UI 可以检查每个已保存 LLM call，而不只是初始用户消息回合。

变更：
- 在 Chat 页面添加 current-conversation trace loading，让它可以按 `llmCallId` 分组 `context_segments`。
- 在右侧面板添加 `LLM 调用检查点` 列表；每个 checkpoint 打开对应已保存 LLM 请求的精确 context stack。
- 当 user、assistant、workspace 和 function-call/process messages 能关联到 LLM call 时，允许点击检查。
- 在浏览器状态中缓存 selected LLM call id。
- 更新 `ZLEAP_MASTER_PLAN.md`，要求未来 UI 工作保留 per-LLM-call context inspection。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。

Git：
- 本工作会话中待记录。

## 2026-05-31 06:25 +08:00

目的：
- 让 agent 足够清楚地理解内部 workspace 概念，从而决定何时进入或退出工作空间。

变更：
- 在 runtime system prompt 中加入明确 workspace decision contract：workspace 是内部能力边界，`main` 负责 planning/integration，child workspaces 使用有限工具专精执行。
- 在 prompt 中说明 child workspaces 应在工作完成、失败、阻塞、缺工具、需要用户输入/审批或需要另一个工作空间时调用 `exitWorkspace`。
- 增加回归覆盖，证明 assembled system message 包含 workspace contract 和 `enterWorkspace`/`exitWorkspace` handoff language。
- 更新 `ZLEAP_MASTER_PLAN.md`，记录 system prompt 应教会内部 workspace model，同时最终面向用户回答仍隐藏这些机制。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。

Git：
- 本工作会话中待记录。

## 2026-05-31 06:18 +08:00

目的：
- 停止把内部 tool-loop limit 暴露成面向用户的 per-workspace operation limit。

变更：
- 将默认 runtime tool-loop circuit breaker 提高到 100 轮，并通过 `ZLEAP_MAX_TOOL_ROUNDS` 可配置。
- 用自然措辞替换面向用户的“连续操作轮次” fallback，询问是否继续或澄清目标。
- 更新测试，让 loop-limit coverage 验证 audit/circuit-breaker 行为，而不依赖旧内部措辞；workspace-tool fake LLMs 通过正常 `exitWorkspace` 协议退出 child workspaces。
- 更新 `ZLEAP_MASTER_PLAN.md`，澄清 loop guard 是高全局安全 circuit breaker，不是 per-workspace product limit。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。

Git：
- 本工作会话中待记录。

## 2026-05-31 06:14 +08:00

目的：
- 移除冗余 Workspace editor 设置，让 workspace input/output protocol 由代码拥有。

变更：
- 用一个可见 `工作空间说明` 字段替换重复的 Workspace `描述`/`工作空间说明` 字段。
- 从 Web UI 移除面向用户的 Workspace `输入类型`、`输出类型` 和 `工具使用说明` 字段。
- 规范化 workspace saves：代码总是提供固定 input protocol（`user_request`、`workspace_task`）、固定 output protocol（`workspace_result`），把单一 workspace explanation 镜像到 runtime instructions，并清空 workspace-level tool instructions。
- 更新 `ZLEAP_MASTER_PLAN.md`，记录 workspace input/output contracts 统一，tool usage guidance 属于 tool definitions。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。

Git：
- 已由包含本日志条目的 Git 提交记录。

## 2026-05-31 06:10 +08:00

目的：
- 当 workspace 没有 MCP Server 时，让 Workspace editor 保持紧凑。
- 让 workspace 保存/删除操作在垂直滚动时始终可触达。

变更：
- 当选中的 workspace 没有 MCP Servers 时，不再自动创建 MCP Server draft；注册表单只在点击 `新增 Server` 后打开。
- 将 Workspace editor action bar 固定在可滚动编辑面板底部。
- 更新 `ZLEAP_MASTER_PLAN.md`，记录紧凑 MCP empty-state 和持久 workspace actions 规则。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。

Git：
- 已由包含本日志条目的 Git 提交记录。
- 当时尚未配置 remote repository，因此无法 push。

## 2026-05-31 06:08 +08:00

目的：
- 防止编辑已有 workspace ID 时意外创建新 workspace。
- 为非内置 workspace 增加 UI 删除路径。

变更：
- 已保存 workspace ID 在 Workspace editor 中只读，新建未保存 workspace ID 仍可编辑。
- 增加 Workspace editor delete/cancel action：未保存 workspace 可放弃，自定义已保存 workspace 可删除，内置 `main/file/cli` 不可删除。
- Workspace UI 删除通过已有 creator-gated `DELETE /api/workspaces/:id` API。
- 更新 `ZLEAP_MASTER_PLAN.md`，记录 immutable workspace ID 和 non-built-in deletion UI 规则。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。

Git：
- 已由包含本日志条目的 Git 提交记录。
- 当时尚未配置 remote repository，因此无法 push。

## 2026-05-31 06:02 +08:00

目的：
- 将 `file` 和 `cli` 作为内置基础工作空间处理，而不是要求默认工具必须先配置 MCP Server。
- 保持 MCP 作为外部/用户提供工具的扩展路径，同时让首次运行的文件搜索和 CLI 执行真实可用。

变更：
- 为 `searchFiles` 和 `runCommand` 添加 internal runtime executors。
- 将 `tool-search-files` 和 `tool-run-command` 的 seed bindings 从 placeholder 改成 runtime executors。
- 保护内置 file/CLI runtime tools，防止普通 workspace tool editing/deletion。
- 更新测试，证明 `searchFiles` 和 `runCommand` 可通过 runtime execution 完成，同时 MCP import/execution 仍由 echo server fixture 覆盖。
- 更新 `ZLEAP_MASTER_PLAN.md`，记录核心本地能力不需要 MCP indirection。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。

Git：
- 已由包含本日志条目的 Git 提交记录。
- 当时尚未配置 remote repository，因此无法 push。

## 2026-05-31 05:42 +08:00

目的：
- 让普通用户看到的 Chat timeline 像一个连续 agent task stream，同时为检查详情的用户暴露 workspace switches 和 function calls。
- 用紧凑可折叠运行过程块替代显眼的 workspace/debug 风格过程消息。

变更：
- 为 workspace entry/exit、function-call batches 和 tool results 添加 `运行过程` chat messages。
- 将非最终 runtime events 渲染为带简单摘要和扩展 workspace/tool metadata 的 collapsible details。
- 保留 child workspace assistant text，并与 final assistant answer 分开显示。
- 更新 `ZLEAP_MASTER_PLAN.md`，记录 user-task-first timeline 规则。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。

Git：
- 已由包含本日志条目的 Git 提交记录。
- 当时尚未配置 remote repository，因此无法 push。

## 2026-05-31 05:36 +08:00

目的：
- 将 MCP 产品/runtime 模型从 tool-first binding 修正为 workspace-scoped MCP Server binding。
- 让 MCP setup 同时支持本地 stdio server 和远程 Streamable HTTP server：保存 server、检测工具、选择挂载工具，再通过生成的 binding 执行。

变更：
- 添加 `mcp_servers` SQLite 表、`McpServerDefinition` 类型、repository CRUD、server-to-binding generation 和 workspace-scoped MCP tool import。
- 添加 `/api/workspaces/:workspaceId/mcp-servers` 下的 list/create/update/delete/discover/import HTTP APIs。
- 更新 MCP execution parsing，接受 `streamable-http` transport names，并继续使用官方 TypeScript SDK client 执行。
- 重做 Workspace UI，让 MCP Server management 成为主流程，在当前 workspace 中发现并挂载选中工具。
- 将 seeded file/CLI capability tools 改回 placeholders，直到绑定真实 MCP Server，避免把假的本地 MCP IDs 显示为可用工具。
- 更新测试和 docs，反映 server-first MCP setup 与 creator-gated MCP installation。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。

Git：
- 已由包含本日志条目的 Git 提交记录。
- 当时尚未配置 remote repository，因此无法 push。

## 2026-05-31 05:27 +08:00

目的：
- 在中央 Chat 对话中显示 child workspace LLM interactions，而不是只藏在 trace/log views。
- 保持 final assistant replies 与 workspace process messages 分离，让用户可见答案保持干净，同时工作空间执行过程可见。

变更：
- 扩展 streaming runtime events，加入 `workspace` event type，用于 workspace entry、child workspace assistant text、child tool calls/results 和 workspace exit summaries。
- 更新 Chat UI message rendering，在 final assistant placeholder 前插入 workspace process messages，并让它们与 user/assistant messages 使用不同样式。
- 添加 streaming child-workspace visibility test，证明 file workspace LLM text 和 tool/exit events 会发出，同时 final answer 仍然分离。
- 更新 `ZLEAP_MASTER_PLAN.md`，让 child workspace process visibility 成为 runtime/UI contract，并澄清它取代了旧的 child workspace interactions hidden-only streaming policy。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- In-app browser reload `http://localhost:4173/` 已确认刷新后的 Chat UI 包含 workspace-aware conversation surface。

Git：
- 已由包含本日志条目的 Git 提交记录。
- 当时尚未配置 remote repository，因此无法 push。

## 2026-05-31 05:22 +08:00

目的：
- 修复 Chat 右侧面板的 workspace display，避免进入 `file` 或其他 child workspace 的回合，在 child 返回结果给 main 后仍只显示 `main`。
- 让 UI 反映 runtime contract：child workspaces 执行能力工作，然后通常退出回 main 做最终整合。

变更：
- 添加 Web UI 逻辑，从 selected/latest turn 的 workspace trace 推导当前 inspected workspace；当涉及非 main workspace 时，优先显示最近的非 main workspace。
- 将 Chat 右侧面板标签从当前工作空间改为当前 inspected workspace，并在适用时显示 status text 和“returned to main” note。
- 更新 workspace badge styling，支持 primary workspace、status 和 involved route。
- 更新 `ZLEAP_MASTER_PLAN.md`，记录显示规则。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- In-app browser reload `http://localhost:4173/` 已确认选中的 `查找js文件` 回合显示 `file`、`状态：失败；运行结束后回到 main` 和 `本轮涉及：main → file`。

Git：
- 已由包含本日志条目的 Git 提交记录。
- 当时尚未配置 remote repository，因此无法 push。

## 2026-05-31 04:52 +08:00

目的：
- 在 Logs tab 中让 runtime memory recall 可检查，包括当前 SQLite FTS recall algorithm 返回 0 命中的回合。
- 澄清召回缺失可能是 FTS query/token 限制，不一定是没有 memory 或权限失败。

变更：
- 在 workspace local-context construction 期间添加 `memory_recall_requested` audit logs，包含 conversation/workspace/task ids、query text、algorithm name、`vectorEnabled`、recall limits、raw partition counts、injected partition counts 和 injected memory ids。
- 在 `hook.afterWorkspaceEnter` metadata 中添加 impression counts。
- 添加成功 child-workspace recall logging 和 zero-hit main-workspace recall logging 测试。
- 更新 `ZLEAP_MASTER_PLAN.md` 和 `docs/03-memory-model.md`，记录 recall observability contract。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。

Git：
- 已由包含本日志条目的 Git 提交记录。
- 当时尚未配置 remote repository，因此无法 push。

## 2026-05-31 04:48 +08:00

目的：
- 将 workspace/tool management 从全局共享 tool-pool UI 改为 workspace-first tool registration，并把 MCP-bound tools 接到真实 MCP client executor，而不是保留为 placeholders。

变更：
- 添加 `@modelcontextprotocol/sdk` 作为官方 MCP TypeScript SDK 依赖。
- 添加 `src/core/mcp-executor.ts`，支持 MCP stdio 和 Streamable HTTP bindings、`listTools()` discovery，以及 `callTool()` execution；连接、配置或工具错误会返回结构化失败结果。
- 更新 `ToolRegistry` 和 `AgentRuntime`，让 MCP tool execution 可在普通和流式 tool loops 中异步运行。
- 添加 `tool_definitions.workspaceId` 和 workspace-scoped tool create/update/delete repository APIs。
- 添加 workspace tool registration 和 MCP tool discovery HTTP APIs。
- 重做 Workspace UI，让工具在选中 workspace 内新增、编辑、发现和删除，而不是从全局池选择。
- 视觉上分离 system/runtime tools 和 workspace-registered tools。
- 添加 MCP echo server fixture 和端到端 runtime 测试，证明 workspace MCP tool 可通过 stdio 执行。
- 更新 `ZLEAP_MASTER_PLAN.md` 和 `docs/02-workspace-runtime.md`，记录 workspace-first tool model 和真实 MCP execution contract。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- In-app browser verification 未完成，因为 Browser Use 在该环境下拒绝 localhost action。

Git：
- 本工作会话中待记录。

## 2026-05-31 04:31 +08:00

目的：
- 将 lifecycle hook logs、tool call logs、approval requests 和 LLM request logs 从 Chat context inspector 移到专门的顶层日志区域，让 Chat 右侧面板专注 workspace state 和 context stack inspection。

变更：
- 添加第四个顶层 Web UI tab：`日志`。
- 在 `src/web/main.tsx` 中添加 `LogsTab`，支持 current conversation trace loading、global recent LLM request loading、compact LLM debug summary、lifecycle log panel、tool call log panel、approval request panel 和 LLM request log panels。
- 为整个可见 log view 和各 log section 添加清空动作；这些动作只清空当前 UI view，不删除持久化 audit/debug records。
- 从 Chat 右侧面板移除 lifecycle、tool call、approval 和 LLM log sections。
- 更新 `src/web/styles.css`，支持新的 log page layout。
- 更新 `ZLEAP_MASTER_PLAN.md`，把专门的 `日志` tab 纳入项目 UI contract。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- Browser verification 未完成，因为该环境下 background startup attempts 后，本地 server process 没有保持在 `http://localhost:4173/` 可访问。

Git：
- 本工作会话中待记录。

## 2026-05-31 04:25 +08:00

目的：
- 按已澄清的 workspace model 对齐 prompt/context contract：runtime strategy 属于 system prompt；workspace routing information 属于 main workspace contract；memory 作为第一层堆栈显示并有清晰二级分区；冗余 local workspace/task categories 合并。

变更：
- 更新 `src/core/context-builder.ts`，primary context stack 使用稳定第一层类别：`system`、`workspace`、`memory`、`history` 和 `user`，并保留 `tool_result` 和 `final_messages` 调试 follow-ups。
- 将 base system prompt、personality prompt、hidden runtime strategy 和 proactive impression-memory write protocol 合并进单一 `system` context segment 和最终 OpenAI-compatible system message。
- 将 active workspace description、instructions、manifest、memory policy 和 tool definitions 放入 `workspace` segment；只有 main workspace 收到完整 available-workspace manifest list。
- 用 `runtime_context.memory` 和 `runtime_context.local_conversation` 替换独立 runtime synthetic tool results for task/history/load。
- 更新 `src/core/attention-budget.ts`、`src/tests/run-tests.ts`、`src/web/main.tsx` 和 `src/web/styles.css`，支持简化 context stack 和二级 UI 展开。
- 更新 `ZLEAP_MASTER_PLAN.md`、`docs/02-workspace-runtime.md`、`docs/03-memory-model.md` 和 `docs/07-context-and-prompt-contracts.md`，使文档匹配新契约。

验证：
- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- 已在 `http://localhost:4173/` 重启本地 server，进程 id 为 `7456`。
- In-app browser automation 未完成，因为 Browser tool 在其 URL policy 下拒绝 localhost navigation/reload request。

Git：
- 已由引入本日志条目的 Git 提交记录。
- 当时尚未配置 remote repository，因此无法 push。

## 2026-05-31 04:10 +08:00

目的：
- 增加长期项目流程规则：每次有意义的代码或文档改动都应该进入 Git，并在本文件中记录时间、目的、涉及区域、验证状态和可用的 commit reference。
- 保留此前多小时 Agent framework 实现工作的验收总结，方便按原始 docs 和设计原则复盘。

变更：
- 添加 `ZLEAP_IMPLEMENTATION_ACCEPTANCE_SUMMARY.md`。
- 添加本文件 `ZLEAP_CHANGELOG.md`。
- 更新 `ZLEAP_MASTER_PLAN.md`，把 Git 版本记录和带时间戳变更日志作为强制项目实践。

验证：
- 仅文档/流程改动，不需要 runtime 验证。

Git：
- 已由引入本日志条目的 Git 提交记录。
- 当时尚未配置 remote repository，因此无法 push。
