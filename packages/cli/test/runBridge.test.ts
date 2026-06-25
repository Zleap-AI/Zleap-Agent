import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AVATAR_ID,
  type SessionEntryRecord,
  type SpaceCapabilitySnapshot,
  type SpaceSessionRecord,
  type ThreadRecord,
} from '@zleap/core';
import type { ZleapStore } from '@zleap/store';
import { RunPersistenceBridge } from '@zleap/agent';

function fakeStore() {
  const writes = {
    threads: [] as ThreadRecord[],
    sessions: [] as SpaceSessionRecord[],
    entries: [] as SessionEntryRecord[],
    runs: [] as unknown[],
    works: [] as unknown[],
    steps: [] as unknown[],
    events: [] as unknown[],
    artifacts: [] as unknown[],
    snapshots: [] as SpaceCapabilitySnapshot[],
  };
  const sessionsById = new Map<string, SpaceSessionRecord>();

  const store = {
    transaction: async (operation: (tx: ZleapStore) => Promise<unknown>) => operation(store as ZleapStore),
    avatars: {
      saveAvatar: async () => undefined,
      saveAvatarVersion: async () => undefined,
      getAvatar: async () => undefined,
      getAvatarVersion: async () => undefined,
      listAvatars: async () => [],
    },
    spaces: {
      saveSpace: async () => undefined,
      saveSpaceVersion: async () => undefined,
      saveCapability: async () => undefined,
      bindCapability: async () => undefined,
      getSpace: async () => undefined,
      getSpaceVersion: async () => undefined,
      listCapabilityBindings: async () => [],
      getSpaceSnapshot: async ({ avatarId, spaceId }) => ({
        id: `${spaceId}:configured_snapshot`,
        avatarId,
        avatarVersion: 1,
        spaceId,
        spaceVersion: 1,
        capabilities: [{ type: 'tool', id: 'grep', version: 1 }],
        createdAt: new Date('2026-01-02T03:04:05.000Z'),
      }),
    },
    models: {
      saveModelConfig: async () => undefined,
      getModelConfig: async () => undefined,
      listModelConfigs: async () => [],
      deleteModelConfig: async () => undefined,
    },
    skills: {
      saveSkill: async () => undefined,
      getSkill: async () => undefined,
      listSkills: async () => [],
    },
    mcp: {
      saveServer: async () => undefined,
      getServer: async () => undefined,
      listServers: async () => [],
      deleteServer: async () => undefined,
      saveTool: async () => undefined,
      getTool: async () => undefined,
      listTools: async () => [],
    },
    threads: {
      createThread: async (record: ThreadRecord) => {
        writes.threads.push(record);
        return record;
      },
      getThread: async (id: string) => writes.threads.find((thread) => thread.id === id),
      listThreads: async () => [],
    },
    sessions: {
      createSession: async (record: SpaceSessionRecord) => {
        writes.sessions.push(record);
        sessionsById.set(record.id, record);
        return record;
      },
      getSession: async (id: string) => sessionsById.get(id),
      appendEntry: async (record: SessionEntryRecord & { leafName?: string }) => {
        writes.entries.push(record);
        const session = sessionsById.get(record.sessionId);
        if (session) {
          sessionsById.set(session.id, { ...session, currentLeafEntryId: record.id });
        }
        return record;
      },
      setLeaf: async () => undefined,
      buildConversation: async () => [],
    },
    ledger: {
      saveRun: async (record: unknown) => {
        writes.runs.push(record);
      },
      saveWork: async (record: unknown) => {
        writes.works.push(record);
      },
      saveWorkStep: async (record: unknown) => {
        writes.steps.push(record);
      },
      saveEvent: async (record: unknown) => {
        writes.events.push(record);
      },
      listEvents: async () => [],
      saveArtifact: async (record: unknown) => {
        writes.artifacts.push(record);
      },
      saveArtifactReference: async () => undefined,
      saveCapabilitySnapshot: async (record: SpaceCapabilitySnapshot) => {
        writes.snapshots.push(record);
      },
    },
    saveSession: async () => undefined,
    touchSession: async () => undefined,
    close: async () => undefined,
  } as unknown as ZleapStore;

  return { store, writes };
}

describe('RunPersistenceBridge', () => {
  it('exposes main reply message entry ids for UI deletion', async () => {
    const { store } = fakeStore();
    const bridge = new RunPersistenceBridge({ getStore: async () => store, localConversationId: 'local' });
    const startedAt = new Date('2026-01-01T00:00:00.000Z');

    await bridge.beginReply({
      source: 'web',
      conversationId: 'conversation-1',
      goal: 'hello',
      messages: [{ role: 'user', content: 'hello' }],
      actor: { userId: 'user-1', tenantId: 'tenant-1', role: 'user' },
    });
    await bridge.handle({
      type: 'before_work',
      runId: 'run_1',
      work: {
        id: 'work_1',
        agentId: DEFAULT_AVATAR_ID,
        goal: 'hello',
        spaces: ['main'],
        skillIds: [],
        toolIds: [],
        status: 'active',
        steps: [],
        artifacts: [],
        startedAt,
      },
    });
    await bridge.handle({
      type: 'space_enter',
      runId: 'run_1',
      workId: 'work_1',
      step: { id: 'step_1', workId: 'work_1', workspaceId: 'session', status: 'active', toolCalls: [], startedAt },
    });
    await bridge.handle({
      type: 'workspace_delta',
      runId: 'run_1',
      workId: 'work_1',
      stepId: 'step_1',
      workspaceId: 'session',
      delta: { kind: 'text', text: 'hi' },
    });
    await bridge.handle({
      type: 'space_exit',
      runId: 'run_1',
      workId: 'work_1',
      step: { id: 'step_1', workId: 'work_1', workspaceId: 'session', status: 'completed', toolCalls: [], startedAt, endedAt: startedAt },
    });

    const ids = bridge.replyEntryIds();
    expect(ids.userEntryId).toMatch(/^web:conversation-1:main:entry:/);
    expect(ids.assistantEntryIds).toHaveLength(1);
    expect(ids.assistantEntryIds[0]).toMatch(/^web:conversation-1:main:entry:/);
  });

  it('persists display image attachments on the main user message entry', async () => {
    const { store, writes } = fakeStore();
    const bridge = new RunPersistenceBridge({ getStore: async () => store, localConversationId: 'local' });

    await bridge.beginReply({
      source: 'web',
      conversationId: 'conversation-1',
      goal: '能看到吗',
      messages: [{ role: 'user', content: '能看到吗' }],
      actor: { userId: 'user-1', tenantId: 'tenant-1', role: 'user' },
      displayAttachments: [
        {
          id: 'img_1',
          kind: 'image',
          name: 'clipboard.png',
          mimeType: 'image/png',
          sizeBytes: 5,
          thumbnailDataUrl: 'data:image/png;base64,dGh1bWI=',
          previewDataUrl: 'data:image/png;base64,cHJldmlldw==',
        },
      ],
    });

    const userEntry = writes.entries.find((entry) => entry.sessionId === 'web:conversation-1:main' && entry.type === 'message');
    expect(userEntry?.data).toMatchObject({
      projectionKind: 'user_message',
      source: 'reply_input',
      conversationId: 'conversation-1',
      displayAttachments: [
        {
          id: 'img_1',
          kind: 'image',
          name: 'clipboard.png',
          mimeType: 'image/png',
          sizeBytes: 5,
          thumbnailDataUrl: 'data:image/png;base64,dGh1bWI=',
          previewDataUrl: 'data:image/png;base64,cHJldmlldw==',
        },
      ],
    });
    expect(JSON.stringify(userEntry?.data)).not.toContain('dataUrl');
  });

  it('persists matching toolCallId for workspace tool preview start and end entries', async () => {
    const { store, writes } = fakeStore();
    const bridge = new RunPersistenceBridge({ getStore: async () => store, localConversationId: 'local' });
    const startedAt = new Date('2026-01-01T00:00:00.000Z');

    await bridge.beginReply({
      source: 'web',
      conversationId: 'conversation-1',
      goal: 'run cli task',
      messages: [{ role: 'user', content: 'run cli task' }],
      actor: { userId: 'user-1', tenantId: 'tenant-1', role: 'user' },
      workspaceRoot: '/tmp/zleap-workspaces/conversation-1',
    });
    await bridge.handle({
      type: 'agent_start',
      run: {
        id: 'run_1',
        agentId: DEFAULT_AVATAR_ID,
        status: 'working',
        goal: 'run cli task',
        works: [],
        artifacts: [],
        startedAt,
      },
    });
    await bridge.handle({
      type: 'before_work',
      runId: 'run_1',
      work: {
        id: 'work_1',
        agentId: DEFAULT_AVATAR_ID,
        goal: 'run cli task',
        spaces: ['cli'],
        skillIds: [],
        toolIds: ['bash'],
        status: 'active',
        steps: [],
        artifacts: [],
        startedAt,
      },
    });
    await bridge.handle({
      type: 'space_enter',
      runId: 'run_1',
      workId: 'work_1',
      step: {
        id: 'step_1',
        workId: 'work_1',
        workspaceId: 'cli',
        status: 'active',
        toolCalls: [],
        startedAt,
      },
    });
    await bridge.handle({
      type: 'workspace_delta',
      runId: 'run_1',
      workId: 'work_1',
      stepId: 'step_1',
      workspaceId: 'cli',
      delta: {
        kind: 'tool',
        name: 'bash',
        phase: 'start',
        toolCallId: 'tool_call_1',
        detail: '{"command":"echo ok"}',
      },
    });
    await bridge.handle({
      type: 'workspace_delta',
      runId: 'run_1',
      workId: 'work_1',
      stepId: 'step_1',
      workspaceId: 'cli',
      delta: {
        kind: 'tool',
        name: 'bash',
        phase: 'end',
        toolCallId: 'tool_call_1',
        detail: 'ok',
        isError: false,
      },
    });

    expect(writes.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionId: 'web:conversation-1:cli',
        type: 'tool_call',
        toolCallId: 'tool_call_1',
        data: expect.objectContaining({ toolName: 'bash', phase: 'start' }),
      }),
      expect.objectContaining({
        sessionId: 'web:conversation-1:cli',
        type: 'tool_result',
        toolCallId: 'tool_call_1',
        data: expect.objectContaining({ toolName: 'bash', phase: 'end', isError: false }),
      }),
    ]));
  });

  it('persists nested provider error causes on lifecycle records', async () => {
    const { store, writes } = fakeStore();
    const bridge = new RunPersistenceBridge({ getStore: async () => store, localConversationId: 'local' });
    const startedAt = new Date('2026-01-02T03:04:05.000Z');
    const endedAt = new Date('2026-01-02T03:05:05.000Z');
    const socketCause = Object.assign(new Error('socket closed while streaming'), {
      name: 'SocketError',
      code: 'UND_ERR_SOCKET',
      errno: 'ECONNRESET',
      request: { apiKey: 'SECRET_API_KEY' },
    });
    const providerError = {
      code: 'provider_error',
      message: 'OpenAI-compatible stream failed',
      cause: socketCause,
    };
    const workspaceError = {
      code: 'workspace_failed' as const,
      message: 'WorkSpace failed: cli',
      cause: providerError,
    };

    await bridge.beginReply({
      source: 'web',
      conversationId: 'conversation-1',
      goal: 'generate pdf',
      messages: [{ role: 'user', content: 'generate pdf' }],
      actor: { userId: 'user-1', tenantId: 'tenant-1', role: 'user' },
    });
    await bridge.handle({
      type: 'agent_start',
      run: {
        id: 'run_1',
        agentId: DEFAULT_AVATAR_ID,
        status: 'working',
        goal: 'generate pdf',
        works: [],
        artifacts: [],
        startedAt,
      },
    });
    await bridge.handle({
      type: 'before_work',
      runId: 'run_1',
      work: {
        id: 'work_1',
        agentId: DEFAULT_AVATAR_ID,
        goal: 'generate pdf',
        spaces: ['cli'],
        skillIds: [],
        toolIds: [],
        status: 'active',
        steps: [],
        artifacts: [],
        startedAt,
      },
    });
    await bridge.handle({
      type: 'space_enter',
      runId: 'run_1',
      workId: 'work_1',
      step: {
        id: 'step_1',
        workId: 'work_1',
        workspaceId: 'cli',
        status: 'active',
        toolCalls: [],
        startedAt,
      },
    });
    await bridge.handle({
      type: 'workspace_delta',
      runId: 'run_1',
      workId: 'work_1',
      stepId: 'step_1',
      workspaceId: 'cli',
      delta: {
        kind: 'provider_lifecycle',
        phase: 'response',
        requestId: 'turn-1',
        modelId: 'qwen',
        status: 'failed',
        textLength: 0,
        toolCallCount: 0,
        error: {
          code: 'provider_error',
          message: 'OpenAI-compatible stream failed',
          cause: {
            name: 'SocketError',
            code: 'UND_ERR_SOCKET',
            message: 'socket closed while streaming',
            details: { errno: 'ECONNRESET' },
          },
        },
      },
    });
    await bridge.handle({
      type: 'space_exit',
      runId: 'run_1',
      workId: 'work_1',
      step: {
        id: 'step_1',
        workId: 'work_1',
        workspaceId: 'cli',
        status: 'failed',
        toolCalls: [],
        error: workspaceError,
        startedAt,
        endedAt,
      },
    });
    await bridge.handle({
      type: 'after_work',
      runId: 'run_1',
      work: {
        id: 'work_1',
        agentId: DEFAULT_AVATAR_ID,
        goal: 'generate pdf',
        spaces: ['cli'],
        skillIds: [],
        toolIds: [],
        status: 'failed',
        steps: [],
        artifacts: [],
        error: workspaceError,
        startedAt,
        endedAt,
      },
    });
    await bridge.handle({
      type: 'agent_end',
      run: {
        id: 'run_1',
        agentId: DEFAULT_AVATAR_ID,
        status: 'failed',
        goal: 'generate pdf',
        works: [],
        artifacts: [],
        error: workspaceError,
        startedAt,
        endedAt,
      },
    });

    const expectedSummary = {
      code: 'workspace_failed',
      message: 'WorkSpace failed: cli',
      cause: {
        code: 'provider_error',
        message: 'OpenAI-compatible stream failed',
        cause: {
          name: 'SocketError',
          code: 'UND_ERR_SOCKET',
          message: 'socket closed while streaming',
          details: { errno: 'ECONNRESET' },
        },
      },
    };
    const providerEvent = writes.events.find((event) => (event as { type?: string }).type === 'after_provider_response') as { data?: { error?: unknown } };
    expect(providerEvent?.data?.error).toEqual(expectedSummary.cause);
    expect((writes.steps.at(-1) as { error?: unknown }).error).toEqual(expectedSummary);
    expect((writes.works.at(-1) as { error?: unknown }).error).toEqual(expectedSummary);
    expect((writes.runs.at(-1) as { error?: unknown }).error).toEqual(expectedSummary);
    expect(JSON.stringify(writes)).not.toContain('SECRET_API_KEY');
  });

  it('persists a durable thread, isolated space sessions, and artifact handoff entries', async () => {
    const { store, writes } = fakeStore();
    const bridge = new RunPersistenceBridge({ getStore: async () => store, localConversationId: 'local' });
    const startedAt = new Date('2026-01-02T03:04:05.000Z');

    await bridge.beginReply({
      source: 'web',
      conversationId: 'conversation-1',
      goal: 'search foo',
      messages: [{ role: 'user', content: 'search foo' }],
      actor: { userId: 'user-1', role: 'user', tenantId: 'tenant-1' },
      workspaceRoot: '/tmp/zleap-workspaces/conversation-1',
    });
    await bridge.handle({
      type: 'agent_start',
      run: {
        id: 'run_1',
        agentId: DEFAULT_AVATAR_ID,
        status: 'working',
        goal: 'search foo',
        works: [],
        artifacts: [],
        startedAt,
      },
    });
    await bridge.handle({
      type: 'before_work',
      runId: 'run_1',
      work: {
        id: 'work_1',
        agentId: DEFAULT_AVATAR_ID,
        goal: 'search foo',
        spaces: ['terminal'],
        skillIds: [],
        toolIds: ['grep'],
        status: 'active',
        steps: [],
        artifacts: [],
        startedAt,
      },
    });
    await bridge.handle({
      type: 'space_enter',
      runId: 'run_1',
      workId: 'work_1',
      step: { id: 'step_1', workId: 'work_1', workspaceId: 'terminal', status: 'active', toolCalls: [], startedAt },
    });
    await bridge.handle({
      type: 'workspace_delta',
      runId: 'run_1',
      workId: 'work_1',
      stepId: 'step_1',
      workspaceId: 'terminal',
      delta: {
        kind: 'turn_lifecycle',
        phase: 'start',
        turnId: 'turn-1',
        modelId: 'test-model',
        status: 'started',
        messageCount: 2,
        toolCount: 1,
        cacheBreakpointCount: 0,
      },
    });
    await bridge.handle({
      type: 'workspace_delta',
      runId: 'run_1',
      workId: 'work_1',
      stepId: 'step_1',
      workspaceId: 'terminal',
      delta: {
        kind: 'provider_lifecycle',
        phase: 'request',
        requestId: 'turn-1',
        modelId: 'test-model',
        status: 'started',
        messageCount: 2,
        toolCount: 1,
        cacheBreakpointCount: 0,
      },
    });
    await bridge.handle({
      type: 'workspace_delta',
      runId: 'run_1',
      workId: 'work_1',
      stepId: 'step_1',
      workspaceId: 'terminal',
      delta: {
        kind: 'provider_lifecycle',
        phase: 'response',
        requestId: 'turn-1',
        modelId: 'test-model',
        status: 'completed',
        finishReason: 'stop',
        textLength: 12,
        toolCallCount: 1,
        usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
        hookFailures: [
          {
            phase: 'afterProviderResponse',
            message: 'afterProviderResponse hook failed',
            code: 'AFTER_PROVIDER',
            occurredAt: startedAt,
          },
        ],
      },
    });
    await bridge.handle({
      type: 'workspace_delta',
      runId: 'run_1',
      workId: 'work_1',
      stepId: 'step_1',
      workspaceId: 'terminal',
      delta: {
        kind: 'turn_lifecycle',
        phase: 'end',
        turnId: 'turn-1',
        modelId: 'test-model',
        status: 'continued',
        finishReason: 'tool_calls',
        textLength: 12,
        toolCallCount: 1,
        toolResultCount: 1,
        outcome: 'tool_results',
        hookFailures: [
          {
            phase: 'afterTurn',
            message: 'afterTurn hook failed',
            code: 'AFTER_TURN',
            occurredAt: startedAt,
          },
        ],
      },
    });
    await bridge.handle({
      type: 'tool_execution_start',
      runId: 'run_1',
      workId: 'work_1',
      stepId: 'step_1',
      call: {
        id: 'call_1',
        toolId: 'grep',
        input: { query: 'foo', reason: 'locate references before editing' },
        reason: 'locate references before editing',
        startedAt,
      },
    });
    await bridge.handle({
      type: 'tool_execution_end',
      runId: 'run_1',
      workId: 'work_1',
      stepId: 'step_1',
      call: {
        id: 'call_1',
        toolId: 'grep',
        input: { query: 'foo', reason: 'locate references before editing' },
        reason: 'locate references before editing',
        startedAt,
        endedAt: startedAt,
        result: 'found foo',
        hookFailures: [
          {
            phase: 'afterToolCall',
            message: 'afterToolCall hook failed',
            code: 'EHOOK',
            occurredAt: startedAt,
          },
        ],
      },
    });
    await bridge.handle({
      type: 'tool_execution_start',
      runId: 'run_1',
      workId: 'work_1',
      stepId: 'step_1',
      call: {
        id: 'call_2',
        toolId: 'read_secret',
        input: { path: 'secret.txt' },
        startedAt,
      },
    });
    await bridge.handle({
      type: 'tool_execution_end',
      runId: 'run_1',
      workId: 'work_1',
      stepId: 'step_1',
      call: {
        id: 'call_2',
        toolId: 'read_secret',
        input: { path: 'secret.txt' },
        startedAt,
        endedAt: startedAt,
        error: {
          code: 'tool_failed',
          message: 'safe tool failure',
          cause: { raw: 'SECRET_TOOL_CAUSE' },
        },
      },
    });
    await bridge.handle({
      type: 'workspace_delta',
      runId: 'run_1',
      workId: 'work_1',
      stepId: 'step_1',
      workspaceId: 'terminal',
      delta: { kind: 'tool', name: 'grep', phase: 'end', detail: 'found foo' },
    });
    await bridge.handle({
      type: 'workspace_delta',
      runId: 'run_1',
      workId: 'work_1',
      stepId: 'step_1',
      workspaceId: 'terminal',
      delta: {
        kind: 'approval',
        status: 'needs_approval',
        approvalId: 'approval_tool_call_write',
        name: 'write',
        args: '{"path":"approval.txt"}',
        preview: 'Write approval.txt (1 line)',
        message: 'Tool "write" requires approval before execution. No action was taken.',
      },
    });
    await bridge.handle({
      type: 'workspace_delta',
      runId: 'run_1',
      workId: 'work_1',
      stepId: 'step_1',
      workspaceId: 'terminal',
      delta: {
        kind: 'approval',
        status: 'approved',
        approvalId: 'approval_tool_call_bash',
        name: 'bash',
        args: '{"command":"pnpm test"}',
        preview: 'Run command: pnpm test',
        message: 'Tool "bash" was approved for execution.',
      },
    });
    await bridge.handle({
      type: 'artifact_produced',
      runId: 'run_1',
      workId: 'work_1',
      stepId: 'step_1',
      artifact: {
        id: 'artifact_1',
        workspaceId: 'terminal',
        title: 'Search result',
        summary: 'found foo',
        data: {
          workspaceResult: {
            status: 'needs_user_input',
            summary: 'Need a target file before editing.',
            artifacts: [],
            observations: ['Found foo'],
            errors: [],
            suggestedNextSteps: ['Ask the user for the file path'],
          },
        },
        createdAt: startedAt,
      },
    });
    await bridge.handle({
      type: 'space_exit',
      runId: 'run_1',
      workId: 'work_1',
      step: {
        id: 'step_1',
        workId: 'work_1',
        workspaceId: 'terminal',
        status: 'exited',
        toolCalls: [],
        startedAt,
        endedAt: startedAt,
        artifact: {
          id: 'artifact_1',
          workspaceId: 'terminal',
          title: 'Search result',
          summary: 'found foo',
          data: {
            workspaceResult: {
              status: 'needs_user_input',
              summary: 'Need a target file before editing.',
              artifacts: [],
              observations: ['Found foo'],
              errors: [],
              suggestedNextSteps: ['Ask the user for the file path'],
            },
          },
          createdAt: startedAt,
        },
        hookFailures: [
          {
            phase: 'afterSpace',
            message: 'afterSpace hook failed',
            code: 'ESPACE_AFTER',
            occurredAt: startedAt,
          },
        ],
      },
    });
    await bridge.finalizeTask({
      taskId: 'run_1',
      space: 'terminal',
      status: 'failed',
      workspaceStatus: 'needs_user_input',
      workspaceResult: {
        status: 'needs_user_input',
        summary: 'Need a target file before editing.',
        artifacts: [],
        observations: ['Found foo'],
        errors: [],
        suggestedNextSteps: ['Ask the user for the file path'],
      },
      summary: 'Need a target file before editing.',
      content: 'found foo',
      references: [],
      meta: { rounds: 1 },
    });
    await bridge.endReply({ status: 'completed', reason: 'completed' });

    expect(writes.threads).toEqual([
      expect.objectContaining({
        id: 'web:conversation-1',
        avatarId: DEFAULT_AVATAR_ID,
        userId: 'user-1',
        tenantId: 'tenant-1',
        metadata: expect.objectContaining({
          userId: 'user-1',
          actorRole: 'user',
          tenantId: 'tenant-1',
          workspaceRoot: '/tmp/zleap-workspaces/conversation-1',
        }),
      }),
    ]);
    expect(writes.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'web:conversation-1:main',
          kind: 'main',
          spaceId: 'main',
          userId: 'user-1',
          tenantId: 'tenant-1',
          metadata: expect.objectContaining({
            userId: 'user-1',
            actorRole: 'user',
            tenantId: 'tenant-1',
            workspaceRoot: '/tmp/zleap-workspaces/conversation-1',
          }),
        }),
        expect.objectContaining({
          id: 'web:conversation-1:terminal',
          kind: 'work',
          parentSessionId: 'web:conversation-1:main',
          spaceId: 'terminal',
          userId: 'user-1',
          tenantId: 'tenant-1',
          metadata: expect.objectContaining({
            userId: 'user-1',
            actorRole: 'user',
            tenantId: 'tenant-1',
            workspaceRoot: '/tmp/zleap-workspaces/conversation-1',
          }),
        }),
      ]),
    );
    const finalWorkSession = writes.sessions.filter((session) => session.id === 'web:conversation-1:terminal').at(-1);
    expect(finalWorkSession).toMatchObject({
      status: 'suspended',
      currentLeafEntryId: expect.any(String),
      metadata: expect.objectContaining({
        runId: 'run_1',
        workId: 'work_1',
        stepId: 'step_1',
        runtimeWorkspaceId: 'terminal',
        workspaceRoot: '/tmp/zleap-workspaces/conversation-1',
        workspaceResultStatus: 'needs_user_input',
        workspaceResultSummary: 'Need a target file before editing.',
      }),
    });
    expect(JSON.stringify(finalWorkSession?.metadata)).not.toContain('Found foo');
    expect(writes.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: 'web:conversation-1:main', type: 'message', role: 'user', content: 'search foo' }),
        expect.objectContaining({
          sessionId: 'web:conversation-1:terminal',
          type: 'message',
          role: 'user',
          content: 'search foo',
          data: expect.objectContaining({
            projectionKind: 'workspace_user_message',
            source: 'space_enter',
          }),
        }),
        expect.objectContaining({
          sessionId: 'web:conversation-1:terminal',
          type: 'tool_call',
          toolCallId: 'call_1',
          data: expect.objectContaining({
            toolId: 'grep',
            reason: 'locate references before editing',
          }),
        }),
        expect.objectContaining({ sessionId: 'web:conversation-1:terminal', type: 'tool_result', role: 'tool', content: 'found foo' }),
        expect.objectContaining({ sessionId: 'web:conversation-1:terminal', type: 'capability_snapshot' }),
        expect.objectContaining({ sessionId: 'web:conversation-1:terminal', type: 'artifact', artifactId: 'artifact_1' }),
        expect.objectContaining({ sessionId: 'web:conversation-1:main', type: 'tool_result', artifactId: 'artifact_1' }),
      ]),
    );
    expect(writes.entries.find((entry) => entry.sessionId === 'web:conversation-1:main' && entry.type === 'message')?.data).toMatchObject({
      projectionKind: 'user_message',
      source: 'reply_input',
      conversationId: 'conversation-1',
      sourceRefs: [{ table: 'threads', ids: ['web:conversation-1'] }],
    });
    expect(writes.entries.find((entry) => entry.type === 'capability_snapshot')?.data).toMatchObject({
      projectionKind: 'capability_snapshot',
      source: 'space_enter',
      sourceRefs: [{ table: 'capability_snapshots', ids: ['run_1:work_1:step_1:capability_snapshot'] }],
    });
    expect(writes.entries.find((entry) => entry.toolCallId === 'call_1')?.data).toMatchObject({
      projectionKind: 'tool_execution_record',
      source: 'tool_execution_end',
      sourceRefs: [{ table: 'ledger_events', ids: ['run_1:work_1:step_1:call_1:tool_execution_end'] }],
      toolId: 'grep',
      hookFailures: [
        {
          phase: 'afterToolCall',
          message: 'afterToolCall hook failed',
          code: 'EHOOK',
          occurredAt: '2026-01-02T03:04:05.000Z',
        },
      ],
    });
    const failedToolEntry = writes.entries.find((entry) => entry.toolCallId === 'call_2');
    expect(failedToolEntry?.data).toMatchObject({
      projectionKind: 'tool_execution_record',
      source: 'tool_execution_end',
      toolId: 'read_secret',
      error: { code: 'tool_failed', message: 'safe tool failure' },
    });
    expect(JSON.stringify(failedToolEntry?.data)).not.toContain('SECRET_TOOL_CAUSE');
    expect(writes.entries.find(
      (entry) => entry.type === 'tool_result' && (entry.data as { projectionKind?: string })?.projectionKind === 'workspace_tool_preview',
    )?.data).toMatchObject({
      projectionKind: 'workspace_tool_preview',
      source: 'workspace_delta',
      phase: 'end',
    });
    expect(writes.entries.find((entry) => entry.data && (entry.data as { projectionKind?: string }).projectionKind === 'approval_request')).toMatchObject({
      sessionId: 'web:conversation-1:terminal',
      type: 'tool_result',
      role: 'tool',
      content: 'Tool "write" requires approval before execution. No action was taken.',
      data: expect.objectContaining({
        projectionKind: 'approval_request',
        source: 'workspace_delta',
        approvalId: 'approval_tool_call_write',
        toolName: 'write',
        status: 'needs_approval',
        preview: 'Write approval.txt (1 line)',
      }),
    });
    expect(writes.entries.find((entry) => entry.data && (entry.data as { projectionKind?: string }).projectionKind === 'approval_decision')).toMatchObject({
      sessionId: 'web:conversation-1:terminal',
      type: 'tool_result',
      role: 'tool',
      content: 'Tool "bash" was approved for execution.',
      data: expect.objectContaining({
        projectionKind: 'approval_decision',
        source: 'workspace_delta',
        approvalId: 'approval_tool_call_bash',
        toolName: 'bash',
        status: 'approved',
        preview: 'Run command: pnpm test',
      }),
    });
    expect(writes.entries.find((entry) => entry.type === 'artifact' && entry.artifactId === 'artifact_1')?.data).toMatchObject({
      projectionKind: 'workspace_artifact',
      source: 'artifact_produced',
      sourceRefs: [{ table: 'artifacts', ids: ['artifact_1'] }],
    });
    const handoff = writes.entries.find((entry) => entry.sessionId === 'web:conversation-1:main' && entry.artifactId === 'artifact_1');
    expect(handoff?.data).toMatchObject({
      projectionKind: 'artifact_handoff',
      source: 'artifact_produced',
      sourceSessionId: 'web:conversation-1:terminal',
      artifactId: 'artifact_1',
      workspaceResultStatus: 'needs_user_input',
      sourceRefs: [
        { table: 'artifacts', ids: ['artifact_1'] },
        { table: 'space_sessions', ids: ['web:conversation-1:terminal'] },
      ],
    });
    expect(handoff?.data).not.toHaveProperty('artifact');
    expect(JSON.stringify(handoff?.data)).not.toContain('Found foo');
    expect(writes.runs).toEqual([expect.objectContaining({ id: 'run_1', threadId: 'web:conversation-1' })]);
    expect(writes.works).toEqual([expect.objectContaining({ id: 'work_1', threadId: 'web:conversation-1' })]);
    expect(writes.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'step_1',
        status: 'active',
        sessionId: 'web:conversation-1:terminal',
        capabilitySnapshotId: 'run_1:work_1:step_1:capability_snapshot',
      }),
      expect.objectContaining({
        id: 'step_1',
        status: 'exited',
        sessionId: 'web:conversation-1:terminal',
        capabilitySnapshotId: 'run_1:work_1:step_1:capability_snapshot',
        metadata: expect.objectContaining({
          hookFailures: [
            {
              phase: 'afterSpace',
              message: 'afterSpace hook failed',
              code: 'ESPACE_AFTER',
              occurredAt: '2026-01-02T03:04:05.000Z',
            },
          ],
        }),
      }),
    ]));
    expect(writes.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'run_1:agent_start',
          runId: 'run_1',
          threadId: 'web:conversation-1',
          sessionId: 'web:conversation-1:main',
          userId: 'user-1',
          tenantId: 'tenant-1',
          type: 'agent_start',
          data: expect.objectContaining({ status: 'working', workCount: 0, artifactCount: 0 }),
        }),
        expect.objectContaining({
          id: 'run_1:work_1:before_work',
          runId: 'run_1',
          workId: 'work_1',
          threadId: 'web:conversation-1',
          sessionId: 'web:conversation-1:main',
          userId: 'user-1',
          tenantId: 'tenant-1',
          type: 'before_work',
          data: expect.objectContaining({ status: 'active', spaces: ['terminal'], toolIds: ['grep'] }),
        }),
        expect.objectContaining({
          id: 'run_1:work_1:step_1:space_enter',
          runId: 'run_1',
          workId: 'work_1',
          workStepId: 'step_1',
          threadId: 'web:conversation-1',
          sessionId: 'web:conversation-1:terminal',
          userId: 'user-1',
          tenantId: 'tenant-1',
          type: 'space_enter',
          data: expect.objectContaining({ status: 'active', workspaceId: 'terminal', toolCallCount: 0 }),
        }),
        expect.objectContaining({
          id: 'run_1:work_1:step_1:space_exit',
          runId: 'run_1',
          workId: 'work_1',
          workStepId: 'step_1',
          threadId: 'web:conversation-1',
          sessionId: 'web:conversation-1:terminal',
          userId: 'user-1',
          tenantId: 'tenant-1',
          type: 'space_exit',
          data: expect.objectContaining({
            status: 'exited',
            workspaceId: 'terminal',
            hookFailures: [
              {
                phase: 'afterSpace',
                message: 'afterSpace hook failed',
                code: 'ESPACE_AFTER',
                occurredAt: '2026-01-02T03:04:05.000Z',
              },
            ],
          }),
        }),
        expect.objectContaining({
          id: 'run_1:work_1:step_1:turn:turn-1:start',
          runId: 'run_1',
          workId: 'work_1',
          workStepId: 'step_1',
          threadId: 'web:conversation-1',
          sessionId: 'web:conversation-1:terminal',
          userId: 'user-1',
          tenantId: 'tenant-1',
          type: 'turn_start',
          data: expect.objectContaining({
            turnId: 'turn-1',
            modelId: 'test-model',
            status: 'started',
            workspaceId: 'terminal',
            messageCount: 2,
            toolCount: 1,
          }),
        }),
        expect.objectContaining({
          id: 'run_1:work_1:step_1:provider:turn-1:request',
          runId: 'run_1',
          workId: 'work_1',
          workStepId: 'step_1',
          threadId: 'web:conversation-1',
          sessionId: 'web:conversation-1:terminal',
          userId: 'user-1',
          tenantId: 'tenant-1',
          type: 'before_provider_request',
          data: expect.objectContaining({
            requestId: 'turn-1',
            modelId: 'test-model',
            status: 'started',
            workspaceId: 'terminal',
            messageCount: 2,
            toolCount: 1,
          }),
        }),
        expect.objectContaining({
          id: 'run_1:work_1:step_1:provider:turn-1:response',
          runId: 'run_1',
          workId: 'work_1',
          workStepId: 'step_1',
          threadId: 'web:conversation-1',
          sessionId: 'web:conversation-1:terminal',
          userId: 'user-1',
          tenantId: 'tenant-1',
          type: 'after_provider_response',
          data: expect.objectContaining({
            requestId: 'turn-1',
            modelId: 'test-model',
            status: 'completed',
            finishReason: 'stop',
            textLength: 12,
            toolCallCount: 1,
            usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
            hookFailures: [
              expect.objectContaining({
                phase: 'afterProviderResponse',
                message: 'afterProviderResponse hook failed',
                code: 'AFTER_PROVIDER',
                occurredAt: startedAt,
              }),
            ],
          }),
        }),
        expect.objectContaining({
          id: 'run_1:work_1:step_1:turn:turn-1:end',
          runId: 'run_1',
          workId: 'work_1',
          workStepId: 'step_1',
          threadId: 'web:conversation-1',
          sessionId: 'web:conversation-1:terminal',
          userId: 'user-1',
          tenantId: 'tenant-1',
          type: 'turn_end',
          data: expect.objectContaining({
            turnId: 'turn-1',
            modelId: 'test-model',
            status: 'continued',
            finishReason: 'tool_calls',
            textLength: 12,
            toolCallCount: 1,
            toolResultCount: 1,
            outcome: 'tool_results',
            hookFailures: [
              expect.objectContaining({
                phase: 'afterTurn',
                message: 'afterTurn hook failed',
                code: 'AFTER_TURN',
                occurredAt: startedAt,
              }),
            ],
          }),
        }),
        expect.objectContaining({
          id: 'run_1:work_1:step_1:call_1:tool_execution_start',
          runId: 'run_1',
          workId: 'work_1',
          workStepId: 'step_1',
          threadId: 'web:conversation-1',
          sessionId: 'web:conversation-1:terminal',
          userId: 'user-1',
          tenantId: 'tenant-1',
          type: 'tool_execution_start',
          data: expect.objectContaining({ toolId: 'grep', status: 'started' }),
        }),
        expect.objectContaining({
          id: 'run_1:work_1:step_1:call_1:tool_execution_end',
          runId: 'run_1',
          workId: 'work_1',
          workStepId: 'step_1',
          threadId: 'web:conversation-1',
          sessionId: 'web:conversation-1:terminal',
          userId: 'user-1',
          tenantId: 'tenant-1',
          type: 'tool_execution_end',
          data: expect.objectContaining({
            toolId: 'grep',
            status: 'completed',
            hookFailures: [
              {
                phase: 'afterToolCall',
                message: 'afterToolCall hook failed',
                code: 'EHOOK',
                occurredAt: '2026-01-02T03:04:05.000Z',
              },
            ],
          }),
        }),
        expect.objectContaining({
          id: 'run_1:work_1:step_1:call_2:tool_execution_end',
          runId: 'run_1',
          workId: 'work_1',
          workStepId: 'step_1',
          threadId: 'web:conversation-1',
          sessionId: 'web:conversation-1:terminal',
          userId: 'user-1',
          tenantId: 'tenant-1',
          type: 'tool_execution_end',
          data: expect.objectContaining({
            toolId: 'read_secret',
            status: 'failed',
            error: { message: 'safe tool failure' },
          }),
        }),
        expect.objectContaining({
          id: 'run_1:work_1:step_1:artifact:artifact_1',
          runId: 'run_1',
          workId: 'work_1',
          workStepId: 'step_1',
          threadId: 'web:conversation-1',
          sessionId: 'web:conversation-1:terminal',
          userId: 'user-1',
          tenantId: 'tenant-1',
          type: 'artifact_produced',
          data: expect.objectContaining({ artifactId: 'artifact_1', workspaceId: 'terminal', hasData: true }),
        }),
        expect.objectContaining({
          id: 'web:conversation-1:main:session_shutdown:1',
          threadId: 'web:conversation-1',
          sessionId: 'web:conversation-1:main',
          userId: 'user-1',
          tenantId: 'tenant-1',
          type: 'session_shutdown',
          data: expect.objectContaining({
            status: 'completed',
            source: 'web',
            conversationId: 'conversation-1',
            reason: 'completed',
          }),
        }),
      ]),
    );
    expect(JSON.stringify(writes.events)).not.toContain('found foo');
    expect(JSON.stringify(writes.events)).not.toContain('"query"');
    expect(JSON.stringify(writes.events)).not.toContain('search foo');
    expect(JSON.stringify(writes.events)).not.toContain('SECRET_AFTER_SPACE');
    expect(writes.snapshots).toEqual([
      expect.objectContaining({
        id: 'run_1:work_1:step_1:capability_snapshot',
        spaceId: 'terminal',
        capabilities: [expect.objectContaining({ type: 'tool', id: 'grep', version: 1 })],
      }),
    ]);
    expect(writes.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'artifact_1',
          threadId: 'web:conversation-1',
          producerSessionId: 'web:conversation-1:terminal',
          targetSessionId: 'web:conversation-1:main',
          status: 'partial',
          data: expect.objectContaining({
            workspaceResult: expect.objectContaining({ status: 'needs_user_input' }),
          }),
        }),
        expect.objectContaining({
          id: 'run_1:result',
          kind: 'task_result',
          status: 'failed',
          data: expect.objectContaining({
            workspaceStatus: 'needs_user_input',
            workspaceResult: expect.objectContaining({ status: 'needs_user_input' }),
          }),
        }),
      ]),
    );
    expect(JSON.stringify(writes.events)).not.toContain('SECRET_TOOL_CAUSE');
  });

  it('refuses to append to a durable thread owned by another actor', async () => {
    const { store, writes } = fakeStore();
    const bridge = new RunPersistenceBridge({ getStore: async () => store, localConversationId: 'local' });

    writes.threads.push({
      id: 'web:conversation-1',
      avatarId: DEFAULT_AVATAR_ID,
      userId: 'user-2',
      tenantId: 'tenant-1',
      title: 'Other user thread',
      status: 'active',
      source: 'web',
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
      updatedAt: new Date('2026-01-02T03:04:05.000Z'),
      metadata: { conversationId: 'conversation-1', userId: 'user-2', tenantId: 'tenant-1' },
    });

    await expect(bridge.beginReply({
      source: 'web',
      conversationId: 'conversation-1',
      goal: 'continue',
      messages: [{ role: 'user', content: 'continue' }],
      actor: { userId: 'user-1', role: 'user', tenantId: 'tenant-1' },
    })).rejects.toThrow('thread_forbidden');
    expect(writes.sessions).toHaveLength(0);
  });

  it('allows gateway local-dev actor to continue a legacy thread without tenant metadata', async () => {
    const { store, writes } = fakeStore();
    const bridge = new RunPersistenceBridge({ getStore: async () => store, localConversationId: 'local' });

    writes.threads.push({
      id: 'wechat:o_user@im.wechat',
      avatarId: DEFAULT_AVATAR_ID,
      userId: 'local-dev-user',
      title: 'WeChat',
      status: 'active',
      source: 'wechat',
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
      updatedAt: new Date('2026-01-02T03:04:05.000Z'),
      metadata: { conversationId: 'o_user@im.wechat', userId: 'local-dev-user' },
    });

    await bridge.beginReply({
      source: 'wechat',
      conversationId: 'o_user@im.wechat',
      goal: '你好',
      messages: [{ role: 'user', content: '你好' }],
      actor: { userId: 'local-dev-user', role: 'admin', tenantId: 'local-dev' },
    });

    expect(writes.sessions.length).toBeGreaterThan(0);
  });

  it('allows local-dev gateway actor to adopt legacy wechat sender-owned threads', async () => {
    const { store, writes } = fakeStore();
    const bridge = new RunPersistenceBridge({ getStore: async () => store, localConversationId: 'local' });
    const conversationId = 'o9cq801bEi4WFeRvcZA7L0qsNQ50@im.wechat';

    writes.threads.push({
      id: `wechat:${conversationId.replace(/[^\w:.-]+/g, '-')}`,
      avatarId: DEFAULT_AVATAR_ID,
      userId: `wechat:${conversationId}`,
      title: 'WeChat',
      status: 'active',
      source: 'wechat',
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
      updatedAt: new Date('2026-01-02T03:04:05.000Z'),
      metadata: { conversationId, userId: `wechat:${conversationId}` },
    });

    await bridge.beginReply({
      source: 'wechat',
      conversationId,
      goal: '你好',
      messages: [{ role: 'user', content: '你好' }],
      actor: { userId: 'local-dev-user', role: 'admin', tenantId: 'local-dev' },
    });

    expect(writes.sessions.length).toBeGreaterThan(0);
    expect(writes.threads.at(-1)?.userId).toBe('local-dev-user');
  });

  it('records durable projection write failures without exposing run payloads', async () => {
    const { store } = fakeStore();
    const bridge = new RunPersistenceBridge({ getStore: async () => store, localConversationId: 'local' });
    const startedAt = new Date('2026-01-02T03:04:05.000Z');
    (store.ledger.saveRun as unknown) = async () => {
      throw Object.assign(new Error('database write failed'), { code: 'ECONNRESET' });
    };

    await bridge.beginReply({
      source: 'web',
      conversationId: 'conversation-1',
      goal: 'secret user goal',
      messages: [{ role: 'user', content: 'secret user goal' }],
      actor: { userId: 'user-1', role: 'user', tenantId: 'tenant-1' },
    });
    await bridge.handle({
      type: 'agent_start',
      run: {
        id: 'run_1',
        agentId: DEFAULT_AVATAR_ID,
        status: 'working',
        goal: 'secret user goal',
        works: [],
        artifacts: [],
        startedAt,
      },
    });

    const status = bridge.inspect();
    expect(status.failureCount).toBe(1);
    expect(status.lastFailure).toMatchObject({
      phase: 'event_projection',
      operation: 'agent_start',
      code: 'ECONNRESET',
      message: 'database write failed',
    });
    expect(JSON.stringify(status)).not.toContain('secret user goal');
  });
});
