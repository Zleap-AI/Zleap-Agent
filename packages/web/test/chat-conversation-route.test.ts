import { DEFAULT_AVATAR_ID, type SessionEntryRecord, type SpaceSessionRecord, type ThreadRecord } from '@zleap/core';
import type { ZleapStore } from '@zleap/store';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DELETE, GET } from '../app/api/chat/conversation/route';
import { storeFromEnv } from '../lib/server/avatarStore';

vi.mock('../lib/server/avatarStore', () => ({
  storeFromEnv: vi.fn(),
}));

const storeFromEnvMock = vi.mocked(storeFromEnv);
let tempRoot: string | undefined;

describe('/api/chat/conversation route', () => {
  beforeEach(() => {
    storeFromEnvMock.mockReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  it('omits empty placeholder conversations from the summary list', async () => {
    const store = makeStore([]);
    storeFromEnvMock.mockResolvedValue(store as unknown as ZleapStore);

    const response = await GET(actorRequest('?limit=100'));

    await expectStatus(response, 200);
    await expect(response.json()).resolves.toMatchObject({
      conversations: [],
      archived: [],
    });
  });

  it('keeps started conversations in the summary list', async () => {
    const store = makeStore([
      {
        id: 'entry-1',
        sessionId: 'web:conversation-1:main',
        type: 'message',
        role: 'user',
        content: 'hello',
        createdAt: new Date('2026-06-17T06:06:00.000Z'),
      },
    ]);
    storeFromEnvMock.mockResolvedValue(store as unknown as ZleapStore);

    const response = await GET(actorRequest('?limit=100'));

    await expectStatus(response, 200);
    const body = await response.json();
    expect(body.conversations).toEqual([
      expect.objectContaining({
        conversationId: 'conversation-1',
        title: 'Conversation',
      }),
    ]);
    expect(body.archived).toEqual([]);
  });

  it('lists and loads gateway conversations when they use the WebUI owner', async () => {
    const store = makeStore(
      [
        {
          id: 'entry-1',
          sessionId: 'wechat:oc_chat:main',
          type: 'message',
          role: 'user',
          content: 'hello from wechat',
          createdAt: new Date('2026-06-17T06:06:00.000Z'),
        },
      ],
      undefined,
      {
        id: 'wechat:oc_chat',
        source: 'wechat',
        mainSessionId: 'wechat:oc_chat:main',
        metadata: { conversationId: 'oc_chat' },
      },
    );
    storeFromEnvMock.mockResolvedValue(store as unknown as ZleapStore);

    const listResponse = await GET(actorRequest('?limit=100'));
    await expectStatus(listResponse, 200);
    const listBody = await listResponse.json();
    expect(listBody.conversations).toEqual([
      expect.objectContaining({
        conversationId: 'oc_chat',
        source: 'wechat',
      }),
    ]);

    const detailResponse = await GET(actorRequest('?conversationId=oc_chat&source=wechat'));
    await expectStatus(detailResponse, 200);
    const detailBody = await detailResponse.json();
    expect(detailBody).toMatchObject({
      conversationId: 'oc_chat',
      threadId: 'wechat:oc_chat',
      source: 'wechat',
      messages: [expect.objectContaining({ text: 'hello from wechat' })],
    });
  });

  it('does not restore soft-deleted entries in conversation detail', async () => {
    const store = makeStore([
      {
        id: 'entry-1',
        sessionId: 'web:conversation-1:main',
        type: 'message',
        role: 'user',
        content: 'keep user message',
        createdAt: new Date('2026-06-17T06:06:00.000Z'),
      },
      {
        id: 'entry-2',
        sessionId: 'web:conversation-1:main',
        type: 'message',
        role: 'assistant',
        content: 'deleted assistant message',
        createdAt: new Date('2026-06-17T06:07:00.000Z'),
        deletedAt: new Date('2026-06-17T06:08:00.000Z'),
      },
      {
        id: 'entry-3',
        sessionId: 'web:conversation-1:main',
        type: 'message',
        role: 'assistant',
        content: 'keep assistant message',
        createdAt: new Date('2026-06-17T06:09:00.000Z'),
      },
    ]);
    storeFromEnvMock.mockResolvedValue(store as unknown as ZleapStore);

    const response = await GET(actorRequest('?conversationId=conversation-1'));

    await expectStatus(response, 200);
    const body = await response.json();
    const text = JSON.stringify(body.messages);
    expect(text).toContain('keep user message');
    expect(text).toContain('keep assistant message');
    expect(text).not.toContain('deleted assistant message');
  });

  it('restores persisted display image attachments in conversation detail', async () => {
    const store = makeStore([
      {
        id: 'entry-1',
        sessionId: 'web:conversation-1:main',
        type: 'message',
        role: 'user',
        content: '能看到吗',
        data: {
          projectionKind: 'user_message',
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
        },
        createdAt: new Date('2026-06-17T06:06:00.000Z'),
      },
    ]);
    storeFromEnvMock.mockResolvedValue(store as unknown as ZleapStore);

    const response = await GET(actorRequest('?conversationId=conversation-1'));

    await expectStatus(response, 200);
    const body = await response.json();
    expect(body.messages[0]).toMatchObject({
      role: 'user',
      text: '能看到吗',
      attachments: [
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
    expect(JSON.stringify(body.messages[0])).not.toContain('dataUrl');
  });

  it('falls back to thumbnail when old persisted image attachments have no preview image', async () => {
    const store = makeStore([
      {
        id: 'entry-1',
        sessionId: 'web:conversation-1:main',
        type: 'message',
        role: 'user',
        content: '旧图片',
        data: {
          projectionKind: 'user_message',
          displayAttachments: [
            {
              id: 'img_1',
              kind: 'image',
              name: 'old.png',
              mimeType: 'image/png',
              sizeBytes: 5,
              thumbnailDataUrl: 'data:image/png;base64,dGh1bWI=',
            },
          ],
        },
        createdAt: new Date('2026-06-17T06:06:00.000Z'),
      },
    ]);
    storeFromEnvMock.mockResolvedValue(store as unknown as ZleapStore);

    const response = await GET(actorRequest('?conversationId=conversation-1'));

    await expectStatus(response, 200);
    const body = await response.json();
    expect(body.messages[0].attachments[0]).toMatchObject({
      thumbnailDataUrl: 'data:image/png;base64,dGh1bWI=',
      previewDataUrl: 'data:image/png;base64,dGh1bWI=',
    });
  });

  it('restores artifact shortcuts from persisted workspace result data', async () => {
    const store = makeStore([
      {
        id: 'entry-1',
        sessionId: 'web:conversation-1:main',
        type: 'message',
        role: 'user',
        content: '做一个天气网页',
        createdAt: new Date('2026-06-17T06:06:00.000Z'),
      },
      {
        id: 'entry-2',
        sessionId: 'web:conversation-1:main',
        type: 'tool_result',
        role: 'tool',
        content: '已创建 guangzhou_weather.html。',
        data: {
          projectionKind: 'workspace_result',
          workspaceId: 'cli',
          workspaceResult: {
            status: 'completed',
            summary: '已创建天气网页',
            artifacts: [
              {
                kind: 'file',
                ref: 'file:///Users/jomymac/Documents/Zleap/2026-06-17/guangzhou_weather.html',
                description: 'guangzhou_weather.html',
              },
            ],
            observations: [],
            errors: [],
            suggestedNextSteps: [],
          },
        },
        createdAt: new Date('2026-06-17T06:07:00.000Z'),
      },
    ]);
    storeFromEnvMock.mockResolvedValue(store as unknown as ZleapStore);

    const response = await GET(actorRequest('?conversationId=conversation-1'));

    await expectStatus(response, 200);
    const body = await response.json();
    expect(body.messages[1]).toMatchObject({
      role: 'assistant',
      text: '已创建 guangzhou_weather.html。',
      artifacts: [
        {
          spaceId: 'cli',
          title: 'guangzhou_weather.html',
          path: '/Users/jomymac/Documents/Zleap/2026-06-17/guangzhou_weather.html',
        },
      ],
    });
  });

  it('restores artifact shortcuts from legacy assistant text when structured data is missing', async () => {
    const store = makeStore([
      {
        id: 'entry-1',
        sessionId: 'web:conversation-1:main',
        type: 'message',
        role: 'assistant',
        content: '文件路径：当前工作目录 / guangzhou_weather.html（444行 / 14.7KB）',
        createdAt: new Date('2026-06-17T06:07:00.000Z'),
      },
    ]);
    storeFromEnvMock.mockResolvedValue(store as unknown as ZleapStore);

    const response = await GET(actorRequest('?conversationId=conversation-1'));

    await expectStatus(response, 200);
    const body = await response.json();
    expect(body.messages[0]).toMatchObject({
      role: 'assistant',
      artifacts: [
        {
          title: 'guangzhou_weather.html',
          path: 'guangzhou_weather.html',
        },
      ],
    });
  });

  it('resolves relative artifact shortcuts from history against the conversation workspace root', async () => {
    const workspaceRoot = '/Users/jomymac/Documents/Zleap/2026-06-23/conversation-1';
    const store = makeStore(
      [
        {
          id: 'entry-1',
          sessionId: 'web:conversation-1:main',
          type: 'tool_call',
          role: 'assistant',
          content: 'Created output/pdf/302_AI_Research_Report.pdf (+2)\n+%PDF\n+%%EOF',
          data: {
            projectionKind: 'tool_execution_record',
            toolId: 'write',
            input: { path: 'output/pdf/302_AI_Research_Report.pdf' },
            result: 'Created output/pdf/302_AI_Research_Report.pdf (+2)\n+%PDF\n+%%EOF',
          },
          createdAt: new Date('2026-06-23T06:07:00.000Z'),
        },
        {
          id: 'entry-2',
          sessionId: 'web:conversation-1:main',
          type: 'message',
          role: 'assistant',
          content: '报告已生成：output/pdf/302_AI_Research_Report.pdf',
          createdAt: new Date('2026-06-23T06:08:00.000Z'),
        },
      ],
      undefined,
      { metadata: { workspaceRoot } },
    );
    storeFromEnvMock.mockResolvedValue(store as unknown as ZleapStore);

    const response = await GET(actorRequest('?conversationId=conversation-1'));

    await expectStatus(response, 200);
    const body = await response.json();
    expect(body.messages[0].artifacts).toEqual([
      expect.objectContaining({
        title: '302_AI_Research_Report.pdf',
        path: `${workspaceRoot}/output/pdf/302_AI_Research_Report.pdf`,
      }),
    ]);
  });

  it('restores bare file artifact shortcuts under the mentioned output folder', async () => {
    const text = [
      'Successfully generated a complete Weather Query Web App at `weather-app/` with three files:',
      '',
      '1. **index.html** — Semantic HTML structure.',
      '2. **style.css** — Modern design.',
      '3. **script.js** — Full vanilla JavaScript implementation.',
      '',
      '天气查询网页已经生成好了，所有代码都在 `weather-app` 文件夹中（包含 index.html、style.css 和 script.js）。',
    ].join('\n');
    const store = makeStore([
      {
        id: 'entry-1',
        sessionId: 'web:conversation-1:main',
        type: 'message',
        role: 'assistant',
        content: text,
        createdAt: new Date('2026-06-17T06:07:00.000Z'),
      },
    ]);
    storeFromEnvMock.mockResolvedValue(store as unknown as ZleapStore);

    const response = await GET(actorRequest('?conversationId=conversation-1'));

    await expectStatus(response, 200);
    const body = await response.json();
    expect(body.messages[0].artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'index.html', path: 'weather-app/index.html' }),
        expect.objectContaining({ title: 'style.css', path: 'weather-app/style.css' }),
        expect.objectContaining({ title: 'script.js', path: 'weather-app/script.js' }),
      ]),
    );
  });

  it('does not create artifact shortcuts from remote links mentioned in assistant text', async () => {
    const store = makeStore([
      {
        id: 'entry-1',
        sessionId: 'web:conversation-1:main',
        type: 'message',
        role: 'assistant',
        content: [
          '信息来源：',
          '1. 广州日报大洋网：https://news.dayoo.com/guangzhou/202606/16/139995_54970631.htm',
          '2. 新浪天气：http://k.sina.com.cn/article_7857201856_1d45362c00019O6ua74.html',
        ].join('\n'),
        createdAt: new Date('2026-06-17T06:08:00.000Z'),
      },
    ]);
    storeFromEnvMock.mockResolvedValue(store as unknown as ZleapStore);

    const response = await GET(actorRequest('?conversationId=conversation-1'));

    await expectStatus(response, 200);
    const body = await response.json();
    expect(body.messages[0]).toMatchObject({ role: 'assistant' });
    expect(body.messages[0].artifacts).toBeUndefined();
  });

  it('does not create artifact shortcuts from cloned repository file inventories', async () => {
    const store = makeStore([
      {
        id: 'entry-1',
        sessionId: 'web:conversation-1:main',
        type: 'message',
        role: 'assistant',
        content: [
          '已成功将 https://github.com/Zleap-AI/SAG 仓库克隆到当前工作目录。',
          '',
          '仓库结构包括：',
          '- README-CN.md',
          '- README.md',
          '- package-lock.json',
          '- package.json',
          '- web/index.html',
          '- src/api/server.ts',
        ].join('\n'),
        createdAt: new Date('2026-06-17T06:09:00.000Z'),
      },
    ]);
    storeFromEnvMock.mockResolvedValue(store as unknown as ZleapStore);

    const response = await GET(actorRequest('?conversationId=conversation-1'));

    await expectStatus(response, 200);
    const body = await response.json();
    expect(body.messages[0]).toMatchObject({ role: 'assistant' });
    expect(body.messages[0].artifacts).toBeUndefined();
  });

  it('only restores generated artifacts from mixed source inventory and output text', async () => {
    const store = makeStore([
      {
        id: 'entry-1',
        sessionId: 'web:conversation-1:main',
        type: 'message',
        role: 'assistant',
        content: [
          '我已经阅读了 SAG 仓库源码，关键文件包括：',
          '- docs/logo.svg',
          '- README.md',
          '- docs/sag-chat.png',
          '- docs/paper-sag-architecture.jpeg',
          '',
          '已生成 SAG-SAG功能分析报告.md，可以打开查看。',
        ].join('\n'),
        createdAt: new Date('2026-06-17T06:09:30.000Z'),
      },
    ]);
    storeFromEnvMock.mockResolvedValue(store as unknown as ZleapStore);

    const response = await GET(actorRequest('?conversationId=conversation-1'));

    await expectStatus(response, 200);
    const body = await response.json();
    expect(body.messages[0].artifacts).toEqual([
      expect.objectContaining({ title: 'SAG-SAG功能分析报告.md' }),
    ]);
  });

  it('normalizes escaped markdown newlines when restoring assistant messages', async () => {
    const store = makeStore([
      {
        id: 'entry-1',
        sessionId: 'web:conversation-1:main',
        type: 'message',
        role: 'assistant',
        content: 'Report\\n## Summary\\n- One\\n- Two\\n\\nConclusion',
        createdAt: new Date('2026-06-17T06:09:00.000Z'),
      },
    ]);
    storeFromEnvMock.mockResolvedValue(store as unknown as ZleapStore);

    const response = await GET(actorRequest('?conversationId=conversation-1'));

    await expectStatus(response, 200);
    const body = await response.json();
    expect(body.messages[0]).toMatchObject({
      role: 'assistant',
      text: 'Report\n## Summary\n- One\n- Two\n\nConclusion',
    });
  });

  it('does not render duplicate assistant text when workspace result is repeated by a message', async () => {
    const repeatedText = '我来为你创建这个视觉惊艳的禅意仪表盘。先直接生成完整的 HTML 文件。';
    const store = makeStore([
      {
        id: 'entry-1',
        sessionId: 'web:conversation-1:main',
        type: 'tool_result',
        role: 'tool',
        content: repeatedText,
        data: {
          projectionKind: 'workspace_result',
          workspaceId: 'cli',
          workspaceResult: {
            status: 'completed',
            summary: repeatedText,
            artifacts: [
              {
                kind: 'file',
                ref: 'file:///Users/jomymac/Documents/Zleap/2026-06-17/zen_dashboard.html',
                description: 'zen_dashboard.html',
              },
            ],
            observations: [],
            errors: [],
            suggestedNextSteps: [],
          },
        },
        createdAt: new Date('2026-06-17T06:07:00.000Z'),
      },
      {
        id: 'entry-2',
        sessionId: 'web:conversation-1:main',
        type: 'message',
        role: 'assistant',
        content: repeatedText,
        createdAt: new Date('2026-06-17T06:07:01.000Z'),
      },
    ]);
    storeFromEnvMock.mockResolvedValue(store as unknown as ZleapStore);

    const response = await GET(actorRequest('?conversationId=conversation-1'));

    await expectStatus(response, 200);
    const body = await response.json();
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toMatchObject({
      role: 'assistant',
      text: repeatedText,
      artifacts: [
        {
          title: 'zen_dashboard.html',
          path: '/Users/jomymac/Documents/Zleap/2026-06-17/zen_dashboard.html',
        },
      ],
    });
  });

  it('does not render artifact handoff as a second assistant message when final text differs slightly', async () => {
    const handoffText = [
      '## 广州明天（2026年6月18日，星期四）天气预报',
      '',
      '根据多个来源的综合查询结果：',
      '',
      '- 新浪天气：26°C ~ 31°C',
    ].join('\n');
    const finalText = `${handoffText}\n\n明天的广州天气已经查好了。如果有其他需要，随时告诉我。`;
    const store = makeStore([
      {
        id: 'entry-1',
        sessionId: 'web:conversation-1:main',
        type: 'message',
        role: 'user',
        content: '你搜一下广州明天天气',
        createdAt: new Date('2026-06-17T07:52:11.000Z'),
      },
      {
        id: 'entry-2',
        sessionId: 'web:conversation-1:main',
        type: 'tool_result',
        role: 'tool',
        content: handoffText,
        data: {
          projectionKind: 'artifact_handoff',
          workspaceId: 'web-search',
          artifactTitle: '搜索广州明天（2026年6月18日）的天气情况。',
          workspaceResultStatus: 'completed',
        },
        createdAt: new Date('2026-06-17T07:52:29.000Z'),
      },
      {
        id: 'entry-3',
        sessionId: 'web:conversation-1:main',
        type: 'message',
        role: 'assistant',
        content: finalText,
        data: {
          projectionKind: 'workspace_assistant_message',
          workspaceId: 'main',
        },
        createdAt: new Date('2026-06-17T07:52:31.000Z'),
      },
    ]);
    storeFromEnvMock.mockResolvedValue(store as unknown as ZleapStore);

    const response = await GET(actorRequest('?conversationId=conversation-1'));

    await expectStatus(response, 200);
    const body = await response.json();
    expect(body.messages).toHaveLength(2);
    expect(body.messages.map((message: { role: string; text: string }) => [message.role, message.text])).toEqual([
      ['user', '你搜一下广州明天天气'],
      ['assistant', finalText],
    ]);
  });

  it('deletes a durable assistant message and same-turn handoff entries', async () => {
    const deleted: string[] = [];
    const store = makeStore(
      [
        {
          id: 'entry-1',
          sessionId: 'web:conversation-1:main',
          type: 'message',
          role: 'user',
          content: '做一个网页',
          createdAt: new Date('2026-06-17T06:06:00.000Z'),
        },
        {
          id: 'entry-2',
          sessionId: 'web:conversation-1:main',
          type: 'tool_result',
          role: 'tool',
          content: '已创建 index.html。',
          data: { projectionKind: 'workspace_result', workspaceId: 'cli' },
          createdAt: new Date('2026-06-17T06:07:00.000Z'),
        },
        {
          id: 'entry-3',
          sessionId: 'web:conversation-1:main',
          type: 'message',
          role: 'assistant',
          content: '已创建 index.html。',
          createdAt: new Date('2026-06-17T06:08:00.000Z'),
        },
      ],
      (entryId) => deleted.push(entryId),
    );
    storeFromEnvMock.mockResolvedValue(store as unknown as ZleapStore);

    const response = await DELETE(actorRequest('', 'DELETE', { conversationId: 'conversation-1', entryId: 'entry-3' }));

    await expectStatus(response, 200);
    expect(deleted.sort()).toEqual(['entry-2', 'entry-3']);
  });

  it('deletes duplicate same-turn assistant entries behind one visible assistant message', async () => {
    const deleted: string[] = [];
    const store = makeStore(
      [
        {
          id: 'entry-1',
          sessionId: 'web:conversation-1:main',
          type: 'message',
          role: 'user',
          content: '总结一下',
          createdAt: new Date('2026-06-17T06:06:00.000Z'),
        },
        {
          id: 'entry-2',
          sessionId: 'web:conversation-1:main',
          type: 'message',
          role: 'assistant',
          content: '这是总结。',
          createdAt: new Date('2026-06-17T06:07:00.000Z'),
        },
        {
          id: 'entry-3',
          sessionId: 'web:conversation-1:main',
          type: 'message',
          role: 'assistant',
          content: '  这是总结。\n',
          createdAt: new Date('2026-06-17T06:08:00.000Z'),
        },
      ],
      (entryId) => deleted.push(entryId),
    );
    storeFromEnvMock.mockResolvedValue(store as unknown as ZleapStore);

    const response = await DELETE(actorRequest('', 'DELETE', { conversationId: 'conversation-1', entryId: 'entry-2' }));

    await expectStatus(response, 200);
    expect(deleted.sort()).toEqual(['entry-2', 'entry-3']);
  });

  it('deletes the whole local conversation when no entry ids are provided', async () => {
    const deletedThreads: string[] = [];
    const deletedMemoryThreads: string[] = [];
    const store = makeStore(
      [
        {
          id: 'entry-1',
          sessionId: 'wechat:oc_chat:main',
          type: 'message',
          role: 'user',
          content: 'hello from wechat',
          createdAt: new Date('2026-06-17T06:06:00.000Z'),
        },
      ],
      undefined,
      {
        id: 'wechat:oc_chat',
        source: 'wechat',
        mainSessionId: 'wechat:oc_chat:main',
        metadata: { conversationId: 'oc_chat' },
      },
      {
        onDeleteThread: (threadId) => deletedThreads.push(threadId),
        onDeleteMemoryThread: (threadId) => deletedMemoryThreads.push(threadId),
      },
    );
    storeFromEnvMock.mockResolvedValue(store as unknown as ZleapStore);

    const response = await DELETE(actorRequest('', 'DELETE', { conversationId: 'oc_chat', source: 'wechat' }));

    await expectStatus(response, 200);
    await expect(response.json()).resolves.toMatchObject({ deleted: true, threadId: 'wechat:oc_chat' });
    expect(deletedThreads).toEqual(['wechat:oc_chat']);
    expect(deletedMemoryThreads.sort()).toEqual(['oc_chat', 'wechat:oc_chat']);
  });

  it('deletes the artifact workspace directory when deleting the whole local conversation', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'zleap-delete-conversation-'));
    vi.stubEnv('ZLEAP_FILE_WORKSPACE_ROOT', tempRoot);
    const workspaceRoot = join(tempRoot, '2026-06-21', 'conversation-one');
    const unrelatedRoot = join(tempRoot, '2026-06-21', 'other-conversation');
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(unrelatedRoot, { recursive: true });
    await writeFile(join(workspaceRoot, 'created.md'), 'delete me\n');
    await writeFile(join(unrelatedRoot, 'keep.md'), 'keep me\n');
    const store = makeStore(
      [
        {
          id: 'entry-1',
          sessionId: 'web:conversation-1:main',
          type: 'message',
          role: 'user',
          content: 'hello',
          createdAt: new Date('2026-06-17T06:06:00.000Z'),
        },
      ],
      undefined,
      {
        metadata: {
          conversationId: 'conversation-1',
          workspaceRoot,
          workspaceKind: 'artifact',
        },
      },
    );
    storeFromEnvMock.mockResolvedValue(store as unknown as ZleapStore);

    const response = await DELETE(actorRequest('', 'DELETE', { conversationId: 'conversation-1' }));

    await expectStatus(response, 200);
    await expect(access(workspaceRoot)).rejects.toThrow();
    await expect(access(join(unrelatedRoot, 'keep.md'))).resolves.toBeUndefined();
  });

  it('does not delete project workspace directories when deleting the whole local conversation', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'zleap-delete-project-conversation-'));
    vi.stubEnv('ZLEAP_FILE_WORKSPACE_ROOT', join(tempRoot, 'history'));
    const projectRoot = join(tempRoot, 'project');
    await mkdir(projectRoot, { recursive: true });
    await writeFile(join(projectRoot, 'source.ts'), 'export const keep = true;\n');
    const store = makeStore(
      [
        {
          id: 'entry-1',
          sessionId: 'web:conversation-1:main',
          type: 'message',
          role: 'user',
          content: 'edit project',
          createdAt: new Date('2026-06-17T06:06:00.000Z'),
        },
      ],
      undefined,
      {
        metadata: {
          conversationId: 'conversation-1',
          workspaceRoot: projectRoot,
          workspaceKind: 'project',
          projectId: 'project-1',
        },
      },
    );
    storeFromEnvMock.mockResolvedValue(store as unknown as ZleapStore);

    const response = await DELETE(actorRequest('', 'DELETE', { conversationId: 'conversation-1' }));

    await expectStatus(response, 200);
    await expect(access(join(projectRoot, 'source.ts'))).resolves.toBeUndefined();
  });

  it('restores workspace panes from durable work sessions', async () => {
    const workSession: SpaceSessionRecord = {
      id: 'web:conversation-1:cli',
      threadId: 'web:conversation-1',
      avatarId: DEFAULT_AVATAR_ID,
      userId: 'u1',
      tenantId: 't1',
      spaceId: 'cli',
      kind: 'work',
      parentSessionId: 'web:conversation-1:main',
      rootGoal: '做一个网页',
      task: '写 index.html',
      status: 'completed',
      createdAt: new Date('2026-06-17T06:01:00.000Z'),
      updatedAt: new Date('2026-06-17T06:05:00.000Z'),
      metadata: { workspaceResultSummary: '网页已完成' },
    };
    const entriesBySession = new Map<string, SessionEntryRecord[]>([
      ['web:conversation-1:main', [
        {
          id: 'main-1',
          sessionId: 'web:conversation-1:main',
          type: 'message',
          role: 'user',
          content: '做一个网页',
          createdAt: new Date('2026-06-17T06:00:00.000Z'),
        },
      ]],
      ['web:conversation-1:cli', [
        {
          id: 'work-1',
          sessionId: 'web:conversation-1:cli',
          type: 'message',
          role: 'user',
          content: '写 index.html',
          data: { projectionKind: 'workspace_user_message' },
          createdAt: new Date('2026-06-17T06:01:00.000Z'),
        },
        {
          id: 'work-2',
          sessionId: 'web:conversation-1:cli',
          type: 'tool_call',
          role: 'assistant',
          content: 'Created /tmp/index.html (+1)',
          toolCallId: 'call-1',
          data: {
            projectionKind: 'tool_execution_record',
            toolId: 'write',
            input: { path: '/tmp/index.html' },
            result: 'Created /tmp/index.html (+1)',
          },
          createdAt: new Date('2026-06-17T06:02:00.000Z'),
        },
        {
          id: 'work-3',
          sessionId: 'web:conversation-1:cli',
          type: 'message',
          role: 'assistant',
          content: '文件写好了',
          data: { projectionKind: 'workspace_assistant_message' },
          createdAt: new Date('2026-06-17T06:03:00.000Z'),
        },
      ]],
    ]);
    const store = makeStore(entriesBySession.get('web:conversation-1:main') ?? []);
    store.sessions!.listSessions = async (input = {}) =>
      input.threadId === 'web:conversation-1' && input.parentSessionId === 'web:conversation-1:main' ? [workSession] : [];
    store.sessions!.listEntries = async ({ sessionId }) => entriesBySession.get(sessionId) ?? [];
    storeFromEnvMock.mockResolvedValue(store as unknown as ZleapStore);

    const response = await GET(actorRequest('?conversationId=conversation-1'));

    await expectStatus(response, 200);
    const body = await response.json();
    expect(body.workspaces).toEqual([
      expect.objectContaining({
        id: 'cli',
        sessionId: 'web:conversation-1:cli',
        spaceId: 'cli',
        goal: '写 index.html',
        status: 'done',
        statusLine: '网页已完成',
        tools: [expect.objectContaining({ name: 'write', status: 'done', args: expect.stringContaining('/tmp/index.html') })],
        messages: expect.arrayContaining([
          expect.objectContaining({ text: '任务：写 index.html' }),
          expect.objectContaining({ text: '文件写好了' }),
        ]),
        artifacts: [expect.objectContaining({ path: '/tmp/index.html' })],
      }),
    ]);
  });

  it('restores visible workspace transitions from durable work session entries', async () => {
    const webSession: SpaceSessionRecord = {
      id: 'web:conversation-1:web-search',
      threadId: 'web:conversation-1',
      avatarId: DEFAULT_AVATAR_ID,
      userId: 'u1',
      tenantId: 't1',
      spaceId: 'web-search',
      kind: 'work',
      parentSessionId: 'web:conversation-1:main',
      rootGoal: '验证子空间切换',
      task: '整理需求并交给 cli',
      status: 'completed',
      createdAt: new Date('2026-06-17T06:01:00.000Z'),
      updatedAt: new Date('2026-06-17T06:03:00.000Z'),
      metadata: { workspaceResultSummary: '已交给 cli' },
    };
    const cliSession: SpaceSessionRecord = {
      ...webSession,
      id: 'web:conversation-1:cli',
      spaceId: 'cli',
      task: '写验证文件',
      createdAt: new Date('2026-06-17T06:04:00.000Z'),
      updatedAt: new Date('2026-06-17T06:06:00.000Z'),
      metadata: { workspaceResultSummary: '文件已完成' },
    };
    const entriesBySession = new Map<string, SessionEntryRecord[]>([
      ['web:conversation-1:main', [
        {
          id: 'main-1',
          sessionId: 'web:conversation-1:main',
          type: 'message',
          role: 'user',
          content: '验证子空间切换',
          createdAt: new Date('2026-06-17T06:00:00.000Z'),
        },
      ]],
      ['web:conversation-1:web-search', [
        {
          id: 'web-task',
          sessionId: 'web:conversation-1:web-search',
          type: 'message',
          role: 'user',
          content: '整理需求并交给 cli',
          data: { projectionKind: 'workspace_user_message' },
          createdAt: new Date('2026-06-17T06:01:00.000Z'),
        },
        {
          id: 'web-handoff',
          sessionId: 'web:conversation-1:web-search',
          type: 'tool_call',
          role: 'assistant',
          content: 'Workspace result accepted: completed',
          data: {
            projectionKind: 'tool_execution_record',
            toolId: 'switchWorkspace',
            input: {
              space: 'cli',
              task: '写验证文件',
              message: 'web-search 已整理完需求，交给 cli 写文件。',
            },
            result: { status: 'completed' },
          },
          createdAt: new Date('2026-06-17T06:03:00.000Z'),
        },
      ]],
      ['web:conversation-1:cli', [
        {
          id: 'cli-task',
          sessionId: 'web:conversation-1:cli',
          type: 'message',
          role: 'user',
          content: '写验证文件',
          data: { projectionKind: 'workspace_user_message' },
          createdAt: new Date('2026-06-17T06:04:00.000Z'),
        },
        {
          id: 'cli-complete',
          sessionId: 'web:conversation-1:cli',
          type: 'tool_call',
          role: 'assistant',
          content: JSON.stringify({
            message: 'cli 已完成文件写入，返回主空间。',
          }),
          data: {
            projectionKind: 'workspace_tool_preview',
            toolName: 'finishTask',
            phase: 'start',
          },
          createdAt: new Date('2026-06-17T06:06:00.000Z'),
        },
      ]],
    ]);
    const store = makeStore(entriesBySession.get('web:conversation-1:main') ?? []);
    store.sessions!.listSessions = async (input = {}) =>
      input.threadId === 'web:conversation-1' && input.parentSessionId === 'web:conversation-1:main'
        ? [webSession, cliSession]
        : [];
    store.sessions!.listEntries = async ({ sessionId }) => entriesBySession.get(sessionId) ?? [];
    storeFromEnvMock.mockResolvedValue(store as unknown as ZleapStore);

    const response = await GET(actorRequest('?conversationId=conversation-1'));

    await expectStatus(response, 200);
    const body = await response.json();
    const webPane = body.workspaces.find((pane: { id: string }) => pane.id === 'web-search');
    const cliPane = body.workspaces.find((pane: { id: string }) => pane.id === 'cli');
    expect(webPane.transitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromSpace: 'main', toSpace: 'web-search', status: 'handoff' }),
        expect.objectContaining({ fromSpace: 'web-search', toSpace: 'cli', status: 'handoff', message: 'web-search 已整理完需求，交给 cli 写文件。' }),
      ]),
    );
    expect(cliPane.transitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromSpace: 'cli', toSpace: 'main', status: 'completed', message: 'cli 已完成文件写入，返回主空间。' }),
      ]),
    );
    expect(cliPane.transitions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromSpace: 'main', toSpace: 'cli' }),
      ]),
    );
  });

  it('restores malformed tool preview errors in durable work sessions', async () => {
    const workSession: SpaceSessionRecord = {
      id: 'web:conversation-1:cli',
      threadId: 'web:conversation-1',
      avatarId: DEFAULT_AVATAR_ID,
      userId: 'u1',
      tenantId: 't1',
      spaceId: 'cli',
      kind: 'work',
      parentSessionId: 'web:conversation-1:main',
      rootGoal: '写文件',
      task: '写 create_ppt.py',
      status: 'completed',
      createdAt: new Date('2026-06-17T06:01:00.000Z'),
      updatedAt: new Date('2026-06-17T06:05:00.000Z'),
      metadata: { workspaceResultSummary: '工具调用失败后已恢复' },
    };
    const entriesBySession = new Map<string, SessionEntryRecord[]>([
      ['web:conversation-1:main', [
        {
          id: 'main-1',
          sessionId: 'web:conversation-1:main',
          type: 'message',
          role: 'user',
          content: '写文件',
          createdAt: new Date('2026-06-17T06:00:00.000Z'),
        },
      ]],
      ['web:conversation-1:cli', [
        {
          id: 'preview-start',
          sessionId: 'web:conversation-1:cli',
          type: 'tool_call',
          role: 'assistant',
          content: '{"path":"/tmp/create_ppt.py","content":"# truncated"}',
          data: { projectionKind: 'workspace_tool_preview', toolName: 'write', phase: 'start' },
          createdAt: new Date('2026-06-17T06:02:00.000Z'),
        },
        {
          id: 'preview-end',
          sessionId: 'web:conversation-1:cli',
          type: 'tool_result',
          role: 'tool',
          content: 'Tool "write" was rejected: arguments JSON is incomplete or malformed.',
          data: { projectionKind: 'workspace_tool_preview', toolName: 'write', phase: 'end', isError: true },
          createdAt: new Date('2026-06-17T06:02:01.000Z'),
        },
      ]],
    ]);
    const store = makeStore(entriesBySession.get('web:conversation-1:main') ?? []);
    store.sessions!.listSessions = async (input = {}) =>
      input.threadId === 'web:conversation-1' && input.parentSessionId === 'web:conversation-1:main' ? [workSession] : [];
    store.sessions!.listEntries = async ({ sessionId }) => entriesBySession.get(sessionId) ?? [];
    storeFromEnvMock.mockResolvedValue(store as unknown as ZleapStore);

    const response = await GET(actorRequest('?conversationId=conversation-1'));

    await expectStatus(response, 200);
    const body = await response.json();
    expect(body.workspaces[0].tools).toEqual([
      expect.objectContaining({
        name: 'write',
        status: 'error',
        args: expect.stringContaining('create_ppt.py'),
        result: expect.stringContaining('incomplete or malformed'),
      }),
    ]);
  });

  it('merges repeated durable work sessions into one pane per space', async () => {
    const olderCliSession: SpaceSessionRecord = {
      id: 'web:conversation-1:cli:older',
      threadId: 'web:conversation-1',
      avatarId: DEFAULT_AVATAR_ID,
      userId: 'u1',
      tenantId: 't1',
      spaceId: 'cli',
      kind: 'work',
      parentSessionId: 'web:conversation-1:main',
      rootGoal: '生成报告',
      task: '写初稿',
      status: 'completed',
      createdAt: new Date('2026-06-17T06:01:00.000Z'),
      updatedAt: new Date('2026-06-17T06:05:00.000Z'),
      metadata: { workspaceResultSummary: '初稿已完成' },
    };
    const newerCliSession: SpaceSessionRecord = {
      ...olderCliSession,
      id: 'web:conversation-1:cli:newer',
      task: '修订报告',
      createdAt: new Date('2026-06-17T07:01:00.000Z'),
      updatedAt: new Date('2026-06-17T07:05:00.000Z'),
      metadata: { workspaceResultSummary: '修订已完成' },
    };
    const webSession: SpaceSessionRecord = {
      ...olderCliSession,
      id: 'web:conversation-1:web-search',
      spaceId: 'web-search',
      task: '搜索资料',
      createdAt: new Date('2026-06-17T06:30:00.000Z'),
      updatedAt: new Date('2026-06-17T06:35:00.000Z'),
      metadata: { workspaceResultSummary: '搜索已完成' },
    };
    const entriesBySession = new Map<string, SessionEntryRecord[]>([
      ['web:conversation-1:main', [
        {
          id: 'main-1',
          sessionId: 'web:conversation-1:main',
          type: 'message',
          role: 'user',
          content: '生成报告',
          createdAt: new Date('2026-06-17T06:00:00.000Z'),
        },
      ]],
      ['web:conversation-1:cli:older', [
        {
          id: 'older-task',
          sessionId: 'web:conversation-1:cli:older',
          type: 'message',
          role: 'user',
          content: '写初稿',
          data: { projectionKind: 'workspace_user_message' },
          createdAt: new Date('2026-06-17T06:01:00.000Z'),
        },
        {
          id: 'older-tool',
          sessionId: 'web:conversation-1:cli:older',
          type: 'tool_call',
          role: 'assistant',
          content: 'Created /tmp/draft.md (+1)',
          data: {
            projectionKind: 'tool_execution_record',
            toolId: 'write',
            input: { path: '/tmp/draft.md' },
            result: 'Created /tmp/draft.md (+1)',
          },
          createdAt: new Date('2026-06-17T06:02:00.000Z'),
        },
        {
          id: 'older-message',
          sessionId: 'web:conversation-1:cli:older',
          type: 'message',
          role: 'assistant',
          content: '初稿完成',
          data: { projectionKind: 'workspace_assistant_message' },
          createdAt: new Date('2026-06-17T06:03:00.000Z'),
        },
      ]],
      ['web:conversation-1:cli:newer', [
        {
          id: 'newer-task',
          sessionId: 'web:conversation-1:cli:newer',
          type: 'message',
          role: 'user',
          content: '修订报告',
          data: { projectionKind: 'workspace_user_message' },
          createdAt: new Date('2026-06-17T07:01:00.000Z'),
        },
        {
          id: 'newer-tool',
          sessionId: 'web:conversation-1:cli:newer',
          type: 'tool_call',
          role: 'assistant',
          content: 'Updated /tmp/draft.md (+1)',
          data: {
            projectionKind: 'tool_execution_record',
            toolId: 'edit',
            input: { path: '/tmp/draft.md' },
            result: 'Updated /tmp/draft.md (+1)',
          },
          createdAt: new Date('2026-06-17T07:02:00.000Z'),
        },
      ]],
      ['web:conversation-1:web-search', []],
    ]);
    const store = makeStore(entriesBySession.get('web:conversation-1:main') ?? []);
    store.sessions!.listSessions = async (input = {}) =>
      input.threadId === 'web:conversation-1' && input.parentSessionId === 'web:conversation-1:main'
        ? [newerCliSession, webSession, olderCliSession]
        : [];
    store.sessions!.listEntries = async ({ sessionId }) => entriesBySession.get(sessionId) ?? [];
    storeFromEnvMock.mockResolvedValue(store as unknown as ZleapStore);

    const response = await GET(actorRequest('?conversationId=conversation-1'));

    await expectStatus(response, 200);
    const body = await response.json();
    expect(body.workspaces.map((pane: { id: string }) => pane.id)).toEqual(['cli', 'web-search']);
    const cliPane = body.workspaces.find((pane: { id: string }) => pane.id === 'cli');
    expect(cliPane).toMatchObject({
      spaceId: 'cli',
      goal: '修订报告',
      statusLine: '修订已完成',
    });
    expect(cliPane.tools.map((tool: { name: string }) => tool.name)).toEqual(['write', 'edit']);
    expect(cliPane.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: '任务：写初稿', after: 0 }),
        expect.objectContaining({ text: '初稿完成', after: 1 }),
        expect.objectContaining({ text: '任务：修订报告', after: 1 }),
      ]),
    );
    expect(cliPane.artifacts).toEqual([
      expect.objectContaining({ id: 1, path: '/tmp/draft.md', detail: 'Updated (+1) · via edit' }),
    ]);
  });
});

function makeStore(
  entries: SessionEntryRecord[],
  onDelete?: (entryId: string) => void,
  threadPatch: Partial<ThreadRecord> = {},
  hooks: {
    onDeleteThread?: (threadId: string) => void;
    onDeleteMemoryThread?: (threadId: string) => void;
  } = {},
): Partial<ZleapStore> {
  const thread: ThreadRecord = {
    id: 'web:conversation-1',
    avatarId: DEFAULT_AVATAR_ID,
    userId: 'u1',
    tenantId: 't1',
    title: 'Conversation',
    status: 'active',
    source: 'web',
    mainSessionId: 'web:conversation-1:main',
    createdAt: new Date('2026-06-17T06:00:00.000Z'),
    updatedAt: new Date('2026-06-17T06:00:00.000Z'),
    metadata: { conversationId: 'conversation-1' },
    ...threadPatch,
  };
  return {
    threads: {
      createThread: async () => thread,
      getThread: async (id, input = {}) => (id === thread.id && input.userId === 'u1' && input.tenantId === 't1' ? thread : undefined),
      listThreads: async (input = {}) => (!input.status || input.status === thread.status ? [thread] : []),
      deleteThread: async (id, input = {}) => {
        if (id !== thread.id || input.userId !== 'u1' || input.tenantId !== 't1') return false;
        hooks.onDeleteThread?.(id);
        return true;
      },
    },
    core: {
      deleteByThread: async ({ threadId }: { threadId: string }) => {
        hooks.onDeleteMemoryThread?.(threadId);
      },
    } as unknown as ZleapStore['core'],
    sessions: {
      createSession: async () => {
        throw new Error('not implemented');
      },
      getSession: async () => undefined,
      appendEntry: async () => {
        throw new Error('not implemented');
      },
      deleteEntry: async ({ entryId }) => {
        onDelete?.(entryId);
        return true;
      },
      setLeaf: async () => undefined,
      listEntries: async () => entries,
      buildConversation: async () => [],
      listSessions: async () => [],
      buildSessionContext: async () => [],
    },
    close: async () => undefined,
  };
}

function actorRequest(query = '', method = 'GET', body?: unknown): Request {
  return new Request(`http://localhost/api/chat/conversation${query}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      'x-zleap-user-id': 'u1',
      'x-zleap-actor-role': 'user',
      'x-zleap-tenant-id': 't1',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function expectStatus(response: Response, status: number): Promise<void> {
  if (response.status !== status) {
    throw new Error(`expected status ${status}, got ${response.status}: ${await response.clone().text()}`);
  }
}
