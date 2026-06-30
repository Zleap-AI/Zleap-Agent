import type {
  ActorContext,
  AgentNote,
  MemoryOrchestrator,
  MemoryScopeContext,
  PeopleReconcileDecision,
  RecordFragmentMessage,
  RecordRef,
  ScheduledTaskRecord,
  SessionEntryRecord,
  ThreadRecord,
} from '@zleap/core';
import type { ZleapStore } from '@zleap/store';
import { truncate } from './util/text.js';

export const MEMORY_DREAM_TASK_TYPE = 'memory_dream';
export const MEMORY_DREAM_TASK_ID_PREFIX = 'memory-dream';
export const MEMORY_DREAM_DEFAULT_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const MEMORY_DREAM_DEFAULT_MIN_SESSIONS = 3;
export const MEMORY_DREAM_DEFAULT_MIN_TOOL_EVENTS = 20;
export const MEMORY_DREAM_DEFAULT_MAX_SESSIONS = 20;
export const MEMORY_DREAM_DEFAULT_MAX_SESSION_ENTRIES = 160;
export const MEMORY_DREAM_DEFAULT_STALE_RUN_MS = 30 * 60 * 1000;
export const MEMORY_DREAM_MIN_CONFIDENCE = 0.65;

export type DreamMemoryItem = {
  memory: string;
  confidence?: number;
  keywords?: string[];
};

export type MemoryDreamExtraction = {
  experiences: DreamMemoryItem[];
  peopleActions?: DreamPeopleAction[];
};

export type DreamPeopleAction = PeopleReconcileDecision;

export type MemoryDreamPayload = {
  agentId: string;
  userId?: string;
  tenantId?: string;
  windowStart?: string;
  windowEnd: string;
  existingPeople: Array<{ id: string; about: 'user' | 'agent'; memory: string; createdAt: string }>;
  existingExperiences: Array<{ id: string; memory: string; createdAt: string }>;
  sessions: DreamSessionPayload[];
};

export type DreamSessionPayload = {
  threadId: string;
  sessionId: string;
  spaceId: string;
  conversationId?: string;
  updatedAt: string;
  toolEvents: number;
  messages: RecordFragmentMessage[];
};

export type MemoryDreamConfig = {
  minIntervalMs?: number;
  minSessions?: number;
  minToolEvents?: number;
  maxSessions?: number;
  maxSessionEntries?: number;
  staleRunMs?: number;
  now?: Date;
};

export type MemoryDreamResult = {
  status: 'skipped' | 'completed' | 'failed';
  reason?: string;
  runId?: string;
  taskId?: string;
  wrote?: {
    person: number;
    event: number;
    experience: number;
  };
};

export type RunLazyMemoryDreamInput = {
  store: ZleapStore;
  orchestrator: MemoryOrchestrator;
  agentId: string;
  actor?: ActorContext;
  extract: (payload: MemoryDreamPayload) => Promise<MemoryDreamExtraction>;
  config?: MemoryDreamConfig;
};

type DreamSession = DreamSessionPayload & {
  thread: ThreadRecord;
  completed: boolean;
};

export async function runLazyMemoryDream(input: RunLazyMemoryDreamInput): Promise<MemoryDreamResult> {
  if (!hasTaskStore(input.store)) {
    return { status: 'skipped', reason: 'task_store_unavailable' };
  }

  const now = input.config?.now ?? new Date();
  const owner = input.actor ? { userId: input.actor.userId, tenantId: input.actor.tenantId } : undefined;
  const task = await ensureDreamTask(input.store, input.agentId, input.actor, now);
  const staleSeconds = Math.ceil((input.config?.staleRunMs ?? MEMORY_DREAM_DEFAULT_STALE_RUN_MS) / 1000);
  await input.store.tasks.reclaimStaleRuns(staleSeconds).catch(() => 0);

  const recentRuns = await input.store.tasks.listRuns({ taskId: task.id, ...(owner ?? {}), limit: 10 });
  if (recentRuns.some((run) => run.status === 'queued' || run.status === 'running')) {
    return { status: 'skipped', reason: 'dream_already_running', taskId: task.id };
  }

  const lastCompleted = recentRuns.find((run) => run.status === 'completed' && run.finishedAt);
  const minInterval = input.config?.minIntervalMs ?? MEMORY_DREAM_DEFAULT_MIN_INTERVAL_MS;
  if (lastCompleted?.finishedAt && now.getTime() - lastCompleted.finishedAt.getTime() < minInterval) {
    return { status: 'skipped', reason: 'dream_not_due', taskId: task.id };
  }

  const since = lastCompleted?.finishedAt;
  const sessions = await collectDreamSessions(input.store, {
    agentId: input.agentId,
    actor: input.actor,
    since,
    maxSessions: input.config?.maxSessions ?? MEMORY_DREAM_DEFAULT_MAX_SESSIONS,
    maxSessionEntries: input.config?.maxSessionEntries ?? MEMORY_DREAM_DEFAULT_MAX_SESSION_ENTRIES,
  });
  const completed = sessions.filter((session) => session.completed);
  const toolEvents = completed.reduce((sum, session) => sum + session.toolEvents, 0);
  const minSessions = input.config?.minSessions ?? MEMORY_DREAM_DEFAULT_MIN_SESSIONS;
  const minToolEvents = input.config?.minToolEvents ?? MEMORY_DREAM_DEFAULT_MIN_TOOL_EVENTS;
  if (completed.length < minSessions && toolEvents < minToolEvents) {
    return { status: 'skipped', reason: 'not_enough_completed_work', taskId: task.id };
  }

  const baseRunId = memoryDreamRunId(input.agentId, input.actor, now);
  let runId = baseRunId;
  const runInput = {
    taskId: task.id,
    trigger: 'scheduled' as const,
    status: 'running' as const,
    scheduledFor: now,
    startedAt: now,
    metadata: {
      kind: MEMORY_DREAM_TASK_TYPE,
      agentId: input.agentId,
      userId: input.actor?.userId,
      tenantId: input.actor?.tenantId,
      windowStart: since?.toISOString(),
      windowEnd: now.toISOString(),
      inputSessionIds: completed.map((session) => session.sessionId),
    },
  };
  try {
    await input.store.tasks.createRun({ id: runId, ...runInput });
  } catch {
    const existing = await input.store.tasks.getRun(baseRunId).catch(() => undefined);
    if (!existing || existing.status === 'queued' || existing.status === 'running' || existing.status === 'completed') {
      return { status: 'skipped', reason: 'dream_run_exists', taskId: task.id, runId };
    }
    runId = `${baseRunId}:${now.getTime()}`;
    try {
      await input.store.tasks.createRun({ id: runId, ...runInput });
    } catch {
      return { status: 'skipped', reason: 'dream_run_exists', taskId: task.id, runId };
    }
  }

  try {
    const wrote = await applyDream({
      ...input,
      runId,
      now,
      since,
      sessions: completed,
    });
    await input.store.tasks.updateRun(runId, {
      status: 'completed',
      finishedAt: new Date(),
      summary: `Dream wrote ${wrote.person} person, ${wrote.event} event, ${wrote.experience} experience memories.`,
      metadata: {
        kind: MEMORY_DREAM_TASK_TYPE,
        agentId: input.agentId,
        userId: input.actor?.userId,
        tenantId: input.actor?.tenantId,
        windowStart: since?.toISOString(),
        windowEnd: now.toISOString(),
        inputSessionIds: completed.map((session) => session.sessionId),
        wrote,
      },
    });
    return { status: 'completed', taskId: task.id, runId, wrote };
  } catch (error) {
    await input.store.tasks.updateRun(runId, {
      status: 'failed',
      finishedAt: new Date(),
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error), taskId: task.id, runId };
  }
}

export function parseMemoryDreamExtraction(raw: string): MemoryDreamExtraction {
  const object = parseJsonObject(raw);
  if (!isRecord(object)) {
    return emptyExtraction();
  }
  return {
    experiences: parseDreamItems(object.experiences),
    peopleActions: parsePeopleActions(object.peopleActions),
  };
}

async function applyDream(input: RunLazyMemoryDreamInput & {
  runId: string;
  now: Date;
  since?: Date;
  sessions: DreamSession[];
}): Promise<{ person: number; event: number; experience: number }> {
  const baseScope: MemoryScopeContext = {
    agentId: input.agentId,
    userId: input.actor?.userId,
    actorRole: input.actor?.role,
    tenantId: input.actor?.tenantId,
    spaceId: 'session',
    threadId: `dream:${input.runId}`,
  };
  const [context, existingPeople] = await Promise.all([
    input.orchestrator.prepareContext(baseScope).catch(() => ({
    impressions: [] as AgentNote[],
    experiences: [] as RecordRef[],
    recentRecords: [] as RecordRef[],
    })),
    input.orchestrator.listPeopleForReconcile(baseScope, 100).catch(() => [] as AgentNote[]),
  ]);
  const payload: MemoryDreamPayload = {
    agentId: input.agentId,
    userId: input.actor?.userId,
    tenantId: input.actor?.tenantId,
    windowStart: input.since?.toISOString(),
    windowEnd: input.now.toISOString(),
    existingPeople: existingPeople.map((note) => ({
      id: note.id,
      about: note.subject === 'agent' ? 'agent' : 'user',
      memory: note.memory,
      createdAt: note.createdAt.toISOString(),
    })),
    existingExperiences: context.experiences.map((memory) => ({
      id: memory.id,
      memory: memory.memory,
      createdAt: memory.createdAt.toISOString(),
    })),
    sessions: input.sessions.map(({ thread, completed, ...session }) => session),
  };
  const extraction = await input.extract(payload);
  let person = 0;
  let experience = 0;

  for (const action of (extraction.peopleActions ?? []).filter(shouldApplyPeopleAction)) {
    const note = await input.orchestrator.applyPeopleReconcileDecision(action, baseScope, existingPeople);
    if (note) {
      person += 1;
      const index = existingPeople.findIndex((existing) => existing.id === note.id);
      if (index >= 0) existingPeople[index] = note;
      else existingPeople.unshift(note);
    }
  }

  for (const item of extraction.experiences.filter(shouldWriteExperience)) {
    try {
      await input.orchestrator.remember({
        kind: 'experience',
        about: 'user',
        memory: item.memory,
      }, baseScope);
      experience += 1;
    } catch (error) {
      if (isExperienceMemoryRejected(error)) {
        continue;
      }
      throw error;
    }
  }

  let event = 0;
  for (const session of input.sessions) {
    const refs = await input.orchestrator.onPreCompaction(session.messages, {
      agentId: input.agentId,
      userId: input.actor?.userId,
      tenantId: input.actor?.tenantId,
      spaceId: session.spaceId,
      threadId: session.threadId,
    });
    event += refs.length;
  }

  return { person, event, experience };
}

async function ensureDreamTask(store: ZleapStore, agentId: string, actor: ActorContext | undefined, now: Date): Promise<ScheduledTaskRecord> {
  const tasks = await store.tasks.listTasks({ userId: actor?.userId, tenantId: actor?.tenantId, includeDeleted: false, limit: 500 });
  const existing = tasks.find((task) => task.avatarId === agentId && task.type === MEMORY_DREAM_TASK_TYPE);
  if (existing) {
    return existing;
  }
  try {
    return await store.tasks.createTask({
      id: memoryDreamTaskId(agentId, actor),
      userId: actor?.userId,
      tenantId: actor?.tenantId,
      avatarId: agentId,
      permissionMode: 'full_access',
      name: 'Memory Dream',
      type: MEMORY_DREAM_TASK_TYPE,
      prompt: 'Automatically consolidate durable memory.',
      payload: { mode: 'lazy' },
      cron: '0 3 * * *',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
  } catch {
    const raced = await store.tasks.listTasks({ userId: actor?.userId, tenantId: actor?.tenantId, includeDeleted: false, limit: 500 });
    const existingAfterRace = raced.find((task) => task.avatarId === agentId && task.type === MEMORY_DREAM_TASK_TYPE);
    if (existingAfterRace) {
      return existingAfterRace;
    }
    throw new Error('memory dream task could not be created');
  }
}

async function collectDreamSessions(store: ZleapStore, input: {
  agentId: string;
  actor?: ActorContext;
  since?: Date;
  maxSessions: number;
  maxSessionEntries: number;
}): Promise<DreamSession[]> {
  const owner = input.actor ? { userId: input.actor.userId, tenantId: input.actor.tenantId } : {};
  const threads = await store.threads.listThreads({ avatarId: input.agentId, status: 'active', ...owner, limit: input.maxSessions * 3 });
  const sessions: DreamSession[] = [];
  for (const thread of threads) {
    if (input.since && thread.updatedAt <= input.since) {
      continue;
    }
    await appendDreamSession(store, sessions, {
      thread,
      sessionId: thread.mainSessionId ?? `${thread.id}:main`,
      spaceId: 'session',
      owner,
      maxSessionEntries: input.maxSessionEntries,
    });
    const listSessions = (store.sessions as unknown as {
      listSessions?: ZleapStore['sessions']['listSessions'];
    }).listSessions;
    const workSessions = typeof listSessions === 'function'
      ? await listSessions.call(store.sessions, { threadId: thread.id, ...owner, kind: 'work', status: 'completed', limit: 20 }).catch(() => [])
      : [];
    for (const workSession of workSessions) {
      await appendDreamSession(store, sessions, {
        thread,
        sessionId: workSession.id,
        spaceId: workSession.spaceId,
        owner,
        maxSessionEntries: input.maxSessionEntries,
      });
      if (sessions.length >= input.maxSessions) {
        break;
      }
    }
    if (sessions.length >= input.maxSessions) {
      break;
    }
  }
  return sessions;
}

async function appendDreamSession(store: ZleapStore, out: DreamSession[], input: {
  thread: ThreadRecord;
  sessionId: string;
  spaceId: string;
  owner: { userId?: string; tenantId?: string };
  maxSessionEntries: number;
}): Promise<void> {
  const entries = await store.sessions.listEntries({ sessionId: input.sessionId, ...input.owner, limit: input.maxSessionEntries });
  const sanitized = sanitizeSessionEntries(entries);
  if (sanitized.messages.length === 0) {
    return;
  }
  out.push({
    thread: input.thread,
    threadId: input.thread.id,
    sessionId: input.sessionId,
    spaceId: input.spaceId,
    conversationId: stringField(input.thread.metadata, 'conversationId') ?? input.thread.id,
    updatedAt: input.thread.updatedAt.toISOString(),
    toolEvents: sanitized.toolEvents,
    messages: sanitized.messages,
    completed: sanitized.completed,
  });
}

function sanitizeSessionEntries(entries: SessionEntryRecord[]): {
  messages: RecordFragmentMessage[];
  toolEvents: number;
  completed: boolean;
} {
  const messages: RecordFragmentMessage[] = [];
  let sawUser = false;
  let sawAssistantAfterUser = false;
  let toolEvents = 0;
  for (const entry of entries) {
    if (entry.deletedAt) {
      continue;
    }
    if (entry.type === 'message' && (entry.role === 'user' || entry.role === 'assistant')) {
      const content = cleanText(entry.content, 1_200);
      if (!content) continue;
      if (entry.role === 'user') {
        sawUser = true;
      } else if (sawUser) {
        sawAssistantAfterUser = true;
      }
      messages.push({ id: entry.id, role: entry.role, content });
      continue;
    }
    if (entry.type === 'tool_call' || entry.type === 'tool_result') {
      toolEvents += 1;
      const projection = toolProjection(entry);
      if (projection) {
        messages.push({ id: entry.id, role: 'system', content: projection });
      }
    }
  }
  return { messages, toolEvents, completed: sawUser && sawAssistantAfterUser };
}

function toolProjection(entry: SessionEntryRecord): string | undefined {
  const toolName = stringField(entry.data, 'toolName') ?? stringField(entry.data, 'toolId') ?? 'tool';
  if (entry.type === 'tool_call') {
    return `[tool_call] ${toolName} requested`;
  }
  const failed = booleanField(entry.data, 'isError') || Boolean(stringField(entry.data, 'error'));
  return `[tool_result] ${toolName} ${failed ? 'failed' : 'completed'}`;
}

function shouldWriteItem(item: DreamMemoryItem): boolean {
  return (item.confidence ?? 1) >= MEMORY_DREAM_MIN_CONFIDENCE;
}

function shouldWriteExperience(item: DreamMemoryItem): boolean {
  return shouldWriteItem(item);
}

function shouldApplyPeopleAction(action: DreamPeopleAction): boolean {
  if (action.action === 'skip') return true;
  if (action.action === 'archive_profile') return Boolean(action.targetId);
  if ((action.confidence ?? 1) < MEMORY_DREAM_MIN_CONFIDENCE) return false;
  if (action.action === 'update_profile') {
    return Boolean(action.targetId);
  }
  return Boolean(action.memory.trim());
}

function isExperienceMemoryRejected(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'experience_memory_rejected');
}

function parseDreamItems(input: unknown): DreamMemoryItem[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const out: DreamMemoryItem[] = [];
  for (const item of input.slice(0, 20)) {
    if (!isRecord(item)) continue;
    const memory = cleanText(item.memory, 1_200);
    if (!memory) continue;
    out.push({
      memory,
      confidence: boundedNumber(item.confidence),
      keywords: stringArray(item.keywords, 12),
    });
  }
  return out;
}

function parsePeopleActions(input: unknown): DreamPeopleAction[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const out: DreamPeopleAction[] = [];
  for (const item of input.slice(0, 100)) {
    if (!isRecord(item)) continue;
    const action = parsePeopleAction(item.action);
    if (!action) continue;
    const targetId = cleanText(item.targetId, 160);
    const memory = cleanText(item.memory, 1_200);
    const about = item.about === 'agent' ? 'agent' : item.about === 'user' ? 'user' : undefined;
    const confidence = boundedNumber(item.confidence);
    const parsed: DreamPeopleAction | undefined =
      action === 'skip'
        ? { action: 'skip' }
        : action === 'archive_profile'
          ? targetId ? { action: 'archive_profile', targetId } : undefined
          : action === 'update_profile'
            ? targetId && memory ? { action: 'update_profile', targetId, about, memory, confidence } : undefined
            : memory ? { action: 'keep_both', about, memory, confidence } : undefined;
    if (parsed && shouldApplyPeopleAction(parsed)) {
      out.push(parsed);
    }
  }
  return out;
}

function parsePeopleAction(value: unknown): DreamPeopleAction['action'] | undefined {
  return value === 'skip' ||
    value === 'update_profile' ||
    value === 'archive_profile' ||
    value === 'keep_both'
    ? value
    : undefined;
}

function memoryDreamTaskId(agentId: string, actor?: ActorContext): string {
  return [MEMORY_DREAM_TASK_ID_PREFIX, safeId(agentId), safeId(actor?.userId ?? 'global')].join(':');
}

function memoryDreamRunId(agentId: string, actor: ActorContext | undefined, now: Date): string {
  return [memoryDreamTaskId(agentId, actor), now.toISOString().slice(0, 10)].join(':');
}

function hasTaskStore(store: ZleapStore): boolean {
  const tasks = (store as unknown as { tasks?: Record<string, unknown> }).tasks;
  return Boolean(
    tasks &&
      typeof tasks.listTasks === 'function' &&
      typeof tasks.createTask === 'function' &&
      typeof tasks.createRun === 'function' &&
      typeof tasks.updateRun === 'function' &&
      typeof tasks.getRun === 'function' &&
      typeof tasks.listRuns === 'function' &&
      typeof tasks.reclaimStaleRuns === 'function',
  );
}

function emptyExtraction(): MemoryDreamExtraction {
  return { experiences: [], peopleActions: [] };
}

function parseJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    if (start < 0 || end <= start) return undefined;
    try {
      return JSON.parse(unfenced.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const text = value.trim().replace(/\s+/g, ' ');
  return text ? truncate(text, max) : undefined;
}

function stringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.flatMap((item) => {
    const text = cleanText(item, 80);
    return text ? [text] : [];
  }))].slice(0, limit);
}

function boundedNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.min(1, value));
}

function stringField(value: unknown, field: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const raw = value[field];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

function booleanField(value: unknown, field: string): boolean {
  return isRecord(value) && value[field] === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]+/g, '_').slice(0, 80);
}
