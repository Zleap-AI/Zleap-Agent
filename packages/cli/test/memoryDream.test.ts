import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AVATAR_ID,
  MemoryOrchestrator,
  type ActorContext,
  type ScheduledTaskRecord,
  type ScheduledTaskRunRecord,
  type SessionEntryRecord,
  type ThreadRecord,
} from '@zleap/core';
import { createRecordMemoryPort, type CoreExtractor, type ZleapStore } from '@zleap/store';
import { fauxEmbed } from '@zleap/ai';
import { FakeCoreStore, FakeNoteStore } from './helpers/memoryDoubles.js';
import { runLazyMemoryDream, type MemoryDreamExtraction } from '@zleap/agent';

const actor: ActorContext = { userId: 'user-1', role: 'user', tenantId: 'tenant-1' };

describe('lazy memory dream', () => {
  it('auto-writes person, event, and experience lanes from sanitized completed sessions', async () => {
    const capturedEventInputs: string[] = [];
    const store = dreamStore({
      sessions: [
        completedThread('thread-1', '用户喜欢直接给结论', '已记住沟通偏好'),
        completedThread('thread-2', '修复公共 API 限流问题', '通过串行请求和缓存解决'),
        completedThread('thread-3', '处理 loading 状态卡住', '在 finally 中关闭 loading'),
      ],
      workSessions: [
        completedWorkSession('thread-2', 'terminal', '终端空间修复 fetch 重试', '已完成代码修改'),
      ],
      eventExtractor: async (input) => {
        capturedEventInputs.push(JSON.stringify(input.messages));
        const user = input.messages.find((message) => message.role === 'user');
        return user ? [{
          memory: `事项: ${user.content}`,
          workKind: 'result',
          keywords: ['dream', 'result'],
          confidence: 0.9,
          messageIds: user.id ? [user.id] : undefined,
        }] : [];
      },
    });
    const extraction: MemoryDreamExtraction = {
      peopleActions: [
        { action: 'keep_both', about: 'agent', memory: '称呼偏好: 在当前用户面前保持简洁直接。', confidence: 0.9 },
        { action: 'keep_both', about: 'user', memory: '沟通偏好: 用户偏好中文、简洁、可执行的结论。', confidence: 0.9 },
      ],
      experiences: [{
        memory: 'Mobvista 境内主体调研 SOP：面向境外上市科技公司（如 Mobvista）的境内主体调研 SOP：校验广州汇量信息科技有限公司工商全称，再绘制业务链路。',
        confidence: 0.9,
      }, {
        memory: '公共 API 限流恢复流程：遇到免费公共 API 限流时，先降并发为串行请求，再加入指数退避和本地缓存，最后验证失败路径不会卡住界面。',
        confidence: 0.9,
      }],
    };

    const result = await runLazyMemoryDream({
      store,
      orchestrator: store.orchestrator,
      agentId: DEFAULT_AVATAR_ID,
      actor,
      extract: async () => extraction,
      config: {
        now: new Date('2026-06-18T03:00:00.000Z'),
        minIntervalMs: 1,
        minSessions: 3,
        minToolEvents: 99,
      },
    });

    expect(result.status).toBe('completed');
    expect(result.wrote).toEqual({ person: 2, event: 4, experience: 1 });
    expect(store.notes.rows.map((note) => [note.subject, note.memory])).toEqual(
      expect.arrayContaining([
        ['agent', '称呼偏好: 在当前用户面前保持简洁直接。'],
        ['user', '沟通偏好: 用户偏好中文、简洁、可执行的结论。'],
      ]),
    );
    expect(store.core.sources.map((source) => source.kind)).toEqual(expect.arrayContaining(['work', 'experience']));
    expect(store.core.sources).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'work', spaceId: 'terminal' })]));
    expect(JSON.stringify(store.core.events)).not.toContain('Mobvista');
    expect(JSON.stringify(store.core.events)).not.toContain('广州汇量信息科技有限公司');
    expect(JSON.stringify(store.core.events)).toContain('公共 API 限流恢复流程');
    expect(JSON.stringify(store.core.events)).toContain('指数退避');
    expect(capturedEventInputs.join('\n')).toContain('[tool_result] read completed');
    expect(capturedEventInputs.join('\n')).not.toContain('SECRET_TOKEN=abc');
  });

  it('passes latest 100 people profiles into the dream extraction payload', async () => {
    const store = dreamStore({
      sessions: [
        completedThread('thread-1', '任务一', '完成一'),
        completedThread('thread-2', '任务二', '完成二'),
        completedThread('thread-3', '任务三', '完成三'),
      ],
    });
    for (let i = 0; i < 105; i += 1) {
      await store.notes.write({
        kind: 'impression',
        scope: { agentId: DEFAULT_AVATAR_ID, userId: actor.userId },
        subject: 'user',
        memory: `profile ${i}: content ${i}`,
      }, 200);
    }

    const result = await runLazyMemoryDream({
      store,
      orchestrator: store.orchestrator,
      agentId: DEFAULT_AVATAR_ID,
      actor,
      extract: async (payload) => {
        expect(payload.existingPeople).toHaveLength(100);
        expect(payload.existingPeople[0]).toMatchObject({ about: 'user', memory: 'profile 104: content 104' });
        expect(payload.existingPeople.map((note) => note.memory)).not.toContain('profile 0: content 0');
        return { experiences: [], peopleActions: [] };
      },
      config: {
        now: new Date('2026-06-18T04:00:00.000Z'),
        minIntervalMs: 1,
        minSessions: 3,
        minToolEvents: 99,
      },
    });

    expect(result.status).toBe('completed');
  });

  it('applies peopleActions to update, archive, add, and skip invalid profile targets', async () => {
    const store = dreamStore({
      sessions: [
        completedThread('thread-1', '任务一', '完成一'),
        completedThread('thread-2', '任务二', '完成二'),
        completedThread('thread-3', '任务三', '完成三'),
      ],
    });
    const toUpdate = await store.notes.write({
      kind: 'impression',
      scope: { agentId: DEFAULT_AVATAR_ID, userId: actor.userId },
      subject: 'user',
      memory: '沟通偏好: 用户偏好详细解释。',
    }, 100);
    const toArchive = await store.notes.write({
      kind: 'impression',
      scope: { agentId: DEFAULT_AVATAR_ID, userId: actor.userId },
      subject: 'user',
      memory: '旧偏好: 用户临时想尝试旧流程。',
    }, 100);

    const result = await runLazyMemoryDream({
      store,
      orchestrator: store.orchestrator,
      agentId: DEFAULT_AVATAR_ID,
      actor,
      extract: async () => ({
        experiences: [],
        peopleActions: [
          { action: 'update_profile', targetId: toUpdate.id, memory: '沟通偏好: 用户偏好先给结论，再补关键细节。' },
          { action: 'archive_profile', targetId: toArchive.id },
          { action: 'update_profile', targetId: 'missing', memory: '不应该写入。' },
          { action: 'keep_both', about: 'user', memory: '输出偏好: 用户希望行动项可直接执行。' },
        ],
      }),
      config: {
        now: new Date('2026-06-18T05:00:00.000Z'),
        minIntervalMs: 1,
        minSessions: 3,
        minToolEvents: 99,
      },
    });

    expect(result).toMatchObject({ status: 'completed', wrote: { person: 3, event: 0, experience: 0 } });
    expect(await store.notes.getById(toUpdate.id)).toMatchObject({ memory: '沟通偏好: 用户偏好先给结论，再补关键细节。' });
    expect(store.notes.rows.find((note) => note.id === toArchive.id)).toMatchObject({ status: 'archived' });
    expect(store.notes.rows.map((note) => note.memory)).not.toContain('不应该写入。');
    expect(store.notes.rows).toEqual(expect.arrayContaining([expect.objectContaining({ memory: '输出偏好: 用户希望行动项可直接执行。' })]));
  });

  it('skips when the previous dream finished inside the interval', async () => {
    const store = dreamStore({
      sessions: [
        completedThread('thread-1', '任务一', '完成一'),
        completedThread('thread-2', '任务二', '完成二'),
        completedThread('thread-3', '任务三', '完成三'),
      ],
    });
    const task = await store.tasks.createTask(dreamTask(new Date('2026-06-18T01:00:00.000Z')));
    await store.tasks.createRun({
      id: 'previous-run',
      taskId: task.id,
      trigger: 'scheduled',
      status: 'completed',
      startedAt: new Date('2026-06-18T01:00:00.000Z'),
      finishedAt: new Date('2026-06-18T01:05:00.000Z'),
    });

    const result = await runLazyMemoryDream({
      store,
      orchestrator: store.orchestrator,
      agentId: DEFAULT_AVATAR_ID,
      actor,
      extract: async () => ({ peopleActions: [], experiences: [] }),
      config: {
        now: new Date('2026-06-18T02:00:00.000Z'),
        minIntervalMs: 24 * 60 * 60 * 1000,
      },
    });

    expect(result).toMatchObject({ status: 'skipped', reason: 'dream_not_due' });
  });
});

function dreamStore(input: {
  sessions: Array<{ thread: ThreadRecord; entries: SessionEntryRecord[] }>;
  workSessions?: Array<{ threadId: string; sessionId: string; spaceId: string; entries: SessionEntryRecord[] }>;
  eventExtractor?: CoreExtractor;
}): ZleapStore & { notes: FakeNoteStore; core: FakeCoreStore; orchestrator: MemoryOrchestrator } {
  const notes = new FakeNoteStore();
  const core = new FakeCoreStore();
  const tasks = fakeTasks();
  const entriesBySession = new Map([
    ...input.sessions.map((session) => [session.thread.mainSessionId!, session.entries] as const),
    ...(input.workSessions ?? []).map((session) => [session.sessionId, session.entries] as const),
  ]);
  const store = {
    notes,
    core,
    tasks,
    threads: {
      listThreads: async () => input.sessions.map((session) => session.thread),
    },
    sessions: {
      listEntries: async ({ sessionId }: { sessionId: string }) => entriesBySession.get(sessionId) ?? [],
      listSessions: async ({ threadId }: { threadId?: string }) => (input.workSessions ?? [])
        .filter((session) => !threadId || session.threadId === threadId)
        .map((session) => ({
          id: session.sessionId,
          threadId: session.threadId,
          avatarId: DEFAULT_AVATAR_ID,
          userId: actor.userId,
          tenantId: actor.tenantId,
          spaceId: session.spaceId,
          kind: 'work',
          status: 'completed',
          createdAt: new Date('2026-06-18T02:30:00.000Z'),
          updatedAt: new Date('2026-06-18T02:30:00.000Z'),
        })),
    },
    embedText: async (text: string) => fauxEmbed(text, 64),
    close: async () => undefined,
  } as unknown as ZleapStore & { notes: FakeNoteStore; core: FakeCoreStore; orchestrator: MemoryOrchestrator };
  const records = createRecordMemoryPort({
    core,
    embed: (texts) => Promise.all(texts.map((text) => store.embedText(text))),
    embedQuery: (text) => store.embedText(text),
    extractor: input.eventExtractor ?? (async () => []),
  });
  store.orchestrator = new MemoryOrchestrator({ notes, records });
  return store;
}

function completedWorkSession(
  threadId: string,
  spaceId: string,
  userText: string,
  assistantText: string,
): { threadId: string; sessionId: string; spaceId: string; entries: SessionEntryRecord[] } {
  const sessionId = `${threadId}:${spaceId}:work`;
  return {
    threadId,
    sessionId,
    spaceId,
    entries: [
      entry(sessionId, 'u1', 'message', 'user', userText),
      entry(sessionId, 'a1', 'message', 'assistant', assistantText),
    ],
  };
}

function completedThread(threadId: string, userText: string, assistantText: string): { thread: ThreadRecord; entries: SessionEntryRecord[] } {
  const sessionId = `${threadId}:main`;
  const now = new Date('2026-06-18T02:30:00.000Z');
  return {
    thread: {
      id: threadId,
      avatarId: DEFAULT_AVATAR_ID,
      userId: actor.userId,
      tenantId: actor.tenantId,
      mainSessionId: sessionId,
      status: 'active',
      source: 'web',
      createdAt: now,
      updatedAt: now,
      metadata: { conversationId: threadId.replace(/^thread-/, 'conversation-') },
    },
    entries: [
      entry(sessionId, 'u1', 'message', 'user', userText),
      entry(sessionId, 't1', 'tool_result', 'tool', 'SECRET_TOKEN=abc', { toolName: 'read', isError: false }),
      entry(sessionId, 'a1', 'message', 'assistant', assistantText),
    ],
  };
}

function entry(
  sessionId: string,
  id: string,
  type: SessionEntryRecord['type'],
  role: SessionEntryRecord['role'],
  content: string,
  data?: unknown,
): SessionEntryRecord {
  return {
    id: `${sessionId}:${id}`,
    sessionId,
    type,
    role,
    content,
    data,
    createdAt: new Date('2026-06-18T02:30:00.000Z'),
  };
}

function fakeTasks() {
  const tasks: ScheduledTaskRecord[] = [];
  const runs: ScheduledTaskRunRecord[] = [];
  return {
    createTask: async (input: Omit<ScheduledTaskRecord, 'createdAt' | 'updatedAt' | 'deletedAt'> & { createdAt?: Date; updatedAt?: Date }) => {
      if (tasks.some((task) => task.id === input.id)) throw new Error('duplicate task');
      const now = input.createdAt ?? new Date();
      const task = { ...input, createdAt: now, updatedAt: input.updatedAt ?? now } as ScheduledTaskRecord;
      tasks.push(task);
      return task;
    },
    listTasks: async () => tasks,
    createRun: async (input: Omit<ScheduledTaskRunRecord, 'startedAt' | 'finishedAt'> & { startedAt?: Date; finishedAt?: Date }) => {
      if (runs.some((run) => run.id === input.id)) throw new Error('duplicate run');
      const run = { ...input } as ScheduledTaskRunRecord;
      runs.push(run);
      return run;
    },
    updateRun: async (id: string, patch: Partial<ScheduledTaskRunRecord>) => {
      const index = runs.findIndex((run) => run.id === id);
      if (index < 0) throw new Error('missing run');
      runs[index] = { ...runs[index]!, ...patch };
      return runs[index]!;
    },
    getRun: async (id: string) => runs.find((run) => run.id === id),
    listRuns: async ({ taskId, status }: { taskId: string; status?: ScheduledTaskRunRecord['status'] | ScheduledTaskRunRecord['status'][] }) => {
      const statuses = status ? new Set(Array.isArray(status) ? status : [status]) : undefined;
      return runs
        .filter((run) => run.taskId === taskId && (!statuses || statuses.has(run.status)))
        .sort((a, b) => (b.finishedAt?.getTime() ?? b.startedAt?.getTime() ?? 0) - (a.finishedAt?.getTime() ?? a.startedAt?.getTime() ?? 0));
    },
    reclaimStaleRuns: async () => 0,
  };
}

function dreamTask(now: Date): Omit<ScheduledTaskRecord, 'createdAt' | 'updatedAt' | 'deletedAt'> & { createdAt?: Date; updatedAt?: Date } {
  return {
    id: `memory-dream:${DEFAULT_AVATAR_ID}:${actor.userId}`,
    userId: actor.userId,
    tenantId: actor.tenantId,
    avatarId: DEFAULT_AVATAR_ID,
    permissionMode: 'full_access',
    name: 'Memory Dream',
    type: 'memory_dream',
    prompt: 'Automatically consolidate durable memory.',
    cron: '0 3 * * *',
    timezone: 'UTC',
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}
