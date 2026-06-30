import type { ActorContext, AvatarVersionRecord, ModelConfigRecord, SpaceRecord, SpaceVersionRecord } from '@zleap/core';
import type { ZleapStore } from '@zleap/store';
import { homedir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../app/api/chat/route';
import { PLAN_EXECUTE_CONFIRM_MARKER, PLAN_QUESTION_START_MARKER } from '../lib/planOptions';
import { storeFromEnv } from '../lib/server/avatarStore';
import type { ProjectRecord } from '../lib/server/projectStore';
import { readToolState } from '../lib/server/toolStateStore';

const resolveWorkspaceRootMock = vi.hoisted(() => vi.fn(() => '/tmp/zleap-chat-route-test/conversation-1'));
const projectListMock = vi.hoisted(() => vi.fn<() => Promise<ProjectRecord[]>>(async () => []));
type HandleInbound = {
  channel: string;
  conversationId: string;
  kind: string;
  text: string;
  actor?: ActorContext;
  attachments?: Array<{
    id: string;
    kind: 'image';
    name: string;
    mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
    sizeBytes: number;
    data: string;
  }>;
  displayAttachments?: Array<{
    id: string;
    kind: 'image';
    name: string;
    mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
    sizeBytes: number;
    thumbnailDataUrl: string;
    previewDataUrl: string;
  }>;
};
type HandleOpts = {
  historySource?: string;
  handleCommands?: boolean;
  avatarId?: string;
  systemPrompt?: string;
  workspaceRoot?: string;
  targetSpace?: string;
  model?: { id?: string; model?: string };
  engine?: {
    disabledToolIds?: string[];
    allowedSpaceIds?: string[];
    disableAllTools?: boolean;
    taskManager?: unknown;
    temporarySkillIds?: string[];
  };
  confirm?: (request: { approvalId: string; name: string; args: string; preview?: string }) => Promise<boolean> | boolean;
  signal?: AbortSignal;
};

const conversationMock = vi.hoisted(() => {
  const constructorCalls: Array<{ deps: { store?: unknown } }> = [];
  const handleCalls: Array<{ inbound: HandleInbound; opts: HandleOpts }> = [];
  class MockConversationService {
    constructor(deps: { store?: unknown }) {
      constructorCalls.push({ deps });
    }

    async *handle(inbound: HandleInbound, opts: HandleOpts) {
      handleCalls.push({ inbound, opts });
      if (opts.targetSpace === 'approval-test') {
        const approvalRequest = {
          approvalId: 'approval_tool_call_write',
          name: 'write',
          args: '{"path":"approval.txt"}',
          preview: 'Write approval.txt (1 line)',
        };
        const approved = await opts.confirm?.(approvalRequest);
        if (approved) {
          yield { type: 'tool', name: 'write', phase: 'start', detail: approvalRequest.args };
          yield { type: 'tool', name: 'write', phase: 'end', detail: 'Wrote approval.txt', isError: false };
        } else {
          yield {
            type: 'needs_approval',
            ...approvalRequest,
            message: 'Tool "write" requires approval before execution. No action was taken.',
            workspaceId: 'terminal',
          };
        }
        yield { type: 'done' };
        return;
      }
      yield { type: 'delta', text: 'ok' };
      yield { type: 'done' };
    }
  }
  return { constructorCalls, handleCalls, MockConversationService };
});

vi.mock('@zleap/core', async () => {
  const actual = await vi.importActual<typeof import('@zleap/core')>('@zleap/core');
  return {
    ...actual,
    resolveConversationWorkspaceRoot: resolveWorkspaceRootMock,
  };
});

vi.mock('@zleap/agent/engine', () => ({
  ChatEngine: class {},
  DEFAULT_SYSTEM_PROMPT: 'System base prompt',
}));

vi.mock('@zleap/agent/conversation', async () => {
  const actual = await vi.importActual<typeof import('@zleap/agent/conversation')>('@zleap/agent/conversation');
  return {
    ...actual,
    ConversationService: conversationMock.MockConversationService,
    createSharedStore: vi.fn(async () => null),
  };
});

vi.mock('../lib/server/avatarStore', () => ({
  storeFromEnv: vi.fn(),
}));

vi.mock('../lib/server/toolStateStore', () => ({
  readToolState: vi.fn(),
}));

vi.mock('../lib/server/projectStore', () => ({
  projectStore: {
    list: projectListMock,
  },
}));

const storeFromEnvMock = vi.mocked(storeFromEnv);
const readToolStateMock = vi.mocked(readToolState);

describe('/api/chat route actor contract', () => {
  beforeEach(() => {
    storeFromEnvMock.mockReset();
    readToolStateMock.mockResolvedValue({ disabledToolSetIds: [], disabledToolIds: [], cacheByToolId: {} });
    projectListMock.mockReset();
    projectListMock.mockResolvedValue([]);
    resolveWorkspaceRootMock.mockClear();
    conversationMock.constructorCalls.length = 0;
    conversationMock.handleCalls.length = 0;
    vi.stubEnv('ZLEAP_DATABASE_URL', '');
    vi.stubEnv('ZLEAP_MODEL_BASE_URL', '');
    vi.stubEnv('ZLEAP_MODEL_API_KEY', '');
    vi.stubEnv('ZLEAP_MODEL_NAME', '');
    vi.stubEnv('LLM_BASE_URL', '');
    vi.stubEnv('LLM_API_KEY', '');
    vi.stubEnv('LLM_MODEL', '');
    vi.stubEnv('ZLEAP_APPROVAL_TIMEOUT_MS', '1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('requires an actor before reading stores or constructing the engine', async () => {
    const response = await POST(new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ history: [{ role: 'user', text: 'hello' }] }),
    }));

    await expectStatus(response, 401);
    await expect(response.json()).resolves.toMatchObject({ error: 'actor_required' });
    expect(storeFromEnvMock).not.toHaveBeenCalled();
    expect(conversationMock.constructorCalls).toHaveLength(0);
  });

  it('rejects avatars owned by another actor before constructing the engine', async () => {
    const store = makeStore({ avatarUserId: 'u2' });
    storeFromEnvMock.mockResolvedValue(store as ZleapStore);

    const response = await POST(actorRequest({ avatarId: 'avatar-u2', history: [{ role: 'user', text: 'hello' }] }));

    await expectStatus(response, 403);
    await expect(response.json()).resolves.toMatchObject({ error: 'avatar_forbidden', avatarId: 'avatar-u2' });
    expect(store.close).toHaveBeenCalledOnce();
    expect(conversationMock.constructorCalls).toHaveLength(0);
  });

  it('passes actor, workspace root, target space, disabled tools, and no-HITL approval policy into ChatEngine', async () => {
    const store = makeStore();
    storeFromEnvMock.mockResolvedValue(store as ZleapStore);
    readToolStateMock.mockResolvedValue({ disabledToolSetIds: ['files'], disabledToolIds: ['get_time'], cacheByToolId: {} });

    const response = await POST(actorRequest({
      conversationId: 'conversation-1',
      targetSpace: 'research',
      history: [{ role: 'user', text: 'hello' }],
    }));

    await expectStatus(response, 200);
    await expect(response.text()).resolves.toContain('"type":"done"');
    expect(conversationMock.handleCalls).toHaveLength(1);
    const call = conversationMock.handleCalls[0]!;
    expect(call.opts.avatarId).toBe('zleap-default');
    expect(call.opts.engine?.disabledToolIds).toEqual(
      expect.arrayContaining(['get_time', 'read', 'write', 'edit']),
    );
    expect(resolveWorkspaceRootMock).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conversation-1', titleSeed: 'hello' }),
    );
    expect(call.inbound).toMatchObject({
      channel: 'web',
      conversationId: 'conversation-1',
      actor: { userId: 'u1', role: 'user', tenantId: 't1' },
    });
    expect(call.opts).toMatchObject({
      historySource: 'store',
      handleCommands: false,
      targetSpace: 'research',
      workspaceRoot: '/tmp/zleap-chat-route-test/conversation-1',
    });
    expect(call.opts.systemPrompt).toContain('Project mode: no project selected; use this Zleap history folder for generated files.');
    expect(call.opts.systemPrompt).toContain('Use relative paths under this folder for all generated files.');
    expect(call.opts.systemPrompt).toContain('Absolute output paths outside this working directory are not current');
    expect(call.opts.systemPrompt).toContain('current conversation folder');
    expect(call.opts.systemPrompt).toContain('Do not use /tmp or system temp directories');
    await expect(call.opts.confirm?.({
      approvalId: 'approval_mcp',
      name: 'mcp__linear__list_issues__v1',
      args: '{}',
    })).resolves.toBe(false);
    await expect(call.opts.confirm?.({
      approvalId: 'approval_bash',
      name: 'bash',
      args: '{}',
    })).resolves.toBe(false);
    await expect(call.opts.confirm?.({
      approvalId: 'approval_read',
      name: 'read',
      args: '{}',
    })).resolves.toBe(true);
  });

  it('streams the resolved workspace root before tool deltas', async () => {
    const store = makeStore();
    storeFromEnvMock.mockResolvedValue(store as ZleapStore);

    const response = await POST(actorRequest({
      conversationId: 'conversation-1',
      history: [{ role: 'user', text: 'hello' }],
    }));

    await expectStatus(response, 200);
    const body = await response.text();
    expect(body).toContain('"type":"workspace_context"');
    expect(body).toContain('"workspaceRoot":"/tmp/zleap-chat-route-test/conversation-1"');
  });

  it('turns plan mode into an analysis-only prompt and disables all tools', async () => {
    const store = makeStore();
    storeFromEnvMock.mockResolvedValue(store as ZleapStore);

    const response = await POST(actorRequest({
      conversationId: 'conversation-1',
      targetSpace: 'research',
      runMode: 'plan',
      skillId: 'research-skill',
      skillLabel: '研究技能',
      history: [{ role: 'user', text: '先帮我做计划' }],
    }));

    await expectStatus(response, 200);
    await expect(response.text()).resolves.toContain('"type":"done"');
    const planOpts = conversationMock.handleCalls[0]!.opts;
    expect(planOpts.engine?.disableAllTools).toBe(true);
    expect(planOpts.targetSpace).toBeUndefined();
    expect(planOpts.systemPrompt).toContain('Run Mode: Plan');
    expect(planOpts.systemPrompt).toContain('Do not execute tools');
    expect(planOpts.systemPrompt).toContain('ask 2-3 genuinely important questions');
    expect(planOpts.systemPrompt).toContain('Do not repeat the questions and options in the main body');
    expect(planOpts.systemPrompt).toContain('"questions"');
    expect(planOpts.systemPrompt).toContain(PLAN_QUESTION_START_MARKER);
    expect(planOpts.systemPrompt).toContain(PLAN_EXECUTE_CONFIRM_MARKER);
    expect(planOpts.systemPrompt).toContain('renders it as a Continue button');
    expect(planOpts.systemPrompt).toContain('The user selected this skill in the input box: 研究技能 (research-skill)');
    expect(planOpts.engine?.temporarySkillIds).toBeUndefined();
  });

  it('passes input-box selected skills as per-turn workspace mounts', async () => {
    const store = makeStore();
    storeFromEnvMock.mockResolvedValue(store as ZleapStore);

    const response = await POST(actorRequest({
      conversationId: 'conversation-1',
      targetSpace: 'research',
      skillId: 'research-skill',
      skillLabel: '研究技能',
      history: [{ role: 'user', text: '帮我研究这个问题' }],
    }));

    await expectStatus(response, 200);
    await expect(response.text()).resolves.toContain('"type":"done"');
    const skillOpts = conversationMock.handleCalls[0]!.opts;
    expect(skillOpts.engine?.temporarySkillIds).toEqual(['research-skill']);
    expect(skillOpts.systemPrompt).toContain('Selected Skill For This Turn');
    expect(skillOpts.systemPrompt).toContain('This is a strong signal');
    expect(skillOpts.systemPrompt).not.toContain('Skill Package File Index');
  });

  it('adds goal-pursuit instructions without disabling tools', async () => {
    const store = makeStore();
    storeFromEnvMock.mockResolvedValue(store as ZleapStore);

    const response = await POST(actorRequest({
      conversationId: 'conversation-1',
      runMode: 'goal',
      history: [{ role: 'user', text: '把这个任务做完' }],
    }));

    await expectStatus(response, 200);
    await expect(response.text()).resolves.toContain('"type":"done"');
    const goalOpts = conversationMock.handleCalls[0]!.opts;
    expect(goalOpts.engine?.disableAllTools).toBe(false);
    expect(goalOpts.systemPrompt).toContain('Run Mode: Goal');
    expect(goalOpts.systemPrompt).toContain('Final Goal Report');
  });

  it('passes avatar space bindings into ChatEngine', async () => {
    const store = makeStore({ avatarMetadata: { boundSpaceIds: ['research'] } });
    storeFromEnvMock.mockResolvedValue(store as ZleapStore);

    const response = await POST(actorRequest({
      conversationId: 'conversation-1',
      avatarId: 'zleap-default',
      history: [{ role: 'user', text: 'hello' }],
    }));

    await expectStatus(response, 200);
    await expect(response.text()).resolves.toContain('"type":"done"');
    expect(conversationMock.handleCalls).toHaveLength(1);
    expect(conversationMock.handleCalls[0]!.opts.engine?.allowedSpaceIds).toEqual(['research']);
  });

  it('uses the target space model before the composer-selected model', async () => {
    const store = makeStore({
      models: [
        makeModelConfig('global-model', 'global-qwen', { isDefault: true }),
        makeModelConfig('research-model', 'research-qwen'),
      ],
      spaces: [
        {
          id: 'research',
          slug: 'research',
          kind: 'work',
          currentVersion: 1,
          status: 'active',
          createdAt: new Date('2026-01-01T00:00:00Z'),
          updatedAt: new Date('2026-01-01T00:00:00Z'),
        },
      ],
      spaceVersions: [
        {
          spaceId: 'research',
          version: 1,
          label: 'Research',
          modelConfigId: 'research-model',
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
      ],
    });
    storeFromEnvMock.mockResolvedValue(store as ZleapStore);

    const response = await POST(actorRequest({
      conversationId: 'conversation-1',
      targetSpace: 'research',
      modelId: 'global-model',
      history: [{ role: 'user', text: 'hello' }],
    }));

    await expectStatus(response, 200);
    await expect(response.text()).resolves.toContain('"type":"done"');
    expect(conversationMock.handleCalls[0]!.opts.model).toMatchObject({
      id: 'research-model',
      model: 'research-qwen',
    });
  });

  it('passes valid image attachments and display thumbnails to ConversationService', async () => {
    const store = makeStore();
    storeFromEnvMock.mockResolvedValue(store as ZleapStore);

    const response = await POST(actorRequest({
      conversationId: 'conversation-1',
      history: [{ role: 'user', text: 'describe this' }],
      attachments: [imageAttachment({ dataUrl: 'data:image/png;base64,aGVsbG8=' })],
      displayAttachments: [displayImageAttachment()],
    }));

    await expectStatus(response, 200);
    const call = conversationMock.handleCalls[0]!;
    expect(call.inbound.attachments).toEqual([{
      id: 'img_1',
      kind: 'image',
      name: 'shot.png',
      mimeType: 'image/png',
      sizeBytes: 5,
      data: 'aGVsbG8=',
    }]);
    expect(call.inbound.displayAttachments).toEqual([{
      id: 'img_1',
      kind: 'image',
      name: 'shot.png',
      mimeType: 'image/png',
      sizeBytes: 5,
      thumbnailDataUrl: 'data:image/png;base64,dGh1bWI=',
      previewDataUrl: 'data:image/png;base64,cHJldmlldw==',
    }]);
  });

  it.each([
    {
      name: 'declared size smaller than decoded bytes',
      attachments: [imageAttachment({ sizeBytes: 4 })],
    },
    {
      name: 'declared size larger than decoded bytes',
      attachments: [imageAttachment({ sizeBytes: 6 })],
    },
    {
      name: 'display-only thumbnail field at API boundary',
      attachments: [imageAttachment({ thumbnailDataUrl: 'data:image/png;base64,thumb' })],
    },
    {
      name: 'MIME mismatch',
      attachments: [imageAttachment({
        mimeType: 'image/png',
        dataUrl: 'data:image/jpeg;base64,aGVsbG8=',
      })],
    },
    {
      name: 'more than 4 images',
      attachments: [
        imageAttachment({ id: 'img_1' }),
        imageAttachment({ id: 'img_2' }),
        imageAttachment({ id: 'img_3' }),
        imageAttachment({ id: 'img_4' }),
        imageAttachment({ id: 'img_5' }),
      ],
    },
    {
      name: 'declared size over 10MB',
      attachments: [imageAttachment({ sizeBytes: 10 * 1024 * 1024 + 1 })],
    },
    {
      name: 'decoded bytes over 10MB',
      attachments: [imageAttachment({
        sizeBytes: 10,
        dataUrl: `data:image/png;base64,${Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64')}`,
      })],
    },
    {
      name: 'malformed base64 padding only',
      attachments: [imageAttachment({
        sizeBytes: 0,
        dataUrl: 'data:image/png;base64,====',
      })],
    },
    {
      name: 'malformed base64 padding in the middle',
      attachments: [imageAttachment({
        dataUrl: 'data:image/png;base64,a=bc',
      })],
    },
  ])('rejects invalid image attachment payloads: $name', async ({ attachments }) => {
    const response = await POST(actorRequest({
      conversationId: 'conversation-1',
      history: [{ role: 'user', text: 'describe this' }],
      attachments,
    }));

    await expectStatus(response, 400);
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_image_attachment' });
    expect(conversationMock.handleCalls).toHaveLength(0);
  });

  it.each([
    {
      name: 'thumbnail without matching image bytes',
      payload: {
        conversationId: 'conversation-1',
        history: [{ role: 'user', text: 'describe this' }],
        displayAttachments: [displayImageAttachment()],
      },
    },
    {
      name: 'thumbnail id mismatch',
      payload: {
        conversationId: 'conversation-1',
        history: [{ role: 'user', text: 'describe this' }],
        attachments: [imageAttachment()],
        displayAttachments: [displayImageAttachment({ id: 'img_2' })],
      },
    },
    {
      name: 'thumbnail data url MIME mismatch',
      payload: {
        conversationId: 'conversation-1',
        history: [{ role: 'user', text: 'describe this' }],
        attachments: [imageAttachment()],
        displayAttachments: [displayImageAttachment({ thumbnailDataUrl: 'data:image/jpeg;base64,dGh1bWI=' })],
      },
    },
    {
      name: 'preview data url MIME mismatch',
      payload: {
        conversationId: 'conversation-1',
        history: [{ role: 'user', text: 'describe this' }],
        attachments: [imageAttachment()],
        displayAttachments: [displayImageAttachment({ previewDataUrl: 'data:image/jpeg;base64,cHJldmlldw==' })],
      },
    },
    {
      name: 'full dataUrl field in display metadata',
      payload: {
        conversationId: 'conversation-1',
        history: [{ role: 'user', text: 'describe this' }],
        attachments: [imageAttachment()],
        displayAttachments: [displayImageAttachment({ dataUrl: 'data:image/png;base64,aGVsbG8=' })],
      },
    },
  ])('rejects invalid display image attachment payloads: $name', async ({ payload }) => {
    const response = await POST(actorRequest(payload));

    await expectStatus(response, 400);
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_display_image_attachment' });
    expect(conversationMock.handleCalls).toHaveLength(0);
  });

  it('accepts image-only turns by using a server-side current-turn prompt', async () => {
    const store = makeStore();
    storeFromEnvMock.mockResolvedValue(store as ZleapStore);

    const response = await POST(actorRequest({
      conversationId: 'conversation-1',
      history: [{ role: 'user', text: '' }],
      attachments: [imageAttachment({ dataUrl: 'data:image/png;base64,aGVsbG8=' })],
    }));

    await expectStatus(response, 200);
    const call = conversationMock.handleCalls[0]!;
    expect(call.inbound.text).toBe('Please analyze the attached image.');
    expect(call.inbound.attachments).toHaveLength(1);
  });


  it('streams needs_approval deltas from ChatEngine instead of swallowing them', async () => {
    const store = makeStore();
    storeFromEnvMock.mockResolvedValue(store as ZleapStore);

    const response = await POST(actorRequest({
      conversationId: 'conversation-approval',
      targetSpace: 'approval-test',
      history: [{ role: 'user', text: 'write a file' }],
    }));

    await expectStatus(response, 200);
    const body = await response.text();
    expect(body).toContain('"type":"needs_approval"');
    expect(body).toContain('"approvalId":"approval_tool_call_write"');
    expect(body).toContain('"name":"write"');
    expect(body).toContain('"workspaceId":"terminal"');
    expect(body).toContain('"type":"done"');
  });

  it('accepts a matching HTTP approval decision for the pending tool request', async () => {
    const store = makeStore();
    storeFromEnvMock.mockResolvedValue(store as ZleapStore);

    const response = await POST(actorRequest({
      conversationId: 'conversation-approval',
      targetSpace: 'approval-test',
      history: [{ role: 'user', text: 'write a file' }],
      approvalDecision: {
        approvalId: 'approval_tool_call_write',
        toolName: 'write',
        approved: true,
        preview: 'Write approval.txt (1 line)',
      },
    }));

    await expectStatus(response, 200);
    const body = await response.text();
    expect(body).toContain('"type":"tool"');
    expect(body).toContain('"name":"write"');
    expect(body).toContain('"detail":"Wrote approval.txt"');
    expect(body).not.toContain('"type":"needs_approval"');
  });

  it('auto-approves high-risk tools when full access permission mode is selected', async () => {
    const store = makeStore();
    storeFromEnvMock.mockResolvedValue(store as ZleapStore);

    const response = await POST(actorRequest({
      conversationId: 'conversation-approval',
      targetSpace: 'approval-test',
      permissionMode: 'full_access',
      history: [{ role: 'user', text: 'write a file' }],
    }));

    await expectStatus(response, 200);
    const body = await response.text();
    expect(body).toContain('"type":"tool"');
    expect(body).toContain('"name":"write"');
    expect(body).toContain('"detail":"Wrote approval.txt"');
    expect(body).not.toContain('"type":"needs_approval"');
  });

  it('rejects HTTP approval decisions that do not match the pending request preview', async () => {
    const store = makeStore();
    storeFromEnvMock.mockResolvedValue(store as ZleapStore);

    const response = await POST(actorRequest({
      conversationId: 'conversation-approval',
      targetSpace: 'approval-test',
      history: [{ role: 'user', text: 'write a file' }],
      approvalDecision: {
        approvalId: 'approval_tool_call_write',
        toolName: 'write',
        approved: true,
        preview: 'Write other-file.txt (1 line)',
      },
    }));

    await expectStatus(response, 200);
    const body = await response.text();
    expect(body).toContain('"type":"needs_approval"');
    expect(body).toContain('"approvalId":"approval_tool_call_write"');
    expect(body).not.toContain('"detail":"Wrote approval.txt"');
  });

  it('rejects malformed HTTP approval decisions before constructing the engine', async () => {
    const store = makeStore();
    storeFromEnvMock.mockResolvedValue(store as ZleapStore);

    const response = await POST(actorRequest({
      conversationId: 'conversation-approval',
      targetSpace: 'approval-test',
      history: [{ role: 'user', text: 'write a file' }],
      approvalDecision: {
        approvalId: 'approval_tool_call_write',
        approved: true,
      },
    }));

    await expectStatus(response, 400);
    await expect(response.json()).resolves.toEqual({ error: 'invalid_approval_decision' });
    expect(conversationMock.constructorCalls).toHaveLength(0);
  });

  it('passes the selected project root directly into ChatEngine and prompt context', async () => {
    const projectRoot = `${homedir()}/zleap-route-project`;
    const store = makeStore();
    storeFromEnvMock.mockResolvedValue(store as ZleapStore);
    projectListMock.mockResolvedValue([
      {
        id: 'project-1',
        name: 'Project One',
        path: projectRoot,
        note: 'Keep generated files under tmp.',
        spec: 'Use pnpm for scripts.',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    const response = await POST(actorRequest({
      conversationId: 'conversation-1',
      projectId: 'project-1',
      history: [{ role: 'user', text: 'hello' }],
    }));

    await expectStatus(response, 200);
    await expect(response.text()).resolves.toContain('"type":"done"');
    expect(resolveWorkspaceRootMock).not.toHaveBeenCalled();
    expect(conversationMock.handleCalls).toHaveLength(1);
    const projectOpts = conversationMock.handleCalls[0]!.opts;
    expect(projectOpts.workspaceRoot).toBe(projectRoot);
    expect(projectOpts.systemPrompt).toContain(`Working directory: ${projectRoot}`);
    expect(projectOpts.systemPrompt).toContain(`Project root: ${projectRoot}`);
    expect(projectOpts.systemPrompt).toContain('Project mode: read and write files directly in the selected project folder.');
    expect(projectOpts.systemPrompt).toContain('Use relative paths under this project root for generated files');
    expect(projectOpts.systemPrompt).toContain('Use pnpm for scripts.');
  });

  it('rejects unknown project ids before constructing the engine', async () => {
    const store = makeStore();
    storeFromEnvMock.mockResolvedValue(store as ZleapStore);
    projectListMock.mockResolvedValue([]);

    const response = await POST(actorRequest({
      conversationId: 'conversation-1',
      projectId: 'missing-project',
      history: [{ role: 'user', text: 'hello' }],
    }));

    await expectStatus(response, 404);
    await expect(response.json()).resolves.toMatchObject({ error: 'project_not_found', projectId: 'missing-project' });
    expect(conversationMock.constructorCalls).toHaveLength(0);
  });
});

function makeStore(options: {
  avatarUserId?: string;
  avatarMetadata?: Record<string, unknown>;
  models?: ModelConfigRecord[];
  spaces?: SpaceRecord[];
  spaceVersions?: SpaceVersionRecord[];
} = {}): Partial<ZleapStore> & { close: ReturnType<typeof vi.fn> } {
  const spaces = new Map((options.spaces ?? []).map((space) => [space.id, space]));
  const spaceVersions = new Map((options.spaceVersions ?? []).map((version) => [`${version.spaceId}:${version.version}`, version]));
  return {
    avatars: {
      saveAvatar: async () => {},
      saveAvatarVersion: async () => {},
      getAvatar: async (id) => ({
        id,
        userId: options.avatarUserId,
        slug: id,
        name: id,
        currentVersion: 1,
        status: 'active',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      }),
      getAvatarVersion: async (id) =>
        options.avatarMetadata
          ? ({
              avatarId: id,
              version: 1,
              name: id,
              metadata: options.avatarMetadata,
              createdAt: new Date('2026-01-01T00:00:00Z'),
            } satisfies AvatarVersionRecord)
          : undefined,
      listAvatars: async () => [],
    },
    models: {
      saveModelConfig: async () => {},
      getModelConfig: async () => undefined,
      listModelConfigs: async () => options.models ?? [],
      deleteModelConfig: async () => {},
    },
    spaces: {
      saveSpace: async () => {},
      saveSpaceVersion: async () => {},
      saveCapability: async () => {},
      bindCapability: async () => {},
      getSpace: async (id) => spaces.get(id),
      listSpaces: async () => [...spaces.values()],
      getSpaceVersion: async (spaceId, version) => spaceVersions.get(`${spaceId}:${version}`),
      listCapabilityBindings: async () => [],
      getSpaceSnapshot: async () => {
        throw new Error('not implemented');
      },
    },
    threads: {
      getThread: async () => undefined,
      createThread: async () => {},
      listThreads: async () => [],
    } as unknown as ZleapStore['threads'],
    sessions: {
      getSession: async () => undefined,
      createSession: async () => {},
    } as unknown as ZleapStore['sessions'],
    transaction: (async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        threads: { createThread: async () => {} },
        sessions: { createSession: async () => {} },
      })) as unknown as ZleapStore['transaction'],
    close: vi.fn(async () => {}),
  };
}

function makeModelConfig(id: string, model: string, config: Record<string, unknown> = {}): ModelConfigRecord {
  return {
    id,
    providerId: 'openai-compatible',
    model,
    purpose: 'main',
    config: {
      baseUrl: `https://example.test/${id}`,
      apiKey: `${id}-key`,
      ...config,
    },
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

function actorRequest(body: unknown): Request {
  return new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-zleap-user-id': 'u1',
      'x-zleap-actor-role': 'user',
      'x-zleap-tenant-id': 't1',
    },
    body: JSON.stringify(body),
  });
}

function imageAttachment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'img_1',
    kind: 'image',
    name: 'shot.png',
    mimeType: 'image/png',
    sizeBytes: 5,
    dataUrl: 'data:image/png;base64,aGVsbG8=',
    ...overrides,
  };
}

function displayImageAttachment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'img_1',
    kind: 'image',
    name: 'shot.png',
    mimeType: 'image/png',
    sizeBytes: 5,
    thumbnailDataUrl: 'data:image/png;base64,dGh1bWI=',
    previewDataUrl: 'data:image/png;base64,cHJldmlldw==',
    ...overrides,
  };
}

async function expectStatus(response: Response, status: number): Promise<void> {
  if (response.status !== status) {
    throw new Error(`expected status ${status}, got ${response.status}: ${await response.clone().text()}`);
  }
}
