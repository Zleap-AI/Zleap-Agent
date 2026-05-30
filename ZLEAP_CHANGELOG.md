# Zleap Change Log

This file records meaningful project changes with local timestamps so future work can be traced alongside Git history.

## 2026-05-31 07:43 +08:00

Purpose:
- Make memory scopes inspectable and prevent user-impression versus agent-self-impression confusion.

Changed:
- Strengthened the runtime system memory-write protocol so `writeUserImpression` is only for current-user long-term facts and `writeAgentSelfImpression` is only for creator-authorized agent identity/self-knowledge.
- Added conversation trace memory-write recovery so the Chat right panel can show memory rows associated with the selected run even when the run output cache missed them.
- Updated the Memory tab table and editor to show `agentId` and `relationId`, plus a readable scope label.
- Updated the right-panel memory write display to show scope, userId, agentId, workspaceId, relationId, summary, and a structured full-record view.
- Updated master/concept/memory/lifecycle docs with explicit impression scope rules and removed stale model-callable event/update memory guidance.

Verification:
- `npm run typecheck` passed.
- `npm test` passed.
- `npm run build` passed.

Git:
- Recorded by the Git commit that introduced this changelog entry.

## 2026-05-31 07:38 +08:00

Purpose:
- Make context stack and JSON-heavy debug views readable enough to verify callable tools and runtime partitions without scanning raw JSON blobs.

Changed:
- Added a reusable structured JSON viewer for the Web UI.
- Changed context stack sections to render parsed JSON as field groups, nested lists, and table-like arrays instead of raw `<pre>` dumps.
- Changed LLM log message/tool/response payload details to use the same structured JSON view, while keeping raw provider logs separated from the normal context stack.
- Updated the concept guide, master plan, and context contract docs to require readable structured JSON views, especially for the OpenAI-compatible callable `tools` array.

Verification:
- `npm run typecheck` passed.
- `npm test` passed.
- `npm run build` passed.

Git:
- Recorded by the Git commit that introduced this changelog entry.

## 2026-05-31 07:33 +08:00

Purpose:
- Clarify memory handling in the concept guide and keep raw provider payload logs out of the normal context stack.

Changed:
- Added a dedicated memory-recall explanation to the `概念介绍` tab: recent raw context, result/process event projections, fixed impression recall, and why long conversations do not re-inject raw source data.
- Renamed the concept guide's context section to `上下文概览` and removed `final_messages` from the normal context stack illustration.
- Updated the Chat right context panel so `final_messages` is hidden from the stack and appears only behind a subtle `显示原始日志` toggle beside the stack title.
- Updated `ZLEAP_MASTER_PLAN.md`, `zleap-agent-framework.md`, and all files under `docs/` to state that `final_messages` is a raw provider-payload log, not a context layer, and to restate the current memory recall/injection strategy.

Verification:
- `npm run typecheck` passed.
- `npm test` passed.
- `npm run build` passed.

Git:
- Pending in this work session.

## 2026-05-31 07:25 +08:00

Purpose:
- Implement the clarified long-conversation memory recall strategy and make impression recall fixed rather than query-selective.

Changed:
- Changed automatic runtime recall so impression memory always loads up to 20 latest effective user/agent impressions for the current scope without SQLite FTS filtering.
- Split event recall into up to 50 latest result events plus up to 8 SQLite FTS-matched process events for the active `userId + workspaceId`.
- Increased raw local conversation context to 20 messages/records and kept older long-conversation continuity in projected event memory instead of raw transcript injection.
- Changed `runtime_context.memory` and the `memory` context segment to inject compact projected memory views rather than raw `MemoryRow` records, full `detail`, full `metadataJson`, or evidence arrays.
- Updated the Chat context labels and concept intro UI to show result-event/process-event memory sections.
- Updated `ZLEAP_MASTER_PLAN.md`, `zleap-agent-framework.md`, `docs/03-memory-model.md`, and `docs/07-context-and-prompt-contracts.md` with the fixed-impression and long-conversation recall rules.
- Added/updated tests for fixed impression recall, result/process event recall, projection shape, audit partition counts, and 50-result-event behavior.

Verification:
- `npm run typecheck` passed.
- `npm test` passed.
- `npm run build` passed.

Git:
- Recorded by the Git commit that introduced this changelog entry.
- No remote repository is currently configured, so push cannot be performed yet.

## 2026-05-31 07:13 +08:00

Purpose:
- Simplify the Chat right sidebar so it does not duplicate the central timeline and only shows the inspection essentials.

Changed:
- Removed the right-sidebar `正在查看` block because the selected message/turn is already clear in the middle conversation timeline.
- Removed raw `工作空间轨迹` and `LLM 调用检查点` blocks from the Chat sidebar.
- Kept the sidebar focused on `当前工作空间`, `上下文窗口堆栈`, and `本轮记忆写入`.
- Updated `ZLEAP_MASTER_PLAN.md` to make this simplified right-panel structure the UI contract.

Verification:
- `npm run typecheck` passed.
- `npm test` passed.
- `npm run build` passed.

Git:
- Pending in this work session.

## 2026-05-31 07:10 +08:00

Purpose:
- Clarify why child workspaces should know sibling workspace existence: the manifest list is shared environment memory / a capability map, not shared execution authority.

Changed:
- Updated the runtime prompt contract so child workspace awareness is described as a cross-workspace shared capability map similar to knowing other software exists while using one application.
- Updated `ZLEAP_MASTER_PLAN.md` and `zleap-agent-framework.md` to distinguish workspace awareness from tool access and direct switching authority.
- Updated the concept introduction UI labels/copy so the workspace manifest is presented as a shared capability map rather than a main-only list.

Verification:
- `npm run typecheck` passed.
- `npm test` passed.
- `npm run build` passed.

Git:
- Pending in this work session.

## 2026-05-31 07:04 +08:00

Purpose:
- Align memory writing with the clarified strategy: impression is agentic, event is hook/programmatic, skill is both agentic and conservative hook/manual, and runtime memory does not expose model-callable update/delete tools.

Changed:
- Removed `writeEventMemory`, `updateMemory`, and `deleteMemory` from the model-callable runtime memory tool surface and seed cleanup now removes legacy tool definitions/links from existing SQLite databases.
- Kept `searchMemory`, `writeUserImpression`, `writeAgentSelfImpression`, and `writeSkillMemory` as the only universal memory tools visible inside workspaces.
- Updated the hidden runtime prompt contract so event memory is described as lifecycle-hook owned, skill hook extraction is conservative and desensitized, and memory evolution is append/latest rather than in-place model mutation.
- Updated `ZLEAP_MASTER_PLAN.md` and `zleap-agent-framework.md` to clarify the three memory write sources and the boundary between agent freedom and code authority.
- Updated tests to assert legacy memory mutation tools are absent from callable tools while hook-generated event memory remains auditable.

Verification:
- `npm run typecheck` passed.
- `npm test` passed.
- `npm run build` passed.

Git:
- Recorded by the Git commit that introduced this changelog entry.
- No remote repository is currently configured, so push cannot be performed yet.

## 2026-05-31 06:57 +08:00

Purpose:
- Make child workspaces aware of sibling workspace capabilities without allowing them to switch workspaces directly, and preserve workspace-local continuity across switches.

Changed:
- Runtime now includes the workspace manifest list in child workspace context so a child can recommend a sibling handoff through `exitWorkspace.suggestedNextSteps`.
- Child workspaces still do not receive `enterWorkspace`; only `main` can schedule the next workspace.
- Child workspace local conversation context now restores bounded prior records from the same workspace within the conversation, so returning to a workspace behaves like switching back to the same software rather than starting a memoryless sub-agent.
- LLM call completion snapshots now persist the assistant message alongside raw provider metadata, which lets workspace-local history recover previous tool-call decisions.
- Updated `ZLEAP_MASTER_PLAN.md`, `zleap-agent-framework.md`, and the concept intro copy to reflect this software-switching model.

Verification:
- `npm run typecheck` passed.
- `npm test` passed.
- `npm run build` passed.

Git:
- Pending in this work session.

## 2026-05-31 06:53 +08:00

Purpose:
- Keep callable tool schemas in the OpenAI-compatible `tools` request array instead of duplicating them into the system prompt.

Changed:
- Updated `PromptAssembler` so the system message only includes `system` and `workspace` context segments.
- Kept the `tools` context segment as an inspectable snapshot for the Web UI and trace logs.
- Added regression coverage that child workspace tool schemas appear in the request `tools` array but not inside the system message.
- Updated `ZLEAP_MASTER_PLAN.md`, `zleap-agent-framework.md`, and the concept intro copy to clarify this boundary.

Verification:
- `npm run typecheck` passed.
- `npm test` passed.
- `npm run build` passed.

Git:
- Pending in this work session.

## 2026-05-31 06:51 +08:00

Purpose:
- Turn the external Framework markdown into a product-facing concept introduction while keeping it aligned with the latest Zleap runtime decisions.

Changed:
- Rewrote `zleap-agent-framework.md` to remove outdated/conflicting guidance: `listWorkspaces` is not a tool, `exitWorkspace` is child-only, Browser workspace is future scope, vector recall is not enabled in the first version, and tools/context categories follow the latest master plan.
- Added a top-level `概念介绍` Web UI tab.
- Built a visual concept guide covering the traditional-agent problem, Zleap's stable identity + dynamic workspace state model, workspace routing, memory layers, context stack, lifecycle hooks, design principles, and implementation modules.
- Updated `ZLEAP_MASTER_PLAN.md` so the new tab and Framework markdown alignment rules remain part of the project direction.

Verification:
- `npm run typecheck` passed.
- `npm test` passed.
- `npm run build` passed.

Git:
- Pending in this work session.

## 2026-05-31 06:46 +08:00

Purpose:
- Make the Chat context stack numbering read like normal UI order instead of exposing internal sort weights.

Changed:
- Updated the context stack summary labels to display sequential numbers (`1`, `2`, `3`, ...) while continuing to use `sortOrder` only for internal ordering.

Verification:
- `npm run typecheck` passed.
- `npm run build` passed.

Git:
- Pending in this work session.

## 2026-05-31 06:40 +08:00

Purpose:
- Make callable tools visible inside every inspected LLM context stack, so each request shows exactly which function calls were exposed.

Changed:
- Added a first-level `tools` context segment during runtime prompt assembly with active workspace id, tool count, tool schemas, risk levels, and runtime/MCP binding metadata.
- Removed callable tool definitions from the `workspace` segment so workspace information and tool exposure are no longer conflated.
- Included the `tools` segment in the system message assembly, keeping the prompt and stored context stack aligned.
- Updated the Chat context inspector to label/render `tools` as its own expandable category and synthesize the same view from saved `toolsJson` for older LLM call records.
- Updated `ZLEAP_MASTER_PLAN.md` so future context-stack work treats tools as a first-level category.

Verification:
- `npm run typecheck` passed.
- `npm test` passed.
- `npm run build` passed.

Git:
- Pending in this work session.

## 2026-05-31 06:35 +08:00

Purpose:
- Make every saved LLM call inspectable from the Chat UI, not only the initial user-message turn.

Changed:
- Added current-conversation trace loading to the Chat page so it can group `context_segments` by `llmCallId`.
- Added an `LLM 调用检查点` list in the right panel; each checkpoint opens the exact context stack for that saved LLM request.
- Made user, assistant, workspace, and function-call/process messages clickable when they can be associated with an LLM call.
- Cached the selected LLM call id in browser state.
- Updated `ZLEAP_MASTER_PLAN.md` so future UI work preserves per-LLM-call context inspection.

Verification:
- `npm run typecheck` passed.
- `npm test` passed.
- `npm run build` passed.

Git:
- Pending in this work session.

## 2026-05-31 06:25 +08:00

Purpose:
- Teach the agent the internal workspace concept clearly enough to decide when to enter or exit workspaces.

Changed:
- Added an explicit workspace decision contract to the runtime system prompt: workspace is an internal capability boundary, `main` plans/integrates, and child workspaces specialize with limited tools.
- Clarified in the prompt that child workspaces should call `exitWorkspace` when work is complete, failed, blocked, missing tools, requires user input/approval, or needs another workspace.
- Added regression coverage that the assembled system message includes the workspace contract and `enterWorkspace`/`exitWorkspace` handoff language.
- Updated `ZLEAP_MASTER_PLAN.md` with the rule that the system prompt should teach the internal workspace model while final user-facing answers still hide it.

Verification:
- `npm run typecheck` passed.
- `npm test` passed.
- `npm run build` passed.

Git:
- Pending in this work session.

## 2026-05-31 06:18 +08:00

Purpose:
- Stop exposing internal tool-loop limits as a per-workspace operation limit in user-facing chat.

Changed:
- Raised the default runtime tool-loop circuit breaker to 100 rounds and made it configurable with `ZLEAP_MAX_TOOL_ROUNDS`.
- Replaced the user-facing "连续操作轮次" fallback with natural wording that asks whether to continue or clarify the goal.
- Updated tests so loop-limit coverage verifies the audit/circuit-breaker behavior without requiring the old internal wording, and workspace-tool fake LLMs exit child workspaces through the normal `exitWorkspace` protocol.
- Updated `ZLEAP_MASTER_PLAN.md` to clarify that the loop guard is a high global safety circuit breaker, not a per-workspace product limit.

Verification:
- `npm run typecheck` passed.
- `npm test` passed.
- `npm run build` passed.

Git:
- Pending in this work session.

## 2026-05-31 06:14 +08:00

Purpose:
- Remove redundant Workspace editor settings and make the workspace input/output protocol code-owned.

Changed:
- Replaced the duplicate Workspace `描述`/`工作空间说明` fields with one visible `工作空间说明` field.
- Removed user-facing Workspace `输入类型`, `输出类型`, and `工具使用说明` fields from the Web UI.
- Normalized workspace saves so code always supplies the fixed input protocol (`user_request`, `workspace_task`), fixed output protocol (`workspace_result`), mirrors the single workspace explanation into runtime instructions, and clears workspace-level tool instructions.
- Updated `ZLEAP_MASTER_PLAN.md` to record that workspace input/output contracts are uniform and that tool usage guidance belongs to tool definitions.

Verification:
- `npm run typecheck` passed.
- `npm test` passed.
- `npm run build` passed.

Git:
- Recorded by the Git commit that includes this changelog entry.

## 2026-05-31 06:10 +08:00

Purpose:
- Keep the Workspace editor compact when a workspace has no MCP Server.
- Keep workspace save/delete actions reachable during vertical scrolling.

Changed:
- Stopped auto-creating an MCP Server draft when the selected workspace has no MCP Servers; the registration form now opens only after clicking `新增 Server`.
- Made the Workspace editor action bar sticky at the bottom of the scrollable editor panel.
- Updated `ZLEAP_MASTER_PLAN.md` with the compact MCP empty-state and persistent workspace actions rules.

Verification:
- `npm run typecheck` passed.
- `npm test` passed.
- `npm run build` passed.

Git:
- Recorded by the Git commit that includes this changelog entry.
- No remote repository is currently configured, so push cannot be performed yet.

## 2026-05-31 06:08 +08:00

Purpose:
- Prevent editing an existing workspace ID from accidentally creating a new workspace.
- Add a Workspace UI path for deleting non-built-in workspaces.

Changed:
- Made saved workspace IDs read-only in the Workspace editor while keeping new unsaved workspace IDs editable.
- Added a Workspace editor delete/cancel action: unsaved workspaces can be abandoned, custom saved workspaces can be deleted, and built-in `main/file/cli` workspaces cannot be deleted.
- Routed Workspace UI deletion through the existing creator-gated `DELETE /api/workspaces/:id` API.
- Updated `ZLEAP_MASTER_PLAN.md` with the immutable workspace ID and non-built-in deletion UI rules.

Verification:
- `npm run typecheck` passed.
- `npm test` passed.
- `npm run build` passed.

Git:
- Recorded by the Git commit that includes this changelog entry.
- No remote repository is currently configured, so push cannot be performed yet.

## 2026-05-31 06:02 +08:00

Purpose:
- Treat `file` and `cli` as built-in foundational workspaces instead of requiring MCP Server setup for their default tools.
- Keep MCP as the expansion path for external/user-provided tools while making first-run file search and CLI execution actually runnable.

Changed:
- Added internal runtime executors for `searchFiles` and `runCommand`.
- Changed seed bindings for `tool-search-files` and `tool-run-command` from placeholder to runtime executors.
- Protected built-in file/CLI runtime tools from ordinary workspace tool editing/deletion.
- Updated tests to prove `searchFiles` and `runCommand` complete through runtime execution, while MCP import/execution remains covered by the echo server fixture.
- Updated `ZLEAP_MASTER_PLAN.md` with the rule that core local capabilities do not need MCP indirection.

Verification:
- `npm run typecheck` passed.
- `npm test` passed.
- `npm run build` passed.

Git:
- Recorded by the Git commit that includes this changelog entry.
- No remote repository is currently configured, so push cannot be performed yet.

## 2026-05-31 05:42 +08:00

Purpose:
- Make the Chat timeline feel like one continuous agent task stream for ordinary users, while still exposing workspace switches and function calls for users who inspect details.
- Replace visible workspace/debug-looking process messages with compact collapsible run-process blocks.

Changed:
- Added `运行过程` chat messages for workspace entry/exit, function-call batches, and tool results.
- Rendered non-final runtime events as collapsible details with simple summaries and expanded workspace/tool metadata.
- Kept child workspace assistant text visible separately from the final assistant answer.
- Updated `ZLEAP_MASTER_PLAN.md` with the user-task-first timeline rule.

Verification:
- `npm run typecheck` passed.
- `npm test` passed.
- `npm run build` passed.

Git:
- Recorded by the Git commit that includes this changelog entry.
- No remote repository is currently configured, so push cannot be performed yet.

## 2026-05-31 05:36 +08:00

Purpose:
- Correct the MCP product/runtime model from tool-first binding to workspace-scoped MCP Server binding.
- Make MCP setup usable for both local stdio servers and remote Streamable HTTP servers: save server, detect tools, choose mounted tools, then execute through the generated binding.

Changed:
- Added the `mcp_servers` SQLite table, `McpServerDefinition` type, repository CRUD, server-to-binding generation, and workspace-scoped MCP tool import.
- Added HTTP APIs under `/api/workspaces/:workspaceId/mcp-servers` for list/create/update/delete/discover/import.
- Updated MCP execution parsing to accept `streamable-http` transport names and kept execution on the official TypeScript SDK client.
- Reworked the Workspace UI so MCP Server management is the primary workflow, with discovery and selected-tool mounting inside the current workspace.
- Changed seeded file/CLI capability tools back to placeholders until a real MCP Server is bound, so fake local MCP IDs are not presented as working tools.
- Updated tests and docs to reflect server-first MCP setup and creator-gated MCP installation.

Verification:
- `npm run typecheck` passed.
- `npm test` passed.
- `npm run build` passed.

Git:
- Recorded by the Git commit that includes this changelog entry.
- No remote repository is currently configured, so push cannot be performed yet.

## 2026-05-31 05:27 +08:00

Purpose:
- Show child workspace LLM interactions in the central Chat conversation, instead of hiding them only in trace/log views.
- Keep final assistant replies separate from workspace process messages, so user-facing answers stay clean while workspace execution remains visible.

Changed:
- Extended streaming runtime events with a `workspace` event type for workspace entry, child workspace assistant text, child tool calls/results, and workspace exit summaries.
- Updated Chat UI message rendering to insert workspace process messages before the final assistant placeholder and style them separately from user/assistant messages.
- Added a streaming child-workspace visibility test that proves file workspace LLM text and tool/exit events are emitted while the final answer remains separate.
- Updated `ZLEAP_MASTER_PLAN.md` to make child workspace process visibility part of the runtime/UI contract and clarify that this replaces the older hidden-only streaming policy for child workspace interactions.

Verification:
- `npm run typecheck` passed.
- `npm test` passed.
- `npm run build` passed.
- In-app browser reload at `http://localhost:4173/` confirmed the refreshed Chat UI includes the workspace-aware conversation surface.

Git:
- Recorded by the Git commit that includes this changelog entry.
- No remote repository is currently configured, so push cannot be performed yet.

## 2026-05-31 05:22 +08:00

Purpose:
- Fix the Chat right panel's workspace display so a turn that entered `file` or another child workspace is not shown as only `main` after the child returns its result to main.
- Make the UI reflect the runtime contract: child workspaces execute capability work, then normally exit back to main for final integration.

Changed:
- Added Web UI logic that derives the currently inspected workspace from the selected/latest turn's workspace trace, preferring the latest non-main workspace when one was involved.
- Changed the Chat right panel label from current workspace to current inspected workspace, with status text and a "returned to main" note when applicable.
- Updated workspace badge styling for primary workspace, status, and involved route.
- Updated `ZLEAP_MASTER_PLAN.md` with the display rule.

Verification:
- `npm run typecheck` passed.
- `npm test` passed.
- `npm run build` passed.
- In-app browser reload at `http://localhost:4173/` confirmed the selected `查找js文件` turn now displays `file`, `状态：失败；运行结束后回到 main`, and `本轮涉及：main → file`.

Git:
- Recorded by the Git commit that includes this changelog entry.
- No remote repository is currently configured, so push cannot be performed yet.

## 2026-05-31 04:52 +08:00

Purpose:
- Make runtime memory recall inspectable in the Logs tab, including turns where the current SQLite FTS recall algorithm returns zero hits.
- Clarify that missing recall results can be an FTS query/token limitation, not necessarily a missing memory or permission failure.

Changed:
- Added `memory_recall_requested` audit logs during workspace local-context construction, with conversation/workspace/task ids, query text, algorithm name, `vectorEnabled`, recall limits, raw partition counts, injected partition counts, and injected memory ids.
- Added impression counts to `hook.afterWorkspaceEnter` metadata.
- Added tests for successful child-workspace recall logging and zero-hit main-workspace recall logging.
- Updated `ZLEAP_MASTER_PLAN.md` and `docs/03-memory-model.md` with the recall observability contract.

Verification:
- `npm run typecheck` passed.
- `npm test` passed.
- `npm run build` passed.

Git:
- Recorded by the Git commit that includes this changelog entry.
- No remote repository is currently configured, so push cannot be performed yet.

## 2026-05-31 04:10 +08:00

Purpose:
- Add a standing project process rule: every meaningful code or documentation change should be recorded in Git and logged here with timestamp, purpose, touched areas, verification status, and commit reference when available.
- Preserve an acceptance summary for the prior multi-hour Agent framework implementation work, so the work can be reviewed against the original docs and design principles.

Changed:
- Added `ZLEAP_IMPLEMENTATION_ACCEPTANCE_SUMMARY.md`.
- Added this `ZLEAP_CHANGELOG.md`.
- Updated `ZLEAP_MASTER_PLAN.md` to make Git versioning plus timestamped change logging a mandatory project practice.

Verification:
- Documentation/process-only change. No runtime verification required.

Git:
- Recorded by the Git commit that introduced this changelog entry.
- No remote repository is currently configured, so push cannot be performed yet.

## 2026-05-31 04:48 +08:00

Purpose:
- Change workspace/tool management from a global shared tool-pool UI to workspace-first tool registration, and connect MCP-bound tools to a real MCP client executor instead of leaving them as placeholders.

Changed:
- Added `@modelcontextprotocol/sdk` as the official MCP TypeScript SDK dependency.
- Added `src/core/mcp-executor.ts` to support MCP stdio and Streamable HTTP bindings, `listTools()` discovery, and `callTool()` execution with structured failed results on connection/configuration/tool errors.
- Updated `ToolRegistry` and `AgentRuntime` so MCP tool execution can run asynchronously during normal and streaming tool loops.
- Added `tool_definitions.workspaceId` and repository APIs for workspace-scoped tool create/update/delete.
- Added HTTP APIs for workspace tool registration and MCP tool discovery.
- Reworked the Workspace UI so tools are added, edited, discovered, and deleted inside the selected workspace rather than selected from a global pool.
- Visually separated system/runtime tools from workspace-registered tools.
- Added an MCP echo server fixture and an end-to-end runtime test proving a workspace MCP tool can execute through stdio.
- Updated `ZLEAP_MASTER_PLAN.md` and `docs/02-workspace-runtime.md` with the workspace-first tool model and real MCP execution contract.

Verification:
- `npm run typecheck` passed.
- `npm test` passed.
- `npm run build` passed.
- In-app browser verification could not complete because Browser Use rejected the localhost action under its URL policy.

Git:
- Pending in this work session.

## 2026-05-31 04:31 +08:00

Purpose:
- Move lifecycle hook logs, tool call logs, approval requests, and LLM request logs out of the Chat context inspector into a dedicated top-level log area, so the Chat right panel stays focused on workspace state and context stack inspection.

Changed:
- Added a fourth top-level Web UI tab: `日志`.
- Added `LogsTab` in `src/web/main.tsx` with current conversation trace loading, global recent LLM request loading, compact LLM debug summary, lifecycle log panel, tool call log panel, approval request panel, and LLM request log panels.
- Added clear actions for the whole visible log view and for each log section. These clear the current UI view rather than deleting persisted audit/debug records.
- Removed lifecycle, tool call, approval, and LLM log sections from the Chat right panel.
- Updated `src/web/styles.css` for the new log page layout.
- Updated `ZLEAP_MASTER_PLAN.md` so the dedicated `日志` tab is part of the project UI contract.

Verification:
- `npm run typecheck` passed.
- `npm test` passed.
- `npm run build` passed.
- Browser verification could not complete because the local server process did not remain reachable at `http://localhost:4173/` after background startup attempts in this environment.

Git:
- Pending in this work session.

## 2026-05-31 04:25 +08:00

Purpose:
- Align the prompt/context contract with the clarified workspace model: runtime strategy belongs in the system prompt, workspace routing information belongs in the main workspace contract, memory is shown as a first-level stack with clear second-level sections, and redundant local workspace/task categories are merged.

Changed:
- Updated `src/core/context-builder.ts` so the primary context stack now uses stable first-level categories: `system`, `workspace`, `memory`, `history`, and `user`, with debug follow-ups for `tool_result` and `final_messages`.
- Merged base system prompt, personality prompt, hidden runtime strategy, and proactive impression-memory write protocol into the single `system` context segment and final OpenAI-compatible system message.
- Moved active workspace description, instructions, manifest, memory policy, and tool definitions into the `workspace` segment; only the main workspace receives the full available-workspace manifest list.
- Replaced separate runtime synthetic tool results for task/history/load with `runtime_context.memory` and `runtime_context.local_conversation`.
- Updated `src/core/attention-budget.ts`, `src/tests/run-tests.ts`, `src/web/main.tsx`, and `src/web/styles.css` for the simplified context stack and second-level UI expansion.
- Updated `ZLEAP_MASTER_PLAN.md`, `docs/02-workspace-runtime.md`, `docs/03-memory-model.md`, and `docs/07-context-and-prompt-contracts.md` so the documentation matches the new contract.

Verification:
- `npm run typecheck` passed.
- `npm test` passed.
- `npm run build` passed.
- Restarted the local server on `http://localhost:4173/` with process id `7456`.
- In-app browser automation could not complete because the Browser tool rejected the localhost navigation/reload request under its URL policy.

Git:
- Recorded by the Git commit that introduced this changelog entry.
- No remote repository is currently configured, so push cannot be performed yet.
