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
| `docs/04-multi-tenant-isolation.md` | 281 | 待逐条核对 | userId/权限/trace/memory 隔离。 |
| `docs/05-hooks-and-lifecycle.md` | 411 | 待逐条核对 | lifecycle hook、event/skill 提取。 |
| `docs/06-typescript-implementation-roadmap.md` | 424 | 待逐条核对 | 模块/MVP/UI/阶段性要求。 |
| `docs/07-context-and-prompt-contracts.md` | 527 | 待逐条核对 | context stack、prompt、tool loop 契约。 |
| `zleap-agent-framework.md` | 589 | 进行中 | 概念介绍的产品表达，需与主计划一致。 |

## 功能域清单

| ID | 功能域 | 文档要求摘要 | 当前状态 | 下一步 |
| --- | --- | --- | --- | --- |
| A1 | 稳定 Agent 身份 | workspace 切换不改变 system/personality，变化的是工具、局部记忆和局部上下文。 | 待验证 | 检查 `ContextBuilder` 和 workspace 切换测试。 |
| A2 | main/child workspace 工具边界 | `enterWorkspace`/`askUser`/`finishTask` 仅 main 可见；`exitWorkspace` 仅 child 可见；错误绑定也必须隐藏和拒绝。 | 已验证 | 已补充 provider tools、workspace local context 和错误绑定拒绝测试。 |
| A3 | workspace manifest 可见性 | main 和 child 都可看到 workspace manifest；child 看到 sibling manifest 不等于获得 sibling tools。 | 已验证 | 已补充 child manifest 可见但 main-only tools 不可调用的测试。 |
| A4 | handoff 隔离 | parent-to-child 只携带总体要求、当前用户请求、少量用户原话；不得携带父级 assistant 执行记录、enterWorkspace 结果、父级工具证据或 sibling 记录。 | 进行中 | 检查 `AgentRuntime.createParentToChildHandoff`、history 构造和测试。 |
| A5 | child natural-language 不能直接终答 | child 返回文本但不 `exitWorkspace` 时只能保存 trace，runtime 应继续要求退出。 | 待验证 | 检查 tool loop 和测试。 |
| A6 | `exitWorkspace` 结构校验 | 必须校验完整 `WorkspaceResult`，拒绝 `running`、重复退出、畸形 payload，失败时不触发 exit hook。 | 进行中 | 对照 `ToolRegistry.validateWorkspaceResult` 和测试覆盖。 |
| B1 | memory 类型和隔离 | impression 跨 workspace；event 为 `userId + workspaceId`；skill 为 workspace scoped shared 且脱敏。 | 待验证 | 检查 `MemoryService`、repository policy 和测试。 |
| B2 | memory 渐进披露 | 自动召回/search 只给 summary/id，标记 `summary_only`、`detailInjected=false`，需要详情时使用 `readMemory`/`readSkill`。 | 进行中 | 检查 context projection、tool schema、prompt 测试。 |
| B3 | event 自动写入 | 模型没有 event 写入工具；conversation window 和 workspace exit hook 自动写 process/result event。 | 待验证 | 检查 seed 工具列表、hook 触发、metadata。 |
| B4 | memory metadata 禁止原始载荷 | metadata 只能存语义投影和 `sourceRefs`，不能复制 raw messages/tool calls/finalMessages 等。 | 进行中 | 检查 `MemoryService.findRawSourcePayloadKey` 和测试。 |
| B5 | FTS + relation/version | 首版不用 vector；recall 需按完整 partition 判断最新版本，避免跨用户/跨 workspace 覆盖。 | 待验证 | 检查 repository 查询和测试。 |
| C1 | 多租户 conversation ownership | conversationId 由唯一 `userId + agentId` 拥有，跨用户/agent 复用必须拒绝。 | 待验证 | 检查 `ensureConversation` 和测试。 |
| C2 | 敏感调试端点 actor 显式要求 | LLM logs、approval、agent/workspace/memory、trace、conversation delete 都需要显式 actor。 | 待验证 | 检查 HTTP API 和 repository。 |
| C3 | approval 权限 | 高风险非 creator tool/workspace 请求进入 approval，resolve creator-only，普通用户只能看自己的请求。 | 待验证 | 检查 policy 和测试。 |
| D1 | LLM 协议 | OpenAI-compatible Chat Completions，streaming，工具走 `tools` array，API key 不入库/日志。 | 待验证 | 检查 `llm-client`、logs、UI cache。 |
| D2 | tool loop | Observe/Decide/Act/Verify 循环，follow-up LLM 保留完整 context stack，不退化成只有工具结果。 | 待验证 | 检查 `AgentRuntime` 和测试。 |
| E1 | MCP server-first | workspace 内绑定 MCP Server，发现 server tools，再导入到当前 workspace；placeholder 不静默执行。 | 待验证 | 检查 UI/API/repository/executor。 |
| F1 | Web UI 顶层结构 | 顶层 tab、对话三栏、工作空间/MCP、记忆、日志、数据表、概念介绍符合文档。 | 待验证 | 使用浏览器和代码核对。 |
| F2 | 概念介绍 | 需与主计划一致，不能展示废弃概念；context stack 只展示真实层。 | 待验证 | 检查 `src/web/main.tsx`。 |
| G1 | SQLite schema | 表和字段覆盖 agents、workspaces、mcp_servers、tool_calls、memories、runtime config 等。 | 待验证 | 检查 schema/migrations 和数据表 UI。 |

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
- [ ] 针对 A2/A3/A4/A6 增加或确认测试覆盖。
- [ ] 针对 B2/B3/B4/B5 增加或确认测试覆盖。
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
| A2 | 已补充验证 | `src/tests/run-tests.ts::testRuntimeContextAndTools`、`testWorkspaceBoundary`、`testChildWorkspaceCannotUseMainOnlyToolsEvenIfBound`；`PATH=/opt/homebrew/bin:$PATH npm test` 通过。 | 新增断言：main 的 workspace tools 不包含 `exitWorkspace`；child 的 provider `toolsJson` 与 callable tools 均不包含 `enterWorkspace`/`askUser`/`finishTask`，且包含 `exitWorkspace`。 |
| A3 | 已补充验证 | `src/tests/run-tests.ts::testRuntimeContextAndTools`；`PATH=/opt/homebrew/bin:$PATH npm test` 通过。 | 新增断言：child workspace 的 `runtime_context.workspace` 能看到 `main` 与 `dev` manifest，但这不授予 main-only tools。 |
