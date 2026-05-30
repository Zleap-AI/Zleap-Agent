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
