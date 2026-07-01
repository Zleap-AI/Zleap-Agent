import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ModelRegistry,
  ProviderRegistry,
  type Message,
  type AssistantStreamEvent,
  type AiRegistries,
  type ProviderAdapter,
  type ProviderRequest,
} from '@zleap/ai';
import type { SkillDefinition, ToolDescriptor, WorkContext, WorkspaceDelta } from '@zleap/core';
import { TOOL_REASON_DISCIPLINE, assembleWorkTurnContext, runTurnLoop, runtimeToolExchange, toToolSchema } from '@zleap/agent/workspaces';

const TEST_MODEL = 'turn-loop-test';
const AUTOFILL_REASON_RECOVERY = { autofill: ['reason'] as const };
const AUTOFILL_WRITE_RECOVERY = { autofill: ['reason', 'path'] as const };

type ScriptedProviderResponse =
  | string
  | {
      text?: string;
      toolCalls?: Array<{ id?: string; name: string; arguments: unknown; rawArguments?: string; argumentsParseError?: string }>;
      finishReason?: string;
      error?: Extract<AssistantStreamEvent, { type: 'error' }>['error'];
    };

class ScriptedProvider implements ProviderAdapter {
  id = 'test-scripted';
  capabilities = {
    toolCalling: true,
    cacheBreakpoints: false,
    thinking: false,
    tokenizer: 'approx-char4',
  };

  constructor(private readonly handler: (request: ProviderRequest) => ScriptedProviderResponse) {}

  async *stream(_model: Parameters<ProviderAdapter['stream']>[0], request: ProviderRequest): AsyncIterable<AssistantStreamEvent> {
    const response = this.handler(request);
    const payload = typeof response === 'string' ? { text: response } : response;
    if (payload.error) {
      yield { type: 'error', error: payload.error };
      return;
    }
    if (payload.text) {
      yield { type: 'text_start', id: 'scripted' };
      yield { type: 'text_delta', id: 'scripted', text: payload.text };
      yield { type: 'text_end', id: 'scripted' };
    }
    for (const call of payload.toolCalls ?? []) {
      const id = call.id ?? `tool_${call.name}`;
      yield { type: 'toolcall_start', id, name: call.name };
      yield {
        type: 'toolcall_end',
        id,
        name: call.name,
        arguments: call.arguments,
        rawArguments: call.rawArguments,
        argumentsParseError: call.argumentsParseError,
      };
    }
    yield { type: 'done', finishReason: payload.finishReason };
  }
}

function registries(handler: (request: ProviderRequest) => ScriptedProviderResponse): AiRegistries {
  const providers = new ProviderRegistry();
  providers.register(new ScriptedProvider(handler));
  const models = new ModelRegistry();
  models.register({ id: TEST_MODEL, provider: 'test-scripted', model: TEST_MODEL, displayName: 'Test', supportsTools: true });
  return { providers, models };
}

function workContext(emitted: WorkspaceDelta[], skills: SkillDefinition[] = [], availableTools: ToolDescriptor[] = []): WorkContext {
  return {
    goal: 'finish a structured workspace task',
    priorArtifacts: [],
    skills,
    availableTools,
    queryMemory: () => [],
    callTool: async (toolId) => {
      throw new Error(`unexpected external tool: ${toolId}`);
    },
    emit: (delta) => emitted.push(delta),
  };
}

function toolResult(messages: Message[], toolName: string): Extract<Message, { role: 'toolResult' }> | undefined {
  return messages.find((message): message is Extract<Message, { role: 'toolResult' }> => message.role === 'toolResult' && message.toolName === toolName);
}

function toolCall(messages: Message[], toolName: string): Extract<Message, { role: 'assistant' }> | undefined {
  return messages.find((message): message is Extract<Message, { role: 'assistant' }> => (
    message.role === 'assistant' &&
    Array.isArray(message.content) &&
    message.content.some((part) => part.type === 'toolCall' && part.name === toolName)
  ));
}

describe('work turn context assembly', () => {
  it('injects runtime context as assistant tool call plus tool result', () => {
    const messages = runtimeToolExchange('listMemory', { scope: 'current' }, { impressions: [] }, 'runtime:listMemory:1');

    expect(messages).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'runtime:listMemory:1',
            name: 'listMemory',
            arguments: { scope: 'current' },
          },
        ],
      },
      {
        role: 'toolResult',
        toolCallId: 'runtime:listMemory:1',
        toolName: 'listMemory',
        content: JSON.stringify({ impressions: [] }, null, 0),
        isError: false,
      },
    ]);
  });

  it('wraps workspace system prompt sections in XML', () => {
    const assembled = assembleWorkTurnContext({
      persona: 'Base workspace persona',
      global: 'Global operator rule',
      tools: [{ id: 'read', description: 'Read local files.', promptSnippet: 'Read selected local files.' }],
      messages: [{ role: 'user', content: 'inspect prompt shape' }],
      deliverFinal: true,
    });

    expect(assembled.systemPrompt).toContain('<workspace_persona>');
    expect(assembled.systemPrompt).toContain('Base workspace persona');
    expect(assembled.systemPrompt).toContain('</workspace_persona>');
    expect(assembled.systemPrompt).toContain('<work_frame>');
    expect(assembled.systemPrompt).toContain('<workspace_model>');
    expect(assembled.systemPrompt).toContain('Main is the desktop');
    expect(assembled.systemPrompt).toContain('A workspace is an app window');
    expect(assembled.systemPrompt).toContain('call finishTask');
    expect(assembled.systemPrompt).toContain('call switchWorkspace');
    expect(assembled.systemPrompt).toContain('<global_instructions>');
    expect(assembled.systemPrompt).toContain('Global operator rule');
    expect(assembled.systemPrompt).toContain('<workspace_tools>');
    expect(assembled.systemPrompt).toContain('<loop_discipline>');
    expect(assembled.systemPrompt).toContain('<deliver_discipline>');
    expect(assembled.systemPrompt.trim().startsWith('<workspace_persona>')).toBe(true);
    expect(assembled.systemPrompt).not.toContain('\n\nBase workspace persona\n\n');
  });

  it('places runtime tool results before the current user message', () => {
    const assembled = assembleWorkTurnContext({
      persona: 'Base workspace persona',
      messages: [{ role: 'user', content: 'create the requested PPT file' }],
      runtimeMessages: runtimeToolExchange('listMemory', { scope: 'workspace' }, { recentItems: [] }, 'runtime:listMemory:1'),
      deliverFinal: true,
    });

    expect(assembled.messages.map((message) => message.role)).toEqual(['assistant', 'toolResult', 'user']);
    expect(toolCall(assembled.messages, 'listMemory')).toBe(assembled.messages[0]);
    expect(toolResult(assembled.messages, 'listMemory')).toBe(assembled.messages[1]);
    expect(String(assembled.messages[2]?.content)).toContain('create the requested PPT file');
  });

  it('places runtime tool results before cached historical workspace messages', () => {
    const assembled = assembleWorkTurnContext({
      persona: 'Base workspace persona',
      messages: [
        { role: 'user', content: 'previous turn' },
        { role: 'assistant', content: 'previous answer' },
        { role: 'user', content: 'continue the task' },
      ],
      runtimeMessages: runtimeToolExchange('listMemory', { scope: 'workspace' }, { recentItems: [] }, 'runtime:listMemory:1'),
      cacheBreakpoints: [
        { after: 'stable', messageIndex: 0 },
        { after: 'semiStable', messageIndex: 2 },
      ],
      deliverFinal: true,
    });

    expect(toolCall(assembled.messages, 'listMemory')).toBe(assembled.messages[0]);
    expect(toolResult(assembled.messages, 'listMemory')).toBe(assembled.messages[1]);
    expect(assembled.messages[2]).toMatchObject({ role: 'user', content: 'previous turn' });
    expect(assembled.messages[3]).toMatchObject({ role: 'assistant', content: 'previous answer' });
    expect(assembled.messages[4]?.role).toBe('user');
    expect(String(assembled.messages[4]?.content)).toContain('continue the task');
    expect(assembled.cacheBreakpoints).toEqual([
      { after: 'stable', messageIndex: 0 },
      { after: 'semiStable', messageIndex: 4 },
    ]);
  });

  it('prepends workspace context before the current user content', () => {
    const assembled = assembleWorkTurnContext({
      persona: 'Base workspace persona',
      turnGoal: 'Create a weather deck',
      focus: 'Collect weather data',
      messages: [{ role: 'user', content: 'Use Guangzhou weather for tomorrow.' }],
      deliverFinal: true,
    });

    expect(assembled.messages).toHaveLength(1);
    expect(String(assembled.messages[0]?.content)).toBe([
      '<workspace_context>',
      '  <goal>Create a weather deck</goal>',
      '  <task>Collect weather data</task>',
      '</workspace_context>',
      '',
      'Use Guangzhou weather for tomorrow.',
    ].join('\n'));
  });

  it('does not add workspace context when it only repeats the current user content', () => {
    const assembled = assembleWorkTurnContext({
      persona: 'Base workspace persona',
      focus: '你好',
      messages: [{ role: 'user', content: '你好' }],
      deliverFinal: true,
    });

    expect(assembled.messages).toEqual([{ role: 'user', content: '你好' }]);
  });

  it('treats handoff context as prior evidence and routes new web research out of cli', () => {
    const assembled = assembleWorkTurnContext({
      persona: 'This is the local command-line workspace.',
      turnGoal: 'Create a 302.AI PDF report',
      focus: 'Write the final report using the provided research',
      handoffContext: [
        '<workspace_handoff_context>',
        '  <previous_workspace>',
        '    <space>web-search</space>',
        '    <summary>Collected pricing and product evidence for 302.AI.</summary>',
        '  </previous_workspace>',
        '</workspace_handoff_context>',
      ].join('\n'),
      tools: [
        { id: 'switchWorkspace', promptSnippet: 'Switch to another workspace.' },
        { id: 'finishTask', promptSnippet: 'Finish the whole user goal.' },
        { id: 'ls', promptSnippet: 'List local files.' },
        { id: 'bash', promptSnippet: 'Run project commands.' },
        { id: 'write', promptSnippet: 'Write files.' },
      ],
      messages: [{ role: 'user', content: '目录为空，继续完成 PDF 报告。' }],
      deliverFinal: true,
    });

    expect(assembled.systemPrompt).toContain(
      'Treat workspace_handoff_context as already collected evidence from prior spaces.',
    );
    expect(assembled.systemPrompt).toContain(
      'An empty local directory means no local artifact exists yet; it does not mean the handed-off research is missing.',
    );
    expect(assembled.systemPrompt).toContain(
      'Do not restart public web research from CLI just because local files are absent.',
    );
    expect(assembled.systemPrompt).toContain(
      'If handoff text contains an absolute local output path outside the current Working directory, do not follow it',
    );
    expect(assembled.systemPrompt).toContain(
      'If genuinely new public web evidence is required, call switchWorkspace with space=web-search.',
    );
    expect(assembled.systemPrompt).toContain(
      'Do not use bash, curl, wget, or ad-hoc HTTP scripts for public web research.',
    );
    expect(String(assembled.messages.at(-1)?.content)).toContain('<workspace_handoff_context>');
    expect(String(assembled.messages.at(-1)?.content)).toContain('Collected pricing and product evidence for 302.AI.');
  });

  it('keeps task recall and focus out of the stable system prompt', () => {
    const assembled = assembleWorkTurnContext({
      persona: 'Base workspace persona',
      global: 'Global operator rule',
      turnGoal: 'Overall goal',
      focus: 'Inspect memory context assembly',
      recall: '与当前任务相关的记忆:\n- (experience) Prior bugfix note: Use typed memory recall.',
      cacheBreakpoints: [
        { after: 'stable', messageIndex: 0 },
        { after: 'semiStable', messageIndex: 1 },
      ],
      skills: [
        {
          id: 'memory-audit',
          label: 'Memory Audit',
          description: 'Check memory wiring',
          instructions: 'Prefer source evidence',
          toolIds: ['grep'],
          invocationPolicy: 'explicit_only',
          trustStatus: 'review_required',
        },
      ],
      messages: [
        { role: 'user', content: '<System-Memory>semi-stable event</System-Memory>' },
        { role: 'user', content: 'real task message' },
      ],
      deliverFinal: true,
    });

    expect(assembled.systemPrompt).toContain('Base workspace persona');
    expect(assembled.systemPrompt).toContain('Global operator rule');
    expect(assembled.systemPrompt).not.toContain('<active_skills>');
    expect(assembled.systemPrompt).not.toContain('Check memory wiring');
    expect(assembled.systemPrompt).not.toContain('<path>memory-audit/SKILL.md</path>');
    expect(assembled.systemPrompt).not.toContain('Prefer source evidence');
    expect(assembled.systemPrompt).not.toContain('Prior bugfix note');
    expect(assembled.systemPrompt).not.toContain('Overall goal');
    expect(assembled.systemPrompt).not.toContain('Inspect memory context assembly');

    expect(assembled.cacheBreakpoints).toEqual([
      { after: 'stable', messageIndex: 0 },
      { after: 'semiStable', messageIndex: 3 },
    ]);
    expect(assembled.messages).toHaveLength(4);
    expect(assembled.messages[0]).toMatchObject({ role: 'assistant' });
    expect(assembled.messages[1]).toMatchObject({ role: 'toolResult', toolName: 'listSkills' });
    expect(assembled.messages[2]).toMatchObject({ role: 'user', content: '<System-Memory>semi-stable event</System-Memory>' });
    expect(assembled.messages[3]).toMatchObject({ role: 'user' });
    expect(assembled.messages[3]?.content).toContain('<workspace_context>');
    expect(assembled.messages[3]?.content).toContain('Prior bugfix note');
    expect(assembled.messages[3]?.content).toContain('与当前任务相关的记忆');
    expect(assembled.messages[3]?.content).toContain('<goal>');
    expect(assembled.messages[3]?.content).toContain('Inspect memory context assembly');
    expect(assembled.messages[3]?.content).toContain('real task message');
    expect(toolCall(assembled.messages, 'listSkills')).toBeTruthy();
    const listSkills = toolResult(assembled.messages, 'listSkills');
    expect(listSkills).toBeTruthy();
    const payload = JSON.parse(listSkills?.content ?? '{}');
    expect(payload.skills[0]).toMatchObject({
      id: 'memory-audit',
      path: 'memory-audit/SKILL.md',
      label: 'Memory Audit',
      description: 'Check memory wiring',
      lifecycle: 'long_term',
      toolIds: ['grep'],
    });
    expect(payload.skills[0]).not.toHaveProperty('active');
    expect(JSON.stringify(payload)).not.toContain('Prefer source evidence');
  });

  it('tells the model to read matching suggested skills before implementation tools', () => {
    const pdfSkill: SkillDefinition = {
      id: 'pdf',
      version: 1,
      procedureId: 'skill:pdf@1',
      label: 'PDF',
      description: 'Read, create, or review PDF files where layout matters.',
      instructions: '# PDF Skill\nRender PDF pages before reviewing layout.',
      toolIds: [],
      sections: [{ id: 'workflow', title: 'Workflow', level: 2 }],
      lifecycle: 'long_term',
      sensitivity: { status: 'clear', findings: [] },
    };

    const assembled = assembleWorkTurnContext({
      persona: 'Base workspace persona',
      tools: [
        { id: 'findSkill', promptSnippet: 'Find skill manifests.' },
        { id: 'readSkill', promptSnippet: 'Read skill instructions.' },
        { id: 'bash', promptSnippet: 'Run commands.' },
        { id: 'read', promptSnippet: 'Read project files.' },
      ],
      suggestedSkills: [pdfSkill],
      messages: [{ role: 'user', content: '帮我分析这个 PDF 的版式问题' }],
      deliverFinal: true,
    });

    expect(assembled.systemPrompt).toContain(
      'When a visible skill manifest from listSkills or findSkill clearly matches the task, call readSkill with its skillId for the default SKILL.md entry, or with its manifest path for a package file, before file, command, web, or generation tools.',
    );
    expect(assembled.systemPrompt).toContain(
      'The model is responsible for this read; runtime will not expand suggested skill bodies automatically.',
    );
    const listSkills = toolResult(assembled.messages, 'listSkills');
    expect(listSkills).toBeTruthy();
    const payload = JSON.parse(listSkills?.content ?? '{}');
    expect(payload.note).toContain('call readSkill with its skillId for the default SKILL.md entry');
    expect(payload.note).toContain('Runtime does not auto-expand suggested skill bodies');
    expect(payload.skills[0]).toMatchObject({
      id: 'pdf',
      path: 'pdf/SKILL.md',
      label: 'PDF',
    });
    expect(JSON.stringify(payload)).not.toContain('Render PDF pages before reviewing layout');
  });

  it('injects prompt-only tool guidance without leaking it into provider schemas', () => {
    const descriptor: ToolDescriptor = {
      id: 'read',
      description: 'schema description should stay in schema',
      promptSnippet: 'Read snippets only.',
      promptGuidelines: ['Read before editing.', 'Read before editing.'],
      executionMode: 'parallel',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['path', 'reason'],
        additionalProperties: false,
      },
    };

    const assembled = assembleWorkTurnContext({
      persona: 'Base workspace persona',
      tools: [
        descriptor,
        {
          id: 'hidden_tool',
          description: 'hidden schema description',
          promptSnippet: false,
          promptGuidelines: ['hidden guidance'],
        },
      ],
      messages: [{ role: 'user', content: 'inspect tools' }],
    });

    expect(assembled.systemPrompt).toContain('<workspace_tools>');
    expect(assembled.systemPrompt).toContain('<tool_layers>');
    expect(assembled.systemPrompt).toContain('<layer name="Project files" tools="read">');
    expect(assembled.systemPrompt).toContain('<tool_use_order>');
    expect(assembled.systemPrompt).toContain('<tool_details>');
    expect(assembled.systemPrompt).toContain(TOOL_REASON_DISCIPLINE);
    expect(assembled.systemPrompt).toContain('<tool name="read">');
    expect(assembled.systemPrompt).toContain('<use>Read snippets only.</use>');
    expect(assembled.systemPrompt).toContain('<arg name="path" required="true" type="string">');
    expect(assembled.systemPrompt).toContain('<arg name="reason" required="true" type="string">');
    expect(assembled.systemPrompt).toContain('<rule>Read before editing.</rule>');
    expect(assembled.systemPrompt.match(/Read before editing/g)).toHaveLength(1);
    expect(assembled.systemPrompt).not.toContain('schema description should stay in schema');
    expect(assembled.systemPrompt).not.toContain('hidden_tool');
    expect(assembled.systemPrompt).not.toContain('hidden guidance');

    const schema = toToolSchema(descriptor);
    expect(schema).toEqual({
      name: 'read',
      description: 'schema description should stay in schema',
      parameters: descriptor.parameters,
    });
    expect(schema).not.toHaveProperty('promptSnippet');
    expect(schema).not.toHaveProperty('promptGuidelines');
    expect(schema).not.toHaveProperty('executionMode');
  });

  it('tells CLI workspaces to locate existing-file details before using edit instead of write', () => {
    const fileTools: ToolDescriptor[] = ['grep', 'read', 'edit', 'write'].map((id) => ({
      id,
      description: `${id} schema description`,
      promptSnippet: `Use ${id}.`,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    }));

    const assembled = assembleWorkTurnContext({
      persona: 'Cli workspace persona',
      tools: fileTools,
      messages: [{ role: 'user', content: '这个已有 HTML 页面有个细节问题' }],
    });

    expect(assembled.systemPrompt).toContain('For small changes to an existing file or artifact');
    expect(assembled.systemPrompt).toContain('locate the relevant text with grep/read first');
    expect(assembled.systemPrompt).toContain('then call edit with exact old_string/new_string');
    expect(assembled.systemPrompt).toContain('Use write only for new files or when the user explicitly asks for a full rewrite/regeneration');
  });

  it('renders Cache tool guidance as XML without exposing write-cache tools', () => {
    const assembled = assembleWorkTurnContext({
      persona: 'Base workspace persona',
      tools: [
        {
          id: 'listCache',
          promptSnippet: 'List runtime Cache entries.',
          promptGuidelines: ['You cannot write Cache. Runtime writes Cache automatically.'],
          parameters: {
            type: 'object',
            properties: { reason: { type: 'string', description: 'Why Cache may be needed now.' } },
            required: ['reason'],
            additionalProperties: false,
          },
        },
        {
          id: 'readCache',
          promptSnippet: 'Read one runtime Cache entry.',
          promptGuidelines: ['Do not invent cache ids.'],
          parameters: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Cache id from listCache.' },
              reason: { type: 'string', description: 'Why this entry is needed now.' },
            },
            required: ['id', 'reason'],
            additionalProperties: false,
          },
        },
      ],
      messages: [{ role: 'user', content: 'continue from prior workspace evidence' }],
    });

    expect(assembled.systemPrompt).toContain('<layer name="Cache" tools="listCache, readCache">');
    expect(assembled.systemPrompt).toContain('<tool name="listCache">');
    expect(assembled.systemPrompt).toContain('<tool name="readCache">');
    expect(assembled.systemPrompt).toContain('<arg name="id" required="true" type="string">');
    expect(assembled.systemPrompt).toContain('<rule>Do not invent cache ids.</rule>');
    expect(assembled.systemPrompt).not.toContain('saveCache');
    expect(assembled.systemPrompt).not.toContain('&lt;tool name=');
  });

  it('keeps legacy enterWorkspace compatible as a hidden structured result path', async () => {
    const emitted: WorkspaceDelta[] = [];
    const result = await runTurnLoop(
      workContext(emitted),
      {
        registries: registries((request) => {
          const toolNames = new Set((request.tools ?? []).map((tool) => tool.name));
          expect(toolNames.has('enterWorkspace')).toBe(false);
          return {
            toolCalls: [
              {
                name: 'enterWorkspace',
                arguments: {
                  status: 'completed',
                  summary: 'Structured result delivered.',
                  artifacts: [{ kind: 'file', ref: '/tmp/result.txt', description: 'Result file' }],
                  observations: ['Observation one'],
                  errors: [],
                  suggestedNextSteps: ['Review the result'],
                },
              },
            ],
          };
        }),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        messages: [{ role: 'user', content: 'finish this' }],
        deliverFinal: true,
      },
      new AbortController().signal,
    );

    expect(result.workspaceResult).toEqual({
      status: 'completed',
      summary: 'Structured result delivered.',
      artifacts: [{ kind: 'file', ref: '/tmp/result.txt', description: 'Result file' }],
      observations: ['Observation one'],
      errors: [],
      suggestedNextSteps: ['Review the result'],
    });
    expect(result.conclusion).toBe('Structured result delivered.');
    // On success enterWorkspace echoes its structured arguments as the console
    // detail (same payload as the `start` delta), not a plain acceptance string.
    const exitStart = emitted.find(
      (delta) => delta.kind === 'tool' && delta.name === 'enterWorkspace' && delta.phase === 'start',
    ) as { detail: unknown } | undefined;
    expect(exitStart).toBeDefined();
    expect(emitted).toContainEqual(expect.objectContaining({
      kind: 'tool',
      name: 'enterWorkspace',
      phase: 'end',
      toolCallId: 'tool_enterWorkspace',
      detail: exitStart!.detail,
      isError: false,
    }));
  });

  it('exposes switchWorkspace and finishTask instead of enterWorkspace in work spaces', async () => {
    const emitted: WorkspaceDelta[] = [];
    let toolNames: string[] = [];
    let switchWorkspaceSchema: ProviderRequest['tools'][number] | undefined;
    let systemPrompt = '';

    await runTurnLoop(
      workContext(emitted),
      {
        registries: registries((request) => {
          const tools = request.tools ?? [];
          toolNames = tools.map((tool) => tool.name);
          switchWorkspaceSchema = tools.find((tool) => tool.name === 'switchWorkspace');
          systemPrompt = request.systemPrompt;
          return {
            toolCalls: [{
              name: 'finishTask',
              arguments: { message: 'Final result from finishTask.' },
            }],
          };
        }),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        messages: [{ role: 'user', content: 'finish this' }],
        deliverFinal: true,
      },
      new AbortController().signal,
    );

    expect(toolNames).toContain('switchWorkspace');
    expect(toolNames).toContain('finishTask');
    expect(toolNames).not.toContain('enterWorkspace');
    const switchParameters = switchWorkspaceSchema?.parameters as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(switchParameters.properties).not.toHaveProperty('goal');
    expect(switchParameters.required).not.toContain('goal');
    expect(systemPrompt).toContain('call finishTask');
    expect(systemPrompt).toContain('call switchWorkspace');
    expect(systemPrompt).not.toContain('Call enterWorkspace exactly once');
  });

  it('finishes a work space with finishTask defaulting to completed', async () => {
    const emitted: WorkspaceDelta[] = [];
    const result = await runTurnLoop(
      workContext(emitted),
      {
        registries: registries(() => ({
          toolCalls: [{
            id: 'tool_finishTask',
            name: 'finishTask',
            arguments: { message: 'The report is complete.' },
          }],
        })),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        messages: [{ role: 'user', content: 'finish this' }],
        deliverFinal: true,
      },
      new AbortController().signal,
    );

    expect(result.workspaceResult).toEqual({
      status: 'completed',
      summary: 'The report is complete.',
      artifacts: [],
      observations: [],
      errors: [],
      suggestedNextSteps: [],
    });
    expect(result.conclusion).toBe('The report is complete.');
    expect(emitted).toContainEqual(expect.objectContaining({
      kind: 'tool',
      name: 'finishTask',
      phase: 'end',
      toolCallId: 'tool_finishTask',
      isError: false,
    }));
  });

  it('records git clone outputs as imported instead of generated artifacts', async () => {
    const emitted: WorkspaceDelta[] = [];
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'zleap-artifact-source-'));
    const clonedReadme = join(workspaceRoot, 'SAG', 'README.md');
    let calls = 0;
    try {
      const result = await runTurnLoop(
        {
          ...workContext(emitted, [], [{ id: 'bash', description: 'Run shell commands.' }]),
          workspaceRoot,
          callTool: async () => {
            calls += 1;
            await mkdir(join(workspaceRoot, 'SAG'), { recursive: true });
            await writeFile(clonedReadme, '# SAG');
            return 'cloned SAG';
          },
        },
        {
          registries: registries((request) => {
            const latestToolResult = request.messages
              .filter((message): message is Extract<(typeof request.messages)[number], { role: 'toolResult' }> => message.role === 'toolResult')
              .at(-1);
            if (!latestToolResult) {
              return {
                toolCalls: [{
                  id: 'tool_bash_clone',
                  name: 'bash',
                  arguments: {
                    command: 'git clone https://github.com/Zleap-AI/SAG.git SAG',
                    reason: 'clone the requested repository for inspection',
                  },
                }],
              };
            }
            return {
              toolCalls: [{
                id: 'tool_finishTask',
                name: 'finishTask',
                arguments: {
                  status: 'completed',
                  message: 'Repository cloned.',
                  artifacts: [{ kind: 'file', ref: clonedReadme, description: 'README.md' }],
                },
              }],
            };
          }),
          modelId: TEST_MODEL,
          persona: 'Work persona',
          messages: [{ role: 'user', content: 'clone SAG' }],
          deliverFinal: true,
          workspaceId: 'cli',
          approvalPolicy: {
            rules: [{ id: 'allow-bash-clone-test', decision: 'allow', toolIds: ['bash'] }],
          },
        },
        new AbortController().signal,
      );

      expect(calls).toBe(1);
      expect(result.artifactCandidates).toEqual([
        expect.objectContaining({ ref: clonedReadme, source: 'imported', toolName: 'bash' }),
      ]);
      expect(result.workspaceResult?.artifacts).toEqual([]);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('records generated bash outputs as generated artifacts', async () => {
    const emitted: WorkspaceDelta[] = [];
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'zleap-artifact-source-'));
    const report = join(workspaceRoot, 'report.pdf');
    try {
      const result = await runTurnLoop(
        {
          ...workContext(emitted, [], [{ id: 'bash', description: 'Run shell commands.' }]),
          workspaceRoot,
          callTool: async () => {
            await writeFile(report, '%PDF-1.4\n%%EOF');
            return 'generated report.pdf';
          },
        },
        {
          registries: registries((request) => {
            const latestToolResult = request.messages
              .filter((message): message is Extract<(typeof request.messages)[number], { role: 'toolResult' }> => message.role === 'toolResult')
              .at(-1);
            if (!latestToolResult) {
              return {
                toolCalls: [{
                  id: 'tool_bash_generate',
                  name: 'bash',
                  arguments: {
                    command: 'python generate_report.py',
                    reason: 'generate the requested PDF report',
                  },
                }],
              };
            }
            return {
              toolCalls: [{
                id: 'tool_finishTask',
                name: 'finishTask',
                arguments: {
                  status: 'completed',
                  message: 'Report generated.',
                },
              }],
            };
          }),
          modelId: TEST_MODEL,
          persona: 'Work persona',
          messages: [{ role: 'user', content: 'generate pdf' }],
          deliverFinal: true,
          workspaceId: 'cli',
          approvalPolicy: {
            rules: [{ id: 'allow-bash-generate-test', decision: 'allow', toolIds: ['bash'] }],
          },
        },
        new AbortController().signal,
      );

      expect(result.artifactCandidates).toEqual([
        expect.objectContaining({ ref: report, source: 'generated', toolName: 'bash' }),
      ]);
      expect(result.workspaceResult?.artifacts).toEqual([
        expect.objectContaining({ ref: report, source: 'generated' }),
      ]);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('requests a direct workspace switch with switchWorkspace', async () => {
    const emitted: WorkspaceDelta[] = [];
    const result = await runTurnLoop(
      workContext(emitted),
      {
        registries: registries(() => ({
          toolCalls: [{
            id: 'tool_switchWorkspace',
            name: 'switchWorkspace',
            arguments: {
              space: 'cli',
              task: 'Generate the PDF from collected research.',
              message: 'Research is complete; CLI should generate the PDF.',
            },
          }],
        })),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        messages: [{ role: 'user', content: 'collect research then generate pdf' }],
        deliverFinal: true,
        workspaceId: 'web-search',
      },
      new AbortController().signal,
    );

    expect(result.workspaceResult).toMatchObject({
      status: 'completed',
      summary: 'Research is complete; CLI should generate the PDF.',
      handoffs: [{
        space: 'cli',
        task: 'Generate the PDF from collected research.',
        reason: 'Research is complete; CLI should generate the PDF.',
      }],
    });
    expect(emitted).toContainEqual(expect.objectContaining({
      kind: 'tool',
      name: 'switchWorkspace',
      phase: 'end',
      toolCallId: 'tool_switchWorkspace',
      isError: false,
    }));
  });

  it('mounts read-only Cache tools without exposing saveCache', async () => {
    const emitted: WorkspaceDelta[] = [];
    let systemPrompt = '';
    await runTurnLoop(
      workContext(emitted),
      {
        registries: registries((request) => {
          systemPrompt = request.systemPrompt;
          const toolNames = new Set((request.tools ?? []).map((tool) => tool.name));
          expect(toolNames.has('listCache')).toBe(true);
          expect(toolNames.has('readCache')).toBe(true);
          expect(toolNames.has('saveCache')).toBe(false);
          return 'Done.';
        }),
        modelId: TEST_MODEL,
        persona: 'Workspace persona',
        messages: [{ role: 'user', content: 'Use available cache only if needed.' }],
        runtimeCache: {
          captureToolResult: async () => null,
          listForModel: async () => ({ entries: [] }),
          readForModel: async () => ({ found: false, error: 'cache_entry_not_found_or_not_visible' }),
        },
      },
      new AbortController().signal,
    );
    expect(systemPrompt).toContain('Cache tools are runtime tools available in every workspace.');
    expect(systemPrompt).toContain('When listCache returns entries that may help the current task, proactively read the most relevant entries with readCache before continuing.');
    expect(systemPrompt).toContain('Cache is for cross-workspace evidence handoff, not for recovering historical tool results from the current transcript.');
    expect(systemPrompt).toContain('If a shortened historical tool result says it needs full details, use readMessage with its id, not readCache.');
    expect(systemPrompt).not.toContain('summary is not enough');
  });

  it('explains how to recover when readCache receives a non-cache id', async () => {
    const emitted: WorkspaceDelta[] = [];
    let calls = 0;
    await runTurnLoop(
      workContext(emitted),
      {
        registries: registries(() => {
          calls += 1;
          return calls === 1
            ? {
                toolCalls: [{
                  id: 'tool_readCache',
                  name: 'readCache',
                  arguments: {
                    id: '04a4b3f3-a6a2-45b3-93ee-3098338e003b',
                    reason: 'recover prior cached evidence',
                  },
                }],
              }
            : 'Done.';
        }),
        modelId: TEST_MODEL,
        persona: 'Workspace persona',
        messages: [{ role: 'user', content: 'Use cached evidence.' }],
        runtimeCache: {
          captureToolResult: async () => null,
          listForModel: async () => ({ entries: [] }),
          readForModel: async () => ({ found: false, error: 'cache_entry_not_found_or_not_visible' }),
        },
      },
      new AbortController().signal,
    );

    expect(emitted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'tool',
        name: 'readCache',
        phase: 'end',
        isError: true,
        detail: expect.stringContaining('Call listCache first'),
      }),
    ]));
    expect(emitted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'tool',
        name: 'readCache',
        phase: 'end',
        detail: expect.stringContaining('Do not pass message ids, tool call ids, UUIDs, or history entry ids to readCache.'),
      }),
    ]));
  });

  it('captures successful cache-producing tool results through runtime Cache', async () => {
    const emitted: WorkspaceDelta[] = [];
    const captureToolResult = vi.fn(async () => null);
    const context = workContext(emitted, [], [{
      id: 'web_search',
      description: 'search',
      cache: { produces: true, kinds: ['search_result'], capture: 'auto' },
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    }]);
    context.callTool = async () => ({ summary: 'Search summary', items: [{ title: 'Result' }] });

    let modelCalls = 0;
    await runTurnLoop(
      context,
      {
        registries: registries(() => {
          modelCalls += 1;
          return modelCalls === 1
            ? {
                toolCalls: [{
                  id: 'call_1',
                  name: 'web_search',
                  arguments: { q: '302.AI' },
                }],
              }
            : 'Done.';
        }),
        modelId: TEST_MODEL,
        persona: 'Workspace persona',
        messages: [{ role: 'user', content: 'Search 302.AI.' }],
        runtimeCacheScope: { userId: 'u1', agentId: 'a1', threadId: 't1', conversationId: 't1', runId: 'r1' },
        runtimeCache: {
          captureToolResult,
          listForModel: async () => ({ entries: [] }),
          readForModel: async () => ({ found: false, error: 'cache_entry_not_found_or_not_visible' }),
        },
      },
      new AbortController().signal,
    );

    expect(captureToolResult).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1',
      agentId: 'a1',
      threadId: 't1',
      conversationId: 't1',
      runId: 'r1',
      workspaceId: undefined,
      toolCallId: 'call_1',
      toolId: 'web_search',
      toolInput: { q: '302.AI' },
      toolResult: { summary: 'Search summary', items: [{ title: 'Result' }] },
      capability: { produces: true, kinds: ['search_result'], capture: 'auto' },
    }));
  });

  it('rejects enterWorkspace artifacts without stable refs', async () => {
    const emitted: WorkspaceDelta[] = [];
    let calls = 0;
    const result = await runTurnLoop(
      workContext(emitted),
      {
        registries: registries(() => {
          calls += 1;
          if (calls === 1) {
            return {
              toolCalls: [
                {
                  name: 'enterWorkspace',
                  arguments: {
                    status: 'completed',
                    summary: 'Bad artifact.',
                    artifacts: [{ kind: 'file', ref: '' }],
                  },
                },
              ],
            };
          }
          return {
            toolCalls: [
              {
                name: 'enterWorkspace',
                arguments: {
                  status: 'completed',
                  summary: 'Structured result delivered.',
                  artifacts: [{ kind: 'file', ref: '/tmp/result.txt' }],
                },
              },
            ],
          };
        }),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        messages: [{ role: 'user', content: 'finish this' }],
        deliverFinal: true,
      },
      new AbortController().signal,
    );

    expect(result.workspaceResult).toMatchObject({
      status: 'completed',
      summary: 'Structured result delivered.',
      artifacts: [{ kind: 'file', ref: '/tmp/result.txt' }],
    });
    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'tool',
          name: 'enterWorkspace',
          phase: 'end',
          isError: true,
          detail: expect.stringContaining('requires non-empty kind and ref'),
        }),
      ]),
    );
  });

  it('parses enterWorkspace handoff requests for follow-up spaces', async () => {
    const emitted: WorkspaceDelta[] = [];
    const result = await runTurnLoop(
      workContext(emitted),
      {
        registries: registries(() => ({
          toolCalls: [
            {
              name: 'enterWorkspace',
              arguments: {
                status: 'completed',
                summary: 'Collected source material.',
                handoffs: [{
                  space: 'cli',
                  task: 'Generate the PDF from the collected research.',
                  context: 'Use the GLM-5.2 source summary from web search.',
                  reason: 'PDF generation requires scripts and local files.',
                }],
              },
            },
          ],
        })),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        messages: [{ role: 'user', content: 'collect research then hand off' }],
        deliverFinal: true,
        workspaceId: 'web-search',
      },
      new AbortController().signal,
    );

    expect(result.workspaceResult).toMatchObject({
      status: 'completed',
      summary: 'Collected source material.',
      handoffs: [{
        space: 'cli',
        task: 'Generate the PDF from the collected research.',
        context: 'Use the GLM-5.2 source summary from web search.',
        reason: 'PDF generation requires scripts and local files.',
      }],
    });
  });

  it('rejects enterWorkspace handoffs back to the same workspace', async () => {
    const emitted: WorkspaceDelta[] = [];
    let calls = 0;
    const result = await runTurnLoop(
      workContext(emitted),
      {
        registries: registries(() => {
          calls += 1;
          if (calls === 1) {
            return {
              toolCalls: [
                {
                  name: 'enterWorkspace',
                  arguments: {
                    status: 'completed',
                    summary: 'Bad handoff.',
                    handoffs: [{ space: 'web-search', task: 'Search again.' }],
                  },
                },
              ],
            };
          }
          return {
            toolCalls: [
              {
                name: 'enterWorkspace',
                arguments: {
                  status: 'completed',
                  summary: 'Returned without self handoff.',
                },
              },
            ],
          };
        }),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        messages: [{ role: 'user', content: 'do not hand off to self' }],
        deliverFinal: true,
        workspaceId: 'web-search',
      },
      new AbortController().signal,
    );

    expect(result.workspaceResult).toMatchObject({
      status: 'completed',
      summary: 'Returned without self handoff.',
    });
    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'tool',
          name: 'enterWorkspace',
          phase: 'end',
          isError: true,
          detail: expect.stringContaining('cannot target the current workspace'),
        }),
      ]),
    );
  });

  it('accepts plain-text enterWorkspace arguments as a completed summary', async () => {
    const emitted: WorkspaceDelta[] = [];
    const result = await runTurnLoop(
      workContext(emitted),
      {
        registries: registries(() => ({
          toolCalls: [
            {
              name: 'enterWorkspace',
              arguments: 'Finished with a plain text summary.',
            },
          ],
        })),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        messages: [{ role: 'user', content: 'finish this' }],
        deliverFinal: true,
      },
      new AbortController().signal,
    );

    expect(result.workspaceResult).toMatchObject({
      status: 'completed',
      summary: 'Finished with a plain text summary.',
    });
    expect(emitted).toContainEqual(
      expect.objectContaining({
        kind: 'tool',
        name: 'enterWorkspace',
        phase: 'end',
        isError: false,
      }),
    );
  });

  it('uses the latest assistant text when enterWorkspace omits arguments', async () => {
    const emitted: WorkspaceDelta[] = [];
    const result = await runTurnLoop(
      workContext(emitted),
      {
        registries: registries(() => ({
          text: 'Finished from the assistant text.',
          toolCalls: [
            {
              name: 'enterWorkspace',
              arguments: undefined,
            },
          ],
        })),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        messages: [{ role: 'user', content: 'finish this' }],
        deliverFinal: true,
      },
      new AbortController().signal,
    );

    expect(result.workspaceResult).toMatchObject({
      status: 'completed',
      summary: 'Finished from the assistant text.',
    });
    expect(emitted).toContainEqual(
      expect.objectContaining({
        kind: 'tool',
        name: 'enterWorkspace',
        phase: 'end',
        isError: false,
      }),
    );
  });

  it('runs parallel tool descriptors concurrently while preserving tool result order', async () => {
    const emitted: WorkspaceDelta[] = [];
    const started: string[] = [];
    let releaseFastA!: (value: string) => void;
    const fastAResult = new Promise<string>((resolve) => {
      releaseFastA = resolve;
    });
    let turn = 0;
    let observationError: unknown;
    const context: WorkContext = {
      ...workContext(emitted, [], [
        { id: 'fast_a', description: 'Fast A', executionMode: 'parallel' },
        { id: 'fast_b', description: 'Fast B', executionMode: 'parallel' },
        { id: 'slow', description: 'Slow', executionMode: 'sequential' },
      ]),
      callTool: async (toolId) => {
        started.push(toolId);
        if (toolId === 'fast_a') {
          return fastAResult;
        }
        if (toolId === 'fast_b') {
          return 'B';
        }
        if (toolId === 'slow') {
          return 'S';
        }
        throw new Error(`unexpected tool: ${toolId}`);
      },
    };

    const run = runTurnLoop(
      context,
      {
        registries: registries((request) => {
          turn += 1;
          if (turn === 1) {
            return {
              toolCalls: [
                { name: 'fast_a', arguments: {} },
                { name: 'fast_b', arguments: {} },
                { name: 'slow', arguments: {} },
              ],
            };
          }
          const toolResults = request.messages.filter(
            (message): message is Extract<(typeof request.messages)[number], { role: 'toolResult' }> =>
              message.role === 'toolResult',
          );
          expect(toolResults.map((message) => message.toolName)).toEqual(['fast_a', 'fast_b', 'slow']);
          expect(toolResults.map((message) => message.content)).toEqual(['A', 'B', 'S']);
          return 'Parallel tools completed.';
        }),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        messages: [{ role: 'user', content: 'run parallel checks' }],
      },
      new AbortController().signal,
    );

    try {
      await waitFor(() => started.includes('fast_b'));
      expect(started).toEqual(['fast_a', 'fast_b']);
      expect(started).not.toContain('slow');
    } catch (error) {
      observationError = error;
    } finally {
      releaseFastA('A');
    }

    const result = await run;
    if (observationError) {
      throw observationError;
    }
    expect(started).toEqual(['fast_a', 'fast_b', 'slow']);
    expect(result.conclusion).toBe('Parallel tools completed.');
    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'turn_lifecycle',
          phase: 'end',
          outcome: 'tool_results',
          toolCallCount: 3,
          toolResultCount: 3,
        }),
      ]),
    );
  });

  it('returns needs_approval when a high-risk tool is not approved', async () => {
    const emitted: WorkspaceDelta[] = [];
    let callToolCount = 0;
    const context: WorkContext = {
      ...workContext(emitted, [], [{ id: 'write', description: 'Write a file.' }]),
      callTool: async (toolId) => {
        callToolCount += 1;
        throw new Error(`unexpected external tool: ${toolId}`);
      },
    };

    const result = await runTurnLoop(
      context,
      {
        registries: registries(() => ({
          toolCalls: [
            {
              id: 'tool_call_write',
              name: 'write',
              arguments: {
                path: 'notes.md',
                content: 'should not be written',
                reason: 'persist the requested notes',
              },
            },
          ],
        })),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        messages: [{ role: 'user', content: 'write notes' }],
        confirm: async () => false,
        deliverFinal: true,
      },
      new AbortController().signal,
    );

    expect(callToolCount).toBe(0);
    expect(result.hitToolLimit).toBe(false);
    expect(result.workspaceResult).toMatchObject({
      status: 'needs_approval',
      summary: 'Tool "write" requires approval before execution. No action was taken.',
      artifacts: [],
      errors: [],
    });
    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'approval',
          status: 'needs_approval',
          approvalId: 'approval_tool_call_write',
          name: 'write',
          message: 'Tool "write" requires approval before execution. No action was taken.',
        }),
        expect.objectContaining({
          kind: 'turn_lifecycle',
          status: 'completed',
          outcome: 'workspace_result',
          workspaceResultStatus: 'needs_approval',
        }),
      ]),
    );
  });

  it('auto-fills missing tool reasons before execution', async () => {
    const emitted: WorkspaceDelta[] = [];
    const executedInputs: unknown[] = [];
    const readTool: ToolDescriptor = {
      id: 'read',
      description: 'Read a file.',
      promptSnippet: 'Read file contents.',
      recovery: AUTOFILL_REASON_RECOVERY,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['path', 'reason'],
        additionalProperties: false,
      },
      executionMode: 'parallel',
    };
    const context: WorkContext = {
      ...workContext(emitted, [], [readTool]),
      callTool: async (_toolId, input) => {
        executedInputs.push(input);
        return 'README contents';
      },
    };

    const result = await runTurnLoop(
      context,
      {
        registries: registries((request) => {
          const toolResults = request.messages.filter(
            (message): message is Extract<(typeof request.messages)[number], { role: 'toolResult' }> =>
              message.role === 'toolResult',
          );
          const latestToolResult = toolResults.at(-1);
          if (!latestToolResult) {
            return { toolCalls: [{ id: 'missing_reason', name: 'read', arguments: { path: 'README.md' } }] };
          }
          return 'Read complete.';
        }),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        messages: [{ role: 'user', content: 'read README' }],
      },
      new AbortController().signal,
    );

    expect(executedInputs).toHaveLength(1);
    expect(executedInputs[0]).toMatchObject({
      path: 'README.md',
      reason: expect.stringContaining('Runtime auto reason: run read on path="README.md"'),
    });
    expect(result.conclusion).toBe('Read complete.');
    expect(emitted).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'tool',
          name: 'read',
          phase: 'end',
          isError: true,
        }),
      ]),
    );
  });

  it('auto-fills missing edit reasons before approval and execution', async () => {
    const emitted: WorkspaceDelta[] = [];
    const executedInputs: unknown[] = [];
    const editTool: ToolDescriptor = {
      id: 'edit',
      description: 'Edit a file.',
      promptSnippet: 'Edit file contents.',
      recovery: AUTOFILL_REASON_RECOVERY,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['path', 'reason'],
        additionalProperties: false,
      },
    };
    const context: WorkContext = {
      ...workContext(emitted, [], [editTool]),
      callTool: async (_toolId, input) => {
        executedInputs.push(input);
        return 'Updated README.md (+1 -1)';
      },
    };

    const result = await runTurnLoop(
      context,
      {
        registries: registries((request) => {
          const latestToolResult = request.messages
            .filter((message): message is Extract<(typeof request.messages)[number], { role: 'toolResult' }> => message.role === 'toolResult')
            .at(-1);
          if (!latestToolResult) {
            return {
              toolCalls: [
                {
                  id: 'edit_missing_reason',
                  name: 'edit',
                  arguments: { path: 'README.md', old_string: 'old', new_string: 'new' },
                },
              ],
            };
          }
          return 'Edit complete.';
        }),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        messages: [{ role: 'user', content: 'edit README' }],
        approvalPolicy: {
          rules: [{ id: 'allow-edit-reason-retry-test', decision: 'allow', toolIds: ['edit'] }],
        },
      },
      new AbortController().signal,
    );

    expect(executedInputs).toHaveLength(1);
    expect(executedInputs[0]).toMatchObject({
      path: 'README.md',
      old_string: 'old',
      new_string: 'new',
      reason: expect.stringContaining('Runtime auto reason: run edit on path="README.md"'),
    });
    expect(result.conclusion).toBe('Edit complete.');
    expect(emitted).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'tool',
          name: 'edit',
          phase: 'end',
          isError: true,
        }),
      ]),
    );
  });

  it('returns actionable write argument feedback when the model only supplies reason', async () => {
    const emitted: WorkspaceDelta[] = [];
    const executedInputs: unknown[] = [];
    let sawWriteFeedback = false;
    const writeTool: ToolDescriptor = {
      id: 'write',
      description: 'Write a file.',
      promptSnippet: 'Write complete file contents.',
      recovery: AUTOFILL_WRITE_RECOVERY,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['path', 'content', 'reason'],
        additionalProperties: false,
      },
    };
    const context: WorkContext = {
      ...workContext(emitted, [], [writeTool]),
      callTool: async (_toolId, input) => {
        executedInputs.push(input);
        if (!input || typeof input !== 'object' || !('path' in input)) {
          const error = new Error('write requires a "path".') as Error & { code: 'tool_failed' };
          error.code = 'tool_failed';
          throw error;
        }
        return 'Wrote report.md';
      },
    };

    const result = await runTurnLoop(
      context,
      {
        registries: registries((request) => {
          const latestToolResult = request.messages
            .filter((message): message is Extract<(typeof request.messages)[number], { role: 'toolResult' }> => message.role === 'toolResult')
            .at(-1);
          if (!latestToolResult) {
            return { toolCalls: [{ id: 'write_missing_args', name: 'write', arguments: {} }] };
          }
          if (latestToolResult.isError) {
            sawWriteFeedback = true;
            expect(latestToolResult.content).toContain('Recover by calling write again with a complete file payload');
            expect(latestToolResult.content).toContain('- path: preferred relative output file path');
            expect(latestToolResult.content).toContain('- content: complete final UTF-8 file content');
            expect(latestToolResult.content).toContain('Do not call write with only reason');
            return {
              toolCalls: [
                {
                  id: 'write_fixed_args',
                  name: 'write',
                  arguments: {
                    path: 'report.md',
                    content: '# Report\n\nDone.\n',
                    reason: 'create the requested report file',
                  },
                },
              ],
            };
          }
          return 'Report written.';
        }),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        messages: [{ role: 'user', content: 'write a report' }],
        approvalPolicy: {
          rules: [{ id: 'allow-write-argument-feedback-test', decision: 'allow', toolIds: ['write'] }],
        },
      },
      new AbortController().signal,
    );

    expect(sawWriteFeedback).toBe(true);
    expect(executedInputs).toHaveLength(1);
    expect(executedInputs[0]).toMatchObject({
      path: 'report.md',
      content: '# Report\n\nDone.\n',
      reason: 'create the requested report file',
    });
    expect(emitted).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'tool',
          name: 'write',
          toolCallId: 'write_missing_args',
        }),
      ]),
    );
    expect(result.conclusion).toBe('Report written.');
  });

  it('feeds back incomplete edit arguments without executing or showing a tool card', async () => {
    const emitted: WorkspaceDelta[] = [];
    const executedInputs: unknown[] = [];
    let sawEditFeedback = false;
    const editTool: ToolDescriptor = {
      id: 'edit',
      description: 'Edit a file.',
      recovery: AUTOFILL_REASON_RECOVERY,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['path', 'reason'],
        additionalProperties: false,
      },
    };
    const context: WorkContext = {
      ...workContext(emitted, [], [editTool]),
      callTool: async (_toolId, input) => {
        executedInputs.push(input);
        return 'Updated README.md';
      },
    };

    const result = await runTurnLoop(
      context,
      {
        registries: registries((request) => {
          const latestToolResult = request.messages
            .filter((message): message is Extract<(typeof request.messages)[number], { role: 'toolResult' }> => message.role === 'toolResult')
            .at(-1);
          if (!latestToolResult) {
            return { toolCalls: [{ id: 'edit_missing_args', name: 'edit', arguments: {} }] };
          }
          if (latestToolResult.isError) {
            sawEditFeedback = true;
            expect(latestToolResult.content).toContain('Missing required argument: path.');
            expect(latestToolResult.content).toContain('Call edit again with a complete JSON object matching its schema');
            return {
              toolCalls: [
                {
                  id: 'edit_fixed_args',
                  name: 'edit',
                  arguments: {
                    path: 'README.md',
                    old_string: 'old',
                    new_string: 'new',
                    reason: 'update README wording',
                  },
                },
              ],
            };
          }
          return 'Edit complete.';
        }),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        messages: [{ role: 'user', content: 'edit README' }],
        approvalPolicy: {
          rules: [{ id: 'allow-edit-missing-args-feedback-test', decision: 'allow', toolIds: ['edit'] }],
        },
      },
      new AbortController().signal,
    );

    expect(sawEditFeedback).toBe(true);
    expect(executedInputs).toEqual([
      {
        path: 'README.md',
        old_string: 'old',
        new_string: 'new',
        reason: 'update README wording',
      },
    ]);
    expect(emitted).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'tool',
          name: 'edit',
          toolCallId: 'edit_missing_args',
        }),
      ]),
    );
    expect(result.conclusion).toBe('Edit complete.');
  });

  it('rejects edit calls with only path and reason before approval or execution', async () => {
    const emitted: WorkspaceDelta[] = [];
    const executedInputs: unknown[] = [];
    let sawEditFeedback = false;
    const editTool: ToolDescriptor = {
      id: 'edit',
      description: 'Edit a file.',
      recovery: AUTOFILL_REASON_RECOVERY,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          edits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                old_string: { type: 'string' },
                new_string: { type: 'string' },
              },
              required: ['old_string', 'new_string'],
              additionalProperties: false,
            },
          },
          reason: { type: 'string' },
        },
        required: ['path', 'reason'],
        anyOf: [
          { required: ['path', 'old_string', 'new_string', 'reason'] },
          { required: ['path', 'edits', 'reason'] },
        ],
        additionalProperties: false,
      },
    };
    const context: WorkContext = {
      ...workContext(emitted, [], [editTool]),
      callTool: async (_toolId, input) => {
        executedInputs.push(input);
        return 'Updated README.md';
      },
    };

    await runTurnLoop(
      context,
      {
        registries: registries((request) => {
          const latestToolResult = request.messages
            .filter((message): message is Extract<(typeof request.messages)[number], { role: 'toolResult' }> => message.role === 'toolResult')
            .at(-1);
          if (!latestToolResult) {
            return {
              toolCalls: [
                {
                  id: 'edit_only_path_reason',
                  name: 'edit',
                  arguments: {
                    path: 'README.md',
                    reason: 'update README wording',
                  },
                },
              ],
            };
          }
          if (latestToolResult.isError) {
            sawEditFeedback = true;
            expect(latestToolResult.content).toContain('old_string and new_string');
            expect(latestToolResult.content).toContain('edits[]');
            return 'Stopped after edit feedback.';
          }
          return 'Unexpected edit success.';
        }),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        messages: [{ role: 'user', content: 'edit README' }],
        approvalPolicy: {
          rules: [{ id: 'allow-edit-only-path-reason-test', decision: 'allow', toolIds: ['edit'] }],
        },
      },
      new AbortController().signal,
    );

    expect(sawEditFeedback).toBe(true);
    expect(executedInputs).toEqual([]);
    expect(emitted).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'tool',
          name: 'edit',
          toolCallId: 'edit_only_path_reason',
        }),
      ]),
    );
  });

  it('parses stringified write arguments before adding runtime reason', async () => {
    const emitted: WorkspaceDelta[] = [];
    const executedInputs: unknown[] = [];
    const writeTool: ToolDescriptor = {
      id: 'write',
      description: 'Write a file.',
      recovery: AUTOFILL_WRITE_RECOVERY,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['path', 'content', 'reason'],
        additionalProperties: false,
      },
    };
    const context: WorkContext = {
      ...workContext(emitted, [], [writeTool]),
      callTool: async (_toolId, input) => {
        executedInputs.push(input);
        return 'Wrote notes.md';
      },
    };

    const result = await runTurnLoop(
      context,
      {
        registries: registries((request) => {
          const latestToolResult = request.messages
            .filter((message): message is Extract<(typeof request.messages)[number], { role: 'toolResult' }> => message.role === 'toolResult')
            .at(-1);
          if (!latestToolResult) {
            return {
              toolCalls: [
                {
                  id: 'write_string_args',
                  name: 'write',
                  arguments: '{"path":"notes.md","content":"hello\\n"}',
                },
              ],
            };
          }
          return 'Done.';
        }),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        messages: [{ role: 'user', content: 'write notes' }],
        approvalPolicy: {
          rules: [{ id: 'allow-write-string-args-test', decision: 'allow', toolIds: ['write'] }],
        },
      },
      new AbortController().signal,
    );

    expect(executedInputs).toHaveLength(1);
    expect(executedInputs[0]).toMatchObject({
      path: 'notes.md',
      content: 'hello\n',
      reason: expect.stringContaining('Runtime auto reason: run write on path="notes.md"'),
    });
    expect(result.conclusion).toBe('Done.');
  });

  it('repairs fenced write arguments with a trailing comma', async () => {
    const emitted: WorkspaceDelta[] = [];
    const executedInputs: unknown[] = [];
    const writeTool: ToolDescriptor = {
      id: 'write',
      description: 'Write a file.',
      recovery: AUTOFILL_WRITE_RECOVERY,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['path', 'content', 'reason'],
        additionalProperties: false,
      },
    };
    const context: WorkContext = {
      ...workContext(emitted, [], [writeTool]),
      callTool: async (_toolId, input) => {
        executedInputs.push(input);
        return 'Wrote notes.md';
      },
    };

    await runTurnLoop(
      context,
      {
        registries: registries((request) => {
          const latestToolResult = request.messages
            .filter((message): message is Extract<(typeof request.messages)[number], { role: 'toolResult' }> => message.role === 'toolResult')
            .at(-1);
          if (!latestToolResult) {
            return {
              toolCalls: [
                {
                  id: 'write_repaired_args',
                  name: 'write',
                  arguments: '```json\n{"path":"notes.md","content":"hello\\n",}\n```',
                },
              ],
            };
          }
          return 'Done.';
        }),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        messages: [{ role: 'user', content: 'write notes' }],
        approvalPolicy: {
          rules: [{ id: 'allow-write-repaired-args-test', decision: 'allow', toolIds: ['write'] }],
        },
      },
      new AbortController().signal,
    );

    expect(executedInputs).toHaveLength(1);
    expect(executedInputs[0]).toMatchObject({
      path: 'notes.md',
      content: 'hello\n',
      reason: expect.stringContaining('Runtime auto reason: run write on path="notes.md"'),
    });
  });

  it('coerces safe primitive string arguments before calling external tools', async () => {
    const emitted: WorkspaceDelta[] = [];
    const executedInputs: unknown[] = [];
    const configureTool: ToolDescriptor = {
      id: 'configure',
      description: 'Configure runtime.',
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
    };
    const context: WorkContext = {
      ...workContext(emitted, [], [configureTool]),
      callTool: async (_toolId, input) => {
        executedInputs.push(input);
        return 'Configured';
      },
    };

    await runTurnLoop(
      context,
      {
        registries: registries((request) => {
          const latestToolResult = request.messages
            .filter((message): message is Extract<(typeof request.messages)[number], { role: 'toolResult' }> => message.role === 'toolResult')
            .at(-1);
          if (!latestToolResult) {
            return {
              toolCalls: [
                {
                  id: 'configure_string_primitives',
                  name: 'configure',
                  arguments: { limit: '5', ratio: '0.5', enabled: 'false' },
                },
              ],
            };
          }
          return 'Done.';
        }),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        messages: [{ role: 'user', content: 'configure' }],
      },
      new AbortController().signal,
    );

    expect(executedInputs).toEqual([{ limit: 5, ratio: 0.5, enabled: false }]);
  });

  it('canonicalizes noisy schema keys before displaying and calling external tools', async () => {
    const emitted: WorkspaceDelta[] = [];
    const executedInputs: unknown[] = [];
    const readTool: ToolDescriptor = {
      id: 'read',
      description: 'Read a file.',
      promptSnippet: 'Read file contents.',
      recovery: AUTOFILL_REASON_RECOVERY,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          limit: { type: 'number' },
          reason: { type: 'string' },
        },
        required: ['path', 'reason'],
        additionalProperties: false,
      },
    };
    const context: WorkContext = {
      ...workContext(emitted, [], [readTool]),
      callTool: async (_toolId, input) => {
        executedInputs.push(input);
        return 'README contents';
      },
    };

    await runTurnLoop(
      context,
      {
        registries: registries((request) => {
          const latestToolResult = request.messages
            .filter((message): message is Extract<(typeof request.messages)[number], { role: 'toolResult' }> => message.role === 'toolResult')
            .at(-1);
          if (!latestToolResult) {
            return {
              toolCalls: [
                {
                  id: 'read_noisy_path_key',
                  name: 'read',
                  arguments: { 'path\u200B': 'README.md', ' Limit ': '5' },
                },
              ],
            };
          }
          return 'Read complete.';
        }),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        messages: [{ role: 'user', content: 'read README' }],
      },
      new AbortController().signal,
    );

    expect(executedInputs).toEqual([
      {
        path: 'README.md',
        limit: 5,
        reason: expect.stringContaining('Runtime auto reason: run read on path="README.md"'),
      },
    ]);
    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'tool',
          name: 'read',
          phase: 'start',
          detail: expect.stringContaining('"path": "README.md"'),
        }),
      ]),
    );
  });

  it('continues after an image turn when the model narrates an intended tool action without calling one', async () => {
    const emitted: WorkspaceDelta[] = [];
    const executedInputs: unknown[] = [];
    const readTool: ToolDescriptor = {
      id: 'read',
      description: 'Read a file.',
      promptSnippet: 'Read file contents.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['path', 'reason'],
        additionalProperties: false,
      },
    };
    const context: WorkContext = {
      ...workContext(emitted, [], [readTool]),
      callTool: async (_toolId, input) => {
        executedInputs.push(input);
        return 'font setup';
      },
    };
    let turn = 0;

    const result = await runTurnLoop(
      context,
      {
        registries: registries(() => {
          turn += 1;
          if (turn === 1) {
            return {
              text: '看到了，表格里的字显示异常。让我查看一下脚本里表格的具体实现。',
            };
          }
          if (turn === 2) {
            return {
              toolCalls: [
                {
                  id: 'read_table_impl',
                  name: 'read',
                  arguments: { path: 'generate_report.py', reason: 'inspect table font setup after reviewing the screenshot' },
                },
              ],
            };
          }
          return '已经检查脚本。';
        }),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '能看到吗' },
            { type: 'image', mimeType: 'image/png', data: 'screenshot-bytes' },
          ],
        }],
      },
      new AbortController().signal,
    );

    expect(executedInputs).toEqual([
      { path: 'generate_report.py', reason: 'inspect table font setup after reviewing the screenshot' },
    ]);
    expect(result.conclusion).toBe('已经检查脚本。');
    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'turn_lifecycle',
          phase: 'end',
          outcome: 'continue_nudge',
        }),
      ]),
    );
  });

  it('rejects malformed string write arguments before running the tool', async () => {
    const emitted: WorkspaceDelta[] = [];
    const executedInputs: unknown[] = [];
    const rawArguments = `{"path":"notes.md","content":"${'x'.repeat(1100)}`;
    const writeTool: ToolDescriptor = {
      id: 'write',
      description: 'Write a file.',
      recovery: AUTOFILL_WRITE_RECOVERY,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['path', 'content', 'reason'],
        additionalProperties: false,
      },
    };
    const context: WorkContext = {
      ...workContext(emitted, [], [writeTool]),
      callTool: async (_toolId, input) => {
        executedInputs.push(input);
        const error = new Error('write requires a "path".') as Error & { code: 'tool_failed' };
        error.code = 'tool_failed';
        throw error;
      },
    };

    await runTurnLoop(
      context,
      {
        registries: registries((request) => {
          const latestToolResult = request.messages
            .filter((message): message is Extract<(typeof request.messages)[number], { role: 'toolResult' }> => message.role === 'toolResult')
            .at(-1);
          if (!latestToolResult) {
            return {
              toolCalls: [
                {
                  id: 'write_malformed_string_args',
                  name: 'write',
                  arguments: rawArguments,
                  rawArguments,
                  argumentsParseError: `Unterminated string in JSON at position ${rawArguments.length}`,
                },
              ],
            };
          }
          expect(latestToolResult.content).toContain('arguments JSON is incomplete or malformed');
          expect(latestToolResult.content).toContain('Do not reuse the truncated arguments');
          expect(latestToolResult.content).toContain('append the remaining content in small ordered chunks');
          return 'Stopped after malformed arguments.';
        }),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        messages: [{ role: 'user', content: 'write notes' }],
        approvalPolicy: {
          rules: [{ id: 'allow-write-malformed-string-args-test', decision: 'allow', toolIds: ['write'] }],
        },
      },
      new AbortController().signal,
    );

    expect(executedInputs).toEqual([]);
    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'provider_lifecycle',
          phase: 'response',
          toolCalls: [
            expect.objectContaining({
              rawArgumentTail: expect.stringContaining('x'.repeat(40)),
              argumentsParseError: expect.stringContaining('Unterminated'),
            }),
          ],
        }),
      ]),
    );
    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'tool',
          name: 'write',
          phase: 'end',
          isError: true,
        }),
      ]),
    );
    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'tool',
          name: 'write',
          phase: 'start',
          detail: expect.stringContaining('rawArgumentsTail'),
        }),
      ]),
    );
  });

  it('repairs write arguments that only miss the final object closer', async () => {
    const emitted: WorkspaceDelta[] = [];
    const executedInputs: unknown[] = [];
    const rawArguments = '{"path":"notes.md","content":"hello","reason":"write note"';
    const writeTool: ToolDescriptor = {
      id: 'write',
      description: 'Write a file.',
      recovery: AUTOFILL_WRITE_RECOVERY,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['path', 'content', 'reason'],
        additionalProperties: false,
      },
    };
    const context: WorkContext = {
      ...workContext(emitted, [], [writeTool]),
      callTool: async (_toolId, input) => {
        executedInputs.push(input);
        return 'write ok';
      },
    };

    await runTurnLoop(
      context,
      {
        registries: registries((request) => {
          const latestToolResult = request.messages
            .filter((message): message is Extract<(typeof request.messages)[number], { role: 'toolResult' }> => message.role === 'toolResult')
            .at(-1);
          if (!latestToolResult) {
            return {
              toolCalls: [
                {
                  id: 'write_missing_final_object_closer',
                  name: 'write',
                  arguments: rawArguments,
                  rawArguments,
                  argumentsParseError: "Expected ',' or '}' after property value in JSON at position 57",
                },
              ],
            };
          }
          expect(latestToolResult.isError).not.toBe(true);
          return 'Wrote notes.';
        }),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        messages: [{ role: 'user', content: 'write notes' }],
        approvalPolicy: {
          rules: [{ id: 'allow-write-missing-final-object-closer-test', decision: 'allow', toolIds: ['write'] }],
        },
      },
      new AbortController().signal,
    );

    expect(executedInputs).toEqual([
      { path: 'notes.md', content: 'hello', reason: 'write note' },
    ]);
    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'tool',
          name: 'write',
          phase: 'end',
          isError: false,
        }),
      ]),
    );
  });

  it('repairs write arguments that only include content and miss the final object closer', async () => {
    const emitted: WorkspaceDelta[] = [];
    const executedInputs: unknown[] = [];
    const content = [
      '#!/usr/bin/env python3',
      '# -*- coding: utf-8 -*-',
      '"""Zleap 调研报告 PDF 生成 — fpdf2 + CJK fonts"""',
      '',
      'from fpdf import FPDF',
      '',
      'FONT_CJK = "/System/Library/Fonts/Hiragino Sans GB.ttc"',
      '',
      'FONT_SIZES = {"h1": 20, "h2": 16, "h3": 14, "h3b": 13, "body": 10, "small": 9}',
      'H1_SIZE, H2_SIZE, H3B_SIZE, BODY_SIZE, SMALL_SIZE = 20, 16, 13, 10, 9',
      'BODY_W = 170      # usable width per line in mm',
      '',
      'class RF(RF): pass  # placeholder',
      '',
    ].join('\n');
    const rawArguments = JSON.stringify({ content }).slice(0, -1);
    const writeTool: ToolDescriptor = {
      id: 'write',
      description: 'Write a file.',
      recovery: AUTOFILL_WRITE_RECOVERY,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['path', 'content', 'reason'],
        additionalProperties: false,
      },
    };
    const context: WorkContext = {
      ...workContext(emitted, [], [writeTool]),
      callTool: async (_toolId, input) => {
        executedInputs.push(input);
        return 'write ok';
      },
    };

    await runTurnLoop(
      context,
      {
        registries: registries((request) => {
          const latestToolResult = request.messages
            .filter((message): message is Extract<(typeof request.messages)[number], { role: 'toolResult' }> => message.role === 'toolResult')
            .at(-1);
          if (!latestToolResult) {
            return {
              toolCalls: [
                {
                  id: 'write_content_only_missing_final_object_closer',
                  name: 'write',
                  arguments: rawArguments,
                  rawArguments,
                  argumentsParseError: `Expected ',' or '}' after property value in JSON at position ${rawArguments.length}`,
                },
              ],
            };
          }
          expect(latestToolResult.isError).not.toBe(true);
          return 'Wrote generated.py.';
        }),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        messages: [{ role: 'user', content: 'write a Python PDF generator' }],
        approvalPolicy: {
          rules: [{ id: 'allow-write-content-only-missing-final-object-closer-test', decision: 'allow', toolIds: ['write'] }],
        },
      },
      new AbortController().signal,
    );

    expect(executedInputs).toEqual([
      {
        content,
        reason: expect.stringContaining('Runtime auto reason: run write'),
      },
    ]);
  });

  it('repairs common malformed write arguments before running the tool', async () => {
    const emitted: WorkspaceDelta[] = [];
    const executedInputs: unknown[] = [];
    const rawArguments = "```json\n{path: 'notes.md' content: 'hello', reason: 'write note',}\n```";
    const writeTool: ToolDescriptor = {
      id: 'write',
      description: 'Write a file.',
      recovery: AUTOFILL_WRITE_RECOVERY,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['path', 'content', 'reason'],
        additionalProperties: false,
      },
    };
    const context: WorkContext = {
      ...workContext(emitted, [], [writeTool]),
      callTool: async (_toolId, input) => {
        executedInputs.push(input);
        return 'write ok';
      },
    };

    await runTurnLoop(
      context,
      {
        registries: registries((request) => {
          const latestToolResult = request.messages
            .filter((message): message is Extract<(typeof request.messages)[number], { role: 'toolResult' }> => message.role === 'toolResult')
            .at(-1);
          if (!latestToolResult) {
            return {
              toolCalls: [
                {
                  id: 'write_common_malformed_args',
                  name: 'write',
                  arguments: rawArguments,
                  rawArguments,
                  argumentsParseError: "Expected double-quoted property name in JSON at position 9",
                },
              ],
            };
          }
          expect(latestToolResult.isError).not.toBe(true);
          return 'Wrote notes.';
        }),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        messages: [{ role: 'user', content: 'write notes' }],
        approvalPolicy: {
          rules: [{ id: 'allow-write-common-malformed-args-test', decision: 'allow', toolIds: ['write'] }],
        },
      },
      new AbortController().signal,
    );

    expect(executedInputs).toEqual([
      { path: 'notes.md', content: 'hello', reason: 'write note' },
    ]);
  });

  it('tells the model when malformed tool arguments were likely truncated by output limits', async () => {
    const emitted: WorkspaceDelta[] = [];
    const executedInputs: unknown[] = [];
    const rawArguments = '{"path":"generate_report.py","edits":[{"old_string":"make_style(\\\'Body\\\'","new_string":"make_style(\\\'BodyBold\\\'"';
    const editTool: ToolDescriptor = {
      id: 'edit',
      description: 'Edit a file.',
      recovery: AUTOFILL_REASON_RECOVERY,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          edits: { type: 'array' },
          reason: { type: 'string' },
        },
        required: ['path', 'edits', 'reason'],
        additionalProperties: false,
      },
    };
    const context: WorkContext = {
      ...workContext(emitted, [], [editTool]),
      callTool: async (_toolId, input) => {
        executedInputs.push(input);
        return 'should not run';
      },
    };

    await runTurnLoop(
      context,
      {
        registries: registries((request) => {
          const latestToolResult = request.messages
            .filter((message): message is Extract<(typeof request.messages)[number], { role: 'toolResult' }> => message.role === 'toolResult')
            .at(-1);
          if (!latestToolResult) {
            return {
              finishReason: 'max_tokens',
              toolCalls: [
                {
                  id: 'edit_truncated_args',
                  name: 'edit',
                  arguments: rawArguments,
                  rawArguments,
                  argumentsParseError: 'Unterminated string in JSON at position 117',
                },
              ],
            };
          }
          expect(latestToolResult.content).toContain('provider stopped with finishReason="max_tokens"');
          expect(latestToolResult.content).toContain('arguments were likely truncated');
          expect(latestToolResult.content).toContain('Call edit again with one complete JSON object');
          return 'Stopped after truncated arguments.';
        }),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        messages: [{ role: 'user', content: 'edit report script' }],
        approvalPolicy: {
          rules: [{ id: 'allow-edit-truncated-args-test', decision: 'allow', toolIds: ['edit'] }],
        },
      },
      new AbortController().signal,
    );

    expect(executedInputs).toEqual([]);
  });

  it('does not repair missing final closers when the provider stopped at max tokens', async () => {
    const emitted: WorkspaceDelta[] = [];
    const executedInputs: unknown[] = [];
    const rawArguments = '{"path":"notes.md","content":"hello","reason":"write note"';
    const writeTool: ToolDescriptor = {
      id: 'write',
      description: 'Write a file.',
      recovery: AUTOFILL_WRITE_RECOVERY,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['path', 'content', 'reason'],
        additionalProperties: false,
      },
    };
    const context: WorkContext = {
      ...workContext(emitted, [], [writeTool]),
      callTool: async (_toolId, input) => {
        executedInputs.push(input);
        return 'should not run';
      },
    };

    await runTurnLoop(
      context,
      {
        registries: registries((request) => {
          const latestToolResult = request.messages
            .filter((message): message is Extract<(typeof request.messages)[number], { role: 'toolResult' }> => message.role === 'toolResult')
            .at(-1);
          if (!latestToolResult) {
            return {
              finishReason: 'max_tokens',
              toolCalls: [
                {
                  id: 'write_truncated_missing_final_closer',
                  name: 'write',
                  arguments: rawArguments,
                  rawArguments,
                  argumentsParseError: "Expected ',' or '}' after property value in JSON at position 57",
                },
              ],
            };
          }
          expect(latestToolResult.content).toContain('provider stopped with finishReason="max_tokens"');
          expect(latestToolResult.content).toContain('arguments were likely truncated');
          return 'Stopped after truncated arguments.';
        }),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        messages: [{ role: 'user', content: 'write notes' }],
        approvalPolicy: {
          rules: [{ id: 'allow-write-truncated-missing-final-closer-test', decision: 'allow', toolIds: ['write'] }],
        },
      },
      new AbortController().signal,
    );

    expect(executedInputs).toEqual([]);
  });

  it('rejects malformed string bash arguments before running the tool', async () => {
    const emitted: WorkspaceDelta[] = [];
    const executedInputs: unknown[] = [];
    const rawArguments = '{"command":"cat > /tmp/create_ppt.py <<\\\'PYTHON\\\'\\nprint(1)\\n';
    const bashTool: ToolDescriptor = {
      id: 'bash',
      description: 'Run a command.',
      recovery: AUTOFILL_REASON_RECOVERY,
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['command', 'reason'],
        additionalProperties: false,
      },
    };
    const context: WorkContext = {
      ...workContext(emitted, [], [bashTool]),
      callTool: async (_toolId, input) => {
        executedInputs.push(input);
        return 'should not run';
      },
    };

    await runTurnLoop(
      context,
      {
        registries: registries((request) => {
          const latestToolResult = request.messages
            .filter((message): message is Extract<(typeof request.messages)[number], { role: 'toolResult' }> => message.role === 'toolResult')
            .at(-1);
          if (!latestToolResult) {
            return {
              toolCalls: [
                {
                  id: 'bash_malformed_string_args',
                  name: 'bash',
                  arguments: rawArguments,
                },
              ],
            };
          }
          expect(latestToolResult.content).toContain('Tool "bash" was rejected');
          expect(latestToolResult.content).toContain('arguments JSON is incomplete or malformed');
          return 'Stopped after malformed arguments.';
        }),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        messages: [{ role: 'user', content: 'run script creation command' }],
        approvalPolicy: {
          rules: [{ id: 'allow-bash-malformed-string-args-test', decision: 'allow', toolIds: ['bash'] }],
        },
      },
      new AbortController().signal,
    );

    expect(executedInputs).toEqual([]);
  });

  it('emits an approved approval decision before running a high-risk tool', async () => {
    const emitted: WorkspaceDelta[] = [];
    let callToolCount = 0;
    const context: WorkContext = {
      ...workContext(emitted, [], [{ id: 'write', description: 'Write a file.' }]),
      callTool: async (toolId) => {
        callToolCount += 1;
        return { ok: true, toolId };
      },
    };

    const result = await runTurnLoop(
      context,
      {
        registries: registries(() => ({
          toolCalls: [
            {
              id: 'tool_call_write',
              name: 'write',
              arguments: {
                path: 'notes.md',
                content: 'approved content',
                reason: 'persist the requested notes',
              },
            },
            {
              id: 'tool_call_exit',
              name: 'enterWorkspace',
              arguments: {
                status: 'completed',
                summary: 'Wrote the approved notes.',
                artifacts: [],
                observations: [],
                errors: [],
                suggestedNextSteps: [],
              },
            },
          ],
        })),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        messages: [{ role: 'user', content: 'write notes' }],
        confirm: async () => true,
        deliverFinal: true,
      },
      new AbortController().signal,
    );

    expect(callToolCount).toBe(1);
    expect(result.workspaceResult).toMatchObject({ status: 'completed', summary: 'Wrote the approved notes.' });
    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'approval',
          status: 'approved',
          approvalId: 'approval_tool_call_write',
          name: 'write',
          message: 'Tool "write" was approved for execution.',
        }),
        expect.objectContaining({ kind: 'tool', name: 'write', phase: 'start' }),
        expect.objectContaining({ kind: 'tool', name: 'write', phase: 'end', isError: false }),
      ]),
    );
  });

  it('uses the central approval policy to allow a normally high-risk tool', async () => {
    const emitted: WorkspaceDelta[] = [];
    let callToolCount = 0;
    let confirmCount = 0;
    const context: WorkContext = {
      ...workContext(emitted, [], [{ id: 'write', description: 'Write a file.' }]),
      callTool: async (toolId) => {
        callToolCount += 1;
        return { ok: true, toolId };
      },
    };

    const result = await runTurnLoop(
      context,
      {
        registries: registries(() => ({
          toolCalls: [
            {
              id: 'tool_call_write',
              name: 'write',
              arguments: {
                path: 'notes.md',
                content: 'allowed content',
                reason: 'persist the requested notes',
              },
            },
            {
              id: 'tool_call_exit',
              name: 'enterWorkspace',
              arguments: {
                status: 'completed',
                summary: 'Wrote the allowed notes.',
                artifacts: [],
                observations: [],
                errors: [],
                suggestedNextSteps: [],
              },
            },
          ],
        })),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        messages: [{ role: 'user', content: 'write notes' }],
        confirm: async () => {
          confirmCount += 1;
          return true;
        },
        approvalPolicy: {
          rules: [{ id: 'trusted-notes-write', decision: 'allow', toolIds: ['write'], arguments: [{ field: 'path', equals: 'notes.md' }] }],
        },
        deliverFinal: true,
      },
      new AbortController().signal,
    );

    expect(confirmCount).toBe(0);
    expect(callToolCount).toBe(1);
    expect(result.workspaceResult).toMatchObject({ status: 'completed', summary: 'Wrote the allowed notes.' });
    expect(emitted.some((delta) => delta.kind === 'approval')).toBe(false);
  });

  it('keeps carry-back text while stripping structured details from provider replay', async () => {
    let turn = 0;
    const emitted: WorkspaceDelta[] = [];
    const context: WorkContext = {
      ...workContext(emitted, [], [{ id: 'delegateTool', description: 'Delegate work.' }]),
      callTool: async () => ({
        __toolResult: 'Waiting for user input.',
        __carryBack: ['Worker needs a target file.'],
        __details: { workspaceStatus: 'needs_user_input' },
      }),
    };

    const result = await runTurnLoop(
      context,
      {
        registries: registries((request) => {
          turn += 1;
          if (turn === 1) {
            return { toolCalls: [{ name: 'delegateTool', arguments: { task: 'edit file' } }] };
          }
          const lastToolResult = [...request.messages].reverse().find((message) => message.role === 'toolResult');
          expect(lastToolResult).toMatchObject({
            role: 'toolResult',
            toolName: 'delegateTool',
          });
          expect(lastToolResult).not.toHaveProperty('details');
          return 'Need the user to provide the target file.';
        }),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        messages: [{ role: 'user', content: 'edit file' }],
        deliverFinal: false,
      },
      new AbortController().signal,
    );

    expect(result.summary).toContain('Worker needs a target file.');
  });

  it('auto-closes a enterWorkspace carry-back when the runtime marks it as the final handoff', async () => {
    let turn = 0;
    const emitted: WorkspaceDelta[] = [];
    const context: WorkContext = {
      ...workContext(emitted, [], [{ id: 'delegateTool', description: 'Delegate work.' }]),
      callTool: async () => ({
        __toolResult: 'Task completed.',
        __carryBack: ['Final workspace answer.'],
        __details: { workspaceStatus: 'completed', autoClose: true },
      }),
    };

    const result = await runTurnLoop(
      context,
      {
        registries: registries(() => {
          turn += 1;
          if (turn > 1) {
            throw new Error('unexpected second model turn');
          }
          return { toolCalls: [{ name: 'delegateTool', arguments: { task: 'same goal' } }] };
        }),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        messages: [{ role: 'user', content: 'same goal' }],
        deliverFinal: false,
      },
      new AbortController().signal,
    );

    expect(turn).toBe(1);
    expect(result.summary).toContain('Final workspace answer.');
    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'turn_lifecycle',
          phase: 'end',
          status: 'completed',
          outcome: 'final_response',
        }),
      ]),
    );
  });

  it('keeps full carry-back in model replay but emits only display carry-back', async () => {
    let turn = 0;
    const emitted: WorkspaceDelta[] = [];
    const context: WorkContext = {
      ...workContext(emitted, [], [{ id: 'delegateTool', description: 'Delegate work.' }]),
      callTool: async () => ({
        __toolResult: 'Task completed.',
        __carryBack: ['FULL WORKSPACE BODY with details for downstream model use.'],
        __displayCarryBack: ['Short workspace summary.'],
        __details: { workspaceStatus: 'completed', autoClose: true },
      }),
    };

    const result = await runTurnLoop(
      context,
      {
        registries: registries(() => {
          turn += 1;
          if (turn > 1) {
            throw new Error('unexpected second model turn');
          }
          return { toolCalls: [{ name: 'delegateTool', arguments: { task: 'same goal' } }] };
        }),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        messages: [{ role: 'user', content: 'same goal' }],
        deliverFinal: false,
      },
      new AbortController().signal,
    );

    const streamedText = emitted.map((delta) => (delta.kind === 'text' ? delta.text : '')).join('');
    expect(turn).toBe(1);
    expect(result.summary).toContain('Short workspace summary.');
    expect(result.summary).not.toContain('FULL WORKSPACE BODY');
    expect(streamedText).toContain('Short workspace summary.');
    expect(streamedText).not.toContain('FULL WORKSPACE BODY');
  });

  it('emits provider lifecycle summaries without raw prompt or message content', async () => {
    const emitted: WorkspaceDelta[] = [];
    const result = await runTurnLoop(
      workContext(emitted),
      {
        registries: registries((request) => {
          expect(request.systemPrompt).toContain('Do not leak this system rule');
          expect(request.messages[0]?.content).toBe('secret task content');
          return 'Final answer.';
        }),
        modelId: TEST_MODEL,
        persona: 'Do not leak this system rule',
        messages: [{ role: 'user', content: 'secret task content' }],
      },
      new AbortController().signal,
    );

    const turnDeltas = emitted.filter((delta) => delta.kind === 'turn_lifecycle');
    const providerDeltas = emitted.filter((delta) => delta.kind === 'provider_lifecycle');
    expect(result.conclusion).toBe('Final answer.');
    expect(turnDeltas).toEqual([
      expect.objectContaining({
        kind: 'turn_lifecycle',
        phase: 'start',
        turnId: 'turn-1',
        modelId: TEST_MODEL,
        status: 'started',
        messageCount: 1,
        toolCount: 0,
      }),
      expect.objectContaining({
        kind: 'turn_lifecycle',
        phase: 'end',
        turnId: 'turn-1',
        modelId: TEST_MODEL,
        status: 'completed',
        outcome: 'final_response',
        textLength: 'Final answer.'.length,
        toolCallCount: 0,
        toolResultCount: 0,
      }),
    ]);
    expect(providerDeltas).toEqual([
      expect.objectContaining({
        kind: 'provider_lifecycle',
        phase: 'request',
        requestId: 'turn-1',
        modelId: TEST_MODEL,
        status: 'started',
        messageCount: 1,
        toolCount: 0,
      }),
      expect.objectContaining({
        kind: 'provider_lifecycle',
        phase: 'response',
        requestId: 'turn-1',
        modelId: TEST_MODEL,
        status: 'completed',
        textLength: 'Final answer.'.length,
        toolCallCount: 0,
      }),
    ]);
    expect(JSON.stringify(turnDeltas)).not.toContain('Do not leak this system rule');
    expect(JSON.stringify(turnDeltas)).not.toContain('secret task content');
    expect(JSON.stringify(providerDeltas)).not.toContain('Do not leak this system rule');
    expect(JSON.stringify(providerDeltas)).not.toContain('secret task content');
  });

  it('preserves provider stream error cause summaries in lifecycle deltas', async () => {
    const emitted: WorkspaceDelta[] = [];
    const streamCause = Object.assign(new Error('socket closed while streaming'), {
      name: 'SocketError',
      code: 'UND_ERR_SOCKET',
      errno: 'ECONNRESET',
      request: { apiKey: 'SECRET_API_KEY' },
    });

    await expect(
      runTurnLoop(
        workContext(emitted),
        {
          registries: registries(() => ({
            error: {
              code: 'provider_error',
              message: 'OpenAI-compatible stream failed',
              cause: streamCause,
            },
          })),
          modelId: TEST_MODEL,
          persona: 'Work persona',
          messages: [{ role: 'user', content: 'generate the PDF' }],
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('OpenAI-compatible stream failed');

    const providerResponse = emitted.find(
      (delta): delta is Extract<WorkspaceDelta, { kind: 'provider_lifecycle' }> =>
        delta.kind === 'provider_lifecycle' && delta.phase === 'response',
    );
    const turnEnd = emitted.find(
      (delta): delta is Extract<WorkspaceDelta, { kind: 'turn_lifecycle' }> =>
        delta.kind === 'turn_lifecycle' && delta.phase === 'end',
    );

    expect(providerResponse?.error).toEqual({
      code: 'provider_error',
      message: 'OpenAI-compatible stream failed',
      cause: {
        name: 'SocketError',
        code: 'UND_ERR_SOCKET',
        message: 'socket closed while streaming',
        details: { errno: 'ECONNRESET' },
      },
    });
    expect(turnEnd?.error).toEqual(providerResponse?.error);
    expect(JSON.stringify(emitted)).not.toContain('SECRET_API_KEY');
  });

  it('runs lifecycle policy hooks and records best-effort end hook failures without raw errors', async () => {
    const emitted: WorkspaceDelta[] = [];
    const calls: string[] = [];
    const codedError = (code: string, message: string): Error & { code?: string } => {
      const error = new Error(message) as Error & { code?: string };
      error.code = code;
      return error;
    };
    const result = await runTurnLoop(
      workContext(emitted),
      {
        registries: registries(() => 'Final answer.'),
        modelId: TEST_MODEL,
        persona: 'Do not leak this lifecycle persona',
        messages: [{ role: 'user', content: 'secret lifecycle task' }],
        lifecycle: {
          beforeTurn: (delta) => {
            calls.push(`beforeTurn:${delta.turnId}:${delta.status}`);
          },
          beforeProviderRequest: (delta) => {
            calls.push(`beforeProviderRequest:${delta.requestId}:${delta.status}`);
          },
          afterProviderResponse: (delta) => {
            calls.push(`afterProviderResponse:${delta.requestId}:${delta.status}`);
            throw codedError('AFTER_PROVIDER', 'SECRET_AFTER_PROVIDER_RESPONSE');
          },
          afterTurn: (delta) => {
            calls.push(`afterTurn:${delta.turnId}:${delta.status}`);
            throw codedError('AFTER_TURN', 'SECRET_AFTER_TURN_END');
          },
        },
      },
      new AbortController().signal,
    );

    const providerResponse = emitted.find(
      (delta): delta is Extract<WorkspaceDelta, { kind: 'provider_lifecycle' }> =>
        delta.kind === 'provider_lifecycle' && delta.phase === 'response',
    );
    const turnEnd = emitted.find(
      (delta): delta is Extract<WorkspaceDelta, { kind: 'turn_lifecycle' }> =>
        delta.kind === 'turn_lifecycle' && delta.phase === 'end',
    );
    expect(result.conclusion).toBe('Final answer.');
    expect(calls).toEqual([
      'beforeTurn:turn-1:started',
      'beforeProviderRequest:turn-1:started',
      'afterProviderResponse:turn-1:completed',
      'afterTurn:turn-1:completed',
    ]);
    expect(providerResponse?.hookFailures).toEqual([
      expect.objectContaining({
        phase: 'afterProviderResponse',
        message: 'afterProviderResponse hook failed',
        code: 'AFTER_PROVIDER',
        occurredAt: expect.any(Date),
      }),
    ]);
    expect(turnEnd?.hookFailures).toEqual([
      expect.objectContaining({
        phase: 'afterTurn',
        message: 'afterTurn hook failed',
        code: 'AFTER_TURN',
        occurredAt: expect.any(Date),
      }),
    ]);
    expect(JSON.stringify(emitted)).not.toContain('SECRET_AFTER_PROVIDER_RESPONSE');
    expect(JSON.stringify(emitted)).not.toContain('SECRET_AFTER_TURN_END');
    expect(JSON.stringify(emitted)).not.toContain('secret lifecycle task');
  });

  it('fails closed before provider requests when lifecycle policy denies the request', async () => {
    const emitted: WorkspaceDelta[] = [];
    let providerCalls = 0;
    const error = new Error('SECRET_BEFORE_PROVIDER_REQUEST') as Error & { code?: string };
    error.code = 'BEFORE_PROVIDER';

    await expect(
      runTurnLoop(
        workContext(emitted),
        {
          registries: registries(() => {
            providerCalls += 1;
            return 'should not run';
          }),
          modelId: TEST_MODEL,
          persona: 'Work persona',
          messages: [{ role: 'user', content: 'secret blocked task' }],
          lifecycle: {
            beforeProviderRequest: () => {
              throw error;
            },
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'lifecycle_hook_failed', message: 'beforeProviderRequest hook failed' });

    const providerRequest = emitted.find(
      (delta): delta is Extract<WorkspaceDelta, { kind: 'provider_lifecycle' }> =>
        delta.kind === 'provider_lifecycle' && delta.phase === 'request',
    );
    const turnEnd = emitted.find(
      (delta): delta is Extract<WorkspaceDelta, { kind: 'turn_lifecycle' }> =>
        delta.kind === 'turn_lifecycle' && delta.phase === 'end',
    );
    expect(providerCalls).toBe(0);
    expect(providerRequest?.hookFailures).toEqual([
      expect.objectContaining({
        phase: 'beforeProviderRequest',
        message: 'beforeProviderRequest hook failed',
        code: 'BEFORE_PROVIDER',
      }),
    ]);
    expect(emitted).not.toContainEqual(expect.objectContaining({ kind: 'provider_lifecycle', phase: 'response' }));
    expect(turnEnd).toEqual(expect.objectContaining({
      kind: 'turn_lifecycle',
      phase: 'end',
      status: 'failed',
      outcome: 'lifecycle_hook_error',
      error: { code: 'lifecycle_hook_failed', message: 'beforeProviderRequest hook failed' },
    }));
    expect(JSON.stringify(emitted)).not.toContain('SECRET_BEFORE_PROVIDER_REQUEST');
    expect(JSON.stringify(emitted)).not.toContain('secret blocked task');
  });

  it('keeps skill instructions behind readSkill progressive disclosure', async () => {
    const emitted: WorkspaceDelta[] = [];
    let turn = 0;
    const skill: SkillDefinition = {
      id: 'deploy-procedure',
      version: 2,
      procedureId: 'skill:deploy-procedure@2',
      label: 'Deploy Procedure',
      description: 'Deployment checklist',
      instructions: '# Steps\nDetailed deploy procedure: run checks, build, then release.',
      toolIds: ['bash'],
      sections: [{ id: 'steps', title: 'Steps', level: 1 }],
      lifecycle: 'long_term',
      tokenBudget: 300,
      sensitivity: { status: 'clear', findings: [] },
    };
    const result = await runTurnLoop(
      workContext(emitted, [skill]),
      {
        registries: registries((request) => {
          turn += 1;
          const toolNames = new Set((request.tools ?? []).map((tool) => tool.name));
          expect(toolNames.has('readSkill')).toBe(true);
          if (turn === 1) {
            const readSkillSchema = request.tools?.find((tool) => tool.name === 'readSkill');
            expect(readSkillSchema?.parameters).toMatchObject({
              type: 'object',
              properties: {
                skillId: { type: 'string' },
                path: { type: 'string' },
              },
              additionalProperties: false,
            });
            expect((readSkillSchema?.parameters as { required?: string[] } | undefined)?.required ?? []).not.toContain('path');
            expect(request.systemPrompt).not.toContain('Deploy Procedure');
            expect(request.systemPrompt).not.toContain('this is a blocking requirement');
            expect(request.systemPrompt).not.toContain('procedure=skill:deploy-procedure@2');
            expect(request.systemPrompt).not.toContain('<sections>Steps</sections>');
            const listSkills = toolResult(request.messages, 'listSkills');
            expect(listSkills).toBeTruthy();
            const payload = JSON.parse(listSkills?.content ?? '{}');
            expect(payload.skills[0]).toMatchObject({
              id: 'deploy-procedure',
              label: 'Deploy Procedure',
              path: 'deploy-procedure/SKILL.md',
              description: 'Deployment checklist',
              sections: [{ id: 'steps', title: 'Steps', level: 1 }],
            });
            expect(payload.skills[0]).not.toHaveProperty('active');
            expect(request.systemPrompt).not.toContain('Detailed deploy procedure');
            expect(JSON.stringify(request.messages)).not.toContain('Detailed deploy procedure');
            return { toolCalls: [{ name: 'readSkill', arguments: { path: 'deploy-procedure/SKILL.md' } }] };
          }
          const lastToolResult = [...request.messages].reverse().find((message) => message.role === 'toolResult');
          const content = lastToolResult?.role === 'toolResult' ? lastToolResult.content : '';
          expect(content).toContain('Detailed deploy procedure');
          expect(JSON.parse(content)).toMatchObject({
            found: true,
            skill: {
              id: 'deploy-procedure',
              version: 2,
              instructions: '# Steps\nDetailed deploy procedure: run checks, build, then release.',
              sectionIndex: [{ id: 'steps', title: 'Steps', level: 1 }],
              contentLength: '# Steps\nDetailed deploy procedure: run checks, build, then release.'.length,
              offset: 0,
              returnedChars: '# Steps\nDetailed deploy procedure: run checks, build, then release.'.length,
              tokenBudget: 10000,
              estimatedTokens: 17,
              sensitivity: { status: 'clear', findings: [] },
              truncated: false,
            },
          });
          return {
            toolCalls: [
              {
                name: 'enterWorkspace',
                arguments: {
                  status: 'completed',
                  summary: 'Used skill detail through readSkill.',
                  artifacts: [],
                  observations: ['Skill details were read on demand.'],
                  errors: [],
                  suggestedNextSteps: [],
                },
              },
            ],
          };
        }),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        skills: [skill],
        messages: [{ role: 'user', content: 'use deploy skill' }],
        deliverFinal: true,
      },
      new AbortController().signal,
    );

    expect(turn).toBe(2);
    expect(result.workspaceResult).toMatchObject({
      status: 'completed',
      summary: 'Used skill detail through readSkill.',
    });
    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'tool', name: 'readSkill', phase: 'end', isError: false }),
      ]),
    );
  });

  it('settles readSkill when skill resolution throws', async () => {
    const emitted: WorkspaceDelta[] = [];
    let turn = 0;
    const brokenSkill = {
      id: 'pdf',
      version: 1,
      procedureId: 'skill:pdf@1',
      label: 'PDF',
      instructions: 'PDF instructions',
      toolIds: [],
      files: [{ path: 'SKILL.md', kind: 'skill', size: 16 }],
      get sensitivity() {
        throw new Error('broken skill package metadata');
      },
    } as unknown as SkillDefinition;

    const result = await runTurnLoop(
      workContext(emitted, [brokenSkill]),
      {
        registries: registries((request) => {
          turn += 1;
          const readSkillResult = toolResult(request.messages, 'readSkill');
          if (!readSkillResult) {
            return { toolCalls: [{ id: 'call-read-skill', name: 'readSkill', arguments: { path: 'pdf/SKILL.md' } }] };
          }
          expect(readSkillResult.isError).toBe(true);
          expect(readSkillResult.content).toContain('broken skill package metadata');
          return {
            toolCalls: [{
              name: 'enterWorkspace',
              arguments: {
                status: 'completed',
                summary: 'Handled readSkill failure.',
                artifacts: [],
                observations: [],
                errors: [],
                suggestedNextSteps: [],
              },
            }],
          };
        }),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        skills: [brokenSkill],
        messages: [{ role: 'user', content: 'read pdf skill' }],
        deliverFinal: true,
      },
      new AbortController().signal,
    );

    expect(turn).toBe(2);
    expect(result.workspaceResult).toMatchObject({
      status: 'completed',
      summary: 'Handled readSkill failure.',
    });
    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'tool', name: 'readSkill', phase: 'start', toolCallId: 'call-read-skill' }),
        expect.objectContaining({
          kind: 'tool',
          name: 'readSkill',
          phase: 'end',
          toolCallId: 'call-read-skill',
          isError: true,
          detail: expect.stringContaining('broken skill package metadata'),
        }),
      ]),
    );
  });

  it('routes read calls for canonical skill paths through skill package reading', async () => {
    const emitted: WorkspaceDelta[] = [];
    const packageRoot = await mkdtemp(join(tmpdir(), 'zleap-pptx-skill-'));
    await writeFile(join(packageRoot, 'SKILL.md'), '# PPTX Skill\nUse python-pptx for slide generation.', 'utf8');
    const skill: SkillDefinition = {
      id: 'pptx',
      version: 1,
      procedureId: 'skill:pptx@1',
      label: 'pptx',
      description: 'Create PowerPoint presentations.',
      instructions: 'Manifest only.',
      toolIds: ['bash'],
      files: [{ path: 'SKILL.md', kind: 'instruction', size: 48 }],
      source: { type: 'local', packageRoot },
    };
    const readTool: ToolDescriptor = {
      id: 'read',
      description: 'Read local file contents.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['path', 'reason'],
        additionalProperties: false,
      },
    };
    let turn = 0;
    try {
      const result = await runTurnLoop(
        {
          ...workContext(emitted, [skill], [readTool]),
          callTool: async () => {
            throw new Error('read should not hit the workspace filesystem for skill package paths');
          },
        },
        {
          registries: registries((request) => {
            turn += 1;
            if (turn === 1) {
              return {
                toolCalls: [
                  {
                    name: 'read',
                    arguments: {
                      path: 'pptx/SKILL.md',
                      reason: 'inspect the PowerPoint skill instructions before creating slides',
                    },
                  },
                ],
              };
            }
            const lastToolResult = [...request.messages].reverse().find((message) => message.role === 'toolResult');
            expect(lastToolResult?.role === 'toolResult' ? lastToolResult.content : '').toContain('Use python-pptx for slide generation.');
            return {
              toolCalls: [
                {
                  name: 'enterWorkspace',
                  arguments: {
                    status: 'completed',
                    message: 'Read the pptx skill package.',
                  },
                },
              ],
            };
          }),
          modelId: TEST_MODEL,
          persona: 'Work persona',
          skills: [skill],
          messages: [{ role: 'user', content: 'create a pptx' }],
          deliverFinal: true,
        },
        new AbortController().signal,
      );

      expect(result.workspaceResult).toMatchObject({
        status: 'completed',
        summary: 'Read the pptx skill package.',
      });
      expect(emitted).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'tool', name: 'read', phase: 'end', isError: false }),
        ]),
      );
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  it('readSkill reads packaged SKILL.md from canonical pdf/SKILL.md paths', async () => {
    const emitted: WorkspaceDelta[] = [];
    const packageRoot = await mkdtemp(join(tmpdir(), 'zleap-pdf-skill-'));
    await writeFile(join(packageRoot, 'SKILL.md'), '# PDF Skill\nRender pages before final delivery.', 'utf8');
    const skill: SkillDefinition = {
      id: 'pdf',
      version: 1,
      procedureId: 'skill:pdf@1',
      label: 'pdf',
      description: 'Read and create PDF files.',
      instructions: 'Manifest only.',
      toolIds: ['bash'],
      files: [{ path: 'SKILL.md', kind: 'skill', size: 47 }],
      source: { type: 'system', packageRoot, sourceName: 'pdf' },
    };
    let turn = 0;
    try {
      await runTurnLoop(
        workContext(emitted, [skill]),
        {
          registries: registries((request) => {
            turn += 1;
            if (turn === 1) return { toolCalls: [{ id: 'call-pdf-skill', name: 'readSkill', arguments: { path: 'pdf/SKILL.md' } }] };
            const lastToolResult = [...request.messages].reverse().find((message) => message.role === 'toolResult');
            const content = lastToolResult?.role === 'toolResult' ? lastToolResult.content : '';
            expect(JSON.parse(content)).toMatchObject({
              found: true,
              skill: {
                id: 'pdf',
                sourceKind: 'package_file',
                path: 'pdf/SKILL.md',
                instructions: '# PDF Skill\nRender pages before final delivery.',
              },
            });
            return {
              toolCalls: [{
                name: 'enterWorkspace',
                arguments: {
                  status: 'completed',
                  summary: 'Read PDF skill.',
                  artifacts: [],
                  observations: [],
                  errors: [],
                  suggestedNextSteps: [],
                },
              }],
            };
          }),
          modelId: TEST_MODEL,
          persona: 'Work persona',
          skills: [skill],
          messages: [{ role: 'user', content: 'read pdf skill' }],
          deliverFinal: true,
        },
        new AbortController().signal,
      );
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }

    expect(turn).toBe(2);
    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'tool', name: 'readSkill', phase: 'end', toolCallId: 'call-pdf-skill', isError: false }),
      ]),
    );
  });

  it('readSkill accepts source-name paths when the mounted skill id is namespaced', async () => {
    const emitted: WorkspaceDelta[] = [];
    const packageRoot = await mkdtemp(join(tmpdir(), 'zleap-pdf-skill-'));
    await writeFile(join(packageRoot, 'SKILL.md'), '# PDF Skill\nRender pages before final delivery.', 'utf8');
    const skill: SkillDefinition = {
      id: 'pdf:pdf',
      version: 1,
      procedureId: 'skill:pdf:pdf@1',
      label: 'PDF',
      description: 'Read and create PDF files.',
      instructions: 'Manifest only.',
      toolIds: ['bash'],
      files: [{ path: 'SKILL.md', kind: 'skill', size: 47 }],
      source: { type: 'system', packageRoot, sourceName: 'pdf' },
    };
    let turn = 0;
    try {
      await runTurnLoop(
        workContext(emitted, [skill]),
        {
          registries: registries((request) => {
            turn += 1;
            if (turn === 1) return { toolCalls: [{ id: 'call-pdf-skill', name: 'readSkill', arguments: { path: 'pdf/SKILL.md' } }] };
            const lastToolResult = [...request.messages].reverse().find((message) => message.role === 'toolResult');
            const content = lastToolResult?.role === 'toolResult' ? lastToolResult.content : '';
            expect(JSON.parse(content)).toMatchObject({
              found: true,
              skill: {
                id: 'pdf:pdf',
                sourceKind: 'package_file',
                path: 'pdf:pdf/SKILL.md',
                instructions: '# PDF Skill\nRender pages before final delivery.',
              },
            });
            return {
              toolCalls: [{
                name: 'enterWorkspace',
                arguments: {
                  status: 'completed',
                  summary: 'Read namespaced PDF skill.',
                  artifacts: [],
                  observations: [],
                  errors: [],
                  suggestedNextSteps: [],
                },
              }],
            };
          }),
          modelId: TEST_MODEL,
          persona: 'Work persona',
          skills: [skill],
          messages: [{ role: 'user', content: 'read pdf skill' }],
          deliverFinal: true,
        },
        new AbortController().signal,
      );
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }

    expect(turn).toBe(2);
    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'tool', name: 'readSkill', phase: 'end', toolCallId: 'call-pdf-skill', isError: false }),
      ]),
    );
  });

  it('readSkill accepts source-name skillId when the mounted skill id is namespaced', async () => {
    const emitted: WorkspaceDelta[] = [];
    const packageRoot = await mkdtemp(join(tmpdir(), 'zleap-pdf-skill-'));
    await writeFile(join(packageRoot, 'SKILL.md'), '# PDF Skill\nRender pages before final delivery.', 'utf8');
    const skill: SkillDefinition = {
      id: 'pdf:pdf',
      version: 1,
      procedureId: 'skill:pdf:pdf@1',
      label: 'PDF',
      description: 'Read and create PDF files.',
      instructions: 'Manifest only.',
      toolIds: ['bash'],
      files: [{ path: 'SKILL.md', kind: 'skill', size: 47 }],
      source: { type: 'system', packageRoot, sourceName: 'pdf' },
    };
    let turn = 0;
    try {
      await runTurnLoop(
        workContext(emitted, [skill]),
        {
          registries: registries((request) => {
            turn += 1;
            if (turn === 1) return { toolCalls: [{ id: 'call-pdf-skill', name: 'readSkill', arguments: { skillId: 'pdf' } }] };
            const lastToolResult = [...request.messages].reverse().find((message) => message.role === 'toolResult');
            const content = lastToolResult?.role === 'toolResult' ? lastToolResult.content : '';
            expect(JSON.parse(content)).toMatchObject({
              found: true,
              skill: {
                id: 'pdf:pdf',
                sourceKind: 'package_file',
                path: 'pdf:pdf/SKILL.md',
                instructions: '# PDF Skill\nRender pages before final delivery.',
              },
            });
            return {
              toolCalls: [{
                name: 'enterWorkspace',
                arguments: {
                  status: 'completed',
                  summary: 'Read namespaced PDF skill by source name.',
                  artifacts: [],
                  observations: [],
                  errors: [],
                  suggestedNextSteps: [],
                },
              }],
            };
          }),
          modelId: TEST_MODEL,
          persona: 'Work persona',
          skills: [skill],
          messages: [{ role: 'user', content: 'read pdf skill' }],
          deliverFinal: true,
        },
        new AbortController().signal,
      );
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }

    expect(turn).toBe(2);
    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'tool', name: 'readSkill', phase: 'end', toolCallId: 'call-pdf-skill', isError: false }),
      ]),
    );
  });

  it('tells a workspace to read a matching mounted pdf skill before implementation tools', () => {
    const pdfSkill: SkillDefinition = {
      id: 'pdf',
      version: 1,
      procedureId: 'skill:pdf@1',
      label: 'pdf',
      description: 'Use when tasks involve reading, creating, or reviewing PDF files where rendering and layout matter.',
      instructions: '# PDF Workflow\nRender and visually inspect generated PDFs.',
      toolIds: ['bash'],
      sections: [{ id: 'pdf-workflow', title: 'PDF Workflow', level: 1 }],
      lifecycle: 'long_term',
      invocationPolicy: 'explicit_only',
      trustStatus: 'review_required',
      sensitivity: { status: 'clear', findings: [] },
    };

    const assembled = assembleWorkTurnContext({
      persona: 'Cli workspace',
      global: 'Global rules',
      turnGoal: '生成一个 PDF 报告',
      focus: '使用 Python 生成中文 PDF',
      skills: [pdfSkill],
      tools: [
        { id: 'bash', description: 'Run shell commands.' },
        { id: 'write', description: 'Write files.' },
        { id: 'edit', description: 'Edit files.' },
        { id: 'readSkill', description: 'Read skill details.' },
      ],
      messages: [{ role: 'user', content: '写一个脚本生成 PDF' }],
      deliverFinal: true,
    });

    expect(assembled.systemPrompt).not.toContain('<active_skills>');
    expect(assembled.systemPrompt).not.toContain('<name>pdf</name>');
    expect(assembled.systemPrompt).not.toContain('<path>pdf/SKILL.md</path>');
    expect(assembled.systemPrompt).not.toContain('procedure=skill:pdf@1');
    expect(assembled.systemPrompt).not.toContain('<policy>explicit_only</policy>');
    expect(assembled.systemPrompt).not.toContain('<trust>review_required</trust>');
    expect(assembled.systemPrompt).not.toContain('this is a blocking requirement');
    expect(assembled.systemPrompt).not.toContain('Render and visually inspect generated PDFs.');
    const listSkills = toolResult(assembled.messages, 'listSkills');
    expect(listSkills).toBeTruthy();
    const payload = JSON.parse(listSkills?.content ?? '{}');
    expect(payload.skills[0]).toMatchObject({
      id: 'pdf',
      label: 'pdf',
      path: 'pdf/SKILL.md',
      description: 'Use when tasks involve reading, creating, or reviewing PDF files where rendering and layout matter.',
    });
    expect(payload.skills[0]).not.toHaveProperty('active');
    expect(JSON.stringify(payload)).not.toContain('Render and visually inspect generated PDFs.');
  });

  it('force-reads per-turn selected skills before the first workspace model turn', async () => {
    const emitted: WorkspaceDelta[] = [];
    let providerCalls = 0;
    const skill: SkillDefinition = {
      id: 'selected-review',
      version: 1,
      procedureId: 'skill:selected-review@1',
      label: 'Selected Review',
      description: 'User-selected review flow.',
      instructions: '# Required Flow\nRead the diff first, then write actionable findings.',
      toolIds: ['grep'],
      sections: [{ id: 'required-flow', title: 'Required Flow', level: 1 }],
      lifecycle: 'per_turn',
      sensitivity: { status: 'clear', findings: [] },
    };

    const result = await runTurnLoop(
      workContext(emitted, [skill]),
      {
        registries: registries((request) => {
          providerCalls += 1;
          expect(request.systemPrompt).not.toContain('Selected Review');
          expect(request.systemPrompt).not.toContain('<path>selected-review/SKILL.md</path>');
          expect(request.systemPrompt).not.toContain('Read the diff first');
          const serializedMessages = JSON.stringify(request.messages);
          expect(serializedMessages).not.toContain('<Selected-Skills>');
          expect(serializedMessages).not.toContain('The user explicitly selected these skills');
          expect(toolCall(request.messages, 'readSkill')).toBeTruthy();
          const readSkill = toolResult(request.messages, 'readSkill');
          expect(readSkill).toBeTruthy();
          expect(JSON.parse(readSkill?.content ?? '{}')).toMatchObject({
            found: true,
            skill: {
              id: 'selected-review',
              path: 'selected-review/SKILL.md',
              instructions: '# Required Flow\nRead the diff first, then write actionable findings.',
            },
          });
          expect(serializedMessages).toContain('Read the diff first, then write actionable findings.');
          return {
            toolCalls: [
              {
                name: 'enterWorkspace',
                arguments: {
                  status: 'completed',
                  summary: 'Followed the selected skill.',
                  artifacts: [],
                  observations: [],
                  errors: [],
                  suggestedNextSteps: [],
                },
              },
            ],
          };
        }),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        skills: [skill],
        messages: [{ role: 'user', content: 'use the selected review skill' }],
        deliverFinal: true,
      },
      new AbortController().signal,
    );

    expect(providerCalls).toBe(1);
    expect(result.workspaceResult).toMatchObject({ status: 'completed', summary: 'Followed the selected skill.' });
    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'tool', name: 'readSkill', phase: 'start' }),
        expect.objectContaining({ kind: 'tool', name: 'readSkill', phase: 'end', isError: false }),
      ]),
    );
  });

  it('lets workspaces find skills before reading details', async () => {
    const emitted: WorkspaceDelta[] = [];
    let turn = 0;
    let searchCount = 0;
    const skill: SkillDefinition = {
      id: 'api-rate-limit',
      version: 1,
      procedureId: 'skill:api-rate-limit@1',
      label: 'API Rate Limit',
      description: 'Handle public API throttling.',
      instructions: '# Procedure\nUse serial requests, bounded retries, and cached fallback data.',
      toolIds: ['bash'],
      sections: [{ id: 'procedure', title: 'Procedure', level: 1 }],
      lifecycle: 'long_term',
      sensitivity: { status: 'clear', findings: [] },
    };
    const context: WorkContext = {
      ...workContext(emitted),
      searchSkills: async ({ query, limit }) => {
        searchCount += 1;
        expect(query).toBe('public api throttling');
        expect(limit).toBe(3);
        return [skill];
      },
    };

    const result = await runTurnLoop(
      context,
      {
        registries: registries((request) => {
          turn += 1;
          const toolNames = new Set((request.tools ?? []).map((tool) => tool.name));
          expect(toolNames.has('findSkill')).toBe(true);
          expect(toolNames.has('readSkill')).toBe(true);
          expect(request.systemPrompt).not.toContain('API Rate Limit');
          expect(request.systemPrompt).not.toContain('Use serial requests');
          expect(request.systemPrompt).toContain('Skill gate: before implementation tools');
          expect(request.systemPrompt).toContain('focused 2-4 keyword query');
          expect(request.systemPrompt).toContain('ppt powerpoint presentation python-pptx');
          if (turn === 1) {
            return { toolCalls: [{ name: 'findSkill', arguments: { query: 'public api throttling', limit: 3 } }] };
          }
          if (turn === 2) {
            const lastToolResult = [...request.messages].reverse().find((message) => message.role === 'toolResult');
            const content = lastToolResult?.role === 'toolResult' ? JSON.parse(lastToolResult.content) : {};
            expect(content).toMatchObject({
              ok: true,
              count: 1,
              skills: [
                {
                  id: 'api-rate-limit',
                  label: 'API Rate Limit',
                  description: 'Handle public API throttling.',
                  active: true,
                },
              ],
            });
            expect(JSON.stringify(content)).not.toContain('Use serial requests');
            return { toolCalls: [{ name: 'readSkill', arguments: { skillId: 'api-rate-limit' } }] };
          }
          const lastToolResult = [...request.messages].reverse().find((message) => message.role === 'toolResult');
          const content = lastToolResult?.role === 'toolResult' ? lastToolResult.content : '';
          expect(content).toContain('Use serial requests');
          return {
            toolCalls: [
              {
                name: 'enterWorkspace',
                arguments: {
                  status: 'completed',
                  summary: 'Found and read the matching skill.',
                  artifacts: [],
                  observations: [],
                  errors: [],
                  suggestedNextSteps: [],
                },
              },
            ],
          };
        }),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        messages: [{ role: 'user', content: 'Need help with public API throttling' }],
        deliverFinal: true,
      },
      new AbortController().signal,
    );

    expect(turn).toBe(3);
    expect(searchCount).toBe(1);
    expect(result.workspaceResult).toMatchObject({
      status: 'completed',
      summary: 'Found and read the matching skill.',
    });
    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'tool', name: 'findSkill', phase: 'end', isError: false }),
        expect.objectContaining({ kind: 'tool', name: 'readSkill', phase: 'end', isError: false }),
      ]),
    );
  });

  it('lets workspaces find skills with a focused query and default limit', async () => {
    const emitted: WorkspaceDelta[] = [];
    let sawBrowse = false;
    const skill: SkillDefinition = {
      id: 'browse-skill',
      version: 1,
      procedureId: 'skill:browse-skill@1',
      label: 'Browse Skill',
      description: 'Visible during browsing.',
      instructions: 'Full details stay hidden until readSkill.',
      toolIds: [],
    };
    const context: WorkContext = {
      ...workContext(emitted),
      searchSkills: async ({ query, limit }) => {
        expect(query).toBe('browse skill');
        expect(limit).toBe(3);
        return [skill];
      },
    };

    await runTurnLoop(
      context,
      {
        registries: registries((request) => {
          const findSkillSchema = request.tools?.find((tool) => tool.name === 'findSkill');
          expect(findSkillSchema?.parameters).toMatchObject({ required: ['query'] });
          const lastToolResult = [...request.messages].reverse().find((message) => message.role === 'toolResult');
          if (!lastToolResult || lastToolResult.role !== 'toolResult') {
            return { toolCalls: [{ name: 'findSkill', arguments: { query: 'browse skill' } }] };
          }
          const content = JSON.parse(lastToolResult.content);
          expect(content).toMatchObject({
            ok: true,
            query: 'browse skill',
            count: 1,
            skills: [{ id: 'browse-skill', label: 'Browse Skill' }],
          });
          expect(JSON.stringify(content)).not.toContain('Full details stay hidden');
          sawBrowse = true;
          return {
            toolCalls: [{
              name: 'enterWorkspace',
              arguments: {
                status: 'completed',
                summary: 'Browsed skills.',
                artifacts: [],
                observations: [],
                errors: [],
                suggestedNextSteps: [],
              },
            }],
          };
        }),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        messages: [{ role: 'user', content: 'browse skills' }],
        deliverFinal: true,
      },
      new AbortController().signal,
    );

    expect(sawBrowse).toBe(true);
  });

  it('caps readSkill detail and reports truncation metadata', async () => {
    const emitted: WorkspaceDelta[] = [];
    const tail = 'TAIL_SECRET_SHOULD_NOT_APPEAR';
    const longInstructions = `${'x'.repeat(2_200)}${tail}`;
    let turn = 0;
    const skill: SkillDefinition = {
      id: 'long-skill',
      label: 'Long Skill',
      description: 'Long-form procedure',
      instructions: longInstructions,
      toolIds: [],
      tokenBudget: 450,
    };

    await runTurnLoop(
      workContext(emitted, [skill]),
      {
        registries: registries((request) => {
          turn += 1;
          if (turn === 1) {
            return { toolCalls: [{ name: 'readSkill', arguments: { skillId: 'long-skill' } }] };
          }
          const lastToolResult = [...request.messages].reverse().find((message) => message.role === 'toolResult');
          const content = lastToolResult?.role === 'toolResult' ? lastToolResult.content : '';
          const parsed = JSON.parse(content) as {
            found: boolean;
            skill: {
              instructions: string;
              contentLength: number;
              offset: number;
              returnedChars: number;
              maxChars: number;
              nextOffset?: number;
              truncated: boolean;
            };
          };
          expect(parsed).toMatchObject({
            found: true,
            skill: {
              contentLength: longInstructions.length,
              offset: 0,
              returnedChars: longInstructions.length,
              maxChars: 40000,
              truncated: false,
            },
          });
          expect(parsed.skill.instructions).toHaveLength(longInstructions.length);
          expect(content).toContain(tail);
          return {
            toolCalls: [
              {
                name: 'enterWorkspace',
                arguments: {
                  status: 'completed',
                  summary: 'Read bounded skill detail.',
                  artifacts: [],
                  observations: [],
                  errors: [],
                  suggestedNextSteps: [],
                },
              },
            ],
          };
        }),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        skills: [skill],
        messages: [{ role: 'user', content: 'inspect long skill' }],
        deliverFinal: true,
      },
      new AbortController().signal,
    );

    expect(JSON.stringify(emitted)).toContain(tail);
  });

  it('readSkill reads the full active skill file and ignores heading/window hints', async () => {
    const emitted: WorkspaceDelta[] = [];
    const instructions = [
      '# Overview',
      'General overview should not be returned.',
      '',
      '```',
      '# Deploy',
      'Code fence heading should not be selectable.',
      '```',
      '',
      '## Deploy',
      'Run checks.',
      'Ship release.',
      '',
      '### Rollback',
      'Keep rollback plan with deploy section.',
      '',
      '## Audit',
      'AUDIT_SECRET_SHOULD_NOT_APPEAR',
    ].join('\n');
    let turn = 0;
    const skill: SkillDefinition = {
      id: 'release-skill',
      label: 'Release Skill',
      description: 'Release procedure',
      instructions,
      toolIds: [],
    };

    await runTurnLoop(
      workContext(emitted, [skill]),
      {
        registries: registries((request) => {
          turn += 1;
          if (turn === 1) return { toolCalls: [{ name: 'readSkill', arguments: { path: 'release-skill/SKILL.md' } }] };
          const lastToolResult = [...request.messages].reverse().find((message) => message.role === 'toolResult');
          const content = lastToolResult?.role === 'toolResult' ? lastToolResult.content : '';
          const parsed = JSON.parse(content) as {
            found: boolean;
            skill: {
              instructions: string;
              contentLength: number;
              offset: number;
              returnedChars: number;
              truncated: boolean;
            };
          };
          expect(parsed).toMatchObject({
            found: true,
            skill: {
              offset: 0,
              truncated: false,
            },
          });
          expect(parsed.skill.instructions).toContain('General overview');
          expect(parsed.skill.instructions).toContain('## Deploy');
          expect(parsed.skill.instructions).toContain('### Rollback');
          expect(parsed.skill.instructions).toContain('AUDIT_SECRET_SHOULD_NOT_APPEAR');
          expect(parsed.skill.contentLength).toBe(parsed.skill.instructions.length);
          expect(parsed.skill.returnedChars).toBe(parsed.skill.instructions.length);
          return {
            toolCalls: [
              {
                name: 'enterWorkspace',
                arguments: {
                  status: 'completed',
                  summary: 'Read a skill section.',
                  artifacts: [],
                  observations: [],
                  errors: [],
                  suggestedNextSteps: [],
                },
              },
            ],
          };
        }),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        skills: [skill],
        messages: [{ role: 'user', content: 'read release skill section' }],
        deliverFinal: true,
      },
      new AbortController().signal,
    );

    expect(JSON.stringify(emitted)).toContain('AUDIT_SECRET_SHOULD_NOT_APPEAR');
  });

  it('reads a bounded skill package reference file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zleap-skill-ref-'));
    await mkdir(join(root, 'references'), { recursive: true });
    await writeFile(join(root, 'references', 'checklist.md'), '# Checklist\nUse deterministic scripts.');
    const emitted: WorkspaceDelta[] = [];
    let turn = 0;
    const skill: SkillDefinition = {
      id: 'package-skill',
      label: 'Package Skill',
      description: 'Skill with external reference files',
      instructions: '# Overview\nRead references/checklist.md when executing.',
      toolIds: [],
      source: { type: 'project', packageRoot: root, sourceName: 'package-skill' },
      files: [{ path: 'references/checklist.md', kind: 'reference', size: 36 }],
    };

    await runTurnLoop(
      workContext(emitted, [skill]),
      {
        registries: registries((request) => {
          turn += 1;
          if (turn === 1) return { toolCalls: [{ name: 'readSkill', arguments: { path: 'package-skill/references/checklist.md' } }] };
          const lastToolResult = [...request.messages].reverse().find((message) => message.role === 'toolResult');
          const content = lastToolResult?.role === 'toolResult' ? lastToolResult.content : '';
          expect(JSON.parse(content)).toMatchObject({
            found: true,
            skill: {
              sourceKind: 'package_file',
              path: 'package-skill/references/checklist.md',
              instructions: '# Checklist\nUse deterministic scripts.',
            },
          });
          return {
            toolCalls: [
              {
                name: 'enterWorkspace',
                arguments: {
                  status: 'completed',
                  summary: 'Read package reference.',
                  artifacts: [],
                  observations: [],
                  errors: [],
                  suggestedNextSteps: [],
                },
              },
            ],
          };
        }),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        skills: [skill],
        messages: [{ role: 'user', content: 'read skill package reference' }],
        deliverFinal: true,
      },
      new AbortController().signal,
    );
  });

  it('infers the only active skill when readSkill is called with a package path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zleap-skill-ref-infer-'));
    await mkdir(join(root, 'references'), { recursive: true });
    await writeFile(join(root, 'references', 'checklist.md'), '# Checklist\nUse deterministic scripts.');
    const emitted: WorkspaceDelta[] = [];
    let turn = 0;
    const skill: SkillDefinition = {
      id: 'package-skill',
      label: 'Package Skill',
      description: 'Skill with external reference files',
      instructions: '# Overview\nRead references/checklist.md when executing.',
      toolIds: [],
      source: { type: 'project', packageRoot: root, sourceName: 'package-skill' },
      files: [{ path: 'references/checklist.md', kind: 'reference', size: 36 }],
    };

    await runTurnLoop(
      workContext(emitted, [skill]),
      {
        registries: registries((request) => {
          turn += 1;
          if (turn === 1) {
            return { toolCalls: [{ name: 'readSkill', arguments: { path: 'references/checklist.md' } }] };
          }
          const lastToolResult = [...request.messages].reverse().find((message) => message.role === 'toolResult');
          const content = lastToolResult?.role === 'toolResult' ? lastToolResult.content : '';
          expect(JSON.parse(content)).toMatchObject({
            found: true,
            skill: {
              id: 'package-skill',
              sourceKind: 'package_file',
              path: 'package-skill/references/checklist.md',
              instructions: '# Checklist\nUse deterministic scripts.',
            },
          });
          return {
            toolCalls: [
              {
                name: 'enterWorkspace',
                arguments: {
                  status: 'completed',
                  summary: 'Read inferred package reference.',
                  artifacts: [],
                  observations: [],
                  errors: [],
                  suggestedNextSteps: [],
                },
              },
            ],
          };
        }),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        skills: [skill],
        messages: [{ role: 'user', content: 'read skill package reference' }],
        deliverFinal: true,
      },
      new AbortController().signal,
    );
  });

  it('reads SKILL.md from the skill package by default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zleap-skill-entry-'));
    const skillMd = [
      '---',
      'name: packaged-review',
      'description: Review a repo.',
      '---',
      '# Packaged Review',
      'Always read the repository map first.',
    ].join('\n');
    await writeFile(join(root, 'SKILL.md'), skillMd);
    const emitted: WorkspaceDelta[] = [];
    let turn = 0;
    const skill: SkillDefinition = {
      id: 'packaged-review',
      label: 'Packaged Review',
      description: 'Skill with a real SKILL.md file',
      instructions: '# Stale DB Body\nThis should not be returned when packageRoot exists.',
      toolIds: [],
      source: { type: 'user', packageRoot: root, sourceName: 'packaged-review' },
      files: [{ path: 'SKILL.md', kind: 'skill', size: skillMd.length }],
    };

    await runTurnLoop(
      workContext(emitted, [skill]),
      {
        registries: registries((request) => {
          turn += 1;
          if (turn === 1) {
            return { toolCalls: [{ name: 'readSkill', arguments: { skillId: 'packaged-review' } }] };
          }
          const lastToolResult = [...request.messages].reverse().find((message) => message.role === 'toolResult');
          const content = lastToolResult?.role === 'toolResult' ? lastToolResult.content : '';
          expect(JSON.parse(content)).toMatchObject({
            found: true,
            skill: {
              sourceKind: 'package_file',
              path: 'packaged-review/SKILL.md',
              instructions: expect.stringContaining('# Packaged Review'),
              files: [{ path: 'SKILL.md', kind: 'skill', size: skillMd.length }],
            },
          });
          expect(content).not.toContain('Stale DB Body');
          return {
            toolCalls: [
              {
                name: 'enterWorkspace',
                arguments: {
                  status: 'completed',
                  summary: 'Read package entry skill file.',
                  artifacts: [],
                  observations: [],
                  errors: [],
                  suggestedNextSteps: [],
                },
              },
            ],
          };
        }),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        skills: [skill],
        messages: [{ role: 'user', content: 'read skill package entry file' }],
        deliverFinal: true,
      },
      new AbortController().signal,
    );
  });

  it('does not expose runSkill; script work must hand off to CLI', async () => {
    const emitted: WorkspaceDelta[] = [];
    const skill: SkillDefinition = {
      id: 'pdf',
      label: 'PDF Skill',
      description: 'PDF workflow',
      instructions: '# PDF\nUse reportlab in the CLI workspace for generation.',
      toolIds: [],
      source: { type: 'user', packageRoot: '/tmp/pdf-skill', sourceName: 'pdf' },
    };

    await runTurnLoop(
      workContext(emitted, [skill]),
      {
        registries: registries((request) => {
          const toolNames = new Set((request.tools ?? []).map((tool) => tool.name));
          expect(toolNames.has('readSkill')).toBe(true);
          expect(toolNames.has('runSkill')).toBe(false);
          expect(request.systemPrompt).toContain('switch to space=cli');
          expect(request.systemPrompt).toContain('Use switchWorkspace when another workspace still needs to continue the same user goal');
          expect(request.systemPrompt).toContain('Use finishTask only when the whole user goal is complete or failed');
          expect(request.systemPrompt).toContain('For scripts, shell commands, Python/Node execution, or local file generation, switch to space=cli');
          return {
            toolCalls: [
              {
                name: 'switchWorkspace',
                arguments: {
                  space: 'cli',
                  task: 'Generate the PDF using reportlab.',
                  message: 'Need CLI to generate the PDF because this workspace cannot execute scripts.',
                },
              },
            ],
          };
        }),
        modelId: TEST_MODEL,
        persona: 'Web search persona',
        skills: [skill],
        messages: [{ role: 'user', content: 'create a PDF after web research' }],
        deliverFinal: true,
        allowSkillScripts: false,
        workspaceId: 'web-search',
      },
      new AbortController().signal,
    );
  });

  it('narrows available tool schemas with active skill tool policy', async () => {
    const emitted: WorkspaceDelta[] = [];
    const availableTools: ToolDescriptor[] = [
      { id: 'read', description: 'Read files' },
      { id: 'write', description: 'Write files' },
      { id: 'bash', description: 'Run commands' },
    ];
    const skill: SkillDefinition = {
      id: 'safe-reader',
      label: 'Safe Reader',
      description: 'Read-only flow',
      instructions: 'Only read files.',
      toolIds: ['read', 'write'],
      allowedTools: ['read', 'write'],
      disallowedTools: ['write'],
    };

    await runTurnLoop(
      workContext(emitted, [skill], availableTools),
      {
        registries: registries((request) => {
          const toolNames = (request.tools ?? []).map((tool) => tool.name);
          expect(toolNames).toContain('read');
          expect(toolNames).toContain('readSkill');
          expect(toolNames).not.toContain('runSkill');
          expect(toolNames).toContain('switchWorkspace');
          expect(toolNames).toContain('finishTask');
          expect(toolNames).not.toContain('enterWorkspace');
          expect(toolNames).not.toContain('write');
          expect(toolNames).not.toContain('bash');
          return {
            toolCalls: [
              {
                name: 'finishTask',
                arguments: {
                  status: 'completed',
                  message: 'Tool schemas were narrowed.',
                },
              },
            ],
          };
        }),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        skills: [skill],
        messages: [{ role: 'user', content: 'use safe reader' }],
        deliverFinal: true,
      },
      new AbortController().signal,
    );
  });

  it('reports a user-facing failure when a work space never uses tools or returns a result', async () => {
    let calls = 0;
    const result = await runTurnLoop(
      workContext([]),
      {
        registries: registries(() => {
          calls += 1;
          return 'I am done in plain text only.';
        }),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        messages: [{ role: 'user', content: 'finish this' }],
        deliverFinal: true,
      },
      new AbortController().signal,
    );

    expect(calls).toBe(3);
    expect(result.hitToolLimit).toBe(false);
    expect(result.workspaceResult).toMatchObject({
      status: 'failed',
      summary: 'The model did not complete this workspace task: it stopped without calling finishTask or switchWorkspace.',
      errors: ['workspace_result_missing'],
    });
    expect(result.workspaceResult?.summary).toContain('finishTask or switchWorkspace');
  });

  it('rejects a plain-text wrap-up after tools ran when the model omits finishTask or switchWorkspace', async () => {
    const emitted: WorkspaceDelta[] = [];
    const readTool: ToolDescriptor = {
      id: 'read',
      description: 'Read a file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    };
    const context: WorkContext = {
      ...workContext(emitted, [], [readTool]),
      callTool: async (toolId) => {
        expect(toolId).toBe('read');
        return 'README contents';
      },
    };

    const result = await runTurnLoop(
      context,
      {
        registries: registries((request) => {
          const hasToolResult = request.messages.some((message) => message.role === 'toolResult');
          if (!hasToolResult) {
            return {
              toolCalls: [
                {
                  name: 'read',
                  arguments: { path: 'README.md', reason: 'inspect project overview' },
                },
              ],
            };
          }
          return 'The project is a workspace-oriented agent app.';
        }),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        messages: [{ role: 'user', content: 'analyze the project' }],
        deliverFinal: true,
      },
      new AbortController().signal,
    );

    expect(result.hitToolLimit).toBe(false);
    expect(result.workspaceResult).toMatchObject({
      status: 'failed',
      summary: 'The model did not complete this workspace task: it stopped without calling finishTask or switchWorkspace.',
      errors: ['workspace_result_missing'],
    });
    expect(result.workspaceResult?.observations).toEqual(expect.arrayContaining([
      expect.stringContaining('workspace-oriented agent app'),
    ]));
  });

  it('treats omitted finishTask as completed when a final answer follows a successful file artifact write', async () => {
    const emitted: WorkspaceDelta[] = [];
    const writeTool: ToolDescriptor = {
      id: 'write',
      description: 'Write a file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    };
    let writeAttempts = 0;
    const context: WorkContext = {
      ...workContext(emitted, [], [writeTool]),
      callTool: async (toolId) => {
        expect(toolId).toBe('write');
        writeAttempts += 1;
        if (writeAttempts === 1) {
          throw new Error('Unterminated string in JSON at position 7188');
        }
        return 'Created sag_analysis.html (+1444)\n+<!doctype html>\n+<title>SAG analysis</title>';
      },
    };

    const result = await runTurnLoop(
      context,
      {
        registries: registries((request) => {
          const writeResults = request.messages.filter((message) => message.role === 'toolResult' && message.toolName === 'write');
          const hasSuccessfulWrite = writeResults.some((message) => message.content.includes('Created sag_analysis.html'));
          if (!writeResults.length || !hasSuccessfulWrite) {
            return {
              toolCalls: [
                {
                  name: 'write',
                  arguments: { path: 'sag_analysis.html', content: '<!doctype html>' },
                },
              ],
            };
          }
          return '完成！sag_analysis.html 已成功生成，包含 SAG 项目深度分析页面。';
        }),
        modelId: TEST_MODEL,
        persona: 'Work persona',
        messages: [{ role: 'user', content: 'generate a deep analysis html report' }],
        confirm: async () => true,
        deliverFinal: true,
      },
      new AbortController().signal,
    );

    expect(writeAttempts).toBe(2);
    expect(result.hitToolLimit).toBe(false);
    expect(result.workspaceResult).toMatchObject({
      status: 'completed',
      summary: expect.stringContaining('sag_analysis.html'),
      errors: [],
    });
    expect(result.workspaceResult?.observations).toEqual([]);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Timed out waiting for condition.');
}
