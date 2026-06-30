import { describe, expect, it } from 'vitest';
import {
  MemoryOrchestrator,
  createMemoryPluginTools,
  renderMemoryBlocks,
  type AgentNote,
  type AgentNoteStore,
  type RecordFragmentMessage,
  type RecordHit,
  type RecordMemoryPort,
  type RecordRef,
  type RecordScope,
  type ToolExecutionContext,
  type WriteAgentNoteInput,
} from '../src/index.js';

class FakeNoteStore implements AgentNoteStore {
  private rows: AgentNote[] = [];
  private seq = 0;
  async write(input: WriteAgentNoteInput, limit = 20): Promise<AgentNote> {
    const now = new Date(Date.now() + this.seq);
    const existing = input.id ? this.rows.find((row) => row.id === input.id) : undefined;
    if (existing) {
      existing.memory = input.memory;
      existing.subject = input.kind === 'impression' ? (input.subject ?? existing.subject ?? 'user') : undefined;
      existing.status = 'active';
      existing.updatedAt = now;
      return existing;
    }
    const note: AgentNote = {
      id: input.id ?? `note_${(this.seq += 1)}`,
      kind: input.kind,
      agentId: input.scope.agentId,
      userId: input.kind === 'impression' ? input.scope.userId : undefined,
      spaceId: undefined,
      threadId: input.scope.threadId,
      subject: input.kind === 'impression' ? (input.subject ?? 'user') : undefined,
      memory: input.memory,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    this.rows.push(note);
    const peers = this.rows
      .filter((r) =>
        r.status === 'active' &&
        r.kind === note.kind &&
        r.agentId === note.agentId &&
        r.userId === note.userId &&
        (note.kind !== 'impression' || (r.subject ?? 'user') === (note.subject ?? 'user')))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    for (const stale of peers.slice(limit)) stale.status = 'archived';
    return note;
  }
  async listRecent({ kind, scope, limit = 20 }: Parameters<AgentNoteStore['listRecent']>[0]): Promise<AgentNote[]> {
    return this.rows
      .filter((r) =>
        r.status === 'active' &&
        r.kind === kind &&
        r.agentId === scope.agentId &&
        r.userId === scope.userId)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, limit);
  }
  async getById(id: string): Promise<AgentNote | undefined> {
    return this.rows.find((r) => r.id === id);
  }
  async archive(id: string): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (row) row.status = 'archived';
  }
  async purgeByAgent(agentId: string): Promise<void> {
    this.rows = this.rows.filter((r) => r.agentId !== agentId);
  }
  async archiveBySpace(): Promise<void> {
    // New experience memories are core records, not space-scoped notes.
  }
  async purgeByUser({ agentId, userId }: { agentId: string; userId: string }): Promise<void> {
    this.rows = this.rows.filter((r) => !(r.kind === 'impression' && r.agentId === agentId && r.userId === userId));
  }
}

class FakeRecordPort implements RecordMemoryPort {
  rows: Array<RecordRef & { scope: RecordScope; originUserId?: string }> = [];
  lastRecallMode: string | undefined;
  lastRecallScope: RecordScope | undefined;
  private seq = 0;
  async ingest({ scope: recordScope, messages }: { scope: RecordScope; messages: RecordFragmentMessage[] }): Promise<RecordRef[]> {
    const memory = messages.map((m) => m.content).join('\n');
    const ref: RecordRef = {
      id: `rec_${(this.seq += 1)}`,
      kind: 'work',
      memory,
      keywords: [],
      createdAt: new Date(Date.now() + this.seq),
    };
    this.rows.push({ ...ref, scope: recordScope });
    return [ref];
  }
  async writeExperience({ scope: recordScope, memory }: Parameters<RecordMemoryPort['writeExperience']>[0]): Promise<RecordRef> {
    const ref: RecordRef = {
      id: `exp_${(this.seq += 1)}`,
      kind: 'experience',
      memory,
      keywords: [],
      createdAt: new Date(Date.now() + this.seq),
    };
    this.rows.push({ ...ref, scope: { agentId: recordScope.agentId }, originUserId: recordScope.userId });
    return ref;
  }
  async recall({ scope: recordScope, query, limit, mode, kinds }: Parameters<RecordMemoryPort['recall']>[0]): Promise<RecordHit[]> {
    this.lastRecallMode = mode;
    this.lastRecallScope = recordScope;
    return this.rows
      .filter((r) => !kinds?.length || (r.kind && kinds.includes(r.kind)))
      .filter((r) => r.scope.agentId === recordScope.agentId)
      .filter((r) =>
        r.kind === 'experience' ||
        (
          r.scope.userId === recordScope.userId &&
          r.scope.tenantId === recordScope.tenantId &&
          r.scope.spaceId === recordScope.spaceId &&
          r.scope.threadId === recordScope.threadId
        ))
      .filter((r) => r.memory.includes(query))
      .slice(0, limit ?? 5)
      .map((r) => ({ ...r, score: 1, paths: ['lexical'] }));
  }
  async listRecent({ scope: recordScope, kind = 'work', limit }: Parameters<RecordMemoryPort['listRecent']>[0]): Promise<RecordRef[]> {
    return this.rows
      .filter((r) => r.kind === kind && r.scope.agentId === recordScope.agentId)
      .filter((r) =>
        kind === 'experience' ||
        (
          r.scope.userId === recordScope.userId &&
          r.scope.tenantId === recordScope.tenantId &&
          r.scope.spaceId === recordScope.spaceId &&
          r.scope.threadId === recordScope.threadId
        ))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit ?? 5);
  }
  async detail(id: string, recordScope: RecordScope) {
    const ref = this.rows.find((r) =>
      r.id === id &&
      r.scope.agentId === recordScope.agentId &&
      (
        r.kind === 'experience' ||
        (
          r.scope.userId === recordScope.userId &&
          r.scope.tenantId === recordScope.tenantId &&
          r.scope.spaceId === recordScope.spaceId &&
          r.scope.threadId === recordScope.threadId
        )
      ));
    return ref ? { ...ref, entities: [] } : undefined;
  }
  async deleteByThread(): Promise<void> {
    this.rows = [];
  }
}

const scope = { agentId: 'agentA', userId: 'userA', spaceId: 'spaceA', threadId: 'threadA' };

describe('MemoryOrchestrator', () => {
  it('writes notes (A) and ingests records (B), then prepares fast context', async () => {
    const notes = new FakeNoteStore();
    const records = new FakeRecordPort();
    const orch = new MemoryOrchestrator({ notes, records });

    await orch.remember({ kind: 'impression', about: 'user', memory: 'name: User is Mia.' }, scope);
    await orch.remember({ kind: 'impression', about: 'agent', memory: 'assistant name: Agent is ZZ.' }, scope);
    await orch.remember({ kind: 'experience', about: 'user', memory: 'deploy: Use the infra manifest.' }, scope);
    await orch.onPreCompaction([{ role: 'user', content: 'discuss billing migration' }], scope);

    const blocks = await orch.prepareContext(scope);
    expect(blocks.impressions.map((n) => n.memory)).toEqual(['assistant name: Agent is ZZ.', 'name: User is Mia.']);
    expect(blocks.experiences.map((n) => n.memory)).toEqual(['deploy: Use the infra manifest.']);
    expect(blocks.recentRecords).toHaveLength(1);

    const rendered = renderMemoryBlocks(blocks);
    expect(rendered.stableText).toContain('Mia');
    expect(rendered.stableText).toContain('subject labels as ownership');
    expect(rendered.stableText).toContain('subject=agent is about this assistant/agent');
    expect(rendered.stableText).toContain('Resolve pronouns by speaker');
    expect(rendered.stableText).toContain('[subject: user; time:');
    expect(rendered.stableText).toContain('[subject: agent; time:');
    expect(rendered.stableText).toContain('Known facts about this agent');
    expect(rendered.stableText).toContain('Agent is ZZ');
    expect(rendered.stableText).not.toContain('infra manifest');
    expect(rendered.recentRecordsText).toContain('billing migration');
  });

  it('recall defaults to precise mode (LLM rerank path)', async () => {
    const records = new FakeRecordPort();
    const orch = new MemoryOrchestrator({ notes: new FakeNoteStore(), records });
    await orch.onPreCompaction([{ role: 'user', content: 'about billing migration' }], scope);
    const hits = await orch.recall({ query: 'billing' }, scope);
    expect(hits).toHaveLength(1);
    expect(records.lastRecallMode).toBe('precise');
  });

  it('updates same-title people memory from runtime candidates instead of exact-deduping only', async () => {
    const notes = new FakeNoteStore();
    const orch = new MemoryOrchestrator({ notes, records: new FakeRecordPort() });

    const first = await orch.remember({ kind: 'impression', about: 'user', memory: 'name: User is Mia.' }, scope);
    const updated = await orch.remember(
      { kind: 'impression', about: 'user', memory: 'name: User is Jomy.' },
      scope,
      { peopleCandidates: [first as AgentNote] },
    );
    expect(updated.id).toBe(first.id);
    expect(await notes.getById(first.id)).toMatchObject({ memory: 'name: User is Jomy.' });

    for (let i = 0; i < 12; i += 1) {
      await orch.remember({ kind: 'impression', about: 'agent', memory: `self ${i}: Agent self ${i}` }, scope);
    }
    const blocks = await orch.prepareContext(scope);
    const selfNotes = blocks.impressions.filter((note) => note.subject === 'agent');
    const userNotes = blocks.impressions.filter((note) => (note.subject ?? 'user') === 'user');
    expect(selfNotes).toHaveLength(10);
    expect(selfNotes[0]?.memory).toBe('self 11: Agent self 11');
    expect(userNotes).toHaveLength(1);
  });

  it('lists latest visible people profiles for reconcile', async () => {
    const notes = new FakeNoteStore();
    const orch = new MemoryOrchestrator({ notes, records: new FakeRecordPort() });

    const userProfile = await orch.remember({ kind: 'impression', about: 'user', memory: '沟通偏好: 用户偏好直接结论。' }, scope);
    const localSelf = await orch.remember({ kind: 'impression', about: 'agent', memory: '本地称呼: 用户称呼 Agent 为 Bee。' }, scope);
    const globalSelf = await orch.remember(
      { kind: 'impression', about: 'agent', visibility: 'global', memory: '全局称呼: Agent 名为 Atlas。' },
      { ...scope, actorRole: 'creator' },
    );
    await orch.remember({ kind: 'impression', about: 'user', memory: '其他用户: 其他用户偏好不会出现。' }, { ...scope, userId: 'userB' });

    const profiles = await orch.listPeopleForReconcile(scope, 100);
    expect(profiles.map((note) => note.id)).toEqual(expect.arrayContaining([userProfile.id, localSelf.id, globalSelf.id]));
    expect(profiles.map((note) => note.memory)).not.toContain('其他用户: 其他用户偏好不会出现。');
  });

  it('updates and archives existing people profiles through reconcile actions', async () => {
    const notes = new FakeNoteStore();
    const orch = new MemoryOrchestrator({ notes, records: new FakeRecordPort() });
    const profile = await orch.remember({ kind: 'impression', about: 'user', memory: '沟通偏好: 用户偏好详细解释。' }, scope);

    const updated = await orch.applyPeopleReconcileDecision({
      action: 'update_profile',
      targetId: profile.id,
      memory: '沟通偏好: 用户偏好先给结论，再补关键细节。',
    }, scope);
    expect(updated).toMatchObject({ id: profile.id, memory: '沟通偏好: 用户偏好先给结论，再补关键细节。' });
    expect(await notes.getById(profile.id)).toMatchObject({ memory: '沟通偏好: 用户偏好先给结论，再补关键细节。' });

    const archived = await orch.applyPeopleReconcileDecision({ action: 'archive_profile', targetId: profile.id }, scope);
    expect(archived).toMatchObject({ id: profile.id, status: 'archived' });
    expect((await orch.listPeopleForReconcile(scope)).map((note) => note.id)).not.toContain(profile.id);
  });

  it('skips people reconcile actions with non-visible targets', async () => {
    const notes = new FakeNoteStore();
    const orch = new MemoryOrchestrator({ notes, records: new FakeRecordPort() });
    const profile = await orch.remember({ kind: 'impression', about: 'user', memory: '沟通偏好: 用户偏好直接结论。' }, scope);

    const result = await orch.applyPeopleReconcileDecision({
      action: 'update_profile',
      targetId: 'missing',
      memory: '不应该写入。',
    }, scope);

    expect(result).toBeUndefined();
    expect(await notes.getById(profile.id)).toMatchObject({ memory: '沟通偏好: 用户偏好直接结论。' });
  });

  it('requires creator/admin for global agent self memory and isolates it by agent', async () => {
    const notes = new FakeNoteStore();
    const orch = new MemoryOrchestrator({ notes, records: new FakeRecordPort() });

    await expect(orch.remember(
      { kind: 'impression', about: 'agent', visibility: 'global', memory: 'global name: Agent is Atlas.' },
      { ...scope, actorRole: 'user' },
    )).rejects.toThrow('creator or admin');

    const global = await orch.remember(
      { kind: 'impression', about: 'agent', visibility: 'global', memory: 'global name: Agent is Atlas.' },
      { ...scope, actorRole: 'creator' },
    );
    expect(global).toMatchObject({ userId: undefined, subject: 'agent' });

    const otherUserBlocks = await orch.prepareContext({ ...scope, userId: 'userB' });
    expect(otherUserBlocks.impressions).toEqual([expect.objectContaining({ id: global.id })]);
    expect(await orch.detail(global.id, { ...scope, userId: 'userB' })).toEqual(expect.objectContaining({ id: global.id }));
    expect(await orch.detail(global.id, { ...scope, agentId: 'agentB', userId: 'userB' })).toBeUndefined();
  });

  it('keeps user-level agent self memory scoped to that user', async () => {
    const notes = new FakeNoteStore();
    const orch = new MemoryOrchestrator({ notes, records: new FakeRecordPort() });

    const selfA = await orch.remember(
      { kind: 'impression', about: 'agent', visibility: 'user', memory: 'local name: Agent is Bee for user A.' },
      scope,
    );
    await orch.remember(
      { kind: 'impression', about: 'agent', visibility: 'user', memory: 'local name: Agent is Dee for user B.' },
      { ...scope, userId: 'userB' },
    );

    const blocksA = await orch.prepareContext(scope);
    const blocksB = await orch.prepareContext({ ...scope, userId: 'userB' });
    expect(blocksA.impressions.some((note) => note.memory.includes('Agent is Bee for user A.'))).toBe(true);
    expect(blocksA.impressions.some((note) => note.memory.includes('Agent is Dee for user B.'))).toBe(false);
    expect(blocksB.impressions.some((note) => note.memory.includes('Agent is Dee for user B.'))).toBe(true);
    expect(blocksB.impressions.some((note) => note.memory.includes('Agent is Bee for user A.'))).toBe(false);
    expect(await orch.detail(selfA.id, { ...scope, userId: 'userB' })).toBeUndefined();
  });

  it('isolates work by agent/user/space/thread while sharing experience by agent only', async () => {
    const records = new FakeRecordPort();
    const orch = new MemoryOrchestrator({ notes: new FakeNoteStore(), records });
    await orch.onPreCompaction([{ role: 'user', content: 'deploy work memory' }], scope);
    await orch.remember({ kind: 'experience', about: 'user', memory: 'deploy lesson: deploy experience memory' }, scope);

    const experience = records.rows.find((row) => row.kind === 'experience');
    expect(experience?.scope).toEqual({ agentId: scope.agentId });
    expect(experience?.originUserId).toBe(scope.userId);
    expect(await orch.recall({ query: 'work', mode: 'fast' }, { ...scope, userId: 'other-user' })).toEqual([]);
    expect(await orch.recall({ query: 'work', mode: 'fast' }, { ...scope, spaceId: 'other-space' })).toEqual([]);
    expect(await orch.recall({ query: 'work', mode: 'fast' }, { ...scope, threadId: 'other-thread' })).toEqual([]);
    expect(await orch.recall({ query: 'experience', mode: 'fast' }, { ...scope, userId: 'other-user', spaceId: 'other-space' }))
      .toEqual([expect.objectContaining({ kind: 'experience', memory: 'deploy lesson: deploy experience memory' })]);
  });

  it('passes tenant and thread scope into record recall', async () => {
    const records = new FakeRecordPort();
    const orch = new MemoryOrchestrator({ notes: new FakeNoteStore(), records });
    const tenantScope = { ...scope, tenantId: 'tenantA' };

    await orch.onPreCompaction([{ role: 'user', content: 'tenant scoped billing work' }], tenantScope);
    const hits = await orch.recall({ query: 'billing', mode: 'fast' }, tenantScope);

    expect(hits).toHaveLength(1);
    expect(records.lastRecallScope).toMatchObject({
      agentId: scope.agentId,
      userId: scope.userId,
      tenantId: 'tenantA',
      spaceId: scope.spaceId,
      threadId: scope.threadId,
    });
  });

  it('scopes memory detail by kind', async () => {
    const records = new FakeRecordPort();
    const orch = new MemoryOrchestrator({ notes: new FakeNoteStore(), records });
    const [work] = await orch.onPreCompaction([{ role: 'user', content: 'space-only work memory' }], scope);
    const experience = await orch.remember({ kind: 'experience', about: 'user', memory: 'shared lesson: agent-wide experience' }, scope);

    expect(await orch.detail(work.id, { ...scope, spaceId: 'other-space' })).toBeUndefined();
    expect(await orch.detail(experience.id, { ...scope, spaceId: 'other-space', userId: 'other-user' }))
      .toEqual(expect.objectContaining({ id: experience.id }));
    expect(await orch.detail(experience.id, { ...scope, agentId: 'other-agent' })).toBeUndefined();
  });

  it('sanitizes accepted technical experience memories before writing', async () => {
    const records = new FakeRecordPort();
    const orch = new MemoryOrchestrator({ notes: new FakeNoteStore(), records });

    const experience = await orch.remember({
      kind: 'experience',
      about: 'user',
      memory: [
        'macOS Python PDF 转换环境修复流程:',
        '在 macOS 上排查 Python 生成 PDF 失败时，',
        '先确认 /Users/jomy/private/report.md 这类本地路径不要进入记忆，',
        '再验证动态库路径和渲染结果，避免重复试错。',
      ].join(' '),
    }, scope);

    expect(experience).toMatchObject({ kind: 'experience' });
    expect(experience.memory).toContain('macOS');
    expect(experience.memory).toContain('PDF');
    expect(experience.memory).not.toContain('/Users/jomy/private/report.md');
    expect(experience.memory).toContain('[本地路径]');
    expect(experience.memory).toContain('避免重复试错');
  });

  it('rejects one-off company research facts as experience memories', async () => {
    const records = new FakeRecordPort();
    const orch = new MemoryOrchestrator({ notes: new FakeNoteStore(), records });

    await expect(orch.remember({
      kind: 'experience',
      about: 'user',
      memory: 'SpaceX 2025-2026估值与财务数据调研: SpaceX估值时间线：2023年约1800亿美元（二级交易），2024年底3500亿美元（$185/股），最终形成调研报告。',
    }, scope)).rejects.toMatchObject({
      code: 'experience_memory_rejected',
      rejectionCode: 'experience_business_facts',
    });
    await expect(orch.remember({
      kind: 'experience',
      about: 'user',
      memory: '[具体名称]广告作弊调研方法论: 完成[具体名称]广告作弊调研：使用5+组关键词搜索，从做空报告、SEC调查、集体诉讼等维度收集信息，最终形成调研报告并输出为PDF。',
    }, scope)).rejects.toMatchObject({
      code: 'experience_memory_rejected',
      rejectionCode: 'experience_business_facts',
    });
    expect(records.rows).toEqual([]);
  });

  it('redacts legacy dirty experience records before projection', async () => {
    const records = new FakeRecordPort();
    records.rows.push({
      id: 'legacy_exp',
      kind: 'experience',
      memory: '面向境外上市科技公司（如 Mobvista）调研广州汇量信息科技有限公司。',
      keywords: [],
      createdAt: new Date(),
      scope: { agentId: scope.agentId },
    });
    const orch = new MemoryOrchestrator({ notes: new FakeNoteStore(), records });

    const blocks = await orch.prepareContext(scope);
    const listed = await orch.list(scope);
    const detail = await orch.detail('legacy_exp', scope);
    const [hit] = await orch.recall({ query: '科技公司', mode: 'fast' }, scope);
    const serialized = JSON.stringify([blocks.experiences, listed.experiences, detail, hit]);

    expect(serialized).not.toContain('Mobvista');
    expect(serialized).not.toContain('广州汇量信息科技有限公司');
    expect(serialized).toContain('境外上市科技公司');
    expect(serialized).toContain('如同类对象');
  });
});

describe('memory plugin tools', () => {
  it('exposes only remember/recall and recall returns usable memory text', async () => {
    const orch = new MemoryOrchestrator({ notes: new FakeNoteStore(), records: new FakeRecordPort() });
    const tools = createMemoryPluginTools({ orchestrator: () => orch, scope: () => scope });
    expect(tools.map((t) => t.id)).toEqual(['remember', 'recall']);

    const ctx = {} as ToolExecutionContext;
    const remember = tools.find((t) => t.id === 'remember')!;
    expect(remember.description).toContain('current user');
    expect(remember.description).toContain('about=agent');
    expect(JSON.stringify(remember.parameters)).not.toContain('visibility');
    expect(remember.promptGuidelines?.join('\n')).toContain('same turn before confirming');
    expect(remember.promptGuidelines?.join('\n')).toContain('about=user means current user');
    expect(remember.promptGuidelines?.join('\n')).toContain('Do not claim memory was saved unless remember returned saved');

    const gatedRemember = createMemoryPluginTools({
      orchestrator: () => orch,
      scope: () => scope,
      exposeVisibility: (toolContext) => toolContext.workspaceId === 'admin',
    }).find((t) => t.id === 'remember')!;
    expect(JSON.stringify(gatedRemember.describe?.({ ...ctx, workspaceId: 'main' })?.parameters)).not.toContain('visibility');
    expect(JSON.stringify(gatedRemember.describe?.({ ...ctx, workspaceId: 'admin' })?.parameters)).toContain('visibility');

    const saved = (await remember.handler({ kind: 'impression', about: 'user', memory: 'n: fact' }, ctx)) as { status: string };
    expect(saved.status).toBe('saved');

    const recall = tools.find((t) => t.id === 'recall')!;
    expect(recall.description).toContain('work and experience memory');
    expect(recall.description).toContain('current conversation/session');
    expect(recall.description).toContain('Do not use recall for user profile');
    expect(recall.promptGuidelines?.join('\n')).toContain('does not search impressions/user profile');
    expect(recall.promptGuidelines?.join('\n')).toContain('scoped to the current conversation/session');
    expect(recall.promptGuidelines?.join('\n')).toContain('choose a returned id');
    const agentSaved = await remember.handler({ kind: 'impression', about: 'agent', memory: 'agent: self fact' }, ctx);
    expect(agentSaved).toMatchObject({ status: 'saved' });
    await remember.handler({
      kind: 'experience',
      about: 'agent',
      memory: 'Retry before render: When a remote API is rate limited, retry with backoff before rendering the final UI.',
    }, ctx);
    const recalled = (await recall.handler({ query: 'rate limited' }, ctx)) as {
      memories: Array<{ kind: string; memory: string; evidenceIds: string[]; createdAt: string; updatedAt?: string; score: number }>;
    };
    expect(recalled.memories[0]).toMatchObject({
      kind: 'experience',
      memory: expect.stringContaining('Retry before render'),
      evidenceIds: [],
      createdAt: expect.any(String),
      score: 1,
    });
    expect(recalled.memories[0]?.memory).toContain('rate limited');
    expect(recalled.memories[0]?.memory).toContain('retry with backoff');
  });

  it('returns rejected instead of saving invalid experience tool calls', async () => {
    const records = new FakeRecordPort();
    const orch = new MemoryOrchestrator({ notes: new FakeNoteStore(), records });
    const remember = createMemoryPluginTools({ orchestrator: () => orch, scope: () => scope }).find((t) => t.id === 'remember')!;

    const rejected = await remember.handler({
      kind: 'experience',
      about: 'user',
      memory: 'SpaceX 2025-2026估值与财务数据调研: SpaceX估值时间线：2023年约1800亿美元，2024年底3500亿美元，最终形成调研报告。',
    }, {} as ToolExecutionContext);

    expect(rejected).toMatchObject({
      saved: false,
      status: 'rejected',
      code: 'experience_business_facts',
    });
    expect(records.rows).toEqual([]);
  });

  it('passes runtime people candidates into the remember tool', async () => {
    const notes = new FakeNoteStore();
    const orch = new MemoryOrchestrator({ notes, records: new FakeRecordPort() });
    const existing = await orch.remember({ kind: 'impression', about: 'user', memory: 'name: User is Mia.' }, scope);
    const remember = createMemoryPluginTools({
      orchestrator: () => orch,
      scope: () => scope,
      peopleCandidates: () => [existing as AgentNote],
    }).find((t) => t.id === 'remember')!;

    const saved = await remember.handler(
      { kind: 'impression', about: 'user', memory: 'name: User is Jomy.' },
      {} as ToolExecutionContext,
    );

    expect(saved).toMatchObject({ id: existing.id, status: 'saved' });
    expect(await notes.getById(existing.id)).toMatchObject({ memory: 'name: User is Jomy.' });
  });

  it('rejects hidden global visibility unless runtime role gate allows it', async () => {
    const orch = new MemoryOrchestrator({ notes: new FakeNoteStore(), records: new FakeRecordPort() });
    const ctx = {} as ToolExecutionContext;
    const userRemember = createMemoryPluginTools({
      orchestrator: () => orch,
      scope: () => ({ ...scope, actorRole: 'user' }),
    }).find((t) => t.id === 'remember')!;
    await expect(userRemember.handler({
      kind: 'impression',
      about: 'agent',
      visibility: 'global',
      memory: 'global self: Agent is Atlas.',
    }, ctx)).resolves.toMatchObject({ saved: false, status: 'rejected' });

    const creatorRemember = createMemoryPluginTools({
      orchestrator: () => orch,
      scope: () => ({ ...scope, actorRole: 'creator' }),
      exposeVisibility: () => true,
    }).find((t) => t.id === 'remember')!;
    await expect(creatorRemember.handler({
      kind: 'impression',
      about: 'agent',
      visibility: 'global',
      memory: 'global self: Agent is Atlas.',
    }, ctx)).resolves.toMatchObject({ status: 'saved' });
  });
});
