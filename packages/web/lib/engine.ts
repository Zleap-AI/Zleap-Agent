import type { Envelope, ToolApprovalRequest } from './types';
import type { PermissionMode } from './permissions';
import type { RunMode } from './runModes';
import type { ChatImageRequestAttachment } from './chatAttachments';

// The engine contract. This is the exact `ChatDelta` union the CLI's
// `ChatEngine.reply()` already streams (`packages/cli/src/engine.ts`), so the
// real backend hook-up is a drop-in: implement `Engine` over an SSE client and
// swap it for `mockEngine` in `app/page.tsx`. Nothing else changes.

// Context inspector snapshot — mirrors `ContextSnapshot` in the CLI engine. The
// MAIN window's assembled blocks (token-counted by the engine), cache breakpoints, memory
// sources, and compaction state, streamed once per turn for live visualization.
export type ContextBlockKind = 'system' | 'semiStable' | 'variable';
export type ContextBlockCategory = 'system' | 'skill' | 'memory' | 'cache' | 'history';
export type ContextBlockSub =
  | 'sessionPersona'
  | 'persona'
  | 'timeGuidance'
  | 'memoryInstruction'
  | 'spaceCatalog'
  | 'skillGuide'
  | 'listMemory'
  | 'listCache'
  | 'readCache'
  | 'listSkills'
  | 'readSkill'
  | 'workspacePrompt'
  | 'toolGuidance'
  | 'activeSkills'
  | 'suggestedSkills'
  | 'projectSnapshot'
  | 'experiences'
  | 'impressions'
  | 'loopDiscipline'
  | 'items'
  | 'recall'
  | 'messages'
  | 'currentTurn';
export type ContextBlockItem = {
  id?: string;
  role?: string;
  title?: string;
  summary?: string;
  score?: number;
  preview?: string;
  createdAt?: string;
  matchedRecall?: boolean;
  recallScore?: number;
  recallPaths?: string[];
};
export type ContextBlock = {
  kind: ContextBlockKind;
  category: ContextBlockCategory;
  sub: ContextBlockSub;
  label: string;
  storage: string;
  meaning: string;
  placement: 'cachedPrefix' | 'perTurn';
  line?: 'A' | 'B';
  tokens: number;
  text?: string;
  items?: ContextBlockItem[];
  count?: number;
};
export type ContextSnapshot = {
  seq: number;
  createdAt: string;
  model: { id: string; label: string; contextWindow?: number };
  window: { usedTokens: number; contextWindow?: number; ratio?: number };
  blocks: ContextBlock[];
  breakpoints: { after: 'stable' | 'semiStable'; messageIndex: number }[];
  compaction: {
    extractedCount: number;
    itemHistoryActive: boolean;
    triggerTokens: number;
    tailTokens: number;
    foldedMessages: number;
    foldedCharacters?: number;
    summaryTokens: number;
    lastStatus: 'idle' | 'skipped' | 'running' | 'retrying' | 'completed' | 'failed';
    lastError?: string;
    lastCompactedAt?: string;
    summary?: { spaceId: string; xml: string; entryId?: string };
  };
  recall?: {
    query: string;
    hits: { id: string; summary: string; score: number }[];
    coveredHits?: { id: string; summary: string; score: number }[];
  };
  raw: { systemPrompt: string; messages: { role: string; content: string }[] };
};

export type ChatDelta =
  | { type: 'delta'; text: string }
  | { type: 'context'; snapshot: ContextSnapshot }
  | { type: 'context_compaction_start'; spaceId: string; attempt: number; maxAttempts: number }
  | { type: 'context_compaction_retry'; spaceId: string; attempt: number; maxAttempts: number; message?: string }
  | { type: 'context_compaction_done'; spaceId: string; foldedMessages: number; attempts: number }
  | { type: 'context_compaction_failed'; spaceId: string; attempts: number; message: string }
  | { type: 'workspace_context'; workspaceRoot: string }
  | { type: 'message_entries'; userEntryId?: string; assistantEntryIds: string[] }
  | { type: 'tool'; name: string; phase: 'start' | 'end'; detail: string; isError?: boolean; toolCallId?: string }
  | { type: 'needs_approval'; approvalId: string; name: string; args: string; preview?: string; message: string; workspaceId?: string }
  | { type: 'approval_status'; approvalId: string; name: string; args?: string; preview?: string; status: NonNullable<ToolApprovalRequest['status']>; message?: string }
  | { type: 'space'; phase: 'enter'; id: string; label: string; goal?: string; task?: string }
  | { type: 'space_result'; id: string; envelope: Envelope }
  | { type: 'space_message'; id: string; text: string }
  | { type: 'space_status'; id: string; message: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

export type ChatTurn = { role: 'user' | 'assistant'; text: string };

export type Engine = (
  history: ChatTurn[],
  signal: AbortSignal,
  opts: {
    confirm: (request: ToolApprovalRequest) => Promise<boolean>;
    conversationId?: string;
    avatarId?: string;
    projectId?: string;
    modelId?: string;
    permissionMode?: PermissionMode;
    /** Forced dispatch target (an @-mentioned space): main dispatches straight to it. */
    targetSpace?: string;
    runMode?: RunMode;
    skillId?: string;
    skillLabel?: string;
    attachments?: ChatImageRequestAttachment[];
  },
) => AsyncIterable<ChatDelta>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Stream a string as several `delta` chunks to mimic token streaming. */
async function* streamText(text: string, signal: AbortSignal): AsyncIterable<ChatDelta> {
  for (const chunk of text.match(/\S+\s*/g) ?? [text]) {
    if (signal.aborted) {
      return;
    }
    yield { type: 'delta', text: chunk };
    await sleep(28);
  }
}

// A representative diff-shaped result so the diff renderer is exercised. The
// header matches `isDiffResult` (`Updated <path> (+A -R)`).
const SAMPLE_DIFF = [
  'Updated lib/report.ts (+3 -1)',
  '   11 export function buildReport(input: Source[]) {',
  '-  12   return input.map((s) => s.title);',
  '+  12   const ranked = rank(input);',
  '+  13   return ranked.map((s) => `${s.title} — ${s.score}`);',
  '+  14 }',
  '   15 ',
].join('\n');

const SEARCH_RESULT = [
  '50 results',
  '1. report.ts          lib/report.ts          builds the weekly report',
  '2. rank.ts            lib/rank.ts            scores sources by recency',
  '3. sources.ts         lib/sources.ts         connector + delta loaders',
  '4. report.test.ts     test/report.test.ts    snapshot of the report shape',
  '5. README.md          README.md              "## Weekly report" section',
].join('\n');

/**
 * Drives the UI with the same event shapes the real engine emits, on a
 * realistic clock. Walks through several spaces (explore → terminal → session) so
 * the 调度台 tabs + auto-follow are exercised; today the real engine enters one
 * space per run, but the model already supports the chain. Type a prompt
 * containing "error" to exercise the failure path.
 */
export const mockEngine: Engine = async function* mockEngine(history, signal) {
  const last = [...history].reverse().find((turn) => turn.role === 'user');
  const prompt = last?.text ?? '';

  yield* streamText('Let me look at the project and pull together what you asked for.\n\n', signal);
  if (signal.aborted) return;

  // ── Explore space ──────────────────────────────────────────────────────
  yield { type: 'space', phase: 'enter', id: 'explore', label: '' };
  await sleep(280);
  if (signal.aborted) return;

  yield { type: 'tool', phase: 'start', name: 'read', detail: "read(path='lib/report.ts')" };
  await sleep(560);
  if (signal.aborted) return;
  yield {
    type: 'tool',
    phase: 'end',
    name: 'read',
    detail: 'export function buildReport(input: Source[]) {\n  return input.map((s) => s.title);\n}',
  };
  await sleep(220);

  yield { type: 'tool', phase: 'start', name: 'grep', detail: "grep(query='report')" };
  await sleep(620);
  if (signal.aborted) return;
  yield { type: 'tool', phase: 'end', name: 'grep', detail: SEARCH_RESULT };
  yield {
    type: 'space_result',
    id: 'explore',
    envelope: {
      status: 'success',
      summary: 'Located the report pipeline and related source files.',
      content: SEARCH_RESULT,
      references: [],
    },
  };
  await sleep(220);

  if (/error|fail|失败|报错/i.test(prompt)) {
    yield* streamText('Hmm, something looks off while applying the change. ', signal);
    await sleep(160);
    yield { type: 'error', message: 'edit failed: target snippet not found in lib/report.ts' };
    return;
  }

  yield* streamText('Found where the report is built. Switching to the code space to apply the change.\n\n', signal);
  if (signal.aborted) return;

  // ── Terminal space ─────────────────────────────────────────────────────
  yield { type: 'space', phase: 'enter', id: 'terminal', label: '' };
  await sleep(300);
  if (signal.aborted) return;
  yield { type: 'tool', phase: 'start', name: 'edit', detail: "edit(path='lib/report.ts')" };
  await sleep(700);
  if (signal.aborted) return;
  yield { type: 'tool', phase: 'end', name: 'edit', detail: SAMPLE_DIFF };
  yield {
    type: 'space_result',
    id: 'terminal',
    envelope: {
      status: 'success',
      summary: 'Updated report ranking logic in lib/report.ts.',
      content: SAMPLE_DIFF,
      references: [],
    },
  };
  await sleep(280);

  // ── Session space ──────────────────────────────────────────────────────
  yield { type: 'space', phase: 'enter', id: 'session', label: '' };
  await sleep(260);
  if (signal.aborted) return;
  yield* streamText(
    'Done. I ranked the sources and enriched each report row with its score. ' +
      'The change is in `lib/report.ts` — want me to add a test next?',
    signal,
  );

  yield { type: 'done' };
};
