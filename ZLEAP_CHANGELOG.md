# Zleap Change Log

This file records meaningful project changes with local timestamps so future work can be traced alongside Git history.

## 2026-05-31 08:52 +08:00

Purpose:
- Reduce information loss during workspace switching by adding runtime-controlled result handoff context, and stabilize user-facing reply language.

Changed:
- Added `WorkspaceHandoffContext` to workspace local context.
- When entering a child workspace, runtime now carries only the current user request, workspace-entry result, and bounded parent result evidence instead of unrelated global history.
- When returning to main, runtime now carries the full child `WorkspaceResult`, the child workspace's final assistant context, and key tool results; tool-call parameters and long intermediate process logs stay in trace/debug storage.
- Updated the hidden runtime prompt so main must treat child handoff results as authoritative and must not casually re-summarize away or omit key facts.
- Added a system-level language rule: user-facing replies follow the user's current message language unless the user asks for translation or another language.
- Updated the master plan and context/workspace docs with the software handoff model: transfer the finished result, not the full editing history.
- Added tests proving handoff context exists in child/main transitions while excluding `tool_call` process items, and tests for the language rule in the system prompt.

Verification:
- `npm run typecheck` passed.
- `npm test` passed.
- `npm run build` passed.
- Restarted the local Web UI server at `http://localhost:4173/`; `/api/health` returned `{ "ok": true }`.

Git:
- Recorded by the Git commit titled `feat: add workspace handoff context`.

## 2026-05-31 08:27 +08:00

Purpose:
- Make existing and cached function-call/tool-result process messages show concrete parameters and result summaries instead of tool names only.

Changed:
- Updated `src/web/main.tsx` to reconstruct process preview items from the associated LLM response and `tool_calls` trace logs when cached messages do not already include structured process items.
- Added argument/result summarizers for common tool payloads such as search queries, shell commands, stdout, summaries, snippets, and errors.
- Updated process previews/details to use reconstructed items so collapsed rows can show what `metasoSearch` searched for and what each tool roughly returned.
- Updated `ZLEAP_MASTER_PLAN.md` with the fallback trace reconstruction requirement for older cached process messages.

Verification:
- `npm run typecheck` passed.
- `npm test` passed.
- `npm run build` passed.
- Restarted the local Web server on `http://localhost:4173/`; `/api/health` returned `{"ok": true}`.

Git:
- Recorded in the Git commit titled `fix: recover process event details`.

## 2026-05-31 08:23 +08:00

Purpose:
- Remove horizontal scrolling from the Chat context inspector raw LLM log view.

Changed:
- Updated `src/web/styles.css` so raw `final_messages` logs use automatic wrapping, break long tokens, and hide horizontal overflow.
- Updated `ZLEAP_MASTER_PLAN.md`, `docs/07-context-and-prompt-contracts.md`, `docs/README.md`, and `zleap-agent-framework.md` to record that raw provider logs must wrap within the panel instead of using X-axis scrolling.

Verification:
- `npm run typecheck` passed.
- `npm test` passed.
- `npm run build` passed.
- Restarted the local Web server on `http://localhost:4173/`; `/api/health` returned `{"ok": true}`.

Git:
- Recorded in the Git commit titled `fix: wrap raw llm logs`.

## 2026-05-31 08:19 +08:00

Purpose:
- Make function-call and tool-result process messages readable at a glance and keep call parameters separate from returned results.

Changed:
- Added structured process items to streamed workspace/tool events so tool calls carry `argumentsJson` and tool results carry `resultJson`.
- Updated Chat process blocks to show one-line tool call/result summaries even while collapsed.
- Updated expanded process details so function-call blocks show actual parameters and tool-result blocks show actual returned results.
- Updated `ZLEAP_MASTER_PLAN.md` with the expected process-message display contract.

Verification:
- `npm run typecheck` passed.
- `npm test` passed.
- `npm run build` passed.
- Restarted the local Web server on `http://localhost:4173/`; `/api/health` returned `{"ok": true}`.

Git:
- Recorded in the Git commit titled `fix: summarize process tool events`.

## 2026-05-31 08:14 +08:00

Purpose:
- Fix the Chat context inspector raw-log UI so raw mode shows only the original LLM messages log directly, instead of showing the numbered context stack or requiring another expand click.

Changed:
- Updated `src/web/main.tsx` so structured mode shows the numbered context stack without `final_messages`, while raw-log mode hides that stack and renders only the saved `final_messages` content in a direct raw text view.
- Updated `src/web/styles.css` for the direct raw log panel.
- Updated `ZLEAP_MASTER_PLAN.md`, `docs/07-context-and-prompt-contracts.md`, `docs/README.md`, and `zleap-agent-framework.md` to clarify that raw provider-log mode hides the structured stack and directly displays `final_messages`.

Verification:
- `npm run typecheck` passed.
- `npm test` passed.
- `npm run build` passed.
- Restarted the local Web server on `http://localhost:4173/`; `/api/health` returned `{"ok": true}`.

Git:
- Recorded in the Git commit titled `fix: show raw llm log directly`.

## 2026-05-31 08:06 +08:00

Purpose:
- Fix Chat context inspection so clicking a user message shows that message's own clean user input instead of a stale/earlier turn such as `我是谁`.

Changed:
- Updated `src/web/main.tsx` so user messages prefer their own saved `turnOutput.contextSegments[0].llmCallId` over cached `inspectLlmCallId`.
- Cleared stale selected LLM call state when sending a new message.
- Changed stream completion binding to derive the current turn's first call from `payload.output.contextSegments`, then select only LLM calls from that point forward for the assistant's final-call binding.
- Added `llmCallId` to streamed workspace/process events and persisted it onto visible workspace/process chat messages, so model-initiated intermediate replies can inspect the exact LLM call that produced them.
- Updated assistant-message fallback binding so a final assistant reply resolves to the final LLM call of its own current turn, while intermediate model-generated workspace messages use their streamed `llmCallId`.
- Updated `ZLEAP_MASTER_PLAN.md` to record that user messages bind to their own sent-turn context and AI replies bind to the concrete model call that produced that visible response, including model-initiated multi-round calls.

Verification:
- `npm run typecheck` passed.
- `npm test` passed.
- `npm run build` passed.
- Restarted the local Web server on `http://localhost:4173/`; `/api/health` returned `{"ok": true}`.

Git:
- Recorded in the Git commit titled `fix: bind chat context to current turn`.

## 2026-05-31 07:56 +08:00

Purpose:
- Change the Chat context inspector raw-log behavior so `显示原始日志` switches the whole context stack into raw text mode instead of appending a separate raw-log block.

Changed:
- Updated `src/web/main.tsx` so the context stack uses one displayed segment list: structured mode hides `final_messages`, while raw mode shows the full inspected stack and renders each segment as raw text.
- Added a raw stack renderer and `raw-json` styling so raw mode displays direct JSON/text rather than structured JSON tables.
- Updated `ZLEAP_MASTER_PLAN.md`, `docs/07-context-and-prompt-contracts.md`, `docs/README.md`, and `zleap-agent-framework.md` to make the raw-log toggle behavior part of the design contract.

Verification:
- `npm run typecheck` passed.
- `npm test` passed.
- `npm run build` passed.
- Restarted the local Web server on `http://localhost:4173/`; `/api/health` returned `{"ok": true}`.

Git:
- Recorded in the Git commit titled `fix: toggle raw context stack`.

## 2026-05-31 07:50 +08:00

Purpose:
- Fix prompt assembly boundaries and guard current-user impression recall.

Changed:
- Changed prompt assembly so the system message contains only system/personality/runtime policy text.
- Moved workspace manifest/context injection from the system message into a synthetic `runtime_context.workspace` tool result.
- Kept memory and local conversation as synthetic tool results, and kept callable schemas only in the OpenAI-compatible top-level `tools` request array.
- Added tests proving the system message no longer includes `## Callable Tools`, `toolCount`, or workspace JSON, while the workspace manifest is still visible through `runtime_context.workspace`.
- Added recall coverage proving current-user impressions and current-agent self impressions are both injected, while other users' impressions are excluded.
- Updated master/context/concept docs with the corrected prompt assembly boundary.

Verification:
- `npm run typecheck` passed.
- `npm test` passed.
- `npm run build` passed.

Git:
- Recorded by the Git commit titled `feat: add progressive skill disclosure`.

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
- Recorded in commit `6f67690 fix: show skill disclosure in context`.

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

## 2026-05-31 09:02 +08:00

Purpose:
- Clarify whether Skill progressive disclosure is actually injected into the context stack and make the UI show that state directly.

Changed:
- Verified against the local SQLite trace that child workspace LLM calls can contain `currentWorkspaceSkillMemory` with `summary_only` and `readSkill`, while `main` calls may correctly show zero workspace-scoped Skill records.
- Added a structured memory-context renderer in the Chat right panel.
- Made the Skill memory section show the injected Skill title/summary, disclosure mode, `readSkill` tool hint, relation id, confidence, and id without requiring raw JSON reading.
- Added an empty-state explanation for Skill memory when the selected LLM call has no active-workspace Skill recall.
- Updated `ZLEAP_MASTER_PLAN.md` so context-stack Skill disclosure visibility is part of the UI contract.

Verification:
- `npm run typecheck` passed.
- `npm test` passed.
- `npm run build` passed.
- `/api/health` returned `{ "ok": true }` on `http://localhost:4173/`.

Git:
- Pending in this work session.

## 2026-05-31 08:39 +08:00

Purpose:
- Implement progressive Skill memory disclosure so the prompt sees recent Skill names/summaries first, and the agent reads full Skill details only when a Skill is clearly relevant to the current task.

Changed:
- Added the runtime memory tool `readSkill`, registered into every workspace beside `searchMemory`, impression writes, and `writeSkillMemory`.
- Changed Skill recall to load recent active-workspace Skill summaries without FTS filtering, and changed prompt projection so Skill detail/procedure are not automatically injected.
- Updated the hidden runtime prompt to teach the agent when to call `readSkill`, and tightened `writeSkillMemory` guidance around concrete reusable procedures, failure recovery, verified tool flows, and non-vague lessons.
- Strengthened Skill quality gates and hook extraction so low-confidence or vague Skill records are rejected, while concrete search/inspect/edit/tool workflows remain valid.
- Updated the concept tab and concept/master docs to explain progressive Skill disclosure and the stricter Skill generation standard.
- Added tests for `readSkill` schema/binding/scope isolation and for summary-only Skill prompt injection.

Verification:
- `npm run typecheck` passed.
- `npm test` passed.
- `npm run build` passed.
- Restarted the local Web UI server at `http://localhost:4173/`; `/api/health` returned `{ "ok": true }`.

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
