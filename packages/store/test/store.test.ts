import { describe, expect, it } from 'vitest';
import { fauxEmbed } from '@zleap/ai';
import { createStore, type Embedder } from '../src/index.js';

// Integration test against a real Postgres + pgvector. Skipped unless a test DB
// is provided, e.g.:
//   docker compose up -d
//   ZLEAP_TEST_DATABASE_URL=postgres://zleap:zleap@localhost:5433/zleap pnpm --filter @zleap/store test
const url = process.env.ZLEAP_TEST_DATABASE_URL;
const DIM = 64;
const embed: Embedder = async (texts) => texts.map((text) => fauxEmbed(text, DIM));

describe.skipIf(!url)('PgStore (integration)', () => {
  it('sanitizes control bytes in ledger json payloads before writing JSONB', async () => {
    const store = await createStore({ connectionString: url!, dimension: DIM, embed });
    expect(store).not.toBeNull();
    if (!store) {
      return;
    }

    const now = new Date();
    const suffix = `${now.getTime()}_${Math.random().toString(36).slice(2)}`;
    const threadId = `thread_json_safe_${suffix}`;
    const sessionId = `session_json_safe_${suffix}`;
    const runId = `run_json_safe_${suffix}`;
    const workId = `work_json_safe_${suffix}`;
    const eventId = `event_json_safe_${suffix}`;
    const binaryLikeMessage = 'provider returned compressed bytes: \u001f�\b\u0000bad';

    await expect(store.ledger.saveRun({
      id: runId,
      avatarId: `avatar_json_safe_${suffix}`,
      avatarVersion: 1,
      threadId,
      mainSessionId: sessionId,
      status: 'failed',
      goal: 'json-safe run',
      startedAt: now,
      endedAt: now,
      error: { code: 'provider_error', message: binaryLikeMessage },
    })).resolves.toBeUndefined();

    await expect(store.ledger.saveWork({
      id: workId,
      runId,
      threadId,
      parentSessionId: sessionId,
      status: 'failed',
      goal: 'json-safe work',
      startedAt: now,
      endedAt: now,
      error: { code: 'workspace_failed', message: binaryLikeMessage },
    })).resolves.toBeUndefined();

    await expect(store.ledger.saveEvent({
      id: eventId,
      runId,
      workId,
      threadId,
      sessionId,
      userId: 'user-1',
      tenantId: 'tenant-1',
      type: 'provider_error',
      data: { error: { message: binaryLikeMessage } },
      createdAt: now,
    })).resolves.toBeUndefined();

    const events = await store.ledger.listEvents({ runId, threadId, limit: 10 });
    expect(events).toEqual([
      expect.objectContaining({
        id: eventId,
        data: { error: { message: expect.not.stringContaining('\u0000') } },
      }),
    ]);

    await store.close();
  });

  it('rejects cross-thread ledger id collisions instead of overwriting durable history', async () => {
    const store = await createStore({ connectionString: url!, dimension: DIM, embed });
    expect(store).not.toBeNull();
    if (!store) {
      return;
    }

    const now = new Date();
    const suffix = `${now.getTime()}_${Math.random().toString(36).slice(2)}`;
    const threadA = `thread_collision_a_${suffix}`;
    const threadB = `thread_collision_b_${suffix}`;
    const sessionA = `session_collision_a_${suffix}`;
    const sessionB = `session_collision_b_${suffix}`;

    const runId = `run_collision_${suffix}`;
    await store.ledger.saveRun({
      id: runId,
      avatarId: `avatar_collision_${suffix}`,
      avatarVersion: 1,
      threadId: threadA,
      mainSessionId: sessionA,
      status: 'working',
      goal: 'first run',
      startedAt: now,
    });
    await expect(
      store.ledger.saveRun({
        id: runId,
        avatarId: `avatar_collision_${suffix}`,
        avatarVersion: 1,
        threadId: threadB,
        mainSessionId: sessionB,
        status: 'working',
        goal: 'second run',
        startedAt: now,
      }),
    ).rejects.toThrow(/conflict/i);

    const otherRunId = `run_collision_other_${suffix}`;
    await store.ledger.saveRun({
      id: otherRunId,
      avatarId: `avatar_collision_${suffix}`,
      avatarVersion: 1,
      threadId: threadB,
      mainSessionId: sessionB,
      status: 'working',
      goal: 'second run',
      startedAt: now,
    });

    const workId = `work_collision_${suffix}`;
    await store.ledger.saveWork({
      id: workId,
      runId,
      threadId: threadA,
      parentSessionId: sessionA,
      status: 'active',
      goal: 'first work',
      startedAt: now,
    });
    await expect(
      store.ledger.saveWork({
        id: workId,
        runId: otherRunId,
        threadId: threadB,
        parentSessionId: sessionB,
        status: 'active',
        goal: 'second work',
        startedAt: now,
      }),
    ).rejects.toThrow(/conflict/i);

    const otherWorkId = `work_collision_other_${suffix}`;
    await store.ledger.saveWork({
      id: otherWorkId,
      runId: otherRunId,
      threadId: threadB,
      parentSessionId: sessionB,
      status: 'active',
      goal: 'second work',
      startedAt: now,
    });

    const stepId = `step_collision_${suffix}`;
    await store.ledger.saveWorkStep({
      id: stepId,
      workId,
      workspaceId: 'cli',
      sessionId: sessionA,
      status: 'active',
      startedAt: now,
    });
    await expect(
      store.ledger.saveWorkStep({
        id: stepId,
        workId: otherWorkId,
        workspaceId: 'cli',
        sessionId: sessionB,
        status: 'active',
        startedAt: now,
      }),
    ).rejects.toThrow(/conflict/i);

    const eventId = `event_collision_${suffix}`;
    await store.ledger.saveEvent({
      id: eventId,
      runId,
      workId,
      workStepId: stepId,
      threadId: threadA,
      sessionId: sessionA,
      userId: 'user-1',
      tenantId: 'tenant-1',
      type: 'tool.execution',
      data: { source: 'first' },
      createdAt: now,
    });
    await expect(
      store.ledger.saveEvent({
        id: eventId,
        runId: otherRunId,
        workId: otherWorkId,
        threadId: threadB,
        sessionId: sessionB,
        userId: 'user-1',
        tenantId: 'tenant-1',
        type: 'tool.execution',
        data: { source: 'second' },
        createdAt: now,
      }),
    ).rejects.toThrow(/conflict/i);
    await expect(store.ledger.listEvents({ runId, threadId: threadA, limit: 10 })).resolves.toEqual([
      expect.objectContaining({ id: eventId, data: { source: 'first' } }),
    ]);
    await expect(store.ledger.listEvents({ runId: otherRunId, threadId: threadB, limit: 10 })).resolves.toEqual([]);

    const artifactId = `artifact_collision_${suffix}`;
    await store.ledger.saveArtifact({
      id: artifactId,
      runId,
      workId,
      workStepId: stepId,
      threadId: threadA,
      producerSessionId: sessionA,
      workspaceId: 'cli',
      kind: 'task_result',
      status: 'success',
      title: 'first artifact',
      summary: 'first artifact',
      createdAt: now,
    });
    await expect(
      store.ledger.saveArtifact({
        id: artifactId,
        runId: otherRunId,
        workId: otherWorkId,
        threadId: threadB,
        producerSessionId: sessionB,
        workspaceId: 'cli',
        kind: 'task_result',
        status: 'success',
        title: 'second artifact',
        summary: 'second artifact',
        createdAt: now,
      }),
    ).rejects.toThrow(/conflict/i);
    await expect(store.ledger.getArtifact(artifactId)).resolves.toMatchObject({
      id: artifactId,
      runId,
      threadId: threadA,
      title: 'first artifact',
    });

    await store.close();
  });

  it('persists super-agent configuration and SpaceSession entries', async () => {
    const store = await createStore({ connectionString: url!, dimension: DIM, embed });
    expect(store).not.toBeNull();
    if (!store) {
      return;
    }

    const now = new Date();
    const suffix = now.getTime();
    const avatarId = `avatar_${suffix}`;
    const spaceId = `space_${suffix}`;
    const threadId = `thread_${suffix}`;
    const sessionId = `session_${suffix}`;
    const firstEntryId = `entry_${suffix}_1`;
    const secondEntryId = `entry_${suffix}_2`;

    await store.avatars.saveAvatar({
      id: avatarId,
      slug: avatarId,
      name: 'Test Avatar',
      currentVersion: 1,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await store.avatars.saveAvatarVersion({
      avatarId,
      version: 1,
      name: 'Test Avatar',
      persona: 'test persona',
      createdAt: now,
    });
    // A well-formed space honors id === slug (core.md §3). Use the unique suffix
    // for both so this integration test never collides with — or masquerades as —
    // the canonical 'main' space when run against a shared database.
    await store.spaces.saveSpace({
      id: spaceId,
      slug: spaceId,
      kind: 'work',
      currentVersion: 1,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await store.spaces.saveSpaceVersion({
      spaceId,
      version: 1,
      label: `Test Space ${suffix}`,
      routingCard: 'test routing card',
      instructions: 'test instructions',
      createdAt: now,
    });
    await store.spaces.saveCapability({
      id: 'dispatch',
      type: 'tool',
      version: 1,
      origin: 'builtin',
      label: 'Dispatch',
      description: 'Dispatch work to a Space.',
      schemaHash: 'hash_dispatch',
      implementationRef: 'builtin:dispatch',
      createdAt: now,
    });
    await store.spaces.bindCapability({
      id: `binding_${suffix}`,
      spaceId,
      spaceVersion: 1,
      capabilityType: 'tool',
      capabilityId: 'dispatch',
      capabilityVersion: 1,
      enabled: true,
      orderIndex: 1,
      createdAt: now,
    });
    await store.mcp.saveServer({
      id: `mcp_${suffix}`,
      userId: 'u1',
      tenantId: 't1',
      name: 'Test MCP',
      transport: 'http',
      config: { url: 'https://mcp.example.test' },
      secretRefs: [{ provider: 'env', key: 'TEST_MCP_TOKEN' }],
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    expect(await store.mcp.getServer(`mcp_${suffix}`)).toEqual(
      expect.objectContaining({
        id: `mcp_${suffix}`,
        userId: 'u1',
        tenantId: 't1',
        name: 'Test MCP',
        transport: 'http',
        secretRefs: [{ provider: 'env', key: 'TEST_MCP_TOKEN' }],
      }),
    );
    expect(await store.mcp.getServer(`mcp_${suffix}`, { userId: 'u2', tenantId: 't1' })).toBeUndefined();
    await expect(store.mcp.listServers({ userId: 'u1', tenantId: 't1' })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: `mcp_${suffix}` })]),
    );
    await expect(store.mcp.listServers({ userId: 'u2', tenantId: 't1' })).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: `mcp_${suffix}` })]),
    );
    await store.mcp.saveTool({
      id: `mcp_${suffix}:list_items`,
      serverId: `mcp_${suffix}`,
      name: 'list_items',
      version: 1,
      label: 'List items',
      inputSchema: { type: 'object' },
      createdAt: now,
    });
    expect(await store.mcp.getTool(`mcp_${suffix}:list_items`)).toEqual(
      expect.objectContaining({
        id: `mcp_${suffix}:list_items`,
        serverId: `mcp_${suffix}`,
        name: 'list_items',
        inputSchema: { type: 'object' },
      }),
    );

    const snapshot = await store.spaces.getSpaceSnapshot({ avatarId, spaceId });
    expect(snapshot.avatarId).toBe(avatarId);
    expect(snapshot.spaceId).toBe(spaceId);
    expect(snapshot.capabilities).toEqual([
      expect.objectContaining({ type: 'tool', id: 'dispatch', version: 1, schemaHash: 'hash_dispatch' }),
    ]);

    await store.threads.createThread({
      id: threadId,
      avatarId,
      userId: 'user-1',
      tenantId: 'tenant-1',
      title: 'Test thread',
      status: 'active',
      source: 'api',
    });
    await store.sessions.createSession({
      id: sessionId,
      threadId,
      avatarId,
      userId: 'user-1',
      tenantId: 'tenant-1',
      spaceId,
      kind: 'main',
      status: 'active',
      rootGoal: 'test goal',
    });
    await store.sessions.createSession({
      id: `${sessionId}_work`,
      threadId,
      avatarId,
      userId: 'user-1',
      tenantId: 'tenant-1',
      spaceId,
      kind: 'work',
      parentSessionId: sessionId,
      status: 'suspended',
      rootGoal: 'test goal',
      task: 'finish pending work',
      currentLeafEntryId: `${sessionId}_work_entry`,
      metadata: {
        workspaceResultStatus: 'needs_user_input',
        workspaceResultSummary: 'Need a target file.',
      },
    });
    await store.sessions.appendEntry({
      id: firstEntryId,
      sessionId,
      type: 'message',
      role: 'user',
      content: 'hello',
      leafName: 'current',
    });
    await store.sessions.appendEntry({
      id: secondEntryId,
      sessionId,
      parentEntryId: firstEntryId,
      type: 'message',
      role: 'assistant',
      content: 'hi',
      data: { projectionKind: 'assistant_message', source: 'test' },
      leafName: 'current',
    });
    await store.sessions.appendEntry({
      id: `entry_${suffix}_3`,
      sessionId,
      parentEntryId: secondEntryId,
      type: 'tool_result',
      role: 'tool',
      content: 'handoff summary',
      data: {
        projectionKind: 'artifact_handoff',
        source: 'artifact_produced',
        sourceRefs: [{ table: 'artifacts', ids: [`artifact_${suffix}`] }],
      },
      leafName: 'current',
    });

    await expect(store.sessions.getSession(sessionId, { userId: 'user-1', tenantId: 'tenant-1' })).resolves.toMatchObject({
      currentLeafEntryId: `entry_${suffix}_3`,
    });
    await store.sessions.createSession({
      id: sessionId,
      threadId,
      avatarId,
      userId: 'user-1',
      tenantId: 'tenant-1',
      spaceId,
      kind: 'main',
      status: 'active',
      rootGoal: 'refreshed goal',
    });
    await expect(store.sessions.getSession(sessionId, { userId: 'user-1', tenantId: 'tenant-1' })).resolves.toMatchObject({
      currentLeafEntryId: `entry_${suffix}_3`,
    });

    const conversation = await store.sessions.buildConversation({ sessionId, leafName: 'current' });
    expect(conversation).toEqual([
      { role: 'user', content: 'hello', data: undefined },
      { role: 'assistant', content: 'hi', data: { projectionKind: 'assistant_message', source: 'test' } },
    ]);
    await expect(store.sessions.buildConversation({ sessionId, leafName: 'current', userId: 'user-1', tenantId: 'tenant-1' })).resolves.toEqual([
      { role: 'user', content: 'hello', data: undefined },
      { role: 'assistant', content: 'hi', data: { projectionKind: 'assistant_message', source: 'test' } },
    ]);
    await expect(store.sessions.buildConversation({ sessionId, leafName: 'current', userId: 'user-2', tenantId: 'tenant-1' })).resolves.toEqual([]);
    await expect(store.sessions.listEntries({ sessionId, leafName: 'current', userId: 'user-1', tenantId: 'tenant-1' })).resolves.toMatchObject([
      { id: firstEntryId, type: 'message', role: 'user', content: 'hello' },
      { id: secondEntryId, type: 'message', role: 'assistant', content: 'hi' },
      { id: `entry_${suffix}_3`, type: 'tool_result', role: 'tool', content: 'handoff summary' },
    ]);
    await expect(store.sessions.listEntries({
      sessionId,
      leafName: 'current',
      projectionKind: 'artifact_handoff',
      userId: 'user-1',
      tenantId: 'tenant-1',
    })).resolves.toEqual([
      expect.objectContaining({
        id: `entry_${suffix}_3`,
        data: {
          projectionKind: 'artifact_handoff',
          source: 'artifact_produced',
          sourceRefs: [{ table: 'artifacts', ids: [`artifact_${suffix}`] }],
        },
      }),
    ]);
    await expect(store.sessions.listEntries({ sessionId, leafName: 'current', userId: 'user-2', tenantId: 'tenant-1' })).resolves.toEqual([]);

    await store.sessions.appendEntry({
      id: `entry_${suffix}_4`,
      sessionId,
      parentEntryId: `entry_${suffix}_3`,
      type: 'compaction',
      role: 'system',
      content: 'Earlier work summary',
      data: {
        projectionKind: 'compaction',
        reason: 'manual_compact',
        foldedMessages: 2,
      },
      leafName: 'current',
    });
    await store.sessions.appendEntry({
      id: `entry_${suffix}_5`,
      sessionId,
      parentEntryId: `entry_${suffix}_4`,
      type: 'message',
      role: 'user',
      content: 'recent follow-up',
      leafName: 'current',
    });
    await expect(store.sessions.buildSessionContext({ sessionId, leafName: 'current', userId: 'user-1', tenantId: 'tenant-1' })).resolves.toEqual([
      { role: 'user', content: 'recent follow-up', data: undefined },
    ]);
    await expect(store.sessions.buildSessionContext({ sessionId, leafName: 'current', userId: 'user-2', tenantId: 'tenant-1' })).resolves.toEqual([]);

    const thread = await store.threads.getThread(threadId);
    expect(thread?.mainSessionId).toBe(sessionId);
    expect(thread).toMatchObject({ userId: 'user-1', tenantId: 'tenant-1' });
    await expect(store.threads.getThread(threadId, { userId: 'user-2', tenantId: 'tenant-1' })).resolves.toBeUndefined();
    await expect(store.threads.listThreads({ userId: 'user-1', tenantId: 'tenant-1' })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: threadId })]),
    );
    await expect(store.threads.listThreads({ userId: 'user-2', tenantId: 'tenant-1' })).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: threadId })]),
    );
    await expect(store.sessions.getSession(sessionId, { userId: 'user-1', tenantId: 'tenant-1' })).resolves.toMatchObject({
      id: sessionId,
      userId: 'user-1',
      tenantId: 'tenant-1',
    });
    await expect(store.sessions.getSession(sessionId, { userId: 'user-2', tenantId: 'tenant-1' })).resolves.toBeUndefined();
    await expect(store.sessions.listSessions({
      threadId,
      parentSessionId: sessionId,
      kind: 'work',
      status: ['active', 'suspended'],
      userId: 'user-1',
      tenantId: 'tenant-1',
    })).resolves.toEqual([
      expect.objectContaining({
        id: `${sessionId}_work`,
        status: 'suspended',
        task: 'finish pending work',
        currentLeafEntryId: `${sessionId}_work_entry`,
        metadata: expect.objectContaining({
          workspaceResultStatus: 'needs_user_input',
          workspaceResultSummary: 'Need a target file.',
        }),
      }),
    ]);
    await expect(store.sessions.listSessions({
      threadId,
      parentSessionId: sessionId,
      kind: 'work',
      status: ['active', 'suspended'],
      userId: 'user-2',
      tenantId: 'tenant-1',
    })).resolves.toEqual([]);

    // listSpaces is the dispatch-catalog source (global spaces).
    const activeSpaces = await store.spaces.listSpaces({ status: 'active' });
    expect(activeSpaces.some((space) => space.id === spaceId)).toBe(true);

    await store.ledger.saveEvent({
      id: `ledger_${suffix}`,
      runId: `run_${suffix}`,
      threadId,
      sessionId,
      userId: 'user-1',
      tenantId: 'tenant-1',
      type: 'tool.execution',
      data: { tool: 'read', outcome: 'success' },
      createdAt: now,
    });
    await expect(store.ledger.listEvents({ runId: `run_${suffix}`, userId: 'user-1', tenantId: 'tenant-1' })).resolves.toEqual([
      expect.objectContaining({
        id: `ledger_${suffix}`,
        runId: `run_${suffix}`,
        userId: 'user-1',
        tenantId: 'tenant-1',
        data: { tool: 'read', outcome: 'success' },
      }),
    ]);
    await expect(store.ledger.listEvents({ runId: `run_${suffix}`, userId: 'user-2', tenantId: 'tenant-1' })).resolves.toEqual([]);

    // task_result artifact round-trip (durable TaskResult for task_detail/resume).
    const taskResultRunId = `run_${suffix}`;
    const taskResultArtifactId = `run_${suffix}:result`;
    await store.ledger.saveRun({
      id: taskResultRunId,
      avatarId,
      avatarVersion: 1,
      threadId,
      mainSessionId: sessionId,
      status: 'completed',
      goal: 'task result artifact round-trip',
      startedAt: now,
      endedAt: now,
    });
    await store.ledger.saveArtifact({
      id: taskResultArtifactId,
      workspaceId: 'terminal',
      title: 'Task result · terminal',
      summary: 'Edited two files and ran the tests.',
      data: { references: [{ kind: 'file', path: 'src/a.ts' }], meta: { rounds: 3 } },
      createdAt: new Date(),
      runId: taskResultRunId,
      threadId,
      producerSessionId: sessionId,
      kind: 'task_result',
      status: 'success',
      content: 'full raw work output…',
    });
    const restored = await store.ledger.getArtifact(taskResultArtifactId);
    expect(restored).toMatchObject({
      id: taskResultArtifactId,
      kind: 'task_result',
      status: 'success',
      summary: 'Edited two files and ran the tests.',
      content: 'full raw work output…',
    });
    expect((restored?.data as { meta?: { rounds?: number } })?.meta?.rounds).toBe(3);
    await expect(store.ledger.getArtifact(taskResultArtifactId, { userId: 'user-1', tenantId: 'tenant-1' })).resolves.toMatchObject({
      id: taskResultArtifactId,
    });
    await expect(store.ledger.getArtifact(taskResultArtifactId, { userId: 'user-2', tenantId: 'tenant-1' })).resolves.toBeUndefined();
    await expect(store.listArtifacts({ userId: 'user-1', tenantId: 'tenant-1' })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: taskResultArtifactId })]),
    );
    await expect(store.listArtifacts({ userId: 'user-2', tenantId: 'tenant-1' })).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: taskResultArtifactId })]),
    );
    expect(await store.ledger.getArtifact('missing')).toBeUndefined();

    await store.close();
  });
});
