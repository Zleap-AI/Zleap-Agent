import { describe, expect, it } from 'vitest';
import { AgentRuntime, type AgentEvent } from '../src/index.js';

describe('AgentRuntime', () => {
  it('uses globally unique ids by default across runtime instances', async () => {
    const first = new AgentRuntime();
    const second = new AgentRuntime();

    for (const runtime of [first, second]) {
      runtime.registerWorkspace({
        id: 'cli',
        label: 'Cli',
        handler: async () => ({
          title: 'done',
          summary: 'done',
        }),
      });
    }

    const firstRun = await first.run({ spaces: ['cli'], goal: 'task one' });
    const secondRun = await second.run({ spaces: ['cli'], goal: 'task two' });
    const firstWork = firstRun.works[0];
    const secondWork = secondRun.works[0];
    const firstStep = firstWork?.steps[0];
    const secondStep = secondWork?.steps[0];
    const firstArtifact = firstRun.artifacts[0];
    const secondArtifact = secondRun.artifacts[0];

    expect(firstRun.id).not.toBe(secondRun.id);
    expect(firstWork?.id).not.toBe(secondWork?.id);
    expect(firstStep?.id).not.toBe(secondStep?.id);
    expect(firstArtifact?.id).not.toBe(secondArtifact?.id);
  });

  it('runs a chain work and passes artifacts between workspaces', async () => {
    const runtime = new AgentRuntime({ idFactory: createIdFactory() });
    const events: AgentEvent[] = [];
    runtime.observe((event) => {
      events.push(event);
    });

    runtime.registerWorkspace({
      id: 'research',
      label: 'Research',
      handler: async (context) => ({
        title: 'Research Artifact',
        summary: `research:${context.goal}`,
        data: { prior: context.priorArtifacts.length },
      }),
    });
    runtime.registerWorkspace({
      id: 'writer',
      label: 'Writer',
      handler: async (context) => ({
        title: 'Writer Artifact',
        summary: `writer:${context.priorArtifacts[0]?.summary ?? 'missing'}`,
        data: { inputTitle: getTitle(context.input) },
      }),
    });

    const run = await runtime.run({
      spaces: ['research', 'writer'],
      goal: 'weekly report',
    });

    expect(run.status).toBe('completed');
    expect(run.works).toHaveLength(1);
    expect(run.works[0]?.steps.map((step) => step.workspaceId)).toEqual(['research', 'writer']);
    expect(run.artifacts.map((artifact) => artifact.title)).toEqual(['Research Artifact', 'Writer Artifact']);
    expect(run.artifacts[1]?.summary).toBe('writer:research:weekly report');
    expect(run.artifacts[1]?.data).toEqual({ inputTitle: 'Research Artifact' });
    expect(events.map((event) => event.type)).toContain('artifact_produced');
    expect(events.at(-1)?.type).toBe('agent_end');
  });

  it('runs lifecycle hooks with real run, work, artifact, and request context', async () => {
    const runtime = new AgentRuntime({ idFactory: createIdFactory() });
    const calls: string[] = [];
    const unsubscribe = runtime.registerHook({
      beforeRun: ({ run, request }) => {
        calls.push(`beforeRun:${run.id}:${request.goal}`);
      },
      beforeWork: ({ run, work }) => {
        calls.push(`beforeWork:${run.id}:${work.id}`);
      },
      beforeSpace: ({ run, work, step, request }) => {
        calls.push(`beforeSpace:${run.id}:${work.id}:${step.id}:${step.workspaceId}:${request.workspaceRoot ?? 'no-root'}`);
      },
      afterArtifact: ({ run, work, step, artifact, request }) => {
        calls.push(`afterArtifact:${run.id}:${work.id}:${step.id}:${artifact.title}:${request.spaces.join('+')}`);
      },
      afterSpace: ({ step }) => {
        calls.push(`afterSpace:${step.workspaceId}:${step.status}`);
      },
      afterWork: ({ work }) => {
        calls.push(`afterWork:${work.status}`);
      },
      afterRun: ({ run }) => {
        calls.push(`afterRun:${run.status}`);
      },
    });

    runtime.registerWorkspace({
      id: 'research',
      label: 'Research',
      handler: async () => ({
        title: 'Hook Artifact',
        summary: 'hook summary',
      }),
    });

    const run = await runtime.run({
      spaces: ['research'],
      goal: 'hook goal',
    });
    unsubscribe();
    await runtime.run({
      spaces: ['research'],
      goal: 'after unsubscribe',
    });

    const work = run.works[0];
    const step = work?.steps[0];
    expect(run.status).toBe('completed');
    expect(calls).toEqual([
      `beforeRun:${run.id}:hook goal`,
      `beforeWork:${run.id}:${work?.id}`,
      `beforeSpace:${run.id}:${work?.id}:${step?.id}:research:no-root`,
      `afterArtifact:${run.id}:${work?.id}:${step?.id}:Hook Artifact:research`,
      'afterSpace:research:exited',
      'afterWork:exited',
      'afterRun:completed',
    ]);
  });

  it('fails closed when beforeSpace denies a workspace before the handler runs', async () => {
    const runtime = new AgentRuntime({ idFactory: createIdFactory() });
    const calls: string[] = [];

    runtime.registerHook({
      beforeSpace: ({ step }) => {
        calls.push(`before:${step.workspaceId}`);
        throw Object.assign(new Error('SECRET_BEFORE_SPACE'), { code: 'ESPACE' });
      },
      afterSpace: ({ step }) => {
        calls.push(`after:${step.workspaceId}:${step.error?.message}`);
      },
    });
    runtime.registerWorkspace({
      id: 'research',
      label: 'Research',
      handler: async () => {
        calls.push('handler');
        return {
          title: 'never',
          summary: 'never',
        };
      },
    });

    const run = await runtime.run({
      spaces: ['research'],
      goal: 'space policy',
    });
    const step = run.works[0]?.steps[0];

    expect(run.status).toBe('failed');
    expect(run.error?.message).toBe('WorkSpace failed: research');
    expect(step?.error?.message).toBe('beforeSpace hook failed');
    expect(step?.hookFailures).toEqual([
      {
        phase: 'beforeSpace',
        message: 'beforeSpace hook failed',
        code: 'ESPACE',
        occurredAt: expect.any(Date),
      },
    ]);
    expect(calls).toEqual(['before:research', 'after:research:beforeSpace hook failed']);
    expect(JSON.stringify(run)).not.toContain('SECRET_BEFORE_SPACE');
    expect(calls).not.toContain('handler');
  });

  it('records afterSpace hook failures without failing a successful workspace', async () => {
    const runtime = new AgentRuntime({ idFactory: createIdFactory() });
    const events: AgentEvent[] = [];
    runtime.observe((event) => {
      events.push(event);
    });

    runtime.registerHook({
      afterSpace: () => {
        throw Object.assign(new Error('SECRET_AFTER_SPACE'), { code: 'ESPACE_AFTER' });
      },
    });
    runtime.registerWorkspace({
      id: 'research',
      label: 'Research',
      handler: async () => ({
        title: 'Space Hook',
        summary: 'workspace still completed',
      }),
    });

    const run = await runtime.run({
      spaces: ['research'],
      goal: 'best effort space hook',
    });
    const step = run.works[0]?.steps[0];
    const exitEvent = events.find((event) => event.type === 'space_exit') as
      | Extract<AgentEvent, { type: 'space_exit' }>
      | undefined;

    expect(run.status).toBe('completed');
    expect(run.artifacts[0]?.summary).toBe('workspace still completed');
    expect(step?.hookFailures).toEqual([
      {
        phase: 'afterSpace',
        message: 'afterSpace hook failed',
        code: 'ESPACE_AFTER',
        occurredAt: expect.any(Date),
      },
    ]);
    expect(exitEvent?.step.hookFailures).toEqual(step?.hookFailures);
    expect(JSON.stringify(step?.hookFailures)).not.toContain('SECRET_AFTER_SPACE');
  });

  it('runs afterSessionTouch after a run is linked to its session', async () => {
    const runtime = new AgentRuntime({ idFactory: createIdFactory() });
    const session = runtime.createSession({
      id: 'session-1',
      agentId: 'assistant',
      kind: 'main',
      trigger: 'user',
    });
    const calls: string[] = [];
    runtime.registerHook({
      afterSessionTouch: ({ run, session: touchedSession, updatedAt }) => {
        calls.push(`${run.id}:${touchedSession.id}:${updatedAt instanceof Date}:${runtime.sessions.get(touchedSession.id)?.runIds.join(',')}`);
      },
    });
    runtime.registerWorkspace({
      id: 'research',
      label: 'Research',
      handler: async () => ({
        title: 'Session Artifact',
        summary: 'session summary',
      }),
    });

    const run = await runtime.run({
      spaces: ['research'],
      goal: 'session lifecycle',
      agent: { id: 'assistant', label: 'Assistant' },
      session: {
        id: session.id,
        kind: session.kind,
        trigger: session.trigger,
      },
    });

    expect(run.status).toBe('completed');
    expect(runtime.sessions.get('session-1')?.runIds).toEqual([run.id]);
    expect(calls).toEqual([`${run.id}:session-1:true:${run.id}`]);
  });

  it('records sanitized afterSessionTouch hook failures without failing the run', async () => {
    const runtime = new AgentRuntime({ idFactory: createIdFactory() });
    const session = runtime.createSession({
      id: 'session-1',
      agentId: 'assistant',
      kind: 'main',
      trigger: 'user',
    });
    runtime.registerHook({
      afterSessionTouch: () => {
        throw Object.assign(new Error('SECRET_SESSION_HOOK_FAILURE'), { code: 'ESESSIONHOOK' });
      },
    });
    runtime.registerWorkspace({
      id: 'research',
      label: 'Research',
      handler: async () => ({
        title: 'Session Artifact',
        summary: 'session summary',
      }),
    });

    const run = await runtime.run({
      spaces: ['research'],
      goal: 'session lifecycle failure',
      agent: { id: 'assistant', label: 'Assistant' },
      session: {
        id: session.id,
        kind: session.kind,
        trigger: session.trigger,
      },
    });

    expect(run.status).toBe('completed');
    expect(runtime.sessions.get('session-1')?.runIds).toEqual([run.id]);
    expect(run.metadata?.hookFailures).toEqual([
      {
        phase: 'afterSessionTouch',
        message: 'afterSessionTouch hook failed',
        code: 'ESESSIONHOOK',
        occurredAt: expect.any(Date),
      },
    ]);
    expect(JSON.stringify(run.metadata?.hookFailures)).not.toContain('SECRET_SESSION_HOOK_FAILURE');
  });

  it('records queryable traces for run, work, step, artifact, and tool execution', async () => {
    const runtime = new AgentRuntime({ idFactory: createIdFactory() });
    runtime.registerTool({
      id: 'lookup',
      handler: async () => ({ ok: true }),
    });
    runtime.registerSkill({
      id: 'lookup-skill',
      label: 'Lookup Skill',
      toolIds: ['lookup'],
    });
    runtime.registerWorkspace({
      id: 'research',
      label: 'Research',
      handler: async (context) => {
        await context.callTool('lookup', { q: context.goal });
        return {
          title: 'Trace Artifact',
          summary: 'trace summary',
        };
      },
    });

    const run = await runtime.run({
      spaces: ['research'],
      goal: 'trace goal',
      skillIds: ['lookup-skill'],
    });

    const runTraces = runtime.traces.query({ runId: run.id });
    const workId = run.works[0]?.id;
    const stepId = run.works[0]?.steps[0]?.id;
    expect(run.status).toBe('completed');
    expect(runTraces.map((trace) => trace.type)).toContain('agent_start');
    expect(runTraces.map((trace) => trace.type)).toContain('agent_end');
    expect(runtime.traces.query({ runId: run.id, kind: 'run' }).map((trace) => trace.status)).toContain('completed');
    expect(runtime.traces.query({ runId: run.id, workId, kind: 'work' }).map((trace) => trace.type)).toContain('work_status');
    expect(runtime.traces.query({ runId: run.id, stepId, kind: 'step' }).map((trace) => trace.status)).toContain('exited');
    expect(runtime.traces.query({ runId: run.id, kind: 'artifact' })).toMatchObject([
      {
        artifactId: run.artifacts[0]?.id,
        title: 'Trace Artifact',
        summary: 'trace summary',
      },
    ]);
    expect(runtime.traces.query({ runId: run.id, kind: 'tool_call' }).map((trace) => trace.type)).toEqual([
      'tool_execution_start',
      'tool_execution_end',
    ]);
  });

  it('runs an agent with default spaces, skills, tools, and persona context', async () => {
    const runtime = new AgentRuntime({ idFactory: createIdFactory() });
    runtime.registerTool({
      id: 'lookup',
      description: 'Lookup a customer.',
      handler: async (input) => ({ input, source: 'tool' }),
    });
    runtime.registerTool({
      id: 'calendar',
      description: 'Read calendar.',
      handler: async () => ({ source: 'calendar' }),
    });
    runtime.registerSkill({
      id: 'research-tools',
      label: 'Research Tools',
      toolIds: ['lookup'],
    });
    runtime.registerAgent({
      id: 'analyst',
      label: 'Analyst',
      avatar: {
        name: 'Ava',
        tone: 'concise',
      },
      instructions: 'Be precise.',
      model: {
        providerId: 'custom-openai',
        model: 'zleap-small',
      },
      defaultSpaces: ['research'],
      defaultSkillIds: ['research-tools'],
      defaultToolIds: ['calendar'],
    });
    runtime.registerWorkspace({
      id: 'research',
      label: 'Research',
      handler: async (context) => {
        const lookup = await context.callTool('lookup', { goal: context.goal });
        return {
          title: 'Agent Artifact',
          summary: context.agent?.instructions ?? 'missing',
          data: {
            agent: context.agent,
            lookup,
            tools: context.availableTools.map((tool) => tool.id),
          },
        };
      },
    });

    const run = await runtime.runAgent({
      agentId: 'analyst',
      goal: 'customer review',
      instructions: 'Use internal evidence.',
    });

    expect(run.status).toBe('completed');
    expect(run.agentId).toBe('analyst');
    expect(run.works[0]?.agentId).toBe('analyst');
    expect(run.works[0]?.spaces).toEqual(['research']);
    expect(run.works[0]?.skillIds).toEqual(['research-tools']);
    expect(run.works[0]?.toolIds).toEqual(['calendar']);
    expect(run.artifacts[0]?.summary).toBe('Be precise.\n\nUse internal evidence.');
    expect(run.artifacts[0]?.data).toEqual({
      agent: {
        id: 'analyst',
        label: 'Analyst',
        avatar: {
          name: 'Ava',
          tone: 'concise',
        },
        instructions: 'Be precise.\n\nUse internal evidence.',
        model: {
          providerId: 'custom-openai',
          model: 'zleap-small',
        },
      },
      lookup: {
        input: { goal: 'customer review' },
        source: 'tool',
      },
      tools: ['calendar', 'lookup'],
    });
  });

  it('lets agent runs override spaces and extend skills without losing defaults', async () => {
    const runtime = new AgentRuntime({ idFactory: createIdFactory() });
    runtime.registerSkill({
      id: 'default-skill',
      label: 'Default Skill',
      toolIds: [],
    });
    runtime.registerSkill({
      id: 'extra-skill',
      label: 'Extra Skill',
      toolIds: [],
    });
    runtime.registerAgent({
      id: 'writer',
      label: 'Writer',
      defaultSpaces: ['draft'],
      defaultSkillIds: ['default-skill'],
    });
    runtime.registerWorkspace({
      id: 'review',
      label: 'Review',
      handler: async (context) => ({
        title: 'Review',
        summary: context.skills.map((skill) => skill.id).join(','),
      }),
    });

    const run = await runtime.runAgent({
      agentId: 'writer',
      goal: 'review memo',
      spaces: ['review'],
      skillIds: ['extra-skill'],
    });

    expect(run.status).toBe('completed');
    expect(run.works[0]?.spaces).toEqual(['review']);
    expect(run.works[0]?.skillIds).toEqual(['default-skill', 'extra-skill']);
    expect(run.artifacts[0]?.summary).toBe('default-skill,extra-skill');
  });

  it('persists successful run artifacts into session and agent memory', async () => {
    const runtime = new AgentRuntime({ idFactory: createIdFactory() });
    runtime.registerAgent({
      id: 'analyst',
      label: 'Analyst',
      defaultSpaces: ['write-memory'],
      defaultMemory: {
        scopes: ['session', 'agent'],
        tags: ['report'],
      },
    });
    runtime.registerWorkspace({
      id: 'write-memory',
      label: 'Write Memory',
      handler: async () => ({
        title: 'Risk Report',
        summary: 'customer risk is elevated',
        data: { score: 82 },
      }),
    });

    const run = await runtime.runAgent({
      agentId: 'analyst',
      goal: 'write risk report',
      session: {
        sessionId: 'main-session',
        kind: 'main',
        trigger: 'user',
      },
    });

    const records = runtime.memories.query({ tags: ['report'] });
    expect(run.status).toBe('completed');
    expect(records).toHaveLength(2);
    expect(runtime.memories.query({ scope: 'session', sessionId: 'main-session' })).toMatchObject([
      {
        scope: 'session',
        agentId: 'analyst',
        sessionId: 'main-session',
        runId: run.id,
        artifactId: run.artifacts[0]?.id,
        title: 'Risk Report',
        summary: 'customer risk is elevated',
        data: { score: 82 },
        tags: ['report'],
      },
    ]);
    expect(runtime.memories.query({ scope: 'agent', agentId: 'analyst', text: 'risk' })).toMatchObject([
      {
        scope: 'agent',
        agentId: 'analyst',
        sessionId: undefined,
        title: 'Risk Report',
      },
    ]);
  });

  it('lets workspaces query scoped memory without leaking other sessions', async () => {
    const runtime = new AgentRuntime({ idFactory: createIdFactory() });
    runtime.registerAgent({
      id: 'analyst',
      label: 'Analyst',
      defaultSpaces: ['remember'],
      defaultMemory: {
        scopes: ['session', 'agent'],
        tags: ['decision'],
      },
    });
    runtime.registerWorkspace({
      id: 'remember',
      label: 'Remember',
      handler: async (context) => ({
        title: 'Decision',
        summary: `decision for ${context.session?.id}`,
      }),
    });

    await runtime.runAgent({
      agentId: 'analyst',
      goal: 'store first decision',
      session: {
        sessionId: 'session-a',
        kind: 'main',
        trigger: 'user',
      },
    });
    await runtime.runAgent({
      agentId: 'analyst',
      goal: 'store second decision',
      session: {
        sessionId: 'session-b',
        kind: 'main',
        trigger: 'user',
      },
    });

    runtime.registerWorkspace({
      id: 'remember',
      label: 'Remember',
      handler: async (context) => {
        const sessionMemories = context.queryMemory({ scope: 'session', tags: ['decision'] });
        const agentMemories = context.queryMemory({ scope: 'agent', tags: ['decision'] });
        const visibleMemories = context.queryMemory({ tags: ['decision'] });
        return {
          title: 'Memory Query',
          summary: 'memory query complete',
          data: {
            session: sessionMemories.map((memory) => memory.summary),
            agent: agentMemories.map((memory) => memory.summary),
            visible: visibleMemories.map((memory) => `${memory.scope}:${memory.summary}`),
          },
        };
      },
    });

    const run = await runtime.runAgent({
      agentId: 'analyst',
      goal: 'query memory',
      session: {
        sessionId: 'session-a',
        kind: 'main',
        trigger: 'user',
      },
      memory: { scopes: [] },
    });

    expect(run.status).toBe('completed');
    expect(run.artifacts[0]?.data).toEqual({
      session: ['decision for session-a'],
      agent: ['decision for session-a', 'decision for session-b'],
      visible: [
        'session:decision for session-a',
        'agent:decision for session-a',
        'agent:decision for session-b',
      ],
    });
  });

  it('does not persist failed run artifacts into memory', async () => {
    const runtime = new AgentRuntime({ idFactory: createIdFactory() });
    runtime.registerAgent({
      id: 'analyst',
      label: 'Analyst',
      defaultSpaces: ['fail'],
      defaultMemory: {
        scopes: ['agent'],
      },
    });
    runtime.registerWorkspace({
      id: 'fail',
      label: 'Fail',
      handler: async () => {
        throw new Error('cannot finish');
      },
    });

    const run = await runtime.runAgent({
      agentId: 'analyst',
      goal: 'fail to write memory',
    });

    expect(run.status).toBe('failed');
    expect(runtime.memories.list()).toHaveLength(0);
  });

  it('fails closed when a requested agent is missing', async () => {
    const runtime = new AgentRuntime({ idFactory: createIdFactory() });
    const events: AgentEvent[] = [];
    runtime.observe((event) => {
      events.push(event);
    });

    const run = await runtime.runAgent({
      agentId: 'missing-agent',
      goal: 'do work',
    });

    expect(run.status).toBe('failed');
    expect(run.agentId).toBe('missing-agent');
    expect(run.error?.code).toBe('agent_not_found');
    expect(run.works).toHaveLength(0);
    expect(events.map((event) => event.type)).toEqual(['agent_start', 'run_status', 'error', 'agent_end']);
  });

  it('binds user-triggered agent runs to a main session', async () => {
    const runtime = new AgentRuntime({ idFactory: createIdFactory() });
    runtime.registerAgent({
      id: 'assistant',
      label: 'Assistant',
      defaultSpaces: ['chat'],
    });
    runtime.registerWorkspace({
      id: 'chat',
      label: 'Chat',
      handler: async (context) => ({
        title: 'Chat Response',
        summary: context.session?.id ?? 'missing',
        data: {
          session: context.session,
        },
      }),
    });

    const run = await runtime.runAgent({
      agentId: 'assistant',
      goal: 'reply to user',
      session: {
        sessionId: 'main-session',
        kind: 'main',
        trigger: 'user',
        title: 'Primary chat',
      },
    });

    const session = runtime.sessions.get('main-session');
    expect(run.status).toBe('completed');
    expect(run.session).toEqual({
      id: 'main-session',
      kind: 'main',
      trigger: 'user',
    });
    expect(run.works[0]?.session).toEqual(run.session);
    expect(run.artifacts[0]?.data).toEqual({ session: run.session });
    expect(session?.agentId).toBe('assistant');
    expect(session?.runIds).toEqual([run.id]);
  });

  it('reports async persistence write-through failures without breaking session creation', async () => {
    const failures: unknown[] = [];
    const runtime = new AgentRuntime({
      idFactory: createIdFactory(),
      now: () => new Date('2026-06-13T01:02:03.000Z'),
      persistence: {
        saveSession: async () => {
          throw Object.assign(new Error('session mirror failed'), { code: 'ESINK' });
        },
      },
      onPersistenceFailure: (failure) => failures.push(failure),
    });

    const session = runtime.createSession({
      id: 'main-session',
      agentId: 'assistant',
      kind: 'main',
      trigger: 'user',
      title: 'private session title',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(session.id).toBe('main-session');
    expect(runtime.sessions.get('main-session')).toBe(session);
    expect(failures).toEqual([
      {
        operation: 'saveSession',
        code: 'ESINK',
        message: 'session mirror failed',
        occurredAt: new Date('2026-06-13T01:02:03.000Z'),
      },
    ]);
    expect(JSON.stringify(failures)).not.toContain('private session title');
  });

  it('reports synchronous session touch persistence failures without throwing', async () => {
    const failures: unknown[] = [];
    const runtime = new AgentRuntime({
      idFactory: createIdFactory(),
      now: () => new Date('2026-06-13T01:02:03.000Z'),
      persistence: {
        saveSession: () => undefined,
        touchSession: () => {
          throw Object.assign(new Error('session touch failed'), { code: 'ETOUCH' });
        },
      },
      onPersistenceFailure: (failure) => failures.push(failure),
    });
    runtime.registerWorkspace({
      id: 'write-memory',
      label: 'Write Memory',
      handler: async () => ({
        title: 'Private artifact',
        summary: 'artifact summary',
      }),
    });

    const session = runtime.createSession({
      id: 'sync-failure-session',
      agentId: 'assistant',
      kind: 'main',
      trigger: 'user',
    });
    failures.length = 0;

    await expect(runtime.run({
      agent: { id: 'assistant', label: 'Assistant' },
      session,
      spaces: ['write-memory'],
      goal: 'persist memory',
    })).resolves.toMatchObject({ status: 'completed' });
    expect(failures).toEqual([
      {
        operation: 'touchSession',
        code: 'ETOUCH',
        message: 'session touch failed',
        occurredAt: new Date('2026-06-13T01:02:03.000Z'),
      },
    ]);
    expect(JSON.stringify(failures)).not.toContain('artifact summary');
  });

  it('keeps scheduled sub-session runs isolated from the main session', async () => {
    const runtime = new AgentRuntime({ idFactory: createIdFactory() });
    runtime.registerAgent({
      id: 'assistant',
      label: 'Assistant',
      defaultSpaces: ['report'],
    });
    runtime.registerWorkspace({
      id: 'report',
      label: 'Report',
      handler: async (context) => ({
        title: 'Scheduled Report',
        summary: `${context.session?.kind}:${context.session?.trigger}`,
        data: {
          parentSessionId: context.session?.parentSessionId,
        },
      }),
    });

    const main = runtime.createSession({
      id: 'main-session',
      agentId: 'assistant',
      kind: 'main',
      trigger: 'user',
      title: 'Primary chat',
    });
    const scheduledRun = await runtime.runAgent({
      agentId: 'assistant',
      goal: 'daily summary',
      session: {
        kind: 'sub',
        trigger: 'schedule',
        parentSessionId: main.id,
        title: 'Daily summary run',
      },
    });

    const subSessionId = scheduledRun.session?.id;
    const subSession = subSessionId ? runtime.sessions.get(subSessionId) : undefined;
    expect(scheduledRun.status).toBe('completed');
    expect(scheduledRun.session?.kind).toBe('sub');
    expect(scheduledRun.session?.trigger).toBe('schedule');
    expect(scheduledRun.session?.parentSessionId).toBe('main-session');
    expect(scheduledRun.artifacts[0]?.summary).toBe('sub:schedule');
    expect(scheduledRun.artifacts[0]?.data).toEqual({ parentSessionId: 'main-session' });
    expect(runtime.sessions.get('main-session')?.runIds).toEqual([]);
    expect(subSession?.runIds).toEqual([scheduledRun.id]);
  });

  it('fails closed when a requested workspace is missing', async () => {
    const runtime = new AgentRuntime({ idFactory: createIdFactory() });
    const run = await runtime.run({
      spaces: ['missing'],
      goal: 'unknown',
    });

    expect(run.status).toBe('failed');
    expect(run.error?.code).toBe('workspace_not_found');
    expect(runtime.traces.query({ runId: run.id, kind: 'error' })).toMatchObject([
      {
        title: 'workspace_not_found',
      },
    ]);
  });

  it('marks a run aborted when the signal is already aborted', async () => {
    const runtime = new AgentRuntime({ idFactory: createIdFactory() });
    const controller = new AbortController();
    controller.abort();

    runtime.registerWorkspace({
      id: 'research',
      label: 'Research',
      handler: async () => ({
        title: 'never',
        summary: 'never',
      }),
    });

    const run = await runtime.run(
      {
        spaces: ['research'],
        goal: 'cancelled',
      },
      { signal: controller.signal },
    );

    expect(run.status).toBe('aborted');
    expect(run.error?.code).toBe('work_aborted');
  });

  it('lets workspaces call registered tools and records the tool call', async () => {
    const runtime = new AgentRuntime({ idFactory: createIdFactory() });
    const events: AgentEvent[] = [];
    runtime.observe((event) => {
      events.push(event);
    });

    runtime.registerTool({
      id: 'lookup',
      description: 'Lookup a value.',
      parameters: { type: 'object' },
      handler: async (input, context) => ({
        input,
        workspaceId: context.workspaceId,
      }),
    });
    runtime.registerSkill({
      id: 'research-tools',
      label: 'Research Tools',
      instructions: 'Use lookup for research queries.',
      toolIds: ['lookup'],
    });
    runtime.registerWorkspace({
      id: 'research',
      label: 'Research',
      handler: async (context) => {
        const result = await context.callTool('lookup', { query: context.goal });
        return {
          title: 'Tool Artifact',
          summary: 'tool result collected',
          data: {
            result,
            skills: context.skills.map((skill) => skill.id),
            tools: context.availableTools.map((tool) => tool.id),
          },
        };
      },
    });

    const run = await runtime.run({
      spaces: ['research'],
      goal: 'customer risk',
      skillIds: ['research-tools'],
    });

    const step = run.works[0]?.steps[0];
    expect(run.status).toBe('completed');
    expect(run.artifacts[0]?.data).toEqual({
      result: {
        input: { query: 'customer risk' },
        workspaceId: 'research',
      },
      skills: ['research-tools'],
      tools: ['lookup'],
    });
    expect(step?.toolCalls).toHaveLength(1);
    expect(step?.toolCalls[0]?.toolId).toBe('lookup');
    expect(step?.toolCalls[0]?.result).toEqual({
      input: { query: 'customer risk' },
      workspaceId: 'research',
    });
    expect(run.works[0]?.skillIds).toEqual(['research-tools']);
    expect(run.works[0]?.toolIds).toEqual([]);
    expect(events.map((event) => event.type)).toContain('tool_execution_start');
    expect(events.map((event) => event.type)).toContain('tool_execution_end');
  });

  it('runs tool hooks around tool execution with auditable context', async () => {
    const runtime = new AgentRuntime({ idFactory: createIdFactory() });
    const calls: string[] = [];

    runtime.registerHook({
      beforeToolCall: ({ run, work, step, call, execution, request }) => {
        calls.push(`before:${run.id}:${work.id}:${step.id}:${call.toolId}:${call.reason}:${execution.workspaceId}:${request.goal}`);
      },
      afterToolCall: ({ call }) => {
        calls.push(`after:${call.toolId}:${JSON.stringify(call.result)}`);
      },
    });
    runtime.registerTool({
      id: 'lookup',
      requiresReason: true,
      handler: async () => {
        calls.push('handler');
        return { ok: true };
      },
    });
    runtime.registerWorkspace({
      id: 'research',
      label: 'Research',
      handler: async (context) => {
        await context.callTool('lookup', { reason: 'collect evidence' });
        return {
          title: 'Hooked Tool',
          summary: 'done',
        };
      },
    });

    const run = await runtime.run({
      spaces: ['research'],
      goal: 'hook tool',
      toolIds: ['lookup'],
    });
    const work = run.works[0];
    const step = work?.steps[0];

    expect(run.status).toBe('completed');
    expect(calls).toEqual([
      `before:${run.id}:${work?.id}:${step?.id}:lookup:collect evidence:research:hook tool`,
      'handler',
      'after:lookup:{"ok":true}',
    ]);
  });

  it('prepares tool arguments before hooks, reason checks, and handler execution', async () => {
    const runtime = new AgentRuntime({ idFactory: createIdFactory() });
    const calls: string[] = [];

    runtime.registerHook({
      beforeToolCall: ({ call }) => {
        calls.push(`before:${JSON.stringify(call.input)}:${call.reason}`);
      },
    });
    runtime.registerTool({
      id: 'lookup',
      requiresReason: true,
      prepareArguments: async (input, context) => {
        const record = input as { q?: string };
        calls.push(`prepare:${context.workspaceId}:${record.q}`);
        return {
          query: record.q?.trim(),
          reason: 'normalized lookup',
        };
      },
      handler: async (input) => {
        calls.push(`handler:${JSON.stringify(input)}`);
        return input;
      },
    });
    runtime.registerWorkspace({
      id: 'research',
      label: 'Research',
      handler: async (context) => {
        const result = await context.callTool('lookup', { q: ' customer risk ' });
        return {
          title: 'Prepared Tool',
          summary: 'done',
          data: { result },
        };
      },
    });

    const run = await runtime.run({
      spaces: ['research'],
      goal: 'prepare tool args',
      toolIds: ['lookup'],
    });
    const call = run.works[0]?.steps[0]?.toolCalls[0];

    expect(run.status).toBe('completed');
    expect(run.artifacts[0]?.data).toEqual({ result: { query: 'customer risk', reason: 'normalized lookup' } });
    expect(call?.input).toEqual({ query: 'customer risk', reason: 'normalized lookup' });
    expect(call?.reason).toBe('normalized lookup');
    expect(calls).toEqual([
      'prepare:research: customer risk ',
      'before:{"query":"customer risk","reason":"normalized lookup"}:normalized lookup',
      'handler:{"query":"customer risk","reason":"normalized lookup"}',
    ]);
  });

  it('exposes tool execution metadata to workspace tool descriptors', async () => {
    const runtime = new AgentRuntime({ idFactory: createIdFactory() });

    runtime.registerTool({
      id: 'lookup',
      promptSnippet: 'Look up external facts.',
      promptGuidelines: ['Use when local context is insufficient.'],
      executionMode: 'parallel',
      cache: { produces: true, kinds: ['tool_result'], capture: 'auto', maxContentChars: 1024 },
      handler: async () => 'lookup',
    });
    runtime.registerTool({
      id: 'write',
      handler: async () => 'write',
    });
    runtime.registerTool({
      id: 'remember',
      parameters: {
        type: 'object',
        properties: { memory: { type: 'string' } },
        required: ['memory'],
        additionalProperties: false,
      },
      describe: (context) => ({
        parameters: {
          type: 'object',
          properties: {
            memory: { type: 'string' },
            ...(context.workspaceId === 'research' ? { visibility: { type: 'string', enum: ['user', 'global'] } } : {}),
          },
          required: ['memory'],
          additionalProperties: false,
        },
      }),
      handler: async () => 'remember',
    });
    runtime.registerWorkspace({
      id: 'research',
      label: 'Research',
      handler: async (context) => ({
        title: 'Tool Metadata',
        summary: 'tool descriptors captured',
        data: { tools: context.availableTools },
      }),
    });

    const run = await runtime.run({
      spaces: ['research'],
      goal: 'inspect tool metadata',
      toolIds: ['lookup', 'write', 'remember'],
    });

    expect(run.status).toBe('completed');
    expect(run.artifacts[0]?.data).toEqual({
      tools: [
        expect.objectContaining({
          id: 'lookup',
          promptSnippet: 'Look up external facts.',
          promptGuidelines: ['Use when local context is insufficient.'],
          executionMode: 'parallel',
          cache: { produces: true, kinds: ['tool_result'], capture: 'auto', maxContentChars: 1024 },
        }),
        expect.objectContaining({ id: 'write', executionMode: 'sequential' }),
        expect.objectContaining({
          id: 'remember',
          parameters: expect.objectContaining({
            properties: expect.objectContaining({
              memory: { type: 'string' },
              visibility: { type: 'string', enum: ['user', 'global'] },
            }),
          }),
        }),
      ],
    });
  });

  it('records prepareArguments failures as failed tool calls before beforeToolCall and handler execution', async () => {
    const runtime = new AgentRuntime({ idFactory: createIdFactory() });
    const calls: string[] = [];

    runtime.registerHook({
      beforeToolCall: ({ call }) => {
        calls.push(`before:${call.toolId}`);
      },
      afterToolCall: ({ call }) => {
        calls.push(`after:${call.toolId}:${call.error?.code}`);
      },
    });
    runtime.registerTool({
      id: 'lookup',
      prepareArguments: async () => {
        calls.push('prepare');
        throw new Error('SECRET_PREPARE_FAILURE');
      },
      handler: async () => {
        calls.push('handler');
        return 'never';
      },
    });
    runtime.registerWorkspace({
      id: 'research',
      label: 'Research',
      handler: async (context) => {
        await context.callTool('lookup', { q: 'raw' });
        return {
          title: 'never',
          summary: 'never',
        };
      },
    });

    const run = await runtime.run({
      spaces: ['research'],
      goal: 'prepare failure',
      toolIds: ['lookup'],
    });
    const call = run.works[0]?.steps[0]?.toolCalls[0];

    expect(run.status).toBe('failed');
    expect(run.error?.code).toBe('tool_failed');
    expect(call?.input).toEqual({ q: 'raw' });
    expect(call?.error?.code).toBe('tool_failed');
    expect(call?.error?.message).toBe('Tool failed: lookup');
    expect(calls).toEqual(['prepare', 'after:lookup:tool_failed']);
    expect(JSON.stringify(call?.error)).not.toContain('SECRET_PREPARE_FAILURE');
  });

  it('preserves explicit tool_failed validation messages from prepareArguments', async () => {
    const runtime = new AgentRuntime({ idFactory: createIdFactory() });
    const calls: string[] = [];
    const validationError = new Error('write requires a "content" string.') as Error & { code: 'tool_failed' };
    validationError.code = 'tool_failed';

    runtime.registerHook({
      afterToolCall: ({ call }) => {
        calls.push(`after:${call.toolId}:${call.error?.message}`);
      },
    });
    runtime.registerTool({
      id: 'write',
      prepareArguments: async () => {
        throw validationError;
      },
      handler: async () => 'never',
    });
    runtime.registerWorkspace({
      id: 'research',
      label: 'Research',
      handler: async (context) => {
        await context.callTool('write', { reason: 'missing fields' });
        return {
          title: 'never',
          summary: 'never',
        };
      },
    });

    const run = await runtime.run({
      spaces: ['research'],
      goal: 'prepare validation failure',
      toolIds: ['write'],
    });
    const call = run.works[0]?.steps[0]?.toolCalls[0];

    expect(run.status).toBe('failed');
    expect(run.error?.code).toBe('tool_failed');
    expect(run.error?.message).toBe('write requires a "content" string.');
    expect(call?.error?.code).toBe('tool_failed');
    expect(call?.error?.message).toBe('write requires a "content" string.');
    expect(calls).toEqual(['after:write:write requires a "content" string.']);
  });

  it('fails closed when a beforeToolCall hook rejects a tool call', async () => {
    const runtime = new AgentRuntime({ idFactory: createIdFactory() });
    const calls: string[] = [];

    runtime.registerHook({
      beforeToolCall: ({ call }) => {
        calls.push(`before:${call.toolId}`);
        throw new Error('policy denied');
      },
      afterToolCall: ({ call }) => {
        calls.push(`after:${call.toolId}:${call.error?.code}`);
      },
    });
    runtime.registerTool({
      id: 'lookup',
      handler: async () => {
        calls.push('handler');
        return 'never';
      },
    });
    runtime.registerWorkspace({
      id: 'research',
      label: 'Research',
      handler: async (context) => {
        await context.callTool('lookup', {});
        return {
          title: 'never',
          summary: 'never',
        };
      },
    });

    const run = await runtime.run({
      spaces: ['research'],
      goal: 'blocked tool',
      toolIds: ['lookup'],
    });
    const call = run.works[0]?.steps[0]?.toolCalls[0];

    expect(run.status).toBe('failed');
    expect(run.error?.code).toBe('tool_failed');
    expect(call?.error?.code).toBe('tool_failed');
    expect(calls).toEqual(['before:lookup', 'after:lookup:tool_failed']);
  });

  it('records afterToolCall hook failures without failing a successful tool call', async () => {
    const runtime = new AgentRuntime({ idFactory: createIdFactory() });
    const events: AgentEvent[] = [];
    runtime.observe((event) => {
      events.push(event);
    });

    runtime.registerHook({
      afterToolCall: () => {
        throw Object.assign(new Error('SECRET_AFTER_HOOK'), { code: 'EHOOK' });
      },
    });
    runtime.registerTool({
      id: 'lookup',
      handler: async () => ({ ok: true }),
    });
    runtime.registerWorkspace({
      id: 'research',
      label: 'Research',
      handler: async (context) => {
        const result = await context.callTool('lookup', {});
        return {
          title: 'Hook Failure',
          summary: 'tool still completed',
          data: { result },
        };
      },
    });

    const run = await runtime.run({
      spaces: ['research'],
      goal: 'best effort after hook',
      toolIds: ['lookup'],
    });
    const call = run.works[0]?.steps[0]?.toolCalls[0];
    const endEvent = events.find((event) => event.type === 'tool_execution_end') as
      | Extract<AgentEvent, { type: 'tool_execution_end' }>
      | undefined;

    expect(run.status).toBe('completed');
    expect(run.artifacts[0]?.data).toEqual({ result: { ok: true } });
    expect(call?.result).toEqual({ ok: true });
    expect(call?.error).toBeUndefined();
    expect(call?.hookFailures).toEqual([
      {
        phase: 'afterToolCall',
        message: 'afterToolCall hook failed',
        code: 'EHOOK',
        occurredAt: expect.any(Date),
      },
    ]);
    expect(endEvent?.call.hookFailures).toEqual(call?.hookFailures);
    expect(JSON.stringify(call?.hookFailures)).not.toContain('SECRET_AFTER_HOOK');
  });

  it('preserves the original tool error when afterToolCall hook failure auditing also fails', async () => {
    const runtime = new AgentRuntime({ idFactory: createIdFactory() });

    runtime.registerHook({
      afterToolCall: () => {
        throw Object.assign(new Error('SECRET_AFTER_HOOK'), { code: 'EHOOK' });
      },
    });
    runtime.registerTool({
      id: 'lookup',
      handler: async () => {
        throw { code: 'tool_failed', message: 'original tool failure' };
      },
    });
    runtime.registerWorkspace({
      id: 'research',
      label: 'Research',
      handler: async (context) => {
        await context.callTool('lookup', {});
        return {
          title: 'never',
          summary: 'never',
        };
      },
    });

    const run = await runtime.run({
      spaces: ['research'],
      goal: 'tool failure and after hook failure',
      toolIds: ['lookup'],
    });
    const call = run.works[0]?.steps[0]?.toolCalls[0];

    expect(run.status).toBe('failed');
    expect(run.error?.message).toBe('original tool failure');
    expect(call?.error?.message).toBe('original tool failure');
    expect(call?.hookFailures).toEqual([
      {
        phase: 'afterToolCall',
        message: 'afterToolCall hook failed',
        code: 'EHOOK',
        occurredAt: expect.any(Date),
      },
    ]);
    expect(JSON.stringify(call?.hookFailures)).not.toContain('SECRET_AFTER_HOOK');
  });

  it('passes the request workspaceRoot into workspace and tool contexts', async () => {
    const runtime = new AgentRuntime({ idFactory: createIdFactory() });
    const workspaceRoot = '/tmp/zleap-runtime-project';

    runtime.registerTool({
      id: 'inspect-root',
      handler: async (_input, context) => ({ workspaceRoot: context.workspaceRoot }),
    });
    runtime.registerWorkspace({
      id: 'terminal',
      label: 'Terminal',
      handler: async (context) => {
        const toolResult = await context.callTool('inspect-root', {});
        return {
          title: 'Root Probe',
          summary: context.workspaceRoot ?? 'missing',
          data: {
            workspaceRoot: context.workspaceRoot,
            toolResult,
          },
        };
      },
    });

    const run = await runtime.run({
      spaces: ['terminal'],
      goal: 'inspect root',
      toolIds: ['inspect-root'],
      workspaceRoot,
    });

    expect(run.status).toBe('completed');
    expect(run.artifacts[0]?.data).toEqual({
      workspaceRoot,
      toolResult: { workspaceRoot },
    });
  });

  it('auto-fills a reason before executing tools that opt into runtime rationale checks', async () => {
    const runtime = new AgentRuntime({ idFactory: createIdFactory() });
    let executed = false;
    let executedInput: unknown;

    runtime.registerTool({
      id: 'mutate-file',
      requiresReason: true,
      recovery: { autofill: ['reason'] },
      handler: async (input) => {
        executed = true;
        executedInput = input;
        return 'updated';
      },
    });
    runtime.registerWorkspace({
      id: 'terminal',
      label: 'Terminal',
      handler: async (context) => {
        await context.callTool('mutate-file', { path: 'a.txt' });
        return {
          title: 'updated',
          summary: 'updated',
        };
      },
    });

    const run = await runtime.run({
      spaces: ['terminal'],
      goal: 'missing reason',
      toolIds: ['mutate-file'],
    });

    const call = run.works[0]?.steps[0]?.toolCalls[0];
    expect(run.status).toBe('completed');
    expect(call?.toolId).toBe('mutate-file');
    expect(call?.reason).toContain('Runtime auto reason: run mutate-file on path="a.txt"');
    expect(call?.error).toBeUndefined();
    expect(executed).toBe(true);
    expect(executedInput).toMatchObject({
      path: 'a.txt',
      reason: expect.stringContaining('Runtime auto reason: run mutate-file on path="a.txt"'),
    });
  });

  it('does not auto-fill a missing reason unless the tool opts into recovery', async () => {
    const runtime = new AgentRuntime({ idFactory: createIdFactory() });
    let executed = false;

    runtime.registerTool({
      id: 'strict-mutate-file',
      requiresReason: true,
      handler: async () => {
        executed = true;
        return 'updated';
      },
    });
    runtime.registerWorkspace({
      id: 'terminal',
      label: 'Terminal',
      handler: async (context) => {
        await context.callTool('strict-mutate-file', { path: 'a.txt' });
        return {
          title: 'updated',
          summary: 'updated',
        };
      },
    });

    const run = await runtime.run({
      spaces: ['terminal'],
      goal: 'missing reason',
      toolIds: ['strict-mutate-file'],
    });

    const call = run.works[0]?.steps[0]?.toolCalls[0];
    expect(run.status).toBe('failed');
    expect(call?.toolId).toBe('strict-mutate-file');
    expect(call?.error?.code).toBe('tool_reason_required');
    expect(executed).toBe(false);
  });

  it('coerces safe primitive string arguments from the tool schema', async () => {
    const runtime = new AgentRuntime({ idFactory: createIdFactory() });
    let executedInput: unknown;

    runtime.registerTool({
      id: 'configure',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer' },
          ratio: { type: 'number' },
          enabled: { type: 'boolean' },
        },
        required: ['limit', 'ratio', 'enabled'],
        additionalProperties: false,
      },
      handler: async (input) => {
        executedInput = input;
        return input;
      },
    });
    runtime.registerWorkspace({
      id: 'terminal',
      label: 'Terminal',
      handler: async (context) => {
        await context.callTool('configure', { limit: '5', ratio: '0.25', enabled: 'false' });
        return {
          title: 'configured',
          summary: 'configured',
        };
      },
    });

    const run = await runtime.run({
      spaces: ['terminal'],
      goal: 'configure tool',
      toolIds: ['configure'],
    });

    expect(run.status).toBe('completed');
    expect(executedInput).toEqual({ limit: 5, ratio: 0.25, enabled: false });
  });

  it('accepts request-scoped skill definitions without global registry registration', async () => {
    const runtime = new AgentRuntime({ idFactory: createIdFactory() });
    runtime.registerTool({
      id: 'lookup',
      description: 'Lookup a value.',
      parameters: { type: 'object' },
      handler: async () => 'scoped-result',
    });
    runtime.registerWorkspace({
      id: 'research',
      label: 'Research',
      handler: async (context) => {
        const result = await context.callTool('lookup', {});
        return {
          title: 'Scoped Skill',
          summary: context.skills.map((skill) => `${skill.id}:${skill.instructions}`).join(','),
          data: {
            result,
            tools: context.availableTools.map((tool) => tool.id),
          },
        };
      },
    });

    const run = await runtime.run({
      spaces: ['research'],
      goal: 'request-scoped skill',
      skillIds: ['repo-research'],
      skills: [
        {
          id: 'repo-research',
          label: 'Repo Research',
          instructions: 'Read first.',
          toolIds: ['lookup'],
        },
      ],
    });

    expect(run.status).toBe('completed');
    expect(run.works[0]?.skillIds).toEqual(['repo-research']);
    expect(run.artifacts[0]?.summary).toBe('repo-research:Read first.');
    expect(run.artifacts[0]?.data).toEqual({
      result: 'scoped-result',
      tools: ['lookup'],
    });
  });

  it('fails closed when a workspace calls a registered but unscoped tool', async () => {
    const runtime = new AgentRuntime({ idFactory: createIdFactory() });
    runtime.registerTool({
      id: 'lookup',
      handler: async () => 'never',
    });
    runtime.registerWorkspace({
      id: 'research',
      label: 'Research',
      handler: async (context) => {
        await context.callTool('lookup', {});
        return {
          title: 'never',
          summary: 'never',
        };
      },
    });

    const run = await runtime.run({
      spaces: ['research'],
      goal: 'unscoped tool',
    });

    const step = run.works[0]?.steps[0];
    expect(run.status).toBe('failed');
    expect(run.error?.code).toBe('tool_not_allowed');
    expect(step?.toolCalls).toHaveLength(0);
  });

  it('surfaces missing tools as tool_not_found', async () => {
    const runtime = new AgentRuntime({ idFactory: createIdFactory() });
    runtime.registerWorkspace({
      id: 'research',
      label: 'Research',
      handler: async (context) => {
        await context.callTool('missing', {});
        return {
          title: 'never',
          summary: 'never',
        };
      },
    });

    const run = await runtime.run({
      spaces: ['research'],
      goal: 'missing tool',
      toolIds: ['missing'],
    });

    expect(run.status).toBe('failed');
    expect(run.error?.code).toBe('tool_not_found');
    expect(run.works[0]?.error?.code).toBe('tool_not_found');
    expect(run.works[0]?.steps[0]?.error?.code).toBe('tool_not_found');
  });

  it('surfaces failed tool handlers as tool_failed and records the failed call', async () => {
    const runtime = new AgentRuntime({ idFactory: createIdFactory() });
    runtime.registerTool({
      id: 'broken',
      handler: async () => {
        throw new Error('provider timeout');
      },
    });
    runtime.registerSkill({
      id: 'broken-tools',
      label: 'Broken Tools',
      toolIds: ['broken'],
    });
    runtime.registerWorkspace({
      id: 'research',
      label: 'Research',
      handler: async (context) => {
        await context.callTool('broken', { value: 1 });
        return {
          title: 'never',
          summary: 'never',
        };
      },
    });

    const run = await runtime.run({
      spaces: ['research'],
      goal: 'broken tool',
      skillIds: ['broken-tools'],
    });

    const call = run.works[0]?.steps[0]?.toolCalls[0];
    expect(run.status).toBe('failed');
    expect(run.error?.code).toBe('tool_failed');
    expect(call?.toolId).toBe('broken');
    expect(call?.input).toEqual({ value: 1 });
    expect(call?.error?.code).toBe('tool_failed');
    expect(call?.error?.message).toBe('Tool "broken" failed: provider timeout');
    expect(call?.endedAt).toBeInstanceOf(Date);
  });

  it('fails before work starts when a requested skill is missing', async () => {
    const runtime = new AgentRuntime({ idFactory: createIdFactory() });

    const run = await runtime.run({
      spaces: ['research'],
      goal: 'missing skill',
      skillIds: ['unknown-skill'],
    });

    expect(run.status).toBe('failed');
    expect(run.error?.code).toBe('skill_not_found');
    expect(run.works).toHaveLength(0);
  });
});

function createIdFactory(): () => string {
  let counter = 1;
  return () => `test_${counter++}`;
}

function getTitle(input: unknown): string | undefined {
  if (input && typeof input === 'object' && 'title' in input) {
    return String(input.title);
  }
  return undefined;
}
