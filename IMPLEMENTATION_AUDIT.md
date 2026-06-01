# Zleap 文档实现对齐审计

本文件用于长期跟踪 docs 与当前 TypeScript 实现的一致性。审计目标不是新增超出文档的新功能，而是逐条确认文档里的功能、边界、权限和不变量是否真实实现、是否有测试证明，以及是否存在逻辑冲突。

## 审计规则

- 权威来源优先级：最新用户确认规则、`ZLEAP_MASTER_PLAN.md`、`docs/` 主题文档、`zleap-agent-framework.md`。
- 每个条目必须有当前证据：代码路径、测试用例、命令输出或运行时行为。
- 只把能被证据覆盖的条目标为已验证；只有代码存在但缺少针对性测试时标为待补测试。
- 如果文档要求和实现冲突，优先修实现或测试；不通过新增违背文档的产品行为来掩盖冲突。
- 发现文档之间互相冲突时，记录冲突并按主计划和最新代码意图处理，必要时同步文档。

## 文档范围

| 文档 | 行数 | 审计状态 | 备注 |
| --- | ---: | --- | --- |
| `ZLEAP_MASTER_PLAN.md` | 440 | 进行中 | 长期主计划，当前最重要来源。 |
| `docs/README.md` | 112 | 进行中 | 文档组织和不变量摘要。 |
| `docs/01-agent-philosophy.md` | 211 | 待逐条核对 | Agent/workspace/memory 理念。 |
| `docs/02-workspace-runtime.md` | 417 | 进行中 | workspace runtime、MCP、handoff、工具边界。 |
| `docs/03-memory-model.md` | 495 | 进行中 | impression/event/skill、FTS、渐进披露。 |
| `docs/04-multi-tenant-isolation.md` | 281 | 进行中 | userId/权限/trace/memory 隔离。 |
| `docs/05-hooks-and-lifecycle.md` | 411 | 进行中 | lifecycle hook、event/skill 提取；已读完全文，正在按细节补强证据。 |
| `docs/06-typescript-implementation-roadmap.md` | 424 | 待逐条核对 | 模块/MVP/UI/阶段性要求。 |
| `docs/07-context-and-prompt-contracts.md` | 527 | 待逐条核对 | context stack、prompt、tool loop 契约。 |
| `zleap-agent-framework.md` | 589 | 进行中 | 概念介绍的产品表达，需与主计划一致。 |

## 功能域清单

| ID | 功能域 | 文档要求摘要 | 当前状态 | 下一步 |
| --- | --- | --- | --- | --- |
| A1 | 稳定 Agent 身份 | workspace 切换不改变 system/personality，变化的是工具、局部记忆和局部上下文。 | 已验证 | 已补充 main/child/return-main 三次 LLM call 的 system/personality 稳定断言。 |
| A2 | main/child workspace 工具边界 | `enterWorkspace`/`askUser`/`finishTask` 仅 main 可见；`exitWorkspace` 仅 child 可见；错误绑定也必须隐藏和拒绝。 | 已验证 | 已补充 provider tools、workspace local context 和错误绑定拒绝测试。 |
| A3 | workspace manifest 可见性 | main 和 child 都可看到 workspace manifest；child 看到 sibling manifest 不等于获得 sibling tools。 | 已验证 | 已补充 child manifest 可见但 main-only tools 不可调用的测试。 |
| A4 | handoff 隔离 | parent-to-child 只携带总体要求、当前用户请求、少量用户原话；不得携带父级 assistant 执行记录、enterWorkspace 结果、父级工具证据或 sibling 记录。 | 已验证 | 已核对 parent/child handoff 构造和隔离断言。 |
| A5 | child natural-language 不能直接终答 | child 返回文本但不 `exitWorkspace` 时只能保存 trace，runtime 应继续要求退出。 | 已验证 | 已确认 runtime 会注入退出提醒并继续 tool loop。 |
| A6 | `exitWorkspace` 结构校验 | 必须校验完整 `WorkspaceResult`，拒绝 `running`、重复退出、畸形 payload，失败时不触发 exit hook。 | 已验证 | 已补强缺字段 payload 验证，并覆盖重复退出/post-exit/tool hook 去重。 |
| B1 | memory 类型和隔离 | impression 跨 workspace；event 为 `userId + workspaceId + conversationId + taskId`；skill 为 workspace scoped shared 且脱敏。 | 已验证 | 已补齐 event `metadata.taskId` final-row policy，并验证 direct API/hook event 行为。 |
| B2 | memory 渐进披露 | 自动召回/search 只给 summary/id，标记 `summary_only`、`detailInjected=false`，需要详情时使用 `readMemory`/`readSkill`。 | 已验证 | 已修正 `searchMemory` event 投影不再返回 `detailSnippet`，并补测试。 |
| B3 | event 自动写入 | 模型没有 event 写入工具；conversation window 和 workspace exit hook 自动写 process/result event。 | 已验证 | 已确认工具面无 `writeEventMemory`，event 由 lifecycle hook 写入。 |
| B4 | memory metadata 禁止原始载荷 | metadata 只能存语义投影和 `sourceRefs`，不能复制 raw messages/tool calls/finalMessages 等。 | 已验证 | 已补齐 raw payload key create/update 拒绝测试。 |
| B5 | FTS + relation/version | 首版不用 vector；recall 需按完整 partition 判断最新版本，避免跨用户/跨 workspace 覆盖。 | 已验证 | 已收紧 repository relation lookup，并补齐 scope 分区和安全 FTS 测试证据。 |
| C1 | 多租户 conversation ownership | conversationId 由唯一 `userId + agentId` 拥有，跨用户/agent 复用必须拒绝。 | 已验证 | `ensureConversation`、trace/tool/LLM/session/approval 写入测试覆盖 owner mismatch。 |
| C2 | 敏感调试端点 actor 显式要求 | LLM logs、approval、agent/workspace/memory、trace、conversation delete 都需要显式 actor。 | 已验证 | 已补 HTTP handler 级测试，逐端点覆盖缺失 actor 和非法 actorRole。 |
| C3 | approval 权限 | 高风险非 creator tool/workspace 请求进入 approval，resolve creator-only，普通用户只能看自己的请求。 | 已验证 | `testWorkspaceEntryApprovalGate`、`testToolPolicyGates`、`testApprovalListIsUserScoped` 覆盖请求、列表、拒绝和 creator resolve。 |
| C4 | 审计日志覆盖 | 至少记录用户消息、workspace 切换、tool 调用、memory 写入、skill 生成、权限拒绝、创建者级操作，且 audit 不作为 memory 注入模型。 | 已验证 | 已补用户消息 audit，并补强 tool-call audit 与 audit 不注入模型上下文测试。 |
| C5 | 数据删除 | 支持删除 user impression、event、conversation、skill；workspace 删除软删 scoped event/skill；普通 list/get/recall/FTS 排除 deleted。 | 已验证 | `testDatabaseAndMemory`、`testDirectMemoryApiUsesPolicyLayer`、`testConversationDeletionLifecycle`、`testWorkspaceDeletionLifecycle` 覆盖。 |
| D1 | LLM 协议 | OpenAI-compatible Chat Completions，streaming，工具走 `tools` array，API key 不入库/日志。 | 已验证 | 已补强 Chat Completions request body、streaming 和 API key 不落库/日志测试。 |
| D2 | tool loop | Observe/Decide/Act/Verify 循环，follow-up LLM 保留完整 context stack，不退化成只有工具结果。 | 已验证 | 已确认非流式和流式 tool loop 都持久化完整 follow-up context stack。 |
| E1 | MCP server-first | workspace 内绑定 MCP Server，发现 server tools，再导入到当前 workspace；placeholder 不静默执行。 | 已验证 | 已覆盖 stdio MCP discover/import/execute，UI server-first 路径和 placeholder failed result。 |
| F1 | Web UI 顶层结构 | 顶层 tab、对话三栏、工作空间/MCP、记忆、日志、数据表、概念介绍符合文档。 | 已验证 | 已用 in-app browser 切换全部顶层页签，并核对源码结构。 |
| F2 | 概念介绍 | 需与主计划一致，不能展示废弃概念；context stack 只展示真实层。 | 已验证 | `ConceptIntroTab` 覆盖稳定身份、workspace、memory、context stack、lifecycle、实现模块。 |
| G1 | SQLite schema | 表和字段覆盖 agents、workspaces、mcp_servers、tool_calls、memories、runtime config 等。 | 已验证 | 已补 schema 必备表和关键字段断言，并确认数据表 UI 读取 creator-only DB API。 |
| H1 | Tool call lifecycle | `beforeToolCall` 应记录待执行 tool call，`afterToolCall` 保存 result 并标记成功/失败/阻塞。 | 已验证 | 已补 pending tool_call 持久化，before/after hook 绑定同一 tool_call id，并补测试。 |
| H2 | afterAgentTurn token usage | `afterAgentTurn` 需要记录 token 使用情况。 | 已验证 | 已将 provider raw `usage` 归一化写入 `hook.afterAgentTurn` metadata，并补测试。 |
| H3 | Skill trace evidence is code-bound | `writeSkillMemory` 可保存 `activeWorkspaceId/workspaceSessionId/taskId`，但这些 trace id 只能来自 runtime state，不能由模型传入或覆盖。 | 已验证 | 已显式拒绝模型传入 code-bound trace 字段，并补 forged trace 测试。 |

## 当前验证记录

### 2026-06-01 初始盘点

- 分支：`0601`。
- 工作区：创建审计文件前为干净状态。
- 已确认文档总量约 3900 行，范围包括 `docs/*.md`、`ZLEAP_MASTER_PLAN.md`、`zleap-agent-framework.md`。
- 已初步查看：
  - `src/core/runtime-config.ts`
  - `src/core/context-builder.ts`
  - `src/core/memory-service.ts`
  - `src/core/workspace-runtime.ts`
  - `src/core/tool-registry.ts`
  - `src/tests/run-tests.ts` 中与 `readMemory`、`exitWorkspace`、工具可见性、handoff 相关的现有测试索引。

## 待办队列

- [ ] 完整阅读并拆分 `ZLEAP_MASTER_PLAN.md` 的所有可测试要求。
- [ ] 完整阅读并拆分 `docs/02-workspace-runtime.md` 的 workspace runtime 要求。
- [ ] 完整阅读并拆分 `docs/03-memory-model.md` 的 memory 要求。
- [ ] 完整阅读并拆分 `docs/04-multi-tenant-isolation.md` 的权限要求。
- [ ] 完整阅读并拆分 `docs/05-hooks-and-lifecycle.md` 的 hook 要求。
- [ ] 完整阅读并拆分 `docs/07-context-and-prompt-contracts.md` 的 context/prompt 要求。
- [x] 针对 A2/A3/A4/A6 增加或确认测试覆盖。
- [x] 针对 B3/B4 增加或确认测试覆盖。
- [ ] 每轮修改后运行 `PATH=/opt/homebrew/bin:$PATH npm test` 和必要的 `npm run build`。

## 外层/历史改动记录

- 已搜索 `/Users/jomymac/Desktop` 与当前仓库父级目录中的 markdown/txt 记录文件。
- 找到的相关记录：
  - `ZLEAP_CHANGELOG.md`：当前仓库已有的详细历史改动记录，后续审计需要优先参考，避免重复验证已知变更背景。
  - `/Users/jomymac/Desktop/302oc/README.md`：无关 302oc 项目说明，不作为本仓库审计依据。
- 未发现其他位于仓库外层、且与 Zleap Agent 实现改动直接相关的记录文档。

## 已验证条目

| ID | 结论 | 证据 | 备注 |
| --- | --- | --- | --- |
| A1 | 已补强验证 | `src/core/context-builder.ts::ContextBuilder.build`；`src/tests/run-tests.ts::testRuntimeContextAndTools`；`PATH=/opt/homebrew/bin:$PATH npm test` 通过。 | `system` context segment 始终由 `## 基础系统提示词`、`## 人格提示词`、`## 内部运行策略` 组成。main、child、返回 main 三次 LLM call 的基础 system prompt 和 personality prompt 与 persisted agent 配置完全一致；变化的是 active workspace 策略、callable tools、workspace context、memory 和 local conversation。 |
| A2 | 已补充验证 | `src/tests/run-tests.ts::testRuntimeContextAndTools`、`testWorkspaceBoundary`、`testChildWorkspaceCannotUseMainOnlyToolsEvenIfBound`；`PATH=/opt/homebrew/bin:$PATH npm test` 通过。 | 新增断言：main 的 workspace tools 不包含 `exitWorkspace`；child 的 provider `toolsJson` 与 callable tools 均不包含 `enterWorkspace`/`askUser`/`finishTask`，且包含 `exitWorkspace`。 |
| A3 | 已补充验证 | `src/tests/run-tests.ts::testRuntimeContextAndTools`；`PATH=/opt/homebrew/bin:$PATH npm test` 通过。 | 新增断言：child workspace 的 `runtime_context.workspace` 能看到 `main` 与 `dev` manifest，但这不授予 main-only tools。 |
| A4 | 已验证 | `src/core/agent-runtime.ts::createParentToChildHandoff`、`createChildToMainHandoff`、`saveFollowUpLlmCall`；`src/tests/run-tests.ts::testWorkspaceExitReturnsToMain`；`PATH=/opt/homebrew/bin:$PATH npm test` 通过。 | parent-to-child handoff 含当前用户请求、总体要求和少量用户原话参考，但不含 `enterWorkspace` tool result、父级工具结果、父级 assistant 执行记录或 sibling workspace 记录。child-to-main 只携带 `WorkspaceResult`、子 workspace AI 摘要、最后结论和关键工具结果；follow-up LLM call 复用完整 active base stack。 |
| A5 | 已验证 | `src/core/agent-runtime.ts::runToolLoop`、`requireChildWorkspaceExit`；`src/tests/run-tests.ts::testRuntimeContextAndTools`；`PATH=/opt/homebrew/bin:$PATH npm test` 通过。 | 子 workspace 直接返回自然语言时不会作为最终用户回答；runtime 记录内部退出要求，向下一轮 LLM 注入 “cannot produce the final user-facing answer” 提醒，并继续要求 `exitWorkspace`。达到上限仍未退出时记录 `workspace_exit_missing` 并保持 child session running。 |
| A6 | 已补强验证 | `src/core/tool-registry.ts::validateWorkspaceResult`；`src/core/agent-runtime.ts::applyExitWorkspaceResult`；`src/tests/run-tests.ts::testMalformedWorkspaceExitDoesNotCommitSession`、`testDuplicateWorkspaceExitCannotOverwriteCommittedSession`、`testWorkspaceExitHookRunsOncePerSuccessfulExitToolCall`；`PATH=/opt/homebrew/bin:$PATH npm test` 通过。 | `exitWorkspace` 拒绝 `running` status 和缺少 `artifacts` 等 required arrays 的 payload；失败时 child session 仍 running、无 `hook.beforeWorkspaceExit`/`hook.afterWorkspaceExit`、不写 event。重复退出和同 batch post-exit tool call 只记录 failed trace，不覆盖首次结果，也不重复执行 exit hook 或 skill usage。 |
| B2 | 发现并修复偏差 | `src/core/memory-service.ts::projectMemorySearchResult`；`src/tests/run-tests.ts::testSearchMemoryToolUsesPolicyLayer`；`PATH=/opt/homebrew/bin:$PATH npm test` 通过。 | 文档要求 `searchMemory` 返回 compact projection、disclosure/read-tool hints 和 detail availability，不默认返回完整 detail。原实现对 event 返回 `detailSnippet`，短 detail 时会等同泄露完整 detail；现改为 `snippet=summary`、`disclosure=summary_only`、`detailInjected=false`、`readTool`/`readInstruction`，详情只能通过 `readMemory`/`readSkill`。 |
| B1 | 发现并修复偏差 | `src/core/memory-service.ts::canWriteEventStructure`、`maybeWriteConversationWindowEvent`；`src/tests/run-tests.ts::testEventMemoryIsHookGenerated`、`testDirectMemoryApiUsesPolicyLayer`；`PATH=/opt/homebrew/bin:$PATH npm test` 通过。 | `docs/04` 要求 event 绑定 `userId`、`workspaceId`、`conversationId`、`taskId`。原 direct Memory API final-row policy 未强制 `metadata.taskId`；现补齐缺失拒绝，并让 conversation-window hook event 写入确定的 `conversation-window:{index}` task id。 |
| B5 | 发现并修复偏差 | `src/db/repositories.ts::buildFtsQuery`、`recallMemories`、`getMemoryByRelation`；`src/core/memory-service.ts::memoryRelationScope`；`src/tests/run-tests.ts::testDatabaseAndMemory`、`testConversationWindowEventExtractionUsesAbsoluteWindows`；`PATH=/opt/homebrew/bin:$PATH npm test` 通过。 | FTS query 会把 `302.AI` 等带标点自然语言拆成安全 token 后再进入 `MATCH`；recall 的 latest-version 判断按 `memoryType + userId + agentId + workspaceId + relationId` 分区。原 repository relation lookup 可不传 scope 走全局查询，现改为必须显式 scope，并验证跨 user/workspace/type 同名 relation 不互相遮蔽，软删 latest 后同分区回落到旧版本。 |
| B3 | 已验证 | `src/core/memory-service.ts::maybeWriteConversationWindowEvent`、`afterWorkspaceExit`；`src/tests/run-tests.ts::testEventMemoryIsHookGenerated`、`testWorkspaceMemoryPolicyControlsWrites`、`testBuiltInToolsAreSeededAndWorkspaceScoped`；`PATH=/opt/homebrew/bin:$PATH npm test` 通过。 | 模型可见工具面没有 `writeEventMemory`、`updateMemory`、`deleteMemory`；隐藏 `writeEventMemory` 调用返回 unknown tool 且不会写入 event。conversation window hook 会自动写 process/result event，metadata 含 `conversationId`、`taskId`、`sourceRefs` 和 `autoGenerated`；workspace exit hook 写入受 workspace memory policy 控制。 |
| B4 | 已补强验证 | `src/core/memory-service.ts::findRawSourcePayloadKey`、`memoryWriteDecision`；`src/tests/run-tests.ts::testEventMemoryIsHookGenerated`；`PATH=/opt/homebrew/bin:$PATH npm test` 通过。 | Hook 生成的 event metadata 只保留小型生命周期字段和 `sourceRefs`，不含 `messages`、`windowMessages`、`toolCalls`、`argumentsJson`、`resultJson`、`messagesJson`、`responseJson`、`rawJson`、`finalMessages` 等 raw payload key。direct Memory API create/update 若 metadata 顶层或嵌套包含这些 raw key 会被拒绝。 |
| C1 | 已验证 | `src/db/repositories.ts::ensureConversation`、`saveWorkspaceSession`、`saveToolCall`、`saveLlmCall`、`createApprovalRequest`、`getTrace`；`src/tests/run-tests.ts::testTraceAndToolLogsAreUserScoped`、`testLlmLogsAreUserScoped`、`testConversationDeletionLifecycle`；`PATH=/opt/homebrew/bin:$PATH npm test` 通过。 | conversation owner mismatch 会拒绝复用；trace 读取 owner-or-creator；conversation 删除后普通用户不能读取 audit-only trace。 |
| C3 | 已验证 | `src/core/policy-engine.ts::canEnterWorkspace`、`canUseTool`；`src/db/repositories.ts::createApprovalRequest`、`listApprovalRequests`、`resolveApprovalRequest`；`src/tests/run-tests.ts::testWorkspaceEntryApprovalGate`、`testToolPolicyGates`、`testApprovalListIsUserScoped`；`PATH=/opt/homebrew/bin:$PATH npm test` 通过。 | 非 creator 进入 requiresApproval/high-risk workspace 或调用 high-risk tool 会 blocked 并产生 approval；普通用户不能 resolve；普通用户 list 不能通过 `userId` 查询看到别人请求。 |
| C2 | 已验证 | `src/server/index.ts::createZleapServer`；`src/tests/run-tests.ts::testSensitiveHttpEndpointsRequireExplicitActor`；`PATH=/opt/homebrew/bin:$PATH npm test` 通过。 | 覆盖 LLM logs、approval list/resolve、agent update、workspace create/update/delete、direct memory list/create/update/delete、conversation trace、conversation deletion。每个端点缺失 `actorId` 或使用非法 `actorRole=system` 都在 HTTP handler 中返回错误，且 fixture agent/workspace/memory/approval/conversation 未被修改。 |
| C4 | 发现并修复偏差 | `src/core/agent-runtime.ts::prepare`；`src/tests/run-tests.ts::testRuntimeContextAndTools`；`PATH=/opt/homebrew/bin:$PATH npm test` 通过。 | 文档要求 audit 至少记录用户消息。原实现只写 `messages` 表，没有对应 audit 行；现新增 `user_message_received`，metadata 只保存 `messageId`、`agentId`、`contentLength` 等紧凑证据，不复制用户正文。 |
| C4 | 已补强验证 | `src/tests/run-tests.ts::testToolPolicyGates`、`testAuditLogsStayOutOfModelContext`；`PATH=/opt/homebrew/bin:$PATH npm test` 通过。 | tool 调用 audit 可通过 `hook.afterToolCall.resourceId` 对应具体 `tool_calls.id`，metadata 包含 toolName/status/taskId；预置 audit-only marker 可在 trace audit logs 看到，但不会出现在 LLM messages 或 context_segments 中。已有测试同时覆盖 workspace 切换、memory 写入、skill 生成、权限拒绝和 creator 操作 audit。 |
| C5 | 已验证 | `src/db/repositories.ts::deleteMemory`、`deleteConversation`、`deleteWorkspace`；`src/core/memory-service.ts::deleteMemoryRecord`；`src/tests/run-tests.ts::testDatabaseAndMemory`、`testDirectMemoryApiUsesPolicyLayer`、`testConversationDeletionLifecycle`、`testWorkspaceDeletionLifecycle`；`PATH=/opt/homebrew/bin:$PATH npm test` 通过。 | memory 删除为软删除，`getMemory`、`listMemories`、`recallMemories` 和 FTS query 均排除 deleted；creator 可直接删除 shared skill，删除后 direct list、runtime recall 和 `readSkill` 都不可见；conversation 删除后普通用户不能读 audit-only trace；workspace 删除会软删 scoped event/skill。 |
| D1 | 已补强验证 | `src/core/llm-client.ts::OpenAICompatibleClient`、`src/core/agent-runtime.ts::buildLlmContext`/`saveFollowUpLlmCall`；`src/tests/run-tests.ts::testOpenAIClientRetriesAndDecodesErrors`、`testRuntimeContextAndTools`、`testStreamingToolRoundTextIsNotLeaked`、`testRuntimeStreaming`；`PATH=/opt/homebrew/bin:$PATH npm test` 通过。 | non-streaming 请求 body 使用 OpenAI-compatible `model/messages/temperature/tools`；streaming 请求额外设置 `stream=true`；tools 进入顶层 `tools` array，system message 不复制 tools JSON。API key 只进入 Authorization header，`llm_calls`、`context_segments`、`audit_logs` 序列化后不包含实际 key；provider base URL 和 endpoint 会规范化。 |
| D2 | 已验证 | `src/core/agent-runtime.ts::runToolLoop`、`runStream`、`saveFollowUpLlmCall`；`src/tests/run-tests.ts::testMultiStepToolLoop`、`testStreamingMultiStepToolLoop`、`testStreamingFollowUpFailureMarksLlmCallFailed`、`assertFollowUpContextStacksIncludeBaseSegments`；`PATH=/opt/homebrew/bin:$PATH npm test` 通过。 | 多轮 tool loop 每轮保存 LLM/tool trace；follow-up LLM call 克隆 active `system/workspace/tools/memory/history/user` base segments，再追加 `tool_result` 和 `final_messages`，不会退化为只有工具结果。流式 tool-call 中间文本只进日志不流给用户，follow-up 失败会标记对应 LLM call failed 并清理本轮 user message。 |
| E1 | 已补强验证 | `src/core/mcp-executor.ts::McpToolExecutor`；`src/db/repositories.ts::upsertMcpServer`、`importMcpServerTools`、`upsertWorkspaceTool`；`src/core/tool-registry.ts::execute`；`src/web/main.tsx::WorkspacePanel`；`src/tests/run-tests.ts::testBuiltInToolsAreSeededAndWorkspaceScoped`；`PATH=/opt/homebrew/bin:$PATH npm test` 通过。 | MCP server 是 workspace-scoped first-class resource，支持 stdio 和 Streamable HTTP binding JSON；UI 先注册/编辑 workspace MCP Server，再发现工具并挂载选中工具。测试用真实 stdio MCP fixture 验证 `discoverTools`/`importMcpServerTools`/runtime `callTool`；导入工具保存 `bindingType=mcp`、`mcpServerId`、`mcpToolName`。placeholder workspace tool 会返回 structured failed tool result，不会静默执行。 |
| F1 | 已验证 | `src/web/main.tsx::App`、`ChatTab`、`WorkspaceTab`、`MemoryTab`、`LogsTab`、`DatabaseTablesTab`、`RuntimeConfigTab`、`ConceptIntroTab`；in-app browser `http://localhost:4173/` 七个顶层页签实测；`PATH=/opt/homebrew/bin:$PATH npm test` 通过。 | 顶层 tab 包含对话、工作空间、记忆、日志、数据表、配置、概念介绍。对话页是智能体配置、当前会话、上下文/记忆三栏；工作空间页含 MCP Server 注册、检测工具、挂载选中工具；日志页显示 LLM、audit、tool、approval；数据表页通过 creator actor 读取 DB 表。 |
| F2 | 已验证 | `src/web/main.tsx::ConceptIntroTab`；in-app browser 概念介绍页可见文本；`PATH=/opt/homebrew/bin:$PATH npm test` 通过。 | 概念页与主计划一致：以 `Stable Identity + Dynamic Workspace State` 为核心，明确 workspace 是能力边界不是子 Agent，memory 分 Impression/Event/Skill，记忆召回采用 summary/id 渐进披露，context stack 只列 `system/workspace/tools/memory/local_conversation/user/tool_result` 等真实层，未展示废弃的全工具/全记忆大 Agent 方案。 |
| G1 | 已补强验证 | `src/db/schema.ts::migrate`；`src/db/repositories.ts::listDatabaseTables`、`readDatabaseTable`；`src/web/main.tsx::DatabaseTablesTab`；`src/tests/run-tests.ts::testDatabaseAndMemory`；`PATH=/opt/homebrew/bin:$PATH npm test` 通过。 | schema 覆盖 agents、users、llm_profiles、runtime_config、conversations、messages、workspaces、tool_definitions、workspace_tools、mcp_servers、workspace_sessions、llm_calls、context_segments、tool_calls、memories、memories_fts、approval_requests、audit_logs。测试新增核心表存在性与 agents/workspaces/mcp_servers/tool_definitions/tool_calls/memories/runtime_config/llm_calls/context_segments/workspace_sessions 关键字段断言；数据表 UI 使用 creator-only `/api/db/tables` 浏览原始记录。 |
| H1 | 发现并修复偏差 | `src/core/agent-runtime.ts::executeToolCalls`；`src/db/repositories.ts::saveToolCall`、`updateToolCallResult`；`src/tests/run-tests.ts::testTraceAndToolLogsAreUserScoped`、`testToolPolicyGates`；`PATH=/opt/homebrew/bin:$PATH npm test` 通过。 | 原实现只在工具执行后插入 `tool_calls`，`beforeToolCall` 没有待执行 tool call 记录。现改为工具执行前先落库 `status=pending`，`hook.beforeToolCall` 的 `resourceId/toolCallId` 指向该记录；执行后用同一记录更新 `resultJson` 和最终状态，`hook.afterToolCall` 继续指向同一 id。测试覆盖 repository pending->completed 转换，以及 runtime blocked tool 的 before pending / after blocked 审计链。 |
| H2 | 已补强验证 | `src/core/agent-runtime.ts::llmTokenUsage`、`run` afterAgentTurn audit；`src/tests/run-tests.ts::testRuntimeContextAndTools`；`PATH=/opt/homebrew/bin:$PATH npm test` 通过。 | `llm_calls.responseJson` 继续保留 provider raw response；同时 `hook.afterAgentTurn` metadata 新增 `tokenUsage`，从最终 non-streaming LLM response 的 raw `usage` 中提取。测试 fixture 返回 `prompt_tokens/completion_tokens/total_tokens`，并断言 afterAgentTurn audit 可直接看到这组 usage，满足 lifecycle hook 层记录 token 使用情况的要求。 |
| H3 | 已补强验证 | `src/core/memory-service.ts::executeMemoryTool`、`runtimeMemoryEvidence`；`src/tests/run-tests.ts::testSkillMemoryToolQualityGate`；`PATH=/opt/homebrew/bin:$PATH npm test` 通过。 | `writeSkillMemory` 成功写入时，metadata 的 `activeWorkspaceId`、`workspaceSessionId`、`taskId` 来自 runtime 传入的 active workspace session，测试已验证这些字段对应真实 dev session。新增 forged trace 测试：模型在 tool arguments 中传入 `activeWorkspaceId=main`、伪造 `workspaceSessionId/taskId` 时，runtime 返回 `Runtime memory scope is code-bound`，tool call 标记 failed，且不会写入该 skill。相同 code-bound trace 字段也加入 `writeUserImpression`、`writeAgentSelfImpression` 的显式拒绝列表。 |
