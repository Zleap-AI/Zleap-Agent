# Zleap Agent Framework Implementation Acceptance Summary

本文档用于验收从“补齐完整 WebUI 可调试 Agent 框架内部机制”目标开始，到当前版本为止已经落地的工作。

目标起点不是做一个静态 Demo WebUI，而是把 WebUI 后面的 Agent runtime、workspace 编排、memory、context、tool call、trace、权限隔离和调试面补成一个可以继续演进的框架。

## 1. 总体目标对齐

用户给出的核心目标可以概括为：

- WebUI 基本形态可以保留，但必须服务于调试真实 Agent 框架。
- Agent 不是一个大 prompt，而是由 runtime 管理的可检查执行系统。
- main workspace 负责编排，子 workspace 负责能力执行。
- memory 不是独立 workspace，而是每个 workspace 都可用的工具能力。
- 代码必须强制隔离身份、workspace、memory scope、tool visibility、approval 和 trace，不让模型自己传 id 决定边界。
- event memory 默认每约 20 条消息自动沉淀。
- skill memory 由用户或 agent 主动触发，并且必须是可复用、脱敏、有结构的经验。
- impression memory 只能通过显式 memory tool 写入，不能由 keyword heuristic 偷偷生成。
- 所有重大机制变化必须同步写入 `ZLEAP_MASTER_PLAN.md` 和相关 docs。

对应原始理念：

- `ZLEAP_MASTER_PLAN.md`: headless TypeScript core + Node API + React/Vite Web UI + SQLite Raw SQL。
- `docs/01-agent-philosophy.md`: Agent 要有可追踪的长期身份、记忆和行为边界。
- `docs/02-workspace-runtime.md`: workspace 是能力边界，main 负责选择和整合。
- `docs/03-memory-model.md`: impression/event/skill 是不同语义的 memory。
- `docs/04-multi-tenant-isolation.md`: user/workspace/creator 隔离是底层设计，不是 UI 装饰。
- `docs/05-hooks-and-lifecycle.md`: lifecycle hooks 是 memory 和 trace 的关键生产点。
- `docs/07-context-and-prompt-contracts.md`: context 是分区堆栈，不是扁平大 prompt。

## 2. UI 与 LLM 调试面

已落地内容：

- WebUI 使用中文界面。
- Chat 支持流式输出，服务端提供 `/api/agent/run/stream`，前端按 SSE 增量渲染。
- Chat 消息支持基础 Markdown 渲染，包括标题、列表、引用、链接、行内代码、代码块。
- 失败请求保留用户原始输入，并提供重试。
- 支持清空当前会话，同时保留 LLM 设置和浏览器缓存。
- 支持清空浏览器缓存。
- Enter 发送，Ctrl+Enter 换行。
- 点击某条用户消息时，右侧面板切换到那一轮的 context stack。
- 右侧面板展示当前会话 trace、context segments、final messages、tool calls、memory writes、audit logs、approval requests。
- 右侧增加 LLM 请求日志和全局近期 LLM 日志，用于检查 provider 请求是否真的发出、是否返回、失败原因是什么。
- 302AI base URL 规范化到 `https://api.302ai.com/v1/chat/completions`，并兼容纠正历史缓存里的 `api.302.ai`。
- API key 只允许浏览器缓存，不写入源码、SQLite、日志或计划文档。

对应理念：

- `ZLEAP_MASTER_PLAN.md` 的 Web UI 三栏结构、中文界面、streaming、Markdown、retry、clear conversation、context stack、LLM logs。
- `docs/07-context-and-prompt-contracts.md` 的“用户看到的是自然对话，内部 context/tool/runtime 只在调试面可见”。
- `docs/06-typescript-implementation-roadmap.md` 的 streaming Markdown chat、context stack、LLM logs 调试目标。

验收入口：

- `src/web/main.tsx`
- `src/web/styles.css`
- `src/server/index.ts`
- `src/core/llm-client.ts`

## 3. Workspace 编排机制

已落地内容：

- main workspace 不再通过 `listWorkspaces` 工具发现子 workspace。
- runtime 把 workspace manifests 直接注入 main context，包含名称、描述、capabilities、inputKinds、outputKinds、riskLevel、requiresApproval。
- 每一轮从 main workspace 开始。
- main 只能看到编排工具和 main 自己的 memory tools。
- 子 workspace 只有在 main 显式调用 `enterWorkspace` 后才进入。
- 进入子 workspace 后，runtime 创建 `WorkspaceTask`、`WorkspaceLocalContext`、`WorkspaceSession` 和初始 `WorkspaceResult`。
- 子 workspace 只能使用自身工具和通用 memory tools，不能直接调用 sibling workspace 工具。
- `file` 不能调用 `cli` 工具。
- MCP-bound 工具作为可检查的工具定义存在，但在 MCP executor 未连接时明确失败，不假装成功。
- `WorkspaceLocalContext.availableTools` 与真实 LLM callable tools 保持一致，不让 UI 显示 runtime 实际会拒绝的工具。

对应理念：

- `docs/02-workspace-runtime.md`: main 接收 manifest，而不是靠工具枚举 workspace。
- `docs/02-workspace-runtime.md`: 模型自由选择是否进入 workspace；代码决定当前 active workspace 和可见工具集。
- `docs/07-context-and-prompt-contracts.md`: child workspace context 只围绕自身任务、manifest、local memory 和 local evidence。
- `ZLEAP_MASTER_PLAN.md`: workspace 是工具 + 工具说明 + manifest metadata + memory policy。

验收入口：

- `src/core/workspace-runtime.ts`
- `src/core/tool-registry.ts`
- `src/core/context-builder.ts`
- `src/db/seed.ts`
- `src/tests/run-tests.ts`

## 4. 子 Workspace 退出与交付边界

已落地内容：

- 子 workspace 退出 main 的唯一正常路径是 `exitWorkspace`。
- `exitWorkspace` 必须提交完整 `WorkspaceResult`：
  - `status`
  - `summary`
  - `artifacts`
  - `observations`
  - `errors`
  - `suggestedNextSteps`
- `running` 只能是内部 session 状态，不能作为 `exitWorkspace.status`。
- malformed `exitWorkspace` 不会提交 session，不触发 exit hooks。
- duplicate `exitWorkspace` 不能覆盖第一次已经提交的 `WorkspaceResult`。
- 子 workspace 直接输出自然语言不会被当成最终用户回答；runtime 会把它作为内部 trace 保存，并继续要求模型调用 `exitWorkspace`。
- `exitWorkspace` 后同一 assistant tool-call batch 里剩余的 child tool call 会被记录为 failed post-exit call，不再执行，也不会污染已经完成的 session evidence。
- main workspace 有 `askUser` 和 `finishTask` 两个终止型编排工具；成功后直接提交 main `WorkspaceResult`，不再让 LLM 二次复述。

对应理念：

- `docs/02-workspace-runtime.md`: 子 workspace 通过结构化 `WorkspaceResult` 交付给 main。
- `docs/07-context-and-prompt-contracts.md`: raw evidence 留在子 workspace trace，不压扁进 main prompt。
- `docs/05-hooks-and-lifecycle.md`: workspace exit hooks 只能绑定真实成功 exit。
- `ZLEAP_MASTER_PLAN.md`: main/child 工具边界是代码强制，不是 prompt 建议。

验收入口：

- `src/core/agent-runtime.ts`
- `src/core/tool-registry.ts`
- `src/core/workspace-runtime.ts`
- `src/tests/run-tests.ts`

## 5. Context Stack 与 Prompt Contract

已落地内容：

- user message 保持干净。
- system/personality/policy/workspace/task/workspace result/memory/history/tool result/final messages 分区保存。
- context stack 存入 `context_segments`，WebUI 可检查。
- 每次 tool loop 后的 follow-up LLM call 也保存自己的 context snapshot，而不是只保存首轮。
- `final_messages` 可检查，能看到真正送给 OpenAI-compatible Chat Completions 的 messages。
- `WorkspaceSession.localContext` 成为 active workspace memory/context 的权威来源。
- Prompt assembly 不再做第二次独立 memory recall，避免 WebUI trace 和模型实际看到的不一致。
- attention budgeting 保持结构化 JSON 可解析，避免把 memory/task/result/tool result 裁成不可调试碎片。
- system/policy prompt 明确要求用户可见回答不要暴露 runtime、workspace、context stack、memory injection、tool orchestration。
- personality prompt 不再写 workspace/context/runtime 这些内部机制。

对应理念：

- `docs/07-context-and-prompt-contracts.md`: context 是可审计分区，不是扁平大窗口。
- `ZLEAP_MASTER_PLAN.md`: final LLM messages 必须可检查。
- `docs/01-agent-philosophy.md`: Agent 的人格和系统行为要分层，不能把内部工程机制暴露给用户。

验收入口：

- `src/core/context-builder.ts`
- `src/core/prompt-assembler.ts`
- `src/core/attention-budget.ts`
- `src/core/agent-runtime.ts`
- `src/db/repositories.ts`

## 6. Memory 总体机制

已落地内容：

- 没有独立 Memory workspace。
- `searchMemory`、`updateMemory`、`deleteMemory`、`writeUserImpression`、`writeAgentSelfImpression`、`writeEventMemory`、`writeSkillMemory` 挂载到每个 workspace。
- event/skill memory 由当前 active workspace 绑定，模型不能传 `workspaceId`。
- user impression 由当前 run 的 `userId` 绑定，模型不能传 `userId`。
- agent self impression 由当前 agent 的 `agentId` 绑定，且需要 creator role。
- runtime memory tool schema 不暴露 scope-moving 字段：
  - `updateMemory` 不允许改 `memoryType/userId/agentId/workspaceId/relationId/version`。
  - `searchMemory` 不暴露 user/agent/workspace debug filters。
- `searchMemory` 是 runtime 工具，不是 creator-global debug 工具。即使当前 run 是 creator，也不能让模型借此搜索其他用户或 agent self impression。
- Direct Memory Web UI/API 走同一个 `MemoryService` policy layer，不绕过 memory policy。
- Direct Memory API update 会校验 patched final row，不只校验原 row。
- Direct Memory API 的 operation-level `conversationId` 只作为 trace link，普通用户必须拥有该 conversation 才能写审计。

对应理念：

- `docs/03-memory-model.md`: memory 是 impression/event/skill 三类语义，不是一个万能表格。
- `docs/03-memory-model.md` 2026-05-30/31 更新：memory tools 挂在每个 workspace，scope 由代码绑定。
- `docs/04-multi-tenant-isolation.md`: memory 隔离是底层边界。
- `ZLEAP_MASTER_PLAN.md`: model freedom 与 code authority 分离。

验收入口：

- `src/core/memory-service.ts`
- `src/core/tool-registry.ts`
- `src/db/seed.ts`
- `src/db/repositories.ts`
- `src/tests/run-tests.ts`

## 7. Event Memory

已落地内容：

- conversation-window event extraction 默认每 20 条 stored messages 生成 process/result event。
- 事件窗口使用完整 conversation 的绝对 message index，不使用 prompt recent-history slice。
- 长对话不会因为只加载最近历史而把第 26 个窗口错标成第 1 个窗口。
- streaming 和 non-streaming 都先保存最终 assistant message，再执行 `afterAgentTurn`，所以 20-message window 行为一致。
- workspace exit 时会立即生成该 child workspace session 的 process/result event，不必等 20-message window。
- exit event evidence 限定在当前 session/task，不会把同一 workspace 的旧 session evidence 混进去。
- event relationId 包含 userId、workspaceId、conversationId/window 或 task 信息，避免跨会话误去重。
- event write 需要 `conversationId` 和合法 `eventKind`，并遵守 active workspace 的 `eventWriteEnabled`。
- event recall 按 partition 召回，受当前 workspace `maxEventMemories` 下推到 SQLite recall limit。

对应理念：

- `docs/03-memory-model.md`: event 是用户在某 workspace 的事件经验，使用 `userId + workspaceId + relationId/version`。
- `docs/05-hooks-and-lifecycle.md`: afterAgentTurn 和 workspace exit 是 event extraction 的生命周期点。
- 用户明确要求：event 大约每 20 条消息生成一次。

验收入口：

- `src/core/memory-service.ts`
- `src/core/agent-runtime.ts`
- `src/db/repositories.ts`
- `src/tests/run-tests.ts`

## 8. Skill Memory

已落地内容：

- skill memory 是 workspace-scoped、user-shared 的可复用经验。
- skill 可以由用户或 agent 主动触发。
- 支持中文主动触发语义，并测试“触发句本身不能被当成 skill 内容保存”。
- skill 写入必须包含 reusable procedure、appliesWhen、avoidWhen、confidence、desensitized 等结构。
- skill 写入会拒绝明显私密内容，例如路径、邮箱、电话、secret 等。
- skill 可以引用 `evidenceEventIds`，但 evidence 必须是同 workspace、同 conversation 或当前用户允许访问的 event。
- workspace exit 的 successful process/result event 可以保守提炼 shared skill candidate。
- 使用过的 skill 在 workspace exit 后记录 usage feedback：
  - `usageCount`
  - `successCount`
  - `failureCount`
  - blocked/needs-input counters
  - last session/task/conversation outcome
- active workspace 的 `skillWriteEnabled` 和 `maxSkillMemories` 会被 runtime 强制执行。
- skill recall limit 下推到 SQL recall 层，不被 repository 默认 limit 偷偷截断。

对应理念：

- `docs/03-memory-model.md`: skill 是脱敏后的 workspace 经验，不是某个用户的私密记录。
- `docs/05-hooks-and-lifecycle.md`: afterSkillExtracted 与 skill usage feedback 是生命周期机制。
- 用户明确要求：skill memory 由 agent/user 主动触发，而不是固定条数自动生成。

验收入口：

- `src/core/memory-service.ts`
- `src/core/workspace-runtime.ts`
- `src/db/repositories.ts`
- `src/tests/run-tests.ts`

## 9. Impression Memory

已落地内容：

- user impression 不再由 `afterAgentTurn` keyword heuristic 自动生成。
- user impression 只能由 agent 显式调用 `writeUserImpression` 写入。
- `writeUserImpression` 只适用于稳定长期偏好、背景、身份、约束。
- impression 是跨 workspace 的身份层 memory，但 metadata 会保留 active workspace/session/task evidence，方便 WebUI trace 追溯来源。
- agent self impression 只能由 creator role 通过 `writeAgentSelfImpression` 或 direct Memory API 管理。
- agent self impression recall 必须匹配 exact `agentId`，不召回其他 agent、自身 scope 不明或 global impression。

对应理念：

- `docs/03-memory-model.md`: impression 是长期稳定认识，不是短期任务事实。
- `docs/04-multi-tenant-isolation.md`: agent self impression 是 creator-controlled。
- 用户明确要求：impression memory 主动由 agent tool 写入，不要 keyword heuristic。

验收入口：

- `src/core/memory-service.ts`
- `src/core/context-builder.ts`
- `src/tests/run-tests.ts`

## 10. 多租户、权限与 Approval

已落地内容：

- conversationId 绑定唯一 `userId + agentId`，不能跨用户/agent 复用。
- tool_calls、workspace_sessions、approval_requests、llm_calls 都带 userId 或按 conversation owner 校验。
- trace 读取需要显式 `actorId/actorRole`。
- 删除后的 conversation trace 只能 creator 查看，因为普通用户 ownership 已无法从 conversation row 验证。
- LLM logs 是 tenant-scoped debug data，普通用户只能看自己的，creator 可看全局。
- HTTP 敏感/调试/管理端点不再默认补 `actorId=user`：
  - LLM call logs
  - approvals list/resolve
  - agent update
  - workspace create/update/delete
  - memory list/create/update/delete
  - conversation trace
  - conversation delete
- workspace create/edit/delete 是 creator-gated capability installation/removal。
- workspace upsert 验证所有 tool ids，失败时不会部分写入 workspace 或 tool links。
- workspace delete 会拒绝 built-in workspace，并软删除该 workspace 下 event/skill memory。
- high-risk workspace/tool 需要 creator approval。
- approval_requests 可在 trace/UI 中检查，creator resolve 后相同请求可重试通过。

对应理念：

- `docs/04-multi-tenant-isolation.md`: userId 是所有用户数据查询的硬约束。
- `docs/02-workspace-runtime.md`: workspace 管理是 creator/operator 级能力安装，不是模型 tool call。
- `ZLEAP_MASTER_PLAN.md`: sensitive/debug/admin HTTP endpoints 必须显式 actor。

验收入口：

- `src/server/actor.ts`
- `src/server/index.ts`
- `src/db/repositories.ts`
- `src/core/tool-registry.ts`
- `src/tests/run-tests.ts`

## 11. LLM Provider、Streaming 与 Tool Loop

已落地内容：

- 使用真实 OpenAI-compatible Chat Completions 协议。
- 默认 base URL 规范化为 `/v1/chat/completions`。
- streaming path 解析 OpenAI-compatible content deltas 和 tool_call deltas。
- streaming tool loop 支持模型先发 tool call，再把 tool result 送回 follow-up LLM call，直到最终文本或达到轮次上限。
- non-streaming tool loop 和 streaming tool loop 都有最大轮次限制，避免无界自治执行。
- 中间轮如果同时产生 tool call 和 assistant content，该 content 只进入 trace/debug，不流给用户。
- provider 请求成功/失败都会更新 `llm_calls`，失败会保存 diagnostic，pending 会在服务启动时标为 interrupted。

对应理念：

- `ZLEAP_MASTER_PLAN.md`: 真实 LLM，不做产品 mock mode；测试可以 fake provider。
- `docs/07-context-and-prompt-contracts.md`: tool loop 后每一轮 context/final messages 都可检查。
- 用户要求：流式输出、LLM 请求日志、能看 provider 是否真的返回。

验收入口：

- `src/core/llm-client.ts`
- `src/core/agent-runtime.ts`
- `src/db/repositories.ts`
- `src/server/index.ts`
- `src/web/main.tsx`

## 12. 数据模型与 SQLite

已落地内容：

- 使用 Raw SQL 和 `better-sqlite3`。
- core tables 覆盖：
  - agents
  - llm_profiles
  - conversations
  - messages
  - workspaces
  - tool_definitions
  - workspace_tools
  - workspace_sessions
  - llm_calls
  - context_segments
  - tool_calls
  - memories
  - memories_fts
  - approval_requests
  - audit_logs
- workspaces 增加 manifest metadata 和 `memoryPolicyJson`。
- tool call logs 增加 user/workspaceSession/task evidence。
- memories 使用单表 + `memoryType` 区分 impression/event/skill。
- FTS + relationId/version 作为首版 recall 基础。
- relation/version latest 判断限定在完整 scope partition 内。
- 删除 memory 使用 soft delete，并确保 list/get/recall/FTS 排除 deleted rows。

对应理念：

- `ZLEAP_MASTER_PLAN.md`: SQLite Raw SQL，不引入复杂 ORM。
- `docs/03-memory-model.md`: 首版没有 vector store，FTS + relation/version 先跑通。
- `docs/04-multi-tenant-isolation.md`: relation/version 也必须在 user/workspace/agent scope 内解释。

验收入口：

- `src/db/schema.ts`
- `src/db/repositories.ts`
- `src/db/seed.ts`

## 13. 文档同步

已落地内容：

- `ZLEAP_MASTER_PLAN.md` 被持续更新为最高级开发指引。
- 新决策覆盖旧决策时，主计划写明“最新用户决策为准，旧 docs 不得保留冲突指导”。
- 已同步更新的 docs 包括：
  - `docs/01-agent-philosophy.md`
  - `docs/02-workspace-runtime.md`
  - `docs/03-memory-model.md`
  - `docs/04-multi-tenant-isolation.md`
  - `docs/05-hooks-and-lifecycle.md`
  - `docs/06-typescript-implementation-roadmap.md`
  - `docs/07-context-and-prompt-contracts.md`
  - `docs/README.md`

对应理念：

- 用户明确要求：以后每次更新代码先读主计划，重大改动同步更新文档。
- `ZLEAP_MASTER_PLAN.md`: root README 不作为事实来源，核心 docs + master plan 才是指引。

## 14. 测试与验证

已补充/扩展的测试覆盖了：

- database migration、memory CRUD、FTS/relation recall。
- conversation ownership 和 trace tenant isolation。
- LLM logs owner scoping。
- approval list/resolve policy。
- main/child workspace tool visibility。
- `file` 不能调用 `cli`。
- main manifest injection，不依赖 `listWorkspaces`。
- child workspace direct-response guard。
- valid/malformed/duplicate `exitWorkspace`。
- post-exit same-batch tool call reject。
- main `askUser` / `finishTask` terminal behavior。
- workspace-local recent tool calls session scoping。
- workspace memory policy recall/write gates。
- event metadata contract。
- 20-message absolute event windows。
- streaming 和 non-streaming event extraction parity。
- active skill extraction、skill evidence、skill quality gate。
- impression tool scope code-bound。
- runtime memory tools universal but policy-gated。
- direct Memory API policy layer。
- searchMemory runtime boundary。
- MCP-bound tool readiness。
- workspace deletion lifecycle。
- workspace upsert atomic tool validation。
- explicit HTTP actor parsing。

最近一次验证命令结果：

```text
npm run typecheck
npm test
npm run build
```

三者均通过。

## 15. 当前仍然需要继续演进的部分

这些不是本轮验收失败点，而是下一阶段框架继续完善的明确方向：

- MCP executor 还没有真正接入；当前 MCP-bound 工具是可检查、可失败的占位绑定。
- Browser workspace 不在首版范围内。
- WebUI 的 Workspace 管理和 Memory 管理已经具备调试形态，但未来还需要更完整的 creator/operator 工作流。
- 真实 provider 连通性仍取决于本地网络、代理、DNS 和 302AI 服务可达性；框架现在能记录失败日志，但不能替代网络环境。
- memory 提炼质量目前是规则化保守实现，后续可以把更高质量的提炼策略接入 runtime，但仍必须遵守 code-bound scope 和 policy。

## 16. 验收结论

本轮工作把项目从“有 WebUI 和基础 runtime 的原型”推进到“可以通过 WebUI 检查内部机制的 Agent 框架”。

最重要的变化不是某个页面按钮，而是几个底层边界已经落成：

- main/child workspace 通过结构化协议交接。
- context stack 和 final LLM messages 可检查。
- memory 三分区并受 workspace/user/agent scope 约束。
- event/skill/impression 的生成入口分清楚。
- 模型能自由决定行动，但不能自由决定身份、workspace、memory scope、tool set、approval 和 persistence。
- trace/LLM logs/approval/memory debug 都进入 tenant-aware policy boundary。

这正对应你最初要求的方向：WebUI 是调试入口，核心是一个完整、可审计、可继续扩展的 Agent framework。
