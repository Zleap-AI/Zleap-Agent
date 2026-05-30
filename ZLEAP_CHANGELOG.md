# Zleap Change Log

This file records meaningful project changes with local timestamps so future work can be traced alongside Git history.

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
