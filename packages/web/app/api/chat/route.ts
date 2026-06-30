import { ChatEngine, DEFAULT_SYSTEM_PROMPT, type ChatTaskManager } from '@zleap/agent/engine';
import {
  ConversationService,
  modelFromEnv,
  toEngineModel,
  type EngineOverrides,
  type HandleOptions,
} from '@zleap/agent/conversation';
import { DEFAULT_AVATAR_ID, toCanonicalSpaceId, type InboundMessage, type ScheduledTaskRecord } from '@zleap/core';
import { AvatarRunInputError, buildWebChatRunInput } from '@zleap/avatar';
import type { ZleapStore } from '@zleap/store';
import { storeFromEnv } from '../../../lib/server/avatarStore';
import { getSharedStore } from '../../../lib/server/sharedStore';
import { listFileModelConfigs } from '../../../lib/server/modelConfigFileStore';
import { modelKind } from '../../../lib/models';
import { projectStore } from '../../../lib/server/projectStore';
import { ensureConversationWorkspace, type ConversationWorkspaceRecord } from '../../../lib/server/conversationWorkspace';
import { readToolState } from '../../../lib/server/toolStateStore';
import { expandToolSetIds } from '../../../lib/server/toolSets';
import { isActorResponse, requireHttpActor } from '../../../lib/server/actor';
import { waitForLiveApproval } from '../../../lib/server/liveApprovals';
import { readPermissionPreference } from '../../../lib/server/permissionPreferenceStore';
import { bypassesToolApproval, normalizePermissionMode, shouldAutoApproveToolWithoutHitl, type PermissionMode } from '../../../lib/permissions';
import { boundSpaceIdsFromMetadata } from '../../../lib/avatarSpaceBindings';
import { normalizeRunMode, type RunMode } from '../../../lib/runModes';
import {
  IMAGE_ATTACHMENT_LIMITS,
  dataUrlToBase64Payload,
  isSupportedImageMimeType,
  type ChatImageAttachment,
  type ChatImageRequestAttachment,
} from '../../../lib/chatAttachments';
import {
  PLAN_EXECUTE_CONFIRM_MARKER,
  PLAN_QUESTION_END_MARKER,
  PLAN_QUESTION_START_MARKER,
} from '../../../lib/planOptions';
import { actorToTaskActor, taskDefaultsFromBody, taskRunToJson, taskToJson, withTaskService } from '../../../lib/server/taskService';

// The real agent runs tools (fs, search, shell) on this machine — Node runtime,
// never static.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Turn = { role: 'user' | 'assistant'; text: string };
type ApprovalDecision = {
  approvalId: string;
  toolName: string;
  approved: boolean;
  preview?: string;
};

// Derive the engine's own types so we don't need a direct @zleap/ai dependency.
type ModelConfig = NonNullable<ConstructorParameters<typeof ChatEngine>[0]>;
type ReplyOptions = NonNullable<Parameters<ChatEngine['reply']>[3]>;
type ToolApprovalRequest = Parameters<NonNullable<ReplyOptions['confirm']>>[0];

const APPROVAL_ID_MAX_CHARS = 160;
const APPROVAL_TOOL_NAME_MAX_CHARS = 160;
const APPROVAL_PREVIEW_MAX_CHARS = 1_200;
const DISPLAY_THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;
const DISPLAY_PREVIEW_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Resolve the OpenAI-compatible model from the environment. Accepts both the
 * `ZLEAP_MODEL_*` names (CLI convention) and the project's existing `LLM_*`
 * names in the root .env. When unset, the engine has no model and replies with
 * a "configure a model" error (there is no offline fallback).
 */
async function modelFromStore(store: ZleapStore | null, modelConfigId?: string): Promise<ModelConfig | undefined> {
  const models = store ? await store.models.listModelConfigs() : await listFileModelConfigs();
  const llmOnly = models.filter((model) => modelKind(model) === 'llm');
  const selected = modelConfigId
    ? llmOnly.find((model) => model.id === modelConfigId)
    : llmOnly.find((model) => model.config?.isDefault === true) ?? llmOnly[0];
  if (!selected) return undefined;
  return toEngineModel(selected);
}

async function modelConfigIdFromTargetSpace(store: ZleapStore | null, targetSpace?: string): Promise<string | undefined> {
  const rawSpaceId = targetSpace?.trim();
  if (!store || !rawSpaceId) return undefined;
  const spaceId = toCanonicalSpaceId(rawSpaceId);
  try {
    const space = await store.spaces.getSpace(spaceId);
    if (!space) return undefined;
    const version = await store.spaces.getSpaceVersion(space.id, space.currentVersion);
    return version?.modelConfigId?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function lastUserText(history: Turn[]): string {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const turn = history[i]!;
    if (turn.role === 'user' && turn.text.trim()) {
      return turn.text.trim();
    }
  }
  return '';
}

function parseApprovalDecision(value: unknown): { decision?: ApprovalDecision; error?: string } {
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'invalid_approval_decision' };
  }
  const record = value as Record<string, unknown>;
  const approvalId = boundedString(record.approvalId, APPROVAL_ID_MAX_CHARS);
  const toolName = boundedString(record.toolName, APPROVAL_TOOL_NAME_MAX_CHARS);
  if (!approvalId || !toolName || typeof record.approved !== 'boolean') {
    return { error: 'invalid_approval_decision' };
  }
  const preview = record.preview === undefined ? undefined : boundedString(record.preview, APPROVAL_PREVIEW_MAX_CHARS);
  if (record.preview !== undefined && !preview) {
    return { error: 'invalid_approval_decision' };
  }
  return {
    decision: {
      approvalId,
      toolName,
      approved: record.approved,
      ...(preview ? { preview } : {}),
    },
  };
}

function boundedString(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxChars) {
    return undefined;
  }
  return trimmed;
}

function parseImageAttachments(value: unknown): {
  attachments?: NonNullable<InboundMessage['attachments']>;
  error?: string;
} {
  if (value === undefined) return {};
  if (!Array.isArray(value) || value.length > IMAGE_ATTACHMENT_LIMITS.maxCount) {
    return { error: 'invalid_image_attachment' };
  }
  const attachments: NonNullable<InboundMessage['attachments']> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { error: 'invalid_image_attachment' };
    }
    if (!hasOnlyImageAttachmentRequestKeys(item)) {
      return { error: 'invalid_image_attachment' };
    }
    const record = item as Partial<ChatImageRequestAttachment>;
    if (
      record.kind !== 'image'
      || typeof record.id !== 'string'
      || typeof record.name !== 'string'
      || typeof record.mimeType !== 'string'
      || !isSupportedImageMimeType(record.mimeType)
      || typeof record.sizeBytes !== 'number'
      || record.sizeBytes < 0
      || record.sizeBytes > IMAGE_ATTACHMENT_LIMITS.maxBytes
      || typeof record.dataUrl !== 'string'
    ) {
      return { error: 'invalid_image_attachment' };
    }
    const payload = dataUrlToBase64Payload(record.dataUrl);
    if (!payload || payload.mimeType !== record.mimeType) {
      return { error: 'invalid_image_attachment' };
    }
    const decodedBytes = base64ByteLength(payload.base64);
    if (decodedBytes !== record.sizeBytes || decodedBytes > IMAGE_ATTACHMENT_LIMITS.maxBytes) {
      return { error: 'invalid_image_attachment' };
    }
    attachments.push({
      id: record.id,
      kind: 'image',
      name: record.name,
      mimeType: record.mimeType,
      sizeBytes: record.sizeBytes,
      data: payload.base64,
    });
  }
  return { attachments };
}

function parseDisplayImageAttachments(
  value: unknown,
  attachments: NonNullable<InboundMessage['attachments']> | undefined,
): {
  displayAttachments?: NonNullable<InboundMessage['displayAttachments']>;
  error?: string;
} {
  if (value === undefined) return {};
  if (!Array.isArray(value) || !attachments?.length || value.length !== attachments.length || value.length > IMAGE_ATTACHMENT_LIMITS.maxCount) {
    return { error: 'invalid_display_image_attachment' };
  }
  const displayAttachments: NonNullable<InboundMessage['displayAttachments']> = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    const attachment = attachments[index];
    if (!item || typeof item !== 'object' || Array.isArray(item) || !attachment) {
      return { error: 'invalid_display_image_attachment' };
    }
    if (!hasOnlyDisplayImageAttachmentKeys(item)) {
      return { error: 'invalid_display_image_attachment' };
    }
    const record = item as Partial<ChatImageAttachment>;
    if (
      record.kind !== 'image'
      || typeof record.id !== 'string'
      || typeof record.name !== 'string'
      || typeof record.mimeType !== 'string'
      || !isSupportedImageMimeType(record.mimeType)
      || typeof record.sizeBytes !== 'number'
      || record.sizeBytes < 0
      || record.sizeBytes > IMAGE_ATTACHMENT_LIMITS.maxBytes
      || typeof record.thumbnailDataUrl !== 'string'
      || typeof record.previewDataUrl !== 'string'
    ) {
      return { error: 'invalid_display_image_attachment' };
    }
    if (
      record.id !== attachment.id
      || record.kind !== attachment.kind
      || record.name !== attachment.name
      || record.mimeType !== attachment.mimeType
      || record.sizeBytes !== attachment.sizeBytes
    ) {
      return { error: 'invalid_display_image_attachment' };
    }
    const payload = dataUrlToBase64Payload(record.thumbnailDataUrl);
    if (!payload || payload.mimeType !== record.mimeType || base64ByteLength(payload.base64) > DISPLAY_THUMBNAIL_MAX_BYTES) {
      return { error: 'invalid_display_image_attachment' };
    }
    const previewPayload = dataUrlToBase64Payload(record.previewDataUrl);
    if (!previewPayload || previewPayload.mimeType !== record.mimeType || base64ByteLength(previewPayload.base64) > DISPLAY_PREVIEW_MAX_BYTES) {
      return { error: 'invalid_display_image_attachment' };
    }
    displayAttachments.push({
      id: record.id,
      kind: 'image',
      name: record.name,
      mimeType: record.mimeType,
      sizeBytes: record.sizeBytes,
      thumbnailDataUrl: record.thumbnailDataUrl,
      previewDataUrl: record.previewDataUrl,
    });
  }
  return { displayAttachments };
}

function hasOnlyImageAttachmentRequestKeys(value: object): boolean {
  const allowedKeys = new Set(['id', 'kind', 'name', 'mimeType', 'sizeBytes', 'dataUrl']);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function hasOnlyDisplayImageAttachmentKeys(value: object): boolean {
  const allowedKeys = new Set(['id', 'kind', 'name', 'mimeType', 'sizeBytes', 'thumbnailDataUrl', 'previewDataUrl']);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function base64ByteLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function buildHttpApprovalConfirm(options: {
  actor: { userId: string; tenantId?: string };
  avatarId: string;
  conversationId?: string;
  decision?: ApprovalDecision;
  permissionMode: PermissionMode;
  send: (delta: unknown) => void;
  signal: AbortSignal;
}): (request: ToolApprovalRequest) => Promise<boolean> {
  return async (request) => {
    const storedMode = await readPermissionPreference({
      userId: options.actor.userId,
      tenantId: options.actor.tenantId,
      avatarId: options.avatarId,
    }).catch(() => options.permissionMode);
    const effectiveMode =
      bypassesToolApproval(storedMode) || bypassesToolApproval(options.permissionMode) ? 'full_access' : storedMode;
    if (bypassesToolApproval(effectiveMode)) {
      return true;
    }
    if (shouldAutoApproveToolWithoutHitl(request.name)) {
      return true;
    }
    if (options.decision && approvalDecisionMatches(options.decision, request)) {
      return options.decision.approved;
    }
    const message = `Tool "${request.name}" requires approval before execution. No action was taken.`;
    try {
      options.send({
        type: 'needs_approval',
        approvalId: request.approvalId,
        name: request.name,
        args: request.args,
        preview: request.preview,
        message,
      });
    } catch {
      // The stream may already be closed in tests or aborted clients. The
      // approval wait still resolves false by timeout/abort instead of throwing.
    }
    const liveDecision = await waitForLiveApproval({
      actor: options.actor,
      conversationId: options.conversationId,
      request,
      signal: options.signal,
    });
    return liveDecision?.approved === true;
  };
}

function approvalDecisionMatches(decision: ApprovalDecision | undefined, request: ToolApprovalRequest): boolean {
  if (!decision) {
    return false;
  }
  if (decision.approvalId !== request.approvalId || decision.toolName !== request.name) {
    return false;
  }
  if (decision.preview !== undefined || request.preview !== undefined) {
    return decision.preview === request.preview;
  }
  return true;
}

type ProjectRuntimeContext = {
  systemPrompt: string;
  workspaceRoot: string;
};

type SelectedSkillContext = {
  id: string;
  label: string;
  description?: string;
  version?: number;
  procedureId?: string;
  sourceType?: string;
  sourceName?: string;
  packageRoot?: string;
  files?: Array<{ path: string; kind?: string }>;
  allowedTools?: string[];
  disallowedTools?: string[];
  invocationPolicy?: string;
  trustStatus?: string;
};

async function runtimeContextFromConversation(base: string, workspace: ConversationWorkspaceRecord): Promise<ProjectRuntimeContext> {
  if (workspace.workspaceKind === 'project') {
    const project = workspace.projectId
      ? (await projectStore.list()).find((entry) => entry.id === workspace.projectId)
      : undefined;
    if (!project) {
      throw new Error('project_not_found');
    }
    const projectRoot = workspace.workspaceRoot;
    const lines = [
      `Working directory: ${projectRoot}`,
      `Project: ${project.name}`,
      `Project root: ${projectRoot}`,
      'Project mode: read and write files directly in the selected project folder. Do not copy this project into the Zleap history folder.',
      'This selected project root is the current conversation folder/workspace root for file tools in this run.',
      'Use relative paths under this project root for generated files unless the user explicitly provides another path.',
      'Absolute output paths outside this working directory are not current; keep only the filename and write it under this root.',
      'Do not use /tmp or system temp directories for generated files, temp scripts, or intermediate outputs.',
    ];
    if (project.note?.trim()) lines.push(`Note: ${project.note.trim()}`);
    if (project.spec?.trim()) lines.push('', project.spec.trim());
    return { systemPrompt: `${base}\n\n## Project context\n${lines.join('\n')}`, workspaceRoot: projectRoot };
  }

  const workspaceRoot = workspace.workspaceRoot;
  const lines = [
    `Working directory: ${workspaceRoot}`,
    'Project mode: no project selected; use this Zleap history folder for generated files.',
    'This Zleap history folder is the current conversation folder/workspace root for file tools in this run.',
    'Use relative paths under this folder for all generated files. Do not write to any other local folder unless the user explicitly provides that path.',
    'Absolute output paths outside this working directory are not current; keep only the filename and write it under this folder.',
    'Do not use /tmp or system temp directories for generated files, temp scripts, or intermediate outputs.',
  ];
  return { systemPrompt: `${base}\n\n## Project context\n${lines.join('\n')}`, workspaceRoot };
}

function firstUserText(history: Turn[]): string | undefined {
  return history.find((turn) => turn.role === 'user' && turn.text.trim())?.text.trim();
}

function taskStringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function taskNullableStringField(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === 'string') return value.trim() || null;
  return undefined;
}

function taskPermissionMode(value: unknown): 'request_approval' | 'full_access' | undefined {
  if (value === 'request_approval' || value === 'full_access') return value;
  return undefined;
}

function systemPromptWithRunControls(base: string, options: { runMode: RunMode; skill?: SelectedSkillContext }): string {
  const blocks = [base];
  const modePrompt = runModePrompt(options.runMode);
  if (modePrompt) blocks.push(modePrompt);
  const skillPrompt = selectedSkillPrompt(options.skill);
  if (skillPrompt) blocks.push(skillPrompt);
  return blocks.join('\n\n');
}

function runModePrompt(runMode: RunMode): string | undefined {
  if (runMode === 'plan') {
    return [
      '## Run Mode: Plan',
      'This turn is analysis and planning only. Do not execute tools, dispatch to workspaces, read or write files, run commands, or modify data.',
      'If critical information is missing, reason about the goal, deliverable, scope boundaries, technical path, and acceptance criteria, then ask 2-3 genuinely important questions when useful. Ask only one question when there is truly only one key gap.',
      'Each question must provide 2-3 clickable options. Do not ask meaningless questions just to fill the count.',
      'Do not repeat the questions and options in the main body. Put questions and options only in the fixed JSON question block at the end of the response:',
      PLAN_QUESTION_START_MARKER,
      '{"questions":[{"question":"What should this plan ultimately guide us to produce?","options":[{"id":"1","label":"Runnable harness","recommended":true},{"id":"2","label":"Research report"},{"id":"3","label":"MVP document first"}]},{"question":"Which risk should be controlled first?","options":[{"id":"1","label":"Scope drift"},{"id":"2","label":"Technical feasibility"},{"id":"3","label":"Acceptance clarity"}]}]}',
      PLAN_QUESTION_END_MARKER,
      'The fixed JSON question block must not be inside a code block. Do not change the start/end markers. The JSON must be parseable by JSON.parse; the frontend renders it as a question card.',
      'The user may also type other requirements to revise the plan. Once enough information is available, output a "Final Plan" with the goal, steps, risks, and points that need user confirmation.',
      'When the final plan is complete and the only next step is user confirmation to execute, do not write a natural-language confirmation sentence such as "reply execute".',
      `Output this fixed marker on its own line at the very end: ${PLAN_EXECUTE_CONFIRM_MARKER}`,
      'The fixed marker must not be inside a code block, and its casing/punctuation must not be changed. The frontend renders it as a Continue button and an Other requirements input.',
    ].join('\n');
  }
  if (runMode === 'goal') {
    return [
      '## Run Mode: Goal',
      'Treat the user request as the final goal. After each stage, self-check whether the goal is satisfied, what evidence supports that, and what gaps remain.',
      'If gaps remain, continue with the next step instead of stopping early. Once the goal is satisfied, stop and output a "Final Goal Report" with the goal, completion evidence, remaining risks, and artifact locations.',
    ].join('\n');
  }
  return undefined;
}

function selectedSkillPrompt(skill?: SelectedSkillContext): string | undefined {
  if (!skill) {
    return undefined;
  }
  const lines = [
    '## Selected Skill For This Turn',
    `The user selected this skill in the input box: ${skill.label} (${skill.id}).`,
    'This is a strong signal. If this turn needs a workspace, the skill will be mounted as a temporary per-turn skill in the dispatched workspace. Main should use it only to understand the target and route the task, not to expand detailed skill procedures in main.',
  ];
  if (skill.procedureId) {
    lines.push(`Skill read identifier: ${skill.procedureId}`);
  }
  if (skill.description?.trim()) {
    lines.push(`Skill description: ${skill.description.trim()}`);
  }
  if (skill.trustStatus) {
    lines.push(`Trust status: ${skill.trustStatus}`);
  }
  if (skill.disallowedTools?.length) {
    lines.push(`This skill explicitly disallows tools: ${skill.disallowedTools.join(', ')}`);
  }
  return lines.join('\n');
}

export async function POST(req: Request): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) {
    return actor;
  }

  let history: Turn[] = [];
  let conversationId: string | undefined;
  let avatarId = DEFAULT_AVATAR_ID;
  let projectId: string | null | undefined;
  let modelConfigId: string | undefined;
  let permissionMode = normalizePermissionMode(undefined);
  let targetSpace: string | undefined;
  let runMode: RunMode = 'normal';
  let skillId: string | undefined;
  let skillLabel: string | undefined;
  let approvalDecision: ApprovalDecision | undefined;
  let allowedSpaceIds: string[] | undefined;
  let avatarPersona: string | undefined;
  let attachments: NonNullable<InboundMessage['attachments']> | undefined;
  let displayAttachments: NonNullable<InboundMessage['displayAttachments']> | undefined;
  try {
    const body = (await req.json()) as {
      history?: Turn[];
      conversationId?: string;
      avatarId?: string;
      projectId?: string | null;
      modelId?: string;
      permissionMode?: unknown;
      targetSpace?: string;
      runMode?: unknown;
      skillId?: string;
      skillLabel?: string;
      attachments?: unknown;
      displayAttachments?: unknown;
      approvalDecision?: unknown;
    };
    history = Array.isArray(body.history) ? body.history : [];
    conversationId = typeof body.conversationId === 'string' ? body.conversationId : undefined;
    avatarId = typeof body.avatarId === 'string' && body.avatarId.trim() ? body.avatarId.trim() : DEFAULT_AVATAR_ID;
    projectId = typeof body.projectId === 'string' && body.projectId.trim()
      ? body.projectId.trim()
      : body.projectId === null
        ? null
        : undefined;
    modelConfigId = typeof body.modelId === 'string' && body.modelId.trim() ? body.modelId.trim() : undefined;
    permissionMode = normalizePermissionMode(body.permissionMode);
    targetSpace = typeof body.targetSpace === 'string' && body.targetSpace.trim() ? body.targetSpace.trim() : undefined;
    runMode = normalizeRunMode(body.runMode);
    skillId = boundedString(body.skillId, APPROVAL_TOOL_NAME_MAX_CHARS);
    skillLabel = boundedString(body.skillLabel, APPROVAL_TOOL_NAME_MAX_CHARS);
    const parsedApprovalDecision = parseApprovalDecision(body.approvalDecision);
    if (parsedApprovalDecision.error) {
      return Response.json({ error: parsedApprovalDecision.error }, { status: 400 });
    }
    approvalDecision = parsedApprovalDecision.decision;
    const parsedAttachments = parseImageAttachments(body.attachments);
    if (parsedAttachments.error) {
      return Response.json({ error: parsedAttachments.error }, { status: 400 });
    }
    attachments = parsedAttachments.attachments;
    const parsedDisplayAttachments = parseDisplayImageAttachments(body.displayAttachments, attachments);
    if (parsedDisplayAttachments.error) {
      return Response.json({ error: parsedDisplayAttachments.error }, { status: 400 });
    }
    displayAttachments = parsedDisplayAttachments.displayAttachments;
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  const avatarStore = await storeFromEnv();
  try {
    if (avatarId !== DEFAULT_AVATAR_ID) {
      const avatar = avatarStore ? await avatarStore.avatars.getAvatar(avatarId) : undefined;
      if (!avatarStore || !avatar) {
        return Response.json({ error: 'avatar_not_found', avatarId }, { status: 404 });
      }
      if (avatar.userId && avatar.userId !== actor.userId) {
        return Response.json({ error: 'avatar_forbidden', avatarId }, { status: 403 });
      }
    }
    const avatarVersion = avatarStore ? await avatarStore.avatars.getAvatarVersion(avatarId) : undefined;
    allowedSpaceIds = boundSpaceIdsFromMetadata(avatarVersion?.metadata);
    // The avatar's 人格设定 overrides the identity segment of the system prompt
    // (composeSystemPersona). Fall back to SOUL identity when no persona is set.
    avatarPersona = avatarVersion?.persona?.trim() || undefined;
  } finally {
    await avatarStore?.close().catch(() => {});
  }

  if (!conversationId?.trim()) {
    return Response.json({ error: 'conversation_id_required' }, { status: 400 });
  }

  const userPrompt = lastUserText(history) || (attachments?.length ? 'Please analyze the attached image.' : '');
  let webRun;
  try {
    webRun = buildWebChatRunInput({
      avatarId,
      actorId: actor.userId,
      spaceId: targetSpace,
      conversationId,
      prompt: userPrompt,
    });
  } catch (error) {
    if (error instanceof AvatarRunInputError) {
      return Response.json({ error: error.code }, { status: 400 });
    }
    throw error;
  }
  avatarId = webRun.avatarId;
  const runConversationId = webRun.conversationId;
  if (!runConversationId) {
    return Response.json({ error: 'conversation_id_required' }, { status: 400 });
  }
  conversationId = runConversationId;

  const modelStore = await storeFromEnv();
  let model = modelFromEnv();
  // Resolve the model while this read pool is open, then close it. The engine
  // itself runs on the process-level shared store (one pool), not this one.
  let selectedSkill: SelectedSkillContext | undefined;
  try {
    const spaceModelConfigId = runMode === 'plan' ? undefined : await modelConfigIdFromTargetSpace(modelStore, targetSpace);
    model = (spaceModelConfigId ? await modelFromStore(modelStore, spaceModelConfigId) : undefined) ?? (await modelFromStore(modelStore, modelConfigId)) ?? model;
    if (skillId && modelStore && 'skills' in modelStore) {
      const record = await modelStore.skills.getSkill(skillId).catch(() => undefined);
      selectedSkill = record
        ? {
            id: record.id,
            label: record.label,
            description: record.description,
            version: record.version,
            procedureId: `skill:${record.id}@${record.version}`,
            sourceType: record.sourceType,
            sourceName: record.sourceName,
            packageRoot: record.packageRoot,
            files: record.files?.map((file) => ({ path: file.path, kind: file.kind })),
            allowedTools: record.allowedTools,
            disallowedTools: record.disallowedTools,
            invocationPolicy: record.invocationPolicy,
            trustStatus: record.trustStatus,
          }
        : { id: skillId, label: skillLabel ?? skillId };
    } else if (skillId) {
      selectedSkill = { id: skillId, label: skillLabel ?? skillId };
    }
  } finally {
    await modelStore?.close().catch(() => {});
  }

  // Tools the user switched off (Tool page) are filtered at mount: individual
  // disabled tools plus every tool of a disabled toolset.
  const toolState = await readToolState();
  const disabledToolIds = [...new Set([...toolState.disabledToolIds, ...expandToolSetIds(toolState.disabledToolSetIds)])];

  const conversationStore = await storeFromEnv();
  if (!conversationStore) {
    return Response.json({ error: 'persistence_unavailable' }, { status: 503 });
  }

  let conversation: ConversationWorkspaceRecord;
  try {
    conversation = await ensureConversationWorkspace(conversationStore, actor, {
      conversationId: runConversationId,
      source: 'web',
      avatarId,
      projectId,
      seedTitle: firstUserText(history),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message === 'project_not_found' ? 404 : message.endsWith('_not_allowed') ? 403 : 400;
    return Response.json({ error: message, projectId: typeof projectId === 'string' ? projectId : undefined }, { status });
  } finally {
    await conversationStore.close().catch(() => {});
  }

  let projectContext: ProjectRuntimeContext;
  try {
    projectContext = await runtimeContextFromConversation(avatarPersona ?? DEFAULT_SYSTEM_PROMPT, conversation);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message === 'project_not_found' ? 404 : message.endsWith('_not_allowed') ? 403 : 400;
    return Response.json({ error: message, projectId: conversation.projectId }, { status });
  }
  const effectiveProjectId = conversation.projectId;
  const taskActor = actorToTaskActor(actor);
  const taskDefaults = taskDefaultsFromBody(
    { avatarId, projectId: effectiveProjectId, modelId: modelConfigId, permissionMode, targetSpace },
    avatarId,
  );
  const taskManager: ChatTaskManager = {
    list: async () =>
      withTaskService(async (service) => ({
        tasks: (await service.listTasks(taskActor)).map((task: ScheduledTaskRecord) => taskToJson(task)),
      })),
    create: async (input) =>
      withTaskService(async (service) => ({
        task: taskToJson(
          await service.createTask(
            taskActor,
            {
              name: typeof input.name === 'string' ? input.name : undefined,
              prompt: typeof input.prompt === 'string' ? input.prompt : '',
              cron: typeof input.cron === 'string' ? input.cron : '',
              timezone: typeof input.timezone === 'string' ? input.timezone : undefined,
              enabled: typeof input.enabled === 'boolean' ? input.enabled : undefined,
              projectId: taskStringField(input.projectId),
              conversationId: taskStringField(input.conversationId),
              modelConfigId: taskStringField(input.modelId),
              permissionMode: taskPermissionMode(input.permissionMode),
              targetSpace: typeof input.targetSpace === 'string' ? input.targetSpace : undefined,
            },
            taskDefaults,
          ),
        ),
      })),
    update: async (input) =>
      withTaskService(async (service) => ({
        task: taskToJson(
          await service.updateTask(taskActor, typeof input.id === 'string' ? input.id : '', {
            name: typeof input.name === 'string' ? input.name : undefined,
            prompt: typeof input.prompt === 'string' ? input.prompt : undefined,
            cron: typeof input.cron === 'string' ? input.cron : undefined,
            timezone: typeof input.timezone === 'string' ? input.timezone : undefined,
            enabled: typeof input.enabled === 'boolean' ? input.enabled : undefined,
            projectId: taskNullableStringField(input.projectId),
            conversationId: taskNullableStringField(input.conversationId),
            modelConfigId: taskNullableStringField(input.modelId),
            permissionMode: taskPermissionMode(input.permissionMode),
            targetSpace: taskNullableStringField(input.targetSpace),
          }),
        ),
      })),
    delete: async (input) =>
      withTaskService(async (service) => {
        await service.deleteTask(taskActor, typeof input.id === 'string' ? input.id : '');
        return { ok: true };
      }),
    runNow: async (input) =>
      withTaskService(async (service) => {
        const result = await service.runNow(taskActor, typeof input.id === 'string' ? input.id : '');
        return { task: taskToJson(result.task), run: taskRunToJson(result.run) };
      }),
  };

  // L2 conversation layer on the process-level shared store (one PG pool reused
  // across requests). History is server-owned: loaded from the store by
  // (channel, conversationId), so the client only needs to send the new turn.
  const sharedStore = await getSharedStore();
  const conversations = new ConversationService({ store: sharedStore });
  const systemPrompt = systemPromptWithRunControls(projectContext.systemPrompt, { runMode, skill: selectedSkill });
  const engineOverrides: EngineOverrides = {
    ...(disabledToolIds.length ? { disabledToolIds } : {}),
    ...(allowedSpaceIds ? { allowedSpaceIds } : {}),
    disableAllTools: runMode === 'plan',
    taskManager,
    ...(runMode === 'plan' || !selectedSkill ? {} : { temporarySkillIds: [selectedSkill.id] }),
  };
  const inbound: InboundMessage = {
    channel: webRun.channel,
    conversationId: runConversationId,
    kind: 'user',
    text: webRun.prompt,
    ...(attachments?.length ? { attachments } : {}),
    ...(displayAttachments?.length ? { displayAttachments } : {}),
    actor,
  };
  const baseHandleOptions: HandleOptions = {
    historySource: 'store',
    handleCommands: false,
    avatarId,
    systemPrompt,
    workspaceRoot: projectContext.workspaceRoot,
    engine: engineOverrides,
    ...(model ? { model } : {}),
    ...(runMode !== 'plan' && targetSpace ? { targetSpace } : {}),
  };
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (delta: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(delta)}\n\n`));
      const confirm = buildHttpApprovalConfirm({
        actor,
        avatarId,
        conversationId,
        decision: approvalDecision,
        permissionMode,
        send,
        signal: req.signal,
      });
      try {
        send({ type: 'workspace_context', workspaceRoot: projectContext.workspaceRoot });
        for await (const delta of conversations.handle(inbound, { ...baseHandleOptions, confirm, signal: req.signal })) {
          send(delta);
          if (delta.type === 'done' || delta.type === 'error') {
            break;
          }
        }
      } catch (error) {
        if (!req.signal.aborted) {
          send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
