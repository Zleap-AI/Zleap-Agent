#!/usr/bin/env node

const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';
const DEFAULT_AVATAR_ID = 'zleap-default';
const DEFAULT_PROMPT = '使用Python创建一个2页测试PPT，主题是工具调用可靠性，文件名为tool-reliability-test.pptx。';
const DEFAULT_EXPECTATIONS = [];

const args = parseArgs(process.argv.slice(2));
const baseUrl = args.baseUrl ?? DEFAULT_BASE_URL;
const avatarId = args.avatarId ?? DEFAULT_AVATAR_ID;
const prompt = args.prompt ?? DEFAULT_PROMPT;
const conversationId = args.conversationId ?? `real-${Date.now().toString(36)}`;
const expectations = (args.expect ?? DEFAULT_EXPECTATIONS).flatMap((item) => item.split(',')).map((item) => item.trim()).filter(Boolean);
const headers = {
  'content-type': 'application/json',
  'x-zleap-user-id': args.userId ?? 'local-dev-user',
  'x-zleap-actor-role': args.role ?? 'admin',
  'x-zleap-tenant-id': args.tenantId ?? 'local-dev',
  'x-zleap-actor-permissions': args.permissions ?? 'debug:trace:raw',
};

const sse = await runChat();
const conversation = await getJson(`/api/chat/conversation?conversationId=${encodeURIComponent(conversationId)}&avatarId=${encodeURIComponent(avatarId)}`);
const traces = await loadTraces(conversation);
const summary = summarize({ sse, conversation, traces });
const failures = checkExpectations(summary, expectations);

console.log(JSON.stringify({ conversationId, prompt, summary, failures }, null, 2));
if (failures.length > 0) {
  process.exitCode = 1;
}

async function runChat() {
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      conversationId,
      avatarId,
      projectId: null,
      permissionMode: args.permissionMode ?? 'full_access',
      history: [{ role: 'user', text: prompt }],
      ...(args.modelId ? { modelId: args.modelId } : {}),
      ...(args.targetSpace ? { targetSpace: args.targetSpace } : {}),
      ...(args.skillId ? { skillId: args.skillId, skillLabel: args.skillLabel ?? args.skillId } : {}),
    }),
  });
  if (!response.ok || !response.body) {
    throw new Error(`POST /api/chat failed: HTTP ${response.status} ${await response.text()}`);
  }
  return readSse(response.body);
}

async function readSse(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const deltas = [];
  let buffer = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const json = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
        .trim();
      if (!json || json === '[DONE]') continue;
      const delta = parseJson(json);
      if (!delta) continue;
      deltas.push(delta);
      if (delta.type === 'needs_approval') {
        await approve(delta);
      }
      if (delta.type === 'done' || delta.type === 'error') {
        return deltas;
      }
    }
  }
  return deltas;
}

async function approve(delta) {
  if ((args.autoApprove ?? 'true') === 'false') {
    return;
  }
  await fetch(`${baseUrl}/api/chat/approval`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      conversationId,
      approvalId: delta.approvalId,
      toolName: delta.name,
      approved: true,
      ...(delta.preview ? { preview: delta.preview } : {}),
    }),
  });
}

async function loadTraces(conversation) {
  const sessions = new Map();
  if (conversation?.threadId) {
    sessions.set('main', undefined);
  }
  for (const workspace of conversation?.workspaces ?? []) {
    if (workspace?.sessionId) {
      sessions.set(String(workspace.id ?? workspace.spaceId ?? workspace.sessionId), workspace.sessionId);
    }
  }
  const traces = {};
  for (const [label, sessionId] of sessions) {
    const params = new URLSearchParams({ avatarId, raw: 'true', limit: '1000' });
    if (sessionId) {
      params.set('sessionId', sessionId);
    } else {
      params.set('conversationId', conversationId);
    }
    traces[label] = await getJson(`/api/chat/trace?${params.toString()}`);
  }
  return traces;
}

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`, { headers });
  if (!response.ok) {
    throw new Error(`${path} failed: HTTP ${response.status} ${await response.text()}`);
  }
  return response.json();
}

function summarize(input) {
  const text = JSON.stringify(input);
  const visibleText = visibleModelAndUserText(input);
  const toolDeltas = input.sse.filter((delta) => delta.type === 'tool');
  const sseTools = toolDeltas.map((delta) => `${delta.phase}:${delta.name}`);
  const spaces = input.sse.filter((delta) => delta.type === 'space').map((delta) => ({ id: delta.id, label: delta.label, goal: delta.goal }));
  const spaceResults = input.sse.filter((delta) => delta.type === 'space_result').map((delta) => ({ id: delta.id, envelope: delta.envelope }));
  const contextSnapshots = input.sse.filter((delta) => delta.type === 'context').map((delta) => delta.snapshot).filter(Boolean);
  const contextBlockLabels = contextSnapshots.flatMap((snapshot) => (snapshot.blocks ?? []).map((block) => block.label ?? block.sub));
  const contextBlockSubs = contextSnapshots.flatMap((snapshot) => (snapshot.blocks ?? []).map((block) => block.sub));
  const contextText = JSON.stringify(contextSnapshots);
  const ledgerProviderEvents = Object.fromEntries(
    Object.entries(input.traces).map(([label, trace]) => [
      label,
      (trace.ledgerEvents ?? [])
        .filter((event) => event.type === 'before_provider_request' || event.type === 'after_provider_response')
        .map((event) => ({ type: event.type, data: event.data })),
    ]),
  );
  return {
    deltaCount: input.sse.length,
    spaces,
    spaceResults,
    workspaceCount: input.conversation?.workspaceCount,
    workspaceIds: (input.conversation?.workspaces ?? []).map((workspace) => workspace.id ?? workspace.spaceId),
    sseTools,
    rawTraceSessions: Object.keys(input.traces),
    providerEvents: ledgerProviderEvents,
    contextBlockLabels,
    contextBlockSubs,
    hasListMemoryContext: contextBlockSubs.includes('listMemory'),
    hasListSkillsContext: contextBlockSubs.includes('listSkills'),
    hasReadSkillContext: contextBlockSubs.includes('readSkill'),
    hasLegacyRuntimeXml: /<System-(Impressions|Experience|Items|Memory)>|<Selected-Skills>|<active_skills>|<suggested_skills>/.test(contextText),
    legacyRuntimeXmlMatches: leakMatches(contextText, /<System-(?:Impressions|Experience|Items|Memory)>|<Selected-Skills>|<active_skills>|<suggested_skills>/g),
    hasReadSkill: hasToolEvidence(input, 'readSkill'),
    hasFindSkill: hasToolEvidence(input, 'findSkill'),
    hasMalformedWrite: text.includes('Tool "write" was rejected: arguments JSON is incomplete or malformed'),
    hasTaskIdLeak: /\b(finalTaskId|Previous taskId|taskId:)/.test(visibleText),
    taskIdLeakMatches: leakMatches(visibleText, /\b(finalTaskId|Previous taskId|taskId:)/g),
    hasGoalInSpaceDelta: spaces.some((space) => typeof space.goal === 'string' && space.goal.trim().length > 0),
    hasGoalXmlInContext: visibleText.includes('<goal>') && visibleText.includes('</goal>'),
    goalXmlMatches: leakMatches(visibleText, /<goal>[\s\S]{0,160}?<\/goal>/g),
    writeProviderToolCalls: providerToolCalls(input.traces, 'write'),
  };
}

function leakMatches(text, regex) {
  const matches = [];
  for (const match of text.matchAll(regex)) {
    const index = match.index ?? 0;
    matches.push(text.slice(Math.max(0, index - 80), Math.min(text.length, index + 160)));
    if (matches.length >= 5) break;
  }
  return matches;
}

function visibleModelAndUserText(input) {
  const parts = [];
  for (const delta of input.sse) {
    if (typeof delta.text === 'string') parts.push(delta.text);
    if (delta.type === 'space' && typeof delta.goal === 'string') parts.push(delta.goal);
    if (delta.type === 'context' && delta.snapshot) parts.push(JSON.stringify(delta.snapshot));
    if (delta.type === 'tool' && typeof delta.detail === 'string') parts.push(delta.detail);
  }
  for (const trace of Object.values(input.traces)) {
    for (const entry of trace.entries ?? []) {
      if (typeof entry.content === 'string') parts.push(entry.content);
    }
  }
  return parts.join('\n');
}

function providerToolCalls(traces, name) {
  const calls = [];
  for (const [session, trace] of Object.entries(traces)) {
    for (const event of trace.ledgerEvents ?? []) {
      const toolCalls = event?.data?.toolCalls;
      if (!Array.isArray(toolCalls)) continue;
      for (const call of toolCalls) {
        if (call?.name === name) {
          calls.push({ session, providerEventType: event.type, ...call, finishReason: event.data?.finishReason });
        }
      }
    }
  }
  return calls;
}

function hasToolEvidence(input, name) {
  if (input.sse.some((delta) => delta.type === 'tool' && delta.name === name)) {
    return true;
  }
  for (const trace of Object.values(input.traces)) {
    for (const event of trace.ledgerEvents ?? []) {
      const toolCalls = event?.data?.toolCalls;
      if (!Array.isArray(toolCalls)) continue;
      if (toolCalls.some((call) => call?.name === name)) {
        return true;
      }
    }
  }
  return false;
}

function checkExpectations(summary, expectations) {
  const failures = [];
  for (const expectation of expectations) {
    if (expectation === 'readSkill' && !summary.hasReadSkill) failures.push('expected readSkill tool evidence');
    if (expectation === 'listMemoryContext' && !summary.hasListMemoryContext) failures.push('expected listMemory context block');
    if (expectation === 'listSkillsContext' && !summary.hasListSkillsContext) failures.push('expected listSkills context block');
    if (expectation === 'readSkillContext' && !summary.hasReadSkillContext) failures.push('expected readSkill context block');
    if (expectation === 'noLegacyRuntimeXml' && summary.hasLegacyRuntimeXml) failures.push('expected no legacy runtime XML context blocks');
    if (expectation === 'findSkill' && !summary.hasFindSkill) failures.push('expected findSkill tool evidence');
    if (expectation === 'noTaskId' && summary.hasTaskIdLeak) failures.push('expected no model/user visible taskId leakage');
    if (expectation === 'noMalformedWrite' && summary.hasMalformedWrite) failures.push('expected no malformed write rejection');
    if (expectation === 'goal' && !summary.hasGoalInSpaceDelta) failures.push('expected goal in workspace transition delta');
    if (expectation === 'goalXml' && !summary.hasGoalXmlInContext) failures.push('expected goal XML in model-visible context');
    if (expectation === 'writeProviderTrace' && summary.writeProviderToolCalls.length === 0) failures.push('expected provider-level write tool call trace');
    if (expectation === 'workspace' && summary.spaces.length === 0) failures.push('expected at least one workspace transition');
  }
  return failures;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      continue;
    }
    if (!arg.startsWith('--')) {
      continue;
    }
    const [rawKey, inlineValue] = arg.slice(2).split('=');
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const value = inlineValue ?? argv[index + 1];
    if (inlineValue === undefined) {
      index += 1;
    }
    if (key === 'expect') {
      parsed.expect = [...(parsed.expect ?? []), value];
    } else {
      parsed[key] = value;
    }
  }
  return parsed;
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
