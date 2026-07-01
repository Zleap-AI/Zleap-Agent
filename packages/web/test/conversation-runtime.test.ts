import { afterEach, describe, expect, it, vi } from 'vitest';
import { dropConversationRuntime, getConversationRuntime, type WorkbenchSnapshot } from '../lib/conversationRuntime';
import type { ContextSnapshot, Engine } from '../lib/engine';
import type { WorkPane } from '../lib/types';

describe('conversationRuntime tool settlement', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('normalizes completed hydrated panes so stale running tools do not keep spinning', () => {
    const conversationId = `test-hydrate-${Date.now()}`;
    const runtime = getConversationRuntime(conversationId, idleEngine);
    try {
      runtime.hydrate([], [
        finishedPane({
          tools: [
            {
              name: 'exitWorkspace',
              args: '{"status":"completed"}',
              result: '',
              status: 'running',
            },
          ],
        }),
      ]);

      expect(runtime.getSnapshot().workspaces[0]?.tools[0]).toMatchObject({
        name: 'exitWorkspace',
        status: 'done',
        result: 'workspace 已完成',
      });
    } finally {
      dropConversationRuntime(conversationId);
    }
  });

  it('keeps runtime tool result context blocks visible to the inspector', async () => {
    const conversationId = `test-runtime-tool-context-${Date.now()}`;
    const snapshot: ContextSnapshot = {
      seq: 1,
      createdAt: '2026-06-21T00:00:00.000Z',
      model: { id: 'qwen3.6-flash', label: 'qwen3.6-flash', contextWindow: 128_000 },
      window: { usedTokens: 120, contextWindow: 128_000, ratio: 120 / 128_000 },
      blocks: [
        {
          kind: 'variable',
          category: 'memory',
          sub: 'listMemory',
          label: '运行时工具：listMemory',
          storage: 'runtime tool result · listMemory',
          meaning: 'memory context',
          placement: 'perTurn',
          tokens: 40,
        },
        {
          kind: 'variable',
          category: 'skill',
          sub: 'listSkills',
          label: '运行时工具：listSkills',
          storage: 'runtime tool result · listSkills',
          meaning: 'skill manifests',
          placement: 'perTurn',
          tokens: 40,
        },
        {
          kind: 'variable',
          category: 'skill',
          sub: 'readSkill',
          label: '运行时工具：readSkill',
          storage: 'runtime tool result · readSkill',
          meaning: 'selected skill detail',
          placement: 'perTurn',
          tokens: 40,
        },
      ],
      breakpoints: [],
      compaction: {
        extractedCount: 0,
        itemHistoryActive: false,
        triggerTokens: 10_000,
        tailTokens: 3_200,
        foldedMessages: 0,
        summaryTokens: 0,
        lastStatus: 'idle',
      },
      raw: { systemPrompt: '', messages: [] },
    };
    const engine: Engine = async function* () {
      yield { type: 'context', snapshot };
      yield { type: 'done' };
    };
    const runtime = getConversationRuntime(conversationId, engine);
    try {
      await runtime.send('inspect context');

      expect(runtime.getSnapshot().contextSnapshot?.blocks.map((block) => block.label)).toEqual([
        '运行时工具：listMemory',
        '运行时工具：listSkills',
        '运行时工具：readSkill',
      ]);
    } finally {
      dropConversationRuntime(conversationId);
    }
  });

  it('commits display image attachments and sends request attachments to the engine', async () => {
    const conversationId = `test-image-attachments-${Date.now()}`;
    const seen: unknown[] = [];
    const engine: Engine = async function* (_history, _signal, opts) {
      seen.push(opts.attachments);
      yield { type: 'done' };
    };
    const runtime = getConversationRuntime(conversationId, engine);
    try {
      await runtime.send('describe this', {
        attachments: [{
          id: 'img_1',
          kind: 'image',
          name: 'shot.png',
          mimeType: 'image/png',
          sizeBytes: 6,
          thumbnailDataUrl: 'data:image/png;base64,thumb',
          previewDataUrl: 'data:image/png;base64,preview',
          dataUrl: 'data:image/png;base64,full',
        }],
      });

      expect(seen[0]).toEqual([{
        id: 'img_1',
        kind: 'image',
        name: 'shot.png',
        mimeType: 'image/png',
        sizeBytes: 6,
        thumbnailDataUrl: 'data:image/png;base64,thumb',
        previewDataUrl: 'data:image/png;base64,preview',
        dataUrl: 'data:image/png;base64,full',
      }]);
      expect(runtime.getSnapshot().messages[0]).toMatchObject({
        role: 'user',
        text: 'describe this',
        attachments: [{
          id: 'img_1',
          kind: 'image',
          name: 'shot.png',
          mimeType: 'image/png',
          sizeBytes: 6,
          thumbnailDataUrl: 'data:image/png;base64,thumb',
          previewDataUrl: 'data:image/png;base64,preview',
        }],
      });
      expect(JSON.stringify(runtime.getSnapshot().messages[0])).not.toContain('full');
    } finally {
      dropConversationRuntime(conversationId);
    }
  });

  it('sends image-only messages to the engine and keeps the displayed user text empty', async () => {
    const conversationId = `test-image-only-${Date.now()}`;
    const seen: unknown[] = [];
    const engine: Engine = async function* (_history, _signal, opts) {
      seen.push(opts.attachments);
      yield { type: 'done' };
    };
    const runtime = getConversationRuntime(conversationId, engine);
    try {
      await runtime.send('', {
        attachments: [{
          id: 'img_1',
          kind: 'image',
          name: 'shot.png',
          mimeType: 'image/png',
          sizeBytes: 6,
          thumbnailDataUrl: 'data:image/png;base64,thumb',
          previewDataUrl: 'data:image/png;base64,preview',
          dataUrl: 'data:image/png;base64,full',
        }],
      });

      expect(seen[0]).toHaveLength(1);
      expect(runtime.getSnapshot().messages[0]).toMatchObject({
        role: 'user',
        text: '',
        attachments: [{ id: 'img_1', name: 'shot.png' }],
      });
    } finally {
      dropConversationRuntime(conversationId);
    }
  });

  it('tracks compaction deltas without adding chat messages', async () => {
    const conversationId = `test-compaction-delta-${Date.now()}`;
    const engine: Engine = async function* () {
      yield { type: 'context_compaction_start', spaceId: 'main', attempt: 1, maxAttempts: 3 };
      yield { type: 'context_compaction_retry', spaceId: 'main', attempt: 2, maxAttempts: 3, message: 'temporary model error' };
      yield { type: 'context_compaction_done', spaceId: 'main', foldedMessages: 12, attempts: 2 };
      yield { type: 'done' };
    };
    const runtime = getConversationRuntime(conversationId, engine);
    try {
      await runtime.send('compact first');
      const snapshot = runtime.getSnapshot();
      expect(snapshot.contextCompaction.status).toBe('idle');
      expect(snapshot.messages.map((message) => message.role)).toEqual(['user']);
    } finally {
      dropConversationRuntime(conversationId);
    }
  });

  it('settles a running tool when a workspace result closes the pane before a tool end arrives', async () => {
    const conversationId = `test-stream-${Date.now()}`;
    const engine: Engine = async function* () {
      yield { type: 'space', phase: 'enter', id: 'basic', label: 'basic', goal: 'finish work' };
      yield { type: 'tool', name: 'exitWorkspace', phase: 'start', detail: '{"status":"completed"}' };
      yield { type: 'space_result', id: 'basic', envelope: { status: 'success', summary: '执行完成 · 调用 27 个工具 · 耗时 70.3s' } };
      yield { type: 'done' };
    };
    const runtime = getConversationRuntime(conversationId, engine);
    try {
      await runtime.send('finish work');

      expect(runtime.getSnapshot().workspaces[0]?.tools[0]).toMatchObject({
        name: 'exitWorkspace',
        status: 'done',
        result: 'Workspace finished: 执行完成 · 调用 27 个工具 · 耗时 70.3s',
      });
    } finally {
      dropConversationRuntime(conversationId);
    }
  });

  it('settles tools by toolCallId when the same tool name is running more than once', async () => {
    const conversationId = `test-tool-call-id-settlement-${Date.now()}`;
    const engine: Engine = async function* () {
      yield { type: 'space', phase: 'enter', id: 'basic', label: 'basic', goal: 'read skills' };
      yield { type: 'tool', name: 'readSkill', phase: 'start', detail: '{"path":"pdf/SKILL.md"}', toolCallId: 'call-1' };
      yield { type: 'tool', name: 'readSkill', phase: 'start', detail: '{"path":"docs/SKILL.md"}', toolCallId: 'call-2' };
      yield { type: 'tool', name: 'readSkill', phase: 'end', detail: 'pdf skill text', toolCallId: 'call-1' };
      yield { type: 'done' };
    };
    const runtime = getConversationRuntime(conversationId, engine);
    try {
      await runtime.send('read skills');

      expect(runtime.getSnapshot().workspaces[0]?.tools).toEqual([
        expect.objectContaining({
          toolCallId: 'call-1',
          name: 'readSkill',
          args: '{"path":"pdf/SKILL.md"}',
          result: 'pdf skill text',
          status: 'done',
        }),
        expect.objectContaining({
          toolCallId: 'call-2',
          name: 'readSkill',
          args: '{"path":"docs/SKILL.md"}',
          result: 'run 已结束,但没有收到 workspace 结果',
          status: 'done',
        }),
      ]);
    } finally {
      dropConversationRuntime(conversationId);
    }
  });

  it('sanitizes mojibake workspace text and failed workspace envelopes', async () => {
    const conversationId = `test-mojibake-workspace-${Date.now()}`;
    const noisy = '\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD \uFFFD\uFFFDKK 1 F\uFFFD\uFFFD';
    const engine: Engine = async function* () {
      yield { type: 'space', phase: 'enter', id: 'basic', label: 'basic', goal: 'create report' };
      yield { type: 'space_message', id: 'basic', text: `${noisy}\n好的，重新生成脚本。` };
      yield { type: 'tool', name: 'write', phase: 'start', detail: '{"path":"generate_pdf.py"}' };
      yield { type: 'space_result', id: 'basic', envelope: { status: 'failed', summary: noisy } };
      yield { type: 'done' };
    };
    const runtime = getConversationRuntime(conversationId, engine);
    try {
      await runtime.send('create report');

      const snap = runtime.getSnapshot();
      const paneText = snap.workspaces[0]?.messages?.map((message) => message.text).join('\n') ?? '';
      expect(paneText).not.toContain('\uFFFD');
      expect(paneText).toContain('好的，重新生成脚本。');
      expect(snap.workspaces[0]?.envelope?.summary).toBe('Workspace failed.');
      expect(snap.workspaces[0]?.tools[0]?.result).toBe('Workspace finished: Workspace failed.');
    } finally {
      dropConversationRuntime(conversationId);
    }
  });

  it('records the main dispatch that enters a workspace', async () => {
    const conversationId = `test-main-dispatch-${Date.now()}`;
    const engine: Engine = async function* () {
      yield {
        type: 'space',
        phase: 'enter',
        id: 'web-search',
        label: 'Web Search',
        goal: '完成一份 SAG 技术中文报告',
        task: '搜索 SAG 技术资料',
      };
      yield { type: 'space_result', id: 'web-search', envelope: { status: 'success', summary: '调研完成' } };
      yield { type: 'done' };
    };
    const runtime = getConversationRuntime(conversationId, engine);
    try {
      await runtime.send('SAG 是啥，帮我写个报告');

      const snap = runtime.getSnapshot();
      expect(snap.activeWorkspaceId).toBe('web-search');
      expect(snap.workspaces[0]).toMatchObject({ id: 'web-search', spaceId: 'web-search', goal: '搜索 SAG 技术资料' });
      expect(snap.workspaces[1]).toMatchObject({
        id: 'main',
        spaceId: 'main',
        label: 'Main',
        statusLine: '已进入 Web Search',
      });
      expect(snap.workspaces[1]?.tools[0]).toMatchObject({
        name: 'switchWorkspace',
        status: 'done',
        result: '已进入 Web Search',
      });
      const args = JSON.parse(snap.workspaces[1]?.tools[0]?.args ?? '{}');
      expect(args).toMatchObject({
        space: 'web-search',
        goal: '完成一份 SAG 技术中文报告',
        task: '搜索 SAG 技术资料',
      });
      expect(args).not.toHaveProperty('label');
    } finally {
      dropConversationRuntime(conversationId);
    }
  });

  it('reuses the main pane for default tools before entering a workspace', async () => {
    const conversationId = `test-default-tool-main-pane-${Date.now()}`;
    const engine: Engine = async function* () {
      yield { type: 'tool', name: 'get_time', phase: 'start', detail: '{"timezone":"Asia/Shanghai"}' };
      yield { type: 'tool', name: 'get_time', phase: 'end', detail: '2026-06-17 06:48', isError: false };
      yield { type: 'space', phase: 'enter', id: 'web-search', label: 'Web Search', goal: 'check weather' };
      yield { type: 'space_result', id: 'web-search', envelope: { status: 'success', summary: '查询完成' } };
      yield { type: 'done' };
    };
    const runtime = getConversationRuntime(conversationId, engine);
    try {
      await runtime.send('广州明天下雨吗');

      const snap = runtime.getSnapshot();
      expect(snap.workspaces.map((pane) => pane.id)).toEqual(['web-search', 'main']);
      expect(snap.workspaces.filter((pane) => pane.spaceId === 'main')).toHaveLength(1);
      expect(snap.workspaces.some((pane) => pane.spaceId === 'session')).toBe(false);
      expect(snap.workspaces[1]?.tools.map((tool) => tool.name)).toEqual(['get_time', 'switchWorkspace']);
    } finally {
      dropConversationRuntime(conversationId);
    }
  });

  it('does not render committed assistant text and live text at the same time', async () => {
    const conversationId = `test-atomic-assistant-flush-${Date.now()}`;
    const snapshots: WorkbenchSnapshot[] = [];
    const engine: Engine = async function* () {
      yield { type: 'delta', text: '我先获取当前日期。' };
      yield { type: 'tool', name: 'get_time', phase: 'start', detail: '{}' };
      yield { type: 'tool', name: 'get_time', phase: 'end', detail: '2026-06-17 06:48', isError: false };
      yield { type: 'done' };
    };
    const runtime = getConversationRuntime(conversationId, engine);
    const unsubscribe = runtime.subscribe(() => snapshots.push(runtime.getSnapshot()));
    try {
      await runtime.send('广州明天下雨吗');

      expect(
        snapshots.some((snapshot) => {
          const live = snapshot.live.trim();
          return Boolean(live) && snapshot.messages.some((message) => message.role === 'assistant' && message.text?.trim() === live);
        }),
      ).toBe(false);
    } finally {
      unsubscribe();
      dropConversationRuntime(conversationId);
    }
  });

  it('normalizes escaped markdown newlines across streamed chunks', async () => {
    const conversationId = `test-escaped-markdown-${Date.now()}`;
    const engine: Engine = async function* () {
      yield { type: 'delta', text: 'Report\\' };
      yield { type: 'delta', text: 'n## Summary\\n- One\\n- Two\\n\\nConclusion' };
      yield { type: 'done' };
    };
    const runtime = getConversationRuntime(conversationId, engine);
    try {
      await runtime.send('make report');

      expect(runtime.getSnapshot().messages.at(-1)).toMatchObject({
        role: 'assistant',
        text: 'Report\n## Summary\n- One\n- Two\n\nConclusion',
      });
    } finally {
      dropConversationRuntime(conversationId);
    }
  });

  it('merges duplicate assistant text separated only by hidden tool messages', async () => {
    const conversationId = `test-hidden-tool-assistant-dedupe-${Date.now()}`;
    const text = '广州明天会下雨，建议带伞。';
    const engine: Engine = async function* () {
      yield { type: 'delta', text };
      yield { type: 'tool', name: 'get_time', phase: 'start', detail: '{}' };
      yield { type: 'tool', name: 'get_time', phase: 'end', detail: '2026-06-17 06:48', isError: false };
      yield { type: 'delta', text };
      yield { type: 'done' };
    };
    const runtime = getConversationRuntime(conversationId, engine);
    try {
      await runtime.send('广州明天下雨吗');

      const assistants = runtime.getSnapshot().messages.filter((message) => message.role === 'assistant');
      expect(assistants).toHaveLength(1);
      expect(assistants[0]?.text).toBe(text);
    } finally {
      dropConversationRuntime(conversationId);
    }
  });

  it('merges duplicate assistant text when hydrating a restored snapshot', () => {
    const conversationId = `test-hydrate-assistant-dedupe-${Date.now()}`;
    const runtime = getConversationRuntime(conversationId, idleEngine);
    const text = '广州明天会下雨，建议带伞。';
    try {
      runtime.hydrate(
        [
          { id: 1, role: 'user', text: '广州明天下雨吗', ts: 1 },
          {
            id: 2,
            role: 'assistant',
            text,
            ts: 2,
            artifacts: [{ id: 1, spaceId: 'web-search', kind: 'url', title: '来源', detail: 'source', href: 'https://example.com/a' }],
          },
          { id: 3, role: 'tool', text: '', tool: { name: 'get_time', args: '{}', result: '2026-06-17 07:27', status: 'done' }, ts: 3 },
          {
            id: 4,
            role: 'assistant',
            text: ` ${text}\n`,
            ts: 4,
            artifacts: [{ id: 2, spaceId: 'web-search', kind: 'url', title: '来源', detail: 'source', href: 'https://example.com/a' }],
          },
        ],
        [],
        { replace: true },
      );

      const snap = runtime.getSnapshot();
      const assistants = snap.messages.filter((message) => message.role === 'assistant');
      expect(assistants).toHaveLength(1);
      expect(assistants[0]?.text).toBe(` ${text}\n`);
      expect(assistants[0]?.artifacts).toHaveLength(1);
      expect(snap.messages.filter((message) => message.role === 'tool')).toHaveLength(1);
    } finally {
      dropConversationRuntime(conversationId);
    }
  });

  it('merges duplicate assistant text separated by a restored workspace card', () => {
    const conversationId = `test-hydrate-space-assistant-dedupe-${Date.now()}`;
    const runtime = getConversationRuntime(conversationId, idleEngine);
    const text = '广州明天会下雨，建议带伞。';
    try {
      runtime.hydrate(
        [
          { id: 1, role: 'user', text: '广州明天下雨吗', ts: 1 },
          { id: 2, role: 'assistant', text, ts: 2 },
          {
            id: 3,
            role: 'space',
            text: '',
            space: { id: 'web-search', spaceId: 'web-search', label: 'Web Search' },
            envelope: { status: 'success', summary: '查询完成' },
            ts: 3,
          },
          { id: 4, role: 'assistant', text: `\n${text}`, ts: 4 },
        ],
        [],
        { replace: true },
      );

      const snap = runtime.getSnapshot();
      expect(snap.messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
      expect(snap.messages.filter((message) => message.role === 'space')).toHaveLength(1);
    } finally {
      dropConversationRuntime(conversationId);
    }
  });

  it('keeps repeated assistant text across separate user turns', () => {
    const conversationId = `test-hydrate-user-boundary-${Date.now()}`;
    const runtime = getConversationRuntime(conversationId, idleEngine);
    const text = '可以，我来处理。';
    try {
      runtime.hydrate(
        [
          { id: 1, role: 'user', text: '第一次', ts: 1 },
          { id: 2, role: 'assistant', text, ts: 2 },
          { id: 3, role: 'user', text: '第二次', ts: 3 },
          { id: 4, role: 'assistant', text, ts: 4 },
        ],
        [],
        { replace: true },
      );

      expect(runtime.getSnapshot().messages.filter((message) => message.role === 'assistant')).toHaveLength(2);
    } finally {
      dropConversationRuntime(conversationId);
    }
  });

  it('deletes a committed chat message', async () => {
    const conversationId = `test-delete-message-${Date.now()}`;
    const runtime = getConversationRuntime(conversationId, idleEngine);
    try {
      runtime.hydrate(
        [
          { id: 1, role: 'user', text: '问题', ts: 1 },
          { id: 2, role: 'assistant', text: '回答', ts: 2 },
        ],
        [],
        { replace: true },
      );

      await runtime.deleteMessage(2);

      expect(runtime.getSnapshot().messages.map((message) => message.text)).toEqual(['问题']);
    } finally {
      dropConversationRuntime(conversationId);
    }
  });

  it('binds streamed durable entry ids so message delete removes database history', async () => {
    const conversationId = `test-delete-durable-message-${Date.now()}`;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    const engine: Engine = async function* () {
      yield { type: 'delta', text: '回答' };
      yield { type: 'message_entries', userEntryId: 'entry-user', assistantEntryIds: ['entry-assistant'] };
      yield { type: 'done' };
    };
    const runtime = getConversationRuntime(conversationId, engine, { avatarId: 'zleap-default' });
    try {
      await runtime.send('问题');

      const sent = runtime.getSnapshot().messages.find((message) => message.role === 'user');
      const answer = runtime.getSnapshot().messages.find((message) => message.role === 'assistant');
      expect(sent).toMatchObject({ text: '问题', entryId: 'entry-user' });
      expect(answer).toMatchObject({ text: '回答', entryId: 'entry-assistant' });

      await runtime.deleteMessage(answer!.id);

      expect(runtime.getSnapshot().messages.map((message) => message.text)).toEqual(['问题']);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0]!;
      expect(init?.method).toBe('DELETE');
      expect(JSON.parse(String(init?.body))).toMatchObject({
        conversationId,
        avatarId: 'zleap-default',
        entryIds: ['entry-assistant'],
      });
    } finally {
      dropConversationRuntime(conversationId);
    }
  });

  it('keeps the UI message when durable deletion fails', async () => {
    const conversationId = `test-delete-durable-message-failed-${Date.now()}`;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'delete_failed' }), { status: 500 }));
    const runtime = getConversationRuntime(conversationId, idleEngine);
    try {
      runtime.hydrate(
        [
          { id: 1, entryId: 'entry-user', role: 'user', text: '问题', ts: 1 },
          { id: 2, entryId: 'entry-assistant', role: 'assistant', text: '回答', ts: 2 },
        ],
        [],
        { replace: true },
      );

      await runtime.deleteMessage(2);

      expect(runtime.getSnapshot().messages.map((message) => message.text)).toEqual(['问题', '回答']);
    } finally {
      dropConversationRuntime(conversationId);
    }
  });

  it('resends a selected user message from that point', async () => {
    const conversationId = `test-resend-message-${Date.now()}`;
    const histories: string[][] = [];
    const engine: Engine = async function* (history) {
      histories.push(history.map((turn) => turn.text));
      yield { type: 'delta', text: '重新回答' };
      yield { type: 'done' };
    };
    const runtime = getConversationRuntime(conversationId, engine);
    try {
      runtime.hydrate(
        [
          { id: 1, role: 'user', text: '第一次', ts: 1 },
          { id: 2, role: 'assistant', text: '第一次回答', ts: 2 },
          { id: 3, role: 'user', text: '第二次', ts: 3 },
          { id: 4, role: 'assistant', text: '第二次回答', ts: 4 },
        ],
        [],
        { replace: true },
      );

      await runtime.resendMessage(3);

      expect(histories).toEqual([['第一次', '第一次回答', '第二次']]);
      expect(runtime.getSnapshot().messages.map((message) => message.text)).toEqual([
        '第一次',
        '第一次回答',
        '第二次',
        '重新回答',
      ]);
    } finally {
      dropConversationRuntime(conversationId);
    }
  });

  it('registers exitWorkspace artifact refs on the workspace pane and chat card', async () => {
    const conversationId = `test-exit-artifacts-${Date.now()}`;
    const reportPath = '/tmp/agent-memory-report.md';
    const engine: Engine = async function* () {
      yield { type: 'space', phase: 'enter', id: 'web', label: 'web', goal: 'write report' };
      yield {
        type: 'tool',
        name: 'exitWorkspace',
        phase: 'start',
        detail: JSON.stringify({
          status: 'completed',
          summary: '报告已完成',
          artifacts: [{ kind: 'document', ref: `file://${reportPath}`, description: 'Agent记忆框架对比分析报告' }],
        }),
      };
      yield { type: 'tool', name: 'exitWorkspace', phase: 'end', detail: 'Workspace result accepted: completed', isError: false };
      yield { type: 'space_result', id: 'web', envelope: { status: 'success', summary: '报告已完成' } };
      yield { type: 'done' };
    };
    const runtime = getConversationRuntime(conversationId, engine);
    try {
      await runtime.send('write report');
      const snap = runtime.getSnapshot();
      expect(snap.workspaces[0]?.artifacts).toEqual([
        expect.objectContaining({ title: 'Agent记忆框架对比分析报告', path: reportPath }),
      ]);
      const spaceMessage = snap.messages.find((message) => message.role === 'space');
      expect(spaceMessage?.artifacts).toEqual([
        expect.objectContaining({ title: 'Agent记忆框架对比分析报告', path: reportPath }),
      ]);
    } finally {
      dropConversationRuntime(conversationId);
    }
  });

  it('registers workspace result references from the space result envelope', async () => {
    const conversationId = `test-space-result-references-${Date.now()}`;
    const artifactPath = '/tmp/tool-reliability-test.pptx';
    const engine: Engine = async function* () {
      yield { type: 'space', phase: 'enter', id: 'cli', label: 'Cli', goal: 'create ppt' };
      yield {
        type: 'space_result',
        id: 'cli',
        envelope: {
          status: 'success',
          summary: 'PPT 已完成',
          references: [{ kind: 'file', path: artifactPath }],
        },
      };
      yield { type: 'done' };
    };
    const runtime = getConversationRuntime(conversationId, engine);
    try {
      await runtime.send('create ppt');
      const snap = runtime.getSnapshot();

      expect(snap.workspaces[0]?.artifacts).toEqual([
        expect.objectContaining({
          title: 'tool-reliability-test.pptx',
          path: artifactPath,
        }),
      ]);
      const spaceMessage = snap.messages.find((message) => message.role === 'space');
      expect(spaceMessage?.artifacts).toEqual([
        expect.objectContaining({
          title: 'tool-reliability-test.pptx',
          path: artifactPath,
        }),
      ]);
    } finally {
      dropConversationRuntime(conversationId);
    }
  });

  it('freezes workspace artifacts onto the completed chat card', async () => {
    const conversationId = `test-artifact-handoff-${Date.now()}`;
    const artifactPath = '/Users/jomymac/Documents/Zleap/conversations/web-123/project_analysis.md';
    const engine: Engine = async function* () {
      yield { type: 'space', phase: 'enter', id: 'basic', label: 'basic', goal: 'write report' };
      yield { type: 'tool', name: 'write', phase: 'start', detail: JSON.stringify({ path: artifactPath }) };
      yield {
        type: 'tool',
        name: 'write',
        phase: 'end',
        detail: [`Created ${artifactPath} (+2)`, '+# 项目分析', '+完成'].join('\n'),
        isError: false,
      };
      yield { type: 'space_result', id: 'basic', envelope: { status: 'success', summary: '写好了项目分析文档' } };
      yield { type: 'done' };
    };
    const runtime = getConversationRuntime(conversationId, engine);
    try {
      await runtime.send('write report');

      const spaceMessage = runtime.getSnapshot().messages.find((message) => message.role === 'space');
      expect(spaceMessage?.artifacts).toEqual([
        expect.objectContaining({
          title: 'project_analysis.md',
          path: artifactPath,
          detail: 'Created (+2) · via write',
        }),
      ]);
    } finally {
      dropConversationRuntime(conversationId);
    }
  });

  it('resolves relative file mutation artifacts against the workspace root', async () => {
    const conversationId = `test-relative-artifact-path-${Date.now()}`;
    const workspaceRoot = '/Users/jomymac/Documents/Zleap/2026-06-23/conversation-1';
    const engine: Engine = async function* () {
      yield { type: 'workspace_context', workspaceRoot };
      yield { type: 'space', phase: 'enter', id: 'basic', label: 'basic', goal: 'write report' };
      yield { type: 'tool', name: 'write', phase: 'start', detail: JSON.stringify({ path: 'output/pdf/302_AI_Research_Report.pdf' }) };
      yield {
        type: 'tool',
        name: 'write',
        phase: 'end',
        detail: ['Created output/pdf/302_AI_Research_Report.pdf (+2)', '+%PDF', '+%%EOF'].join('\n'),
      };
      yield { type: 'space_result', id: 'basic', envelope: { status: 'success', summary: '报告已生成' } };
      yield { type: 'done' };
    };
    const runtime = getConversationRuntime(conversationId, engine);
    try {
      await runtime.send('write report');

      const absolutePath = `${workspaceRoot}/output/pdf/302_AI_Research_Report.pdf`;
      expect(runtime.getSnapshot().workspaces[0]?.artifacts[0]).toMatchObject({
        title: '302_AI_Research_Report.pdf',
        path: absolutePath,
      });
      const spaceMessage = runtime.getSnapshot().messages.find((message) => message.role === 'space');
      expect(spaceMessage?.artifacts?.[0]).toMatchObject({ path: absolutePath });
    } finally {
      dropConversationRuntime(conversationId);
    }
  });

  it('coalesces repeated file mutation artifacts for the same path', async () => {
    const conversationId = `test-artifact-path-upsert-${Date.now()}`;
    const artifactPath = '/Users/jomymac/Documents/Zleap/conversations/web-123/generate_pdf.py';
    const engine: Engine = async function* () {
      yield { type: 'space', phase: 'enter', id: 'basic', label: 'basic', goal: 'generate pdf' };
      yield { type: 'tool', name: 'write', phase: 'start', detail: JSON.stringify({ path: artifactPath }) };
      yield { type: 'tool', name: 'write', phase: 'end', detail: `Created ${artifactPath} (+336)\n+print("v1")`, isError: false };
      yield { type: 'tool', name: 'edit', phase: 'start', detail: JSON.stringify({ path: artifactPath }) };
      yield { type: 'tool', name: 'edit', phase: 'end', detail: `Updated ${artifactPath} (+69 -69)\n-print("v1")\n+print("v2")`, isError: false };
      yield { type: 'tool', name: 'edit', phase: 'start', detail: JSON.stringify({ path: artifactPath }) };
      yield { type: 'tool', name: 'edit', phase: 'end', detail: `Updated ${artifactPath} (+1 -1)\n-print("v2")\n+print("v3")`, isError: false };
      yield { type: 'space_result', id: 'basic', envelope: { status: 'success', summary: 'PDF 脚本已完成' } };
      yield { type: 'done' };
    };
    const runtime = getConversationRuntime(conversationId, engine);
    try {
      await runtime.send('generate pdf');

      const snap = runtime.getSnapshot();
      const pane = snap.workspaces.find((item) => item.id === 'basic');
      expect(pane?.artifacts).toEqual([
        expect.objectContaining({
          title: 'generate_pdf.py',
          path: artifactPath,
          detail: 'Updated (+1 -1) · via edit',
        }),
      ]);
      const spaceMessage = snap.messages.find((message) => message.role === 'space');
      expect(spaceMessage?.artifacts).toEqual([
        expect.objectContaining({
          title: 'generate_pdf.py',
          path: artifactPath,
          detail: 'Updated (+1 -1) · via edit',
        }),
      ]);
    } finally {
      dropConversationRuntime(conversationId);
    }
  });

  it('keeps console history when re-entering the same workspace', async () => {
    const conversationId = `test-reenter-workspace-history-${Date.now()}`;
    const firstPath = '/tmp/first.md';
    const secondPath = '/tmp/second.md';
    const engine: Engine = async function* () {
      yield { type: 'space', phase: 'enter', id: 'basic', label: 'basic', goal: 'first task' };
      yield { type: 'tool', name: 'write', phase: 'start', detail: JSON.stringify({ path: firstPath }) };
      yield { type: 'tool', name: 'write', phase: 'end', detail: `Created ${firstPath} (+1)\n+# first`, isError: false };
      yield { type: 'space_result', id: 'basic', envelope: { status: 'success', summary: 'first done' } };
      yield { type: 'space', phase: 'enter', id: 'basic', label: 'basic', goal: 'second task' };
      yield { type: 'tool', name: 'write', phase: 'start', detail: JSON.stringify({ path: secondPath }) };
      yield { type: 'tool', name: 'write', phase: 'end', detail: `Created ${secondPath} (+1)\n+# second`, isError: false };
      yield { type: 'space_result', id: 'basic', envelope: { status: 'success', summary: 'second done' } };
      yield { type: 'done' };
    };
    const runtime = getConversationRuntime(conversationId, engine);
    try {
      await runtime.send('run two tasks in same space');

      const snap = runtime.getSnapshot();
      const pane = snap.workspaces.find((item) => item.id === 'basic');
      expect(pane?.tools.map((tool) => tool.name)).toEqual(['write', 'write']);
      expect(pane?.messages?.some((message) => message.text.includes('重新进入 basic') && message.text.includes('second task'))).toBe(true);
      expect(pane?.artifacts.map((artifact) => artifact.path)).toEqual([firstPath, secondPath]);

      const spaceCards = snap.messages.filter((message) => message.role === 'space');
      expect(spaceCards).toHaveLength(2);
      expect(spaceCards[0]?.artifacts?.map((artifact) => artifact.path)).toEqual([firstPath]);
      expect(spaceCards[1]?.artifacts?.map((artifact) => artifact.path)).toEqual([secondPath]);
    } finally {
      dropConversationRuntime(conversationId);
    }
  });

  it('merges duplicate workspace panes when hydrating a restored snapshot', () => {
    const conversationId = `test-hydrate-duplicate-workspace-panes-${Date.now()}`;
    const runtime = getConversationRuntime(conversationId, idleEngine);
    try {
      runtime.hydrate(
        [],
        [
          finishedPane({
            id: 'basic-newer',
            spaceId: 'basic',
            goal: 'second task',
            startedAt: 20,
            endedAt: 30,
            statusLine: 'second done',
            tools: [{ name: 'edit', args: '{}', result: 'Updated /tmp/report.md (+1)', status: 'done' }],
            messages: [{ text: '任务：second task', after: 0 }],
            artifacts: [{ id: 1, spaceId: 'basic', kind: 'file', title: 'report.md', detail: 'Updated (+1) · via edit', path: '/tmp/report.md' }],
          }),
          finishedPane({
            id: 'basic-older',
            spaceId: 'basic',
            goal: 'first task',
            startedAt: 1,
            endedAt: 10,
            statusLine: 'first done',
            tools: [{ name: 'write', args: '{}', result: 'Created /tmp/report.md (+1)', status: 'done' }],
            messages: [
              { text: '任务：first task', after: 0 },
              { text: 'first done', after: 1 },
            ],
            artifacts: [{ id: 1, spaceId: 'basic', kind: 'file', title: 'report.md', detail: 'Created (+1) · via write', path: '/tmp/report.md' }],
          }),
        ],
        { replace: true },
      );

      const pane = runtime.getSnapshot().workspaces[0];
      expect(runtime.getSnapshot().workspaces).toHaveLength(1);
      expect(pane).toMatchObject({ id: 'basic', spaceId: 'basic', goal: 'second task', statusLine: 'second done' });
      expect(pane?.tools.map((tool) => tool.name)).toEqual(['write', 'edit']);
      expect(pane?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: '任务：first task', after: 0 }),
          expect.objectContaining({ text: 'first done', after: 1 }),
          expect.objectContaining({ text: '任务：second task', after: 1 }),
        ]),
      );
      expect(pane?.artifacts).toEqual([
        expect.objectContaining({ id: 1, path: '/tmp/report.md', detail: 'Updated (+1) · via edit' }),
      ]);
    } finally {
      dropConversationRuntime(conversationId);
    }
  });

  it('queues user input sent while a run is still active', async () => {
    const conversationId = `test-queued-input-${Date.now()}`;
    const firstGate = deferred<void>();
    const histories: string[][] = [];
    const engine: Engine = async function* (history) {
      histories.push(history.map((turn) => turn.text));
      if (histories.length === 1) {
        await firstGate.promise;
        yield { type: 'delta', text: 'first done' };
      } else {
        yield { type: 'delta', text: 'second done' };
      }
      yield { type: 'done' };
    };
    const runtime = getConversationRuntime(conversationId, engine);
    try {
      const first = runtime.send('first');
      const second = runtime.send('second');
      expect(runtime.getSnapshot().queuedInputCount).toBe(1);
      expect(histories).toEqual([['first']]);

      firstGate.resolve();
      await Promise.all([first, second]);

      expect(histories).toEqual([
        ['first'],
        ['first', 'first done', 'second'],
      ]);
      expect(runtime.getSnapshot().queuedInputCount).toBe(0);
      expect(runtime.getSnapshot().messages.map((message) => message.text).filter(Boolean)).toEqual([
        'first',
        'first done',
        'second',
        'second done',
      ]);
    } finally {
      dropConversationRuntime(conversationId);
    }
  });

  it('forwards run mode, skill, and target space options into the engine', async () => {
    const conversationId = `test-send-options-${Date.now()}`;
    const seen: unknown[] = [];
    const engine: Engine = async function* (_history, _signal, opts) {
      seen.push(opts);
      yield { type: 'delta', text: 'planned' };
      yield { type: 'done' };
    };
    const runtime = getConversationRuntime(conversationId, engine);
    try {
      await runtime.send('make a plan', {
        targetSpace: 'basic',
        runMode: 'plan',
        skillId: 'research',
        skillLabel: '研究',
      });

      expect(seen[0]).toMatchObject({
        targetSpace: 'basic',
        runMode: 'plan',
        skillId: 'research',
        skillLabel: '研究',
      });
    } finally {
      dropConversationRuntime(conversationId);
    }
  });

  it('auto-approves a pending tool when permission mode switches to full_access mid-run', async () => {
    const conversationId = `test-full-access-${Date.now()}`;
    const approvalGate = deferred<boolean>();
    const engine: Engine = async function* (_history, _signal, opts) {
      const approved = await opts.confirm({
        approvalId: 'approval_tool_call_mcp',
        name: 'mcp__test__tool__v1',
        args: '{}',
      });
      approvalGate.resolve(approved);
      yield { type: 'delta', text: approved ? 'ok' : 'denied' };
      yield { type: 'done' };
    };
    const runtime = getConversationRuntime(conversationId, engine, { permissionMode: 'request_approval' });
    try {
      const runPromise = runtime.send('run tool');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(runtime.getSnapshot().pendingApproval?.name).toBe('mcp__test__tool__v1');

      runtime.bindContext(undefined, undefined, undefined, 'full_access');
      await runPromise;

      expect(await approvalGate.promise).toBe(true);
      expect(runtime.getSnapshot().pendingApproval).toBeNull();
      expect(runtime.getSnapshot().messages.at(-1)?.text).toBe('ok');
    } finally {
      dropConversationRuntime(conversationId);
    }
  });

  it('dismisses approval notices manually and automatically', async () => {
    vi.useFakeTimers();
    const conversationId = `test-approval-notice-${Date.now()}`;
    const engine: Engine = async function* (_history, _signal, opts) {
      const approved = await opts.confirm({
        approvalId: 'approval_tool_call_write',
        name: 'write',
        args: '{}',
      });
      yield { type: 'delta', text: approved ? 'ok' : 'denied' };
      yield { type: 'done' };
    };
    const runtime = getConversationRuntime(conversationId, engine, { permissionMode: 'request_approval' });
    try {
      const runPromise = runtime.send('run tool');
      await vi.advanceTimersByTimeAsync(0);
      runtime.respondApproval(true);
      expect(runtime.getSnapshot().approvalNotice?.status).toBe('approved');

      runtime.dismissApprovalNotice();
      expect(runtime.getSnapshot().approvalNotice).toBeNull();
      await runPromise;

      const secondRun = runtime.send('run tool again');
      await vi.advanceTimersByTimeAsync(0);
      runtime.respondApproval(true);
      expect(runtime.getSnapshot().approvalNotice?.status).toBe('approved');
      await vi.advanceTimersByTimeAsync(8_000);
      expect(runtime.getSnapshot().approvalNotice).toBeNull();
      await secondRun;
    } finally {
      dropConversationRuntime(conversationId);
    }
  });
});

const idleEngine: Engine = async function* () {
  yield { type: 'done' };
};

function finishedPane(overrides: Partial<WorkPane> = {}): WorkPane {
  return {
    id: 'basic',
    spaceId: 'basic',
    label: 'basic',
    goal: 'finished',
    startedAt: 1,
    endedAt: 2,
    tools: [],
    messages: [],
    artifacts: [],
    statusLine: 'workspace 已完成',
    status: 'done',
    ...overrides,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
