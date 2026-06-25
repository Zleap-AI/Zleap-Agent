'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { motion } from 'framer-motion';
import { useDropzone } from 'react-dropzone';
import {
  ArrowUp,
  ArrowDown,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CornerDownLeft,
  FolderOpen,
  FolderPlus,
  Gauge,
  Image,
  ListChecks,
  Monitor,
  Paperclip,
  PauseCircle,
  PenLine,
  Pencil,
  PlayCircle,
  Plus,
  Puzzle,
  RefreshCw,
  Shield,
  ShieldCheck,
  Square,
  Target,
  Trash2,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { AvatarBadge, NAV_AVATAR_BADGE_PROPS } from './AvatarBadge';
import { parseAvatarTheme } from '@/lib/avatars';
import { webApiFetch } from '@/lib/api';
import {
  IMAGE_ATTACHMENT_LIMITS,
  createImageAttachmentId,
  fileToImageRequestAttachment,
  validateImageAttachmentFiles,
  type ChatImageRequestAttachment,
  type ImageAttachmentValidationError,
} from '@/lib/chatAttachments';
import { filterAgentMentions, filterComposerCommands, parseMention, parseSlashCommand, type ComposerCommandSearchInput } from '@/lib/composerCommands';
import { modelDisplayLabel } from '@/lib/models';
import { parseProjectTheme } from '@/lib/projects';
import { resolveSpaceIcon, type SpaceItem } from '@/lib/spaces';
import { isComposerCompositionKeyEvent } from '@/lib/composerKeyboard';
import type { ModelConfigView, SkillView } from '@/lib/useResources';
import type { ChatSendOptions, RunMode } from '@/lib/runModes';
import type { RunStatus } from '../lib/types';
import { DEFAULT_PERMISSION_MODE, type PermissionMode } from '../lib/permissions';
import { cn } from '@/lib/utils';
import type { ContextSnapshot } from '../lib/engine';
import type { PlanReplyPrompt } from '../lib/planOptions';
import { ContextInspectorChip } from './ContextInspector';
import { ProjectDialog } from './manage/ProjectDialog';
import { Switch } from './ui/switch';

type AgentOption = { id: string; name: string; metadata?: Record<string, unknown> };
type ProjectOption = { id: string; name: string; emoji?: string; accent?: string };
type CreatedProject = { id: string; name: string };
export type GoalComposerState = { text: string; status: 'active' | 'paused'; startedAt: number };

type ComposerProps = {
  status: RunStatus;
  /** `options.targetSpace` (when set via an @-mention) forces a deterministic dispatch to that space. */
  onSend: (text: string, options?: ChatSendOptions) => void;
  onStop: () => void;
  draftValue?: string;
  onDraftChange?: (text: string) => void;
  variant?: 'hero' | 'docked';
  showContextPickers?: boolean;
  agents?: AgentOption[];
  projects?: ProjectOption[];
  /** Work spaces an @-mention can drop a message straight into. */
  spaces?: SpaceItem[];
  models?: ModelConfigView[];
  skills?: SkillView[];
  agentId?: string;
  projectId?: string;
  modelId?: string;
  permissionMode?: PermissionMode;
  contextSnapshot?: ContextSnapshot | null;
  contextCompaction?: {
    status: 'idle' | 'running' | 'retrying' | 'failed';
    spaceId?: string;
    attempt?: number;
    maxAttempts?: number;
    message?: string;
  };
  runMode?: RunMode;
  selectedSkillId?: string;
  goal?: GoalComposerState;
  planReply?: PlanReplyPrompt;
  projectPickerPlacement?: 'toolbar' | 'below' | 'none';
  onAgentChange?: (id: string) => void;
  onProjectChange?: (id: string | undefined) => void;
  onProjectCreated?: (id: string) => void;
  onModelChange?: (id: string) => void;
  onPermissionModeChange?: (mode: PermissionMode) => void;
  onRunModeChange?: (mode: RunMode) => void;
  onSelectedSkillChange?: (id: string | undefined) => void;
  onGoalChange?: (text: string) => void;
  onGoalPause?: () => void;
  onGoalResume?: () => void;
  onGoalDelete?: () => void;
  onDismissPlanReply?: (messageId: string) => void;
};

type MentionItem = { kind: 'agent'; id: string; name: string; agent: AgentOption };

type ComposerCommand = ComposerCommandSearchInput & {
  icon: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  trailing?: string;
  run: () => void;
};

type RuntimeContextView = { mode: 'local'; availableModes?: ['local']; branch?: string };
type ComposerImageAttachment = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  previewUrl: string;
} & (
  | { status: 'pending' }
  | { status: 'ready'; attachment: ChatImageRequestAttachment }
  | { status: 'error'; message: string }
);
type ComposerAttachmentState = {
  items: ComposerImageAttachment[];
  pendingErrors: ImageAttachmentValidationError[];
};
type ComposerAttachmentAction =
  | { type: 'appendPending'; items: ComposerImageAttachment[]; errors?: ImageAttachmentValidationError[] }
  | { type: 'markReady'; id: string; attachment: ChatImageRequestAttachment }
  | { type: 'markError'; id: string; message: string }
  | { type: 'remove'; id: string }
  | { type: 'clear' }
  | { type: 'clearErrors' };

const initialAttachmentState: ComposerAttachmentState = {
  items: [],
  pendingErrors: [],
};

function composerAttachmentReducer(
  state: ComposerAttachmentState,
  action: ComposerAttachmentAction,
): ComposerAttachmentState {
  if (action.type === 'appendPending') {
    return {
      items: [...state.items, ...action.items],
      pendingErrors: [...state.pendingErrors, ...(action.errors ?? [])],
    };
  }
  if (action.type === 'markReady') {
    return {
      ...state,
      items: state.items.map((item) => (item.id === action.id ? { ...item, status: 'ready', attachment: action.attachment } : item)),
    };
  }
  if (action.type === 'markError') {
    return {
      ...state,
      items: state.items.map((item) => (item.id === action.id ? { ...item, status: 'error', message: action.message } : item)),
    };
  }
  if (action.type === 'remove') {
    return {
      ...state,
      items: state.items.filter((item) => item.id !== action.id),
    };
  }
  if (action.type === 'clear') {
    return initialAttachmentState;
  }
  if (action.type === 'clearErrors') {
    return state.pendingErrors.length === 0 ? state : { ...state, pendingErrors: [] };
  }
  return state;
}

const MAX_ROWS = 8;
const TOOLBAR_HOVER = 'transition-colors hover:bg-muted/70 hover:text-ink';
const TOOLBAR_HIT = 'h-7';
const TOOLBAR_ICON = 'size-4 shrink-0';
const TOOLBAR_ICON_BTN = `flex ${TOOLBAR_HIT} w-7 shrink-0 items-center justify-center rounded-pill text-muted-foreground ${TOOLBAR_HOVER}`;
const TOOLBAR_CHIP_BASE = `flex ${TOOLBAR_HIT} shrink-0 items-center gap-1 rounded-pill text-[11px] leading-none text-muted-foreground ${TOOLBAR_HOVER}`;
const TOOLBAR_DROPDOWN_CHIP = `${TOOLBAR_CHIP_BASE} px-1.5`;
const TOOLBAR_LABEL_CHIP = `${TOOLBAR_CHIP_BASE} max-w-[min(100%,160px)] px-2`;
const TOOLBAR_DROPDOWN_CHEVRON = 'size-2.5 shrink-0 opacity-50';
const TOOLBAR_ICON_SLOT = `flex ${TOOLBAR_ICON} items-center justify-center`;
const TOOLBAR_STOP_BTN = `${TOOLBAR_ICON_BTN} border border-border bg-surface text-muted-foreground shadow-xs hover:border-border-strong hover:bg-muted/70 hover:text-ink`;
const RUN_MODE_CYCLE: RunMode[] = ['normal', 'plan', 'goal'];
const RUN_MODE_SHORTCUT = 'Shift+Tab';
const TOOLBAR_AVATAR_PROPS = {
  className: 'size-4',
  letterClassName: 'text-[7px]',
  emojiClassName: 'text-[13px] leading-none',
} as const;

function numericModelConfig(model: ModelConfigView | undefined, key: string): number | undefined {
  const value = model?.config?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nextRunMode(mode: RunMode): RunMode {
  const index = RUN_MODE_CYCLE.indexOf(mode);
  return RUN_MODE_CYCLE[(index + 1) % RUN_MODE_CYCLE.length] ?? 'normal';
}

export function Composer({
  status,
  onSend,
  onStop,
  draftValue,
  onDraftChange,
  variant = 'docked',
  showContextPickers = false,
  agents = [],
  projects = [],
  spaces = [],
  models = [],
  skills = [],
  agentId,
  projectId,
  modelId,
  permissionMode = DEFAULT_PERMISSION_MODE,
  contextSnapshot = null,
  contextCompaction,
  runMode = 'normal',
  selectedSkillId,
  goal,
  planReply,
  projectPickerPlacement = 'toolbar',
  onAgentChange,
  onProjectChange,
  onProjectCreated,
  onModelChange,
  onPermissionModeChange,
  onRunModeChange,
  onSelectedSkillChange,
  onGoalChange,
  onGoalPause,
  onGoalResume,
  onGoalDelete,
  onDismissPlanReply,
}: ComposerProps) {
  const { t } = useTranslation();
  const controlledDraft = draftValue !== undefined;
  const [internalValue, setInternalValue] = useState('');
  const value = controlledDraft ? draftValue : internalValue;
  const setValue = useCallback(
    (next: string | ((previous: string) => string)) => {
      const resolved = typeof next === 'function' ? next(value) : next;
      if (!controlledDraft) {
        setInternalValue(resolved);
      }
      onDraftChange?.(resolved);
    },
    [controlledDraft, onDraftChange, value],
  );
  const [cursor, setCursor] = useState(0);
  const [focused, setFocused] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [slashIndex, setSlashIndex] = useState(0);
  const [dismissedMentionKey, setDismissedMentionKey] = useState<string | null>(null);
  const [dismissedSlashKey, setDismissedSlashKey] = useState<string | null>(null);
  const [contextInspectorOpen, setContextInspectorOpen] = useState(false);
  const [runtimeContext, setRuntimeContext] = useState<RuntimeContextView | null>(null);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  // An @-mentioned space: sticky until cleared, so follow-up turns keep going to
  // the same sub-space (deterministic dispatch decided by the user, not the LLM).
  const [targetSpaceId, setTargetSpaceId] = useState<string | undefined>(undefined);
  const [attachmentState, dispatchAttachments] = useReducer(composerAttachmentReducer, initialAttachmentState);
  const attachments = attachmentState.items;
  const readyAttachments = useMemo(
    () => attachments.flatMap((item) => (item.status === 'ready' ? [item.attachment] : [])),
    [attachments],
  );
  const attachmentsPreparing = attachments.some((item) => item.status === 'pending');
  const attachmentsFailed = attachments.some((item) => item.status === 'error');
  const targetSpace = spaces.find((s) => s.id === targetSpaceId);
  const selectedSkill = selectedSkillId ? skills.find((skill) => skill.id === selectedSkillId) : undefined;
  const compactionActive = contextCompaction?.status === 'running' || contextCompaction?.status === 'retrying' || contextCompaction?.status === 'failed';
  const compactionLabel = contextCompaction?.status === 'retrying'
    ? `正在压缩上下文 · 重试 ${contextCompaction.attempt ?? 1}/${contextCompaction.maxAttempts ?? 3}`
    : contextCompaction?.status === 'failed'
      ? '上下文压缩失败'
      : '正在压缩上下文';
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const openImagePickerRef = useRef<() => void>(() => undefined);
  const attachmentPreviewUrlsRef = useRef<Set<string>>(new Set());
  const composingRef = useRef(false);
  const compositionCommitGuardRef = useRef(false);
  const compositionCommitGuardTimerRef = useRef<number | null>(null);
  const running = status === 'running';
  const canSend = (value.trim().length > 0 || readyAttachments.length > 0) && !attachmentsPreparing && !attachmentsFailed;
  const hasGoal = Boolean(goal?.text.trim());
  const hero = variant === 'hero';
  const canSelectProject = showContextPickers && projectPickerPlacement !== 'none' && (projects.length > 0 || Boolean(onProjectCreated));
  const showAgentControls = showContextPickers && agents.length > 0;
  const showProjectToolbar = canSelectProject && projectPickerPlacement === 'toolbar';
  const showProjectBelow = canSelectProject && projectPickerPlacement === 'below';
  const resolvedAgentId = agentId ?? agents[0]?.id;
  const selectedAgent = agents.find((a) => a.id === resolvedAgentId) ?? agents[0];
  const selectedProject = projectId ? projects.find((p) => p.id === projectId) : undefined;
  const selectedModel = models.find((m) => m.id === modelId) ?? models[0];
  const modelLabel = selectedModel ? modelDisplayLabel(selectedModel) : t('chat.noModel');
  const selectedModelContextWindow = numericModelConfig(selectedModel, 'contextWindow');

  const mention = showContextPickers ? parseMention(value, cursor) : null;

  const mentionItems = useMemo((): MentionItem[] => {
    if (!mention) return [];
    return filterAgentMentions(agents, mention.query)
      .map((agent) => ({ kind: 'agent' as const, id: agent.id, name: agent.name, agent }));
  }, [mention, agents]);

  const mentionKey = mention ? `${mention.start}:${mention.query}` : null;
  const mentionOpen = mention !== null && mentionItems.length > 0 && mentionKey !== dismissedMentionKey;
  const slash = mention ? null : parseSlashCommand(value, cursor);
  const commands = useMemo((): ComposerCommand[] => {
    const items: ComposerCommand[] = [
      {
        id: 'normal',
        group: '模式',
        label: t('chat.normalMode', { defaultValue: '普通模式' }),
        description: t('chat.normalModeDesc', { defaultValue: '关闭计划/目标模式' }),
        keywords: ['default', 'mode'],
        icon: <PlayCircle className="size-4" strokeWidth={1.75} />,
        selected: runMode === 'normal',
        run: () => onRunModeChange?.('normal'),
      },
      {
        id: 'plan',
        group: '模式',
        label: t('chat.planMode', { defaultValue: '计划模式' }),
        description: t('chat.planModeDesc', { defaultValue: '先产出计划，不直接执行' }),
        keywords: ['mode'],
        icon: <ListChecks className="size-4" strokeWidth={1.75} />,
        selected: runMode === 'plan',
        run: () => onRunModeChange?.('plan'),
      },
      {
        id: 'goal',
        group: '模式',
        label: t('chat.goalMode', { defaultValue: '目标模式' }),
        description: t('chat.goalModeDesc', { defaultValue: '把下一条消息设为持续目标' }),
        keywords: ['mode'],
        icon: <Target className="size-4" strokeWidth={1.75} />,
        selected: runMode === 'goal',
        run: () => onRunModeChange?.('goal'),
      },
      {
        id: 'approval',
        group: '权限',
        label: t('chat.permission.approval'),
        description: t('chat.permission.approvalDesc'),
        keywords: ['permission', 'safe'],
        icon: <Shield className="size-4" strokeWidth={1.75} />,
        selected: permissionMode === 'request_approval',
        disabled: !onPermissionModeChange,
        run: () => onPermissionModeChange?.('request_approval'),
      },
      {
        id: 'full-access',
        group: '权限',
        label: t('chat.permission.full'),
        description: t('chat.permission.fullDesc'),
        keywords: ['permission'],
        icon: <ShieldCheck className="size-4" strokeWidth={1.75} />,
        selected: permissionMode === 'full_access',
        disabled: !onPermissionModeChange,
        run: () => onPermissionModeChange?.('full_access'),
      },
      {
        id: 'add-file',
        group: '工具',
        label: t('chat.addPhotoFile', { defaultValue: '添加照片和文件' }),
        description: t('chat.addFile'),
        keywords: ['file', 'attach'],
        icon: <Paperclip className="size-4" strokeWidth={1.75} />,
        run: () => openImagePickerRef.current(),
      },
      {
        id: 'context',
        group: '工具',
        label: t('chat.contextWindow', { defaultValue: '上下文窗口' }),
        description: t('chat.contextWindowDesc', { defaultValue: '查看当前装配给模型的上下文' }),
        keywords: ['inspector', 'tokens'],
        icon: <Gauge className="size-4" strokeWidth={1.75} />,
        run: () => setContextInspectorOpen(true),
      },
    ];

    if (targetSpace) {
      items.push({
        id: 'space-clear',
        group: '空间',
        label: t('chat.clearTargetSpace', { defaultValue: '清除目标空间' }),
        description: targetSpace.label,
        keywords: ['space'],
        icon: <X className="size-4" strokeWidth={1.75} />,
        run: () => setTargetSpaceId(undefined),
      });
    }
    for (const space of spaces) {
      if (space.kind !== 'work' || space.status !== 'ready') continue;
      const Icon = resolveSpaceIcon(space.icon);
      items.push({
        id: `space:${space.id}`,
        group: '空间',
        label: space.label,
        description: space.id,
        keywords: ['space', space.id],
        icon: <Icon className="size-4" style={{ color: space.accent }} strokeWidth={1.75} />,
        selected: targetSpaceId === space.id,
        run: () => setTargetSpaceId(space.id),
      });
    }

    if (selectedSkill) {
      items.push({
        id: 'skill-clear',
        group: '技能',
        label: t('chat.clearSkill', { defaultValue: '不使用技能' }),
        description: selectedSkill.label,
        keywords: ['skill'],
        icon: <X className="size-4" strokeWidth={1.75} />,
        run: () => onSelectedSkillChange?.(undefined),
      });
    }
    for (const skill of skills) {
      items.push({
        id: `skill:${skill.id}`,
        group: '技能',
        label: skill.label,
        description: skill.description,
        keywords: ['skill', skill.id],
        icon: <Puzzle className="size-4" strokeWidth={1.75} />,
        selected: selectedSkillId === skill.id,
        disabled: !onSelectedSkillChange,
        run: () => onSelectedSkillChange?.(skill.id),
      });
    }

    if (canSelectProject) {
      items.push({
        id: 'project-clear',
        group: '项目',
        label: t('chat.clearProject'),
        description: selectedProject?.name,
        keywords: ['project'],
        icon: <X className="size-4" strokeWidth={1.75} />,
        disabled: !onProjectChange,
        run: () => onProjectChange?.(undefined),
      });
      if (onProjectCreated) {
        items.push({
          id: 'project-create',
          group: '项目',
          label: t('project.create', { defaultValue: '新建项目' }),
          description: t('project.pathPlaceholder', { defaultValue: '选择一个项目目录' }),
          keywords: ['project', 'new'],
          icon: <FolderPlus className="size-4" strokeWidth={1.75} />,
          run: () => setProjectDialogOpen(true),
        });
      }
      for (const project of projects) {
        items.push({
          id: `project:${project.id}`,
          group: '项目',
          label: project.name,
          description: project.id,
          keywords: ['project', project.id],
          icon: <FolderOpen className="size-4" strokeWidth={1.75} />,
          selected: projectId === project.id,
          disabled: !onProjectChange,
          run: () => onProjectChange?.(project.id),
        });
      }
    }

    for (const model of models) {
      const label = modelDisplayLabel(model);
      items.push({
        id: `model:${model.id}`,
        group: '模型',
        label,
        description: model.id,
        keywords: ['model', model.id],
        icon: <Monitor className="size-4" strokeWidth={1.75} />,
        selected: modelId === model.id,
        disabled: !onModelChange,
        run: () => onModelChange?.(model.id),
      });
    }
    return items;
  }, [
    canSelectProject,
    modelId,
    models,
    onModelChange,
    onPermissionModeChange,
    onProjectChange,
    onProjectCreated,
    onRunModeChange,
    onSelectedSkillChange,
    permissionMode,
    projectId,
    projects,
    runMode,
    selectedProject?.name,
    selectedSkill,
    selectedSkillId,
    skills,
    spaces,
    t,
    targetSpace,
    targetSpaceId,
  ]);
  const commandItems = useMemo(() => filterComposerCommands(commands, slash?.query ?? ''), [commands, slash?.query]);
  const slashKey = slash ? `${slash.start}:${slash.query}` : null;
  const slashOpen = slash !== null && commandItems.length > 0 && slashKey !== dismissedSlashKey;

  useEffect(() => {
    if (hero) textareaRef.current?.focus();
  }, [hero]);

  useEffect(() => {
    return () => {
      if (compositionCommitGuardTimerRef.current) {
        window.clearTimeout(compositionCommitGuardTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!showContextPickers || agents.length === 0 || agentId) return;
    onAgentChange?.(agents[0]!.id);
  }, [showContextPickers, agents, agentId, onAgentChange]);

  useEffect(() => {
    if (!showProjectBelow) return;
    let cancelled = false;
    void webApiFetch('/api/runtime/context')
      .then(async (response) => {
        if (!response.ok) return null;
        return (await response.json()) as RuntimeContextView;
      })
      .then((context) => {
        if (!cancelled && context?.mode === 'local') {
          setRuntimeContext(context);
        }
      })
      .catch(() => {
        if (!cancelled) setRuntimeContext(null);
      });
    return () => {
      cancelled = true;
    };
  }, [showProjectBelow]);

  useEffect(() => {
    setMentionIndex(0);
    if (!mentionKey) {
      setDismissedMentionKey(null);
    }
  }, [mentionKey, mentionItems.length]);

  useEffect(() => {
    setSlashIndex(0);
    if (!slashKey) {
      setDismissedSlashKey(null);
    }
  }, [slashKey, commandItems.length]);

  useEffect(() => {
    if (!mentionOpen && !slashOpen) return;

    const dismissOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' && event.key !== 'Esc') return;
      event.preventDefault();
      event.stopPropagation();
      if (slashOpen) {
        setDismissedSlashKey(slashKey);
      }
      if (mentionOpen) {
        setDismissedMentionKey(mentionKey);
      }
      textareaRef.current?.focus();
    };

    window.addEventListener('keydown', dismissOnEscape, true);
    return () => window.removeEventListener('keydown', dismissOnEscape, true);
  }, [mentionKey, mentionOpen, slashKey, slashOpen]);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const lineHeight = 24;
    const max = lineHeight * MAX_ROWS;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [value]);

  const applyMention = (item: MentionItem) => {
    if (!mention) return;
    const el = textareaRef.current;
    const end = el?.selectionStart ?? cursor;
    const next = `${value.slice(0, mention.start)}${value.slice(end)}`;
    setValue(next);
    setCursor(mention.start);
    onAgentChange?.(item.id);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(mention.start, mention.start);
    });
  };

  const applySlashCommand = (command: ComposerCommand) => {
    if (!slash || command.disabled) return;
    const el = textareaRef.current;
    const end = el?.selectionStart ?? cursor;
    const next = `${value.slice(0, slash.start)}${value.slice(end)}`;
    setValue(next);
    setCursor(slash.start);
    setDismissedSlashKey(null);
    command.run();
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(slash.start, slash.start);
    });
  };

  const sendText = (text: string, options?: ChatSendOptions): boolean => {
    const hasAttachments = (options?.attachments?.length ?? 0) > 0;
    if ((!text && !hasAttachments) || running) return false;
    if (showContextPickers && agents.length > 0 && !resolvedAgentId) return false;
    if (showContextPickers && resolvedAgentId && resolvedAgentId !== agentId) {
      onAgentChange?.(resolvedAgentId);
    }
    onSend(text, {
      targetSpace: targetSpaceId,
      runMode,
      ...(selectedSkill ? { skillId: selectedSkill.id, skillLabel: selectedSkill.label } : {}),
      ...options,
    });
    if (options?.runMode === 'normal' && runMode !== 'normal') {
      onRunModeChange?.('normal');
    }
    textareaRef.current?.focus();
    return true;
  };

  const showAttachmentErrors = useCallback((errors: ImageAttachmentValidationError[]) => {
    for (const error of errors) {
      const label = error.fileName || t('chat.imageAttachmentFallbackName', { defaultValue: '图片' });
      if (error.code === 'unsupported_type') {
        toast.error(t('chat.imageUnsupported', { defaultValue: `不支持的图片类型：${label}` }));
      }
      if (error.code === 'too_large') {
        toast.error(t('chat.imageTooLarge', { defaultValue: `图片超过 10 MB：${label}` }));
      }
      if (error.code === 'too_many') {
        toast.error(t('chat.imageTooMany', { defaultValue: '每条消息最多添加 4 张图片' }));
      }
    }
  }, [t]);

  useEffect(() => {
    const errors = attachmentState.pendingErrors;
    if (errors.length === 0) return;
    showAttachmentErrors(errors);
    dispatchAttachments({ type: 'clearErrors' });
  }, [attachmentState.pendingErrors, showAttachmentErrors]);

  const revokeAttachmentPreviewUrl = useCallback((url: string) => {
    URL.revokeObjectURL(url);
    attachmentPreviewUrlsRef.current.delete(url);
  }, []);

  const clearAttachmentPreviews = useCallback(() => {
    for (const url of attachmentPreviewUrlsRef.current) {
      URL.revokeObjectURL(url);
    }
    attachmentPreviewUrlsRef.current.clear();
  }, []);

  useEffect(() => () => clearAttachmentPreviews(), [clearAttachmentPreviews]);

  const removeAttachment = useCallback((id: string) => {
    const item = attachments.find((attachment) => attachment.id === id);
    if (item) {
      revokeAttachmentPreviewUrl(item.previewUrl);
    }
    dispatchAttachments({ type: 'remove', id });
  }, [attachments, revokeAttachmentPreviewUrl]);

  const clearAttachments = useCallback(() => {
    clearAttachmentPreviews();
    dispatchAttachments({ type: 'clear' });
  }, [clearAttachmentPreviews]);

  const addImageFiles = async (files: File[]) => {
    const validation = validateImageAttachmentFiles(files, attachments.length);
    if (validation.files.length === 0) {
      dispatchAttachments({ type: 'appendPending', items: [], errors: validation.errors });
      return;
    }
    const pendingItems = validation.files.map((file): ComposerImageAttachment => {
      const id = createImageAttachmentId();
      const previewUrl = URL.createObjectURL(file);
      attachmentPreviewUrlsRef.current.add(previewUrl);
      return {
        id,
        name: file.name || t('chat.imageAttachmentFallbackName', { defaultValue: '图片' }),
        mimeType: file.type,
        sizeBytes: file.size,
        previewUrl,
        status: 'pending',
      };
    });
    dispatchAttachments({ type: 'appendPending', items: pendingItems, errors: validation.errors });
    await Promise.all(
      pendingItems.map(async (item, index) => {
        const file = validation.files[index];
        if (!file) return;
        try {
          const attachment = await fileToImageRequestAttachment(file, item.id);
          dispatchAttachments({ type: 'markReady', id: item.id, attachment });
        } catch {
          dispatchAttachments({
            type: 'markError',
            id: item.id,
            message: t('chat.imageReadFailed', { defaultValue: '读取图片失败' }),
          });
        }
      }),
    );
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const {
    getRootProps,
    getInputProps,
    open: openImagePicker,
    isDragActive,
  } = useDropzone({
    accept: {
      'image/png': ['.png'],
      'image/jpeg': ['.jpg', '.jpeg'],
      'image/webp': ['.webp'],
    },
    multiple: true,
    noClick: true,
    noKeyboard: true,
    maxSize: IMAGE_ATTACHMENT_LIMITS.maxBytes,
    onDrop: (acceptedFiles, fileRejections) => {
      const rejectedFiles = fileRejections.map((rejection) => rejection.file);
      void addImageFiles([...acceptedFiles, ...rejectedFiles]);
    },
  });
  openImagePickerRef.current = openImagePicker;

  const imageFilesFromClipboard = (items: DataTransferItemList | undefined): File[] => {
    return Array.from(items ?? [])
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
  };

  const submit = () => {
    const text = value.trim();
    if (attachmentsPreparing) {
      toast.message(t('chat.imagePreparing', { defaultValue: '图片正在准备中' }));
      return;
    }
    if (attachmentsFailed) {
      toast.error(t('chat.imageFailedRemove', { defaultValue: '请先移除读取失败的图片' }));
      return;
    }
    if (!text && readyAttachments.length === 0) return;
    if (sendText(text, { attachments: readyAttachments })) {
      setValue('');
      clearAttachments();
    }
  };

  const onPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const files = imageFilesFromClipboard(event.clipboardData?.items);
    if (files.length === 0) return;
    event.preventDefault();
    void addImageFiles(files);
  };

  const insertNewline = () => {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? cursor;
    const end = el?.selectionEnd ?? cursor;
    const next = `${value.slice(0, start)}\n${value.slice(end)}`;
    const nextCursor = start + 1;
    setValue(next);
    setCursor(nextCursor);
    requestAnimationFrame(() => {
      const active = textareaRef.current;
      if (!active) return;
      active.focus();
      active.setSelectionRange(nextCursor, nextCursor);
    });
  };

  const startComposition = () => {
    composingRef.current = true;
    compositionCommitGuardRef.current = false;
    if (compositionCommitGuardTimerRef.current) {
      window.clearTimeout(compositionCommitGuardTimerRef.current);
      compositionCommitGuardTimerRef.current = null;
    }
  };

  const endComposition = () => {
    composingRef.current = false;
    compositionCommitGuardRef.current = true;
    if (compositionCommitGuardTimerRef.current) {
      window.clearTimeout(compositionCommitGuardTimerRef.current);
    }
    compositionCommitGuardTimerRef.current = window.setTimeout(() => {
      compositionCommitGuardRef.current = false;
      compositionCommitGuardTimerRef.current = null;
    }, 30);
  };

  const isComposingKeyEvent = (event: ReactKeyboardEvent<HTMLTextAreaElement>) =>
    isComposerCompositionKeyEvent(event, {
      composing: composingRef.current,
      commitGuard: compositionCommitGuardRef.current,
    });

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposingKeyEvent(event)) return;

    if (mentionOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setMentionIndex((i) => (i + 1) % mentionItems.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setMentionIndex((i) => (i - 1 + mentionItems.length) % mentionItems.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const item = mentionItems[mentionIndex];
        if (item) applyMention(item);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissedMentionKey(mentionKey);
        return;
      }
    }
    if (slashOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSlashIndex((i) => (i + 1) % commandItems.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSlashIndex((i) => (i - 1 + commandItems.length) % commandItems.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        event.stopPropagation();
        const command = commandItems[slashIndex];
        if (command) applySlashCommand(command);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissedSlashKey(slashKey);
        return;
      }
    }
    if (event.key === 'Tab' && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      onRunModeChange?.(nextRunMode(runMode));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      if (event.metaKey || event.ctrlKey) {
        insertNewline();
      } else {
        submit();
      }
    }
  };

  const agentTheme = selectedAgent ? parseAvatarTheme(selectedAgent.metadata) : undefined;
  const projectTheme = selectedProject ? parseProjectTheme(selectedProject) : undefined;
  const handleProjectSaved = (project: CreatedProject) => {
    onProjectChange?.(project.id);
    onProjectCreated?.(project.id);
  };

  return (
    <>
    <div className={hero ? '' : 'shrink-0 px-4 pb-6 pt-2'}>
      <div className="relative mx-auto w-full max-w-3xl">
        {mentionOpen ? (
          <div className="absolute bottom-full left-0 right-0 z-50 mb-2" onMouseDown={(e) => e.preventDefault()}>
            <MentionMenu items={mentionItems} activeIndex={mentionIndex} onPick={applyMention} onHover={setMentionIndex} />
          </div>
        ) : null}
        {slashOpen ? (
          <div className="absolute bottom-full left-0 right-0 z-50 mb-2" onMouseDown={(e) => e.preventDefault()}>
            <ComposerCommandMenu items={commandItems} activeIndex={slashIndex} onPick={applySlashCommand} onHover={setSlashIndex} />
          </div>
        ) : null}

        <div
          {...getRootProps({
            className: 'relative z-10 overflow-hidden rounded-xl border bg-surface transition-[box-shadow,border-color,background-color] duration-300 ease-out',
            style: {
              borderColor: focused || isDragActive ? 'var(--border-strong)' : 'var(--border)',
              boxShadow: focused || isDragActive ? 'var(--shadow), 0 0 0 4px var(--accent-glow)' : 'var(--shadow-sm)',
            },
          })}
        >
          <input {...getInputProps()} />
          {planReply ? (
            <PlanReplyComposer
              prompt={planReply}
              running={running}
              onSubmit={sendText}
              onDismiss={(messageId) => onDismissPlanReply?.(messageId)}
            />
          ) : (
            <div className={hero ? 'px-3.5 pb-2.5 pt-4' : 'px-3 pb-2 pt-3'}>
              {goal ? (
                <GoalHeader
                  goal={goal}
                  onChange={onGoalChange}
                  onPause={onGoalPause}
                  onResume={onGoalResume}
                  onDelete={onGoalDelete}
                />
              ) : null}
              {targetSpace ? (
                <div className="mb-1.5 flex px-1">
                  <span
                    className="inline-flex h-6 items-center gap-1.5 rounded-pill border border-border bg-surface-2/60 pl-2 pr-1.5 text-[12px] text-ink"
                    title={t('chat.targetSpaceHint', { defaultValue: 'Messages go straight to this space' })}
                  >
                    {(() => {
                      const Icon = resolveSpaceIcon(targetSpace.icon);
                      return <Icon className="size-3.5" style={{ color: targetSpace.accent }} />;
                    })()}
                    <span className="font-medium">{targetSpace.label}</span>
                    <button
                      type="button"
                      onClick={() => setTargetSpaceId(undefined)}
                      className="rounded-xs opacity-60 transition hover:opacity-100"
                      aria-label={t('chat.clearTargetSpace', { defaultValue: 'Clear target space' })}
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                </div>
              ) : null}
              {attachments.length ? (
                <div className="mb-2 flex flex-wrap gap-2 px-1">
                  {attachments.map((attachment) => (
                    <div key={attachment.id} className="group relative h-16 w-16 overflow-hidden rounded-md border border-border bg-muted">
                      <img src={attachment.previewUrl} alt={attachment.name} className="h-full w-full object-cover" />
                      {attachment.status === 'pending' ? (
                        <div className="absolute inset-0 flex items-center justify-center bg-background/60 text-[11px] font-medium text-muted-foreground backdrop-blur-[1px]">
                          {t('chat.imagePreparingShort', { defaultValue: '准备中' })}
                        </div>
                      ) : null}
                      {attachment.status === 'error' ? (
                        <div className="absolute inset-0 flex items-center justify-center bg-destructive/85 px-1 text-center text-[11px] font-medium leading-4 text-destructive-foreground">
                          {t('chat.imageFailedShort', { defaultValue: '失败' })}
                        </div>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => removeAttachment(attachment.id)}
                        className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-background/90 text-muted-foreground opacity-0 shadow-sm transition hover:text-ink group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                        aria-label={t('chat.removeImageAttachment', { defaultValue: '移除图片' })}
                      >
                        <X className="size-3" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              {isDragActive ? (
                <div className="mb-2 flex items-center gap-1.5 px-1 text-[12px] text-muted-foreground">
                  <Image className="size-3.5" strokeWidth={1.75} />
                  <span>{t('chat.dropImagesHere', { defaultValue: '松开以添加图片' })}</span>
                </div>
              ) : null}
              <textarea
                ref={textareaRef}
                rows={1}
                value={value}
                onChange={(event) => {
                  setValue(event.target.value);
                  setCursor(event.target.selectionStart);
                }}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
                onCompositionStart={startComposition}
                onCompositionEnd={endComposition}
                onKeyUp={(event) => setCursor(event.currentTarget.selectionStart)}
                onClick={(event) => setCursor(event.currentTarget.selectionStart)}
                onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                placeholder={hasGoal ? t('chat.goalFollowupPlaceholder', { defaultValue: '要求后续变更' }) : t('chat.placeholder')}
                className={
                  hero
                    ? 'no-scrollbar max-h-48 w-full resize-none bg-transparent px-2 py-1 text-base leading-7 text-ink placeholder:text-muted-foreground/55 outline-hidden'
                    : 'no-scrollbar max-h-48 w-full resize-none bg-transparent px-2 py-1 text-[15px] leading-6 text-ink placeholder:text-muted-foreground/55 outline-hidden'
                }
              />

              <div className="mt-1 flex items-center gap-0.5 px-1">
                <div className="flex items-center gap-0.5">
                  <ComposerActionMenu
                    runMode={runMode}
                    onRunModeChange={(next) => onRunModeChange?.(runMode === next ? 'normal' : next)}
                    skills={skills}
                    selectedSkill={selectedSkill}
                    onSkillChange={onSelectedSkillChange ?? (() => undefined)}
                    onAddFiles={openImagePicker}
                  />

                  <PermissionModeChip
                    mode={permissionMode}
                    onChange={onPermissionModeChange}
                  />

                  {compactionActive ? (
                    <span
                      className={cn(
                        TOOLBAR_LABEL_CHIP,
                        'max-w-[220px] bg-amber-50 text-amber-700 hover:bg-amber-50 hover:text-amber-700',
                        contextCompaction?.status === 'failed' && 'bg-destructive/10 text-destructive hover:bg-destructive/10 hover:text-destructive',
                      )}
                      title={contextCompaction?.message}
                    >
                      <RefreshCw className={cn(TOOLBAR_ICON, contextCompaction?.status !== 'failed' && 'animate-spin')} strokeWidth={1.75} />
                      <span className="truncate">{compactionLabel}</span>
                    </span>
                  ) : null}

                  {runMode !== 'normal' ? (
                    <ComposerStatusChip
                      icon={runMode === 'plan' ? <ListChecks className={TOOLBAR_ICON} strokeWidth={1.75} /> : <Target className={TOOLBAR_ICON} strokeWidth={1.75} />}
                      label={
                        runMode === 'plan'
                          ? t('chat.planShort', { defaultValue: '计划' })
                          : t('chat.goalShort', { defaultValue: '目标' })
                      }
                      title={`${RUN_MODE_SHORTCUT} ${t('chat.runModeShortcutHint', { defaultValue: '切换模式' })}`}
                      onClear={() => onRunModeChange?.('normal')}
                    />
                  ) : null}

                  {selectedSkill ? (
                    <ComposerStatusChip
                      icon={<Puzzle className={TOOLBAR_ICON} strokeWidth={1.75} />}
                      label={selectedSkill.label}
                      onClear={() => onSelectedSkillChange?.(undefined)}
                    />
                  ) : null}

                  {showAgentControls && selectedAgent ? (
                    <ContextChip
                      variant="icon"
                      label=""
                      ariaLabel={selectedAgent.name}
                      leading={
                        <AvatarBadge
                          name={selectedAgent.name}
                          emoji={agentTheme?.emoji}
                          accent={agentTheme?.accent ?? ''}
                          {...TOOLBAR_AVATAR_PROPS}
                        />
                      }
                      options={agents.map((a) => ({ id: a.id, name: a.name, agent: a }))}
                      selectedId={resolvedAgentId}
                      onSelect={(id) => onAgentChange?.(id)}
                      align="start"
                      renderOptionLeading={(option) => {
                        const theme = parseAvatarTheme(option.agent?.metadata);
                        return (
                          <AvatarBadge
                            name={option.name}
                            emoji={theme.emoji}
                            accent={theme.accent}
                            {...TOOLBAR_AVATAR_PROPS}
                          />
                        );
                      }}
                    />
                  ) : null}

                  {showProjectToolbar ? (
                    <ProjectPickerChip
                      selectedProject={selectedProject}
                      projects={projects}
                      projectId={projectId}
                      onProjectChange={onProjectChange}
                      onCreateProject={() => setProjectDialogOpen(true)}
                      label={selectedProject?.name ?? ''}
                      variant="icon"
                      align="start"
                    />
                  ) : null}
                </div>

                <div className="ml-auto flex items-center gap-0.5">
                  <ContextInspectorChip
                    snapshot={contextSnapshot}
                    model={{
                      id: selectedModel?.id,
                      label: modelLabel,
                      contextWindow: selectedModelContextWindow,
                    }}
                    variant="composer"
                    open={contextInspectorOpen}
                    onOpenChange={setContextInspectorOpen}
                  />

                  {models.length > 0 ? (
                    <ContextChip
                      variant="label"
                      label={modelLabel}
                      options={models.map((m) => ({ id: m.id, name: modelDisplayLabel(m) }))}
                      selectedId={modelId ?? selectedModel?.id}
                      onSelect={(id) => onModelChange?.(id)}
                      align="end"
                    />
                  ) : null}

                  {running ? (
                    <motion.button
                      type="button"
                      onClick={onStop}
                      whileHover={{ scale: 1.04 }}
                      whileTap={{ scale: 0.94 }}
                      className={TOOLBAR_STOP_BTN}
                      title="Stop"
                      aria-label="Stop"
                    >
                      <Square className="size-3 fill-current" />
                    </motion.button>
                  ) : (
                    <motion.button
                      type="button"
                      onClick={submit}
                      disabled={!canSend}
                      initial={false}
                      animate={canSend ? { scale: 1, opacity: 1 } : { scale: 0.94, opacity: 0.45 }}
                      whileHover={canSend ? { scale: 1.04 } : undefined}
                      whileTap={canSend ? { scale: 0.94 } : undefined}
                      transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                      className={`flex ${TOOLBAR_HIT} w-7 shrink-0 items-center justify-center rounded-pill bg-accent-grad text-white shadow-sm disabled:cursor-not-allowed`}
                      title="Send"
                      aria-label="Send"
                    >
                      <ArrowUp className={TOOLBAR_ICON} strokeWidth={2.5} />
                    </motion.button>
                  )}
                </div>
              </div>
	            </div>
	          )}
          {showProjectBelow ? (
            <div className="flex min-h-10 items-center gap-4 border-t border-border/45 bg-muted/20 px-3 py-2">
              <ProjectPickerChip
                selectedProject={selectedProject}
                projects={projects}
                projectId={projectId}
                onProjectChange={onProjectChange}
                onCreateProject={() => setProjectDialogOpen(true)}
                label={selectedProject?.name ?? t('chat.enterProjectWork')}
                variant="label"
                align="start"
                className="max-w-[min(48%,260px)] bg-transparent px-0 !text-[14px] text-muted-foreground shadow-none hover:bg-muted/70"
              />
              {runtimeContext?.mode === 'local' ? (
                <span
                  className={`${TOOLBAR_LABEL_CHIP} bg-transparent px-0 !text-[14px] text-muted-foreground shadow-none`}
                  title={runtimeContext.branch ? `${t('chat.localMode')} · ${runtimeContext.branch}` : t('chat.localMode')}
                >
                  <Monitor className={`${TOOLBAR_ICON} opacity-70`} strokeWidth={1.75} />
                  <span className="truncate">{t('chat.localMode')}</span>
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
    <ProjectDialog open={projectDialogOpen} onOpenChange={setProjectDialogOpen} onSaved={handleProjectSaved} />
    </>
  );
}

function GoalHeader({
  goal,
  onChange,
  onPause,
  onResume,
  onDelete,
}: {
  goal: GoalComposerState;
  onChange?: (text: string) => void;
  onPause?: () => void;
  onResume?: () => void;
  onDelete?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(goal.text);
  const elapsedLabel = useGoalElapsedLabel(goal);

  useEffect(() => {
    if (!editing) setDraft(goal.text);
  }, [editing, goal.text]);

  const save = () => {
    const next = draft.trim();
    setEditing(false);
    if (!next) {
      onDelete?.();
      return;
    }
    if (next !== goal.text) onChange?.(next);
  };

  const cancel = () => {
    setDraft(goal.text);
    setEditing(false);
  };

  return (
    <div className="mb-2 rounded-xl border border-border bg-surface px-3 py-2 shadow-xs">
      <div className="flex min-h-7 items-center gap-2">
        <Target className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
        <span className="shrink-0 text-[13px] font-medium text-ink">
          {goal.status === 'paused' ? '已暂停的目标' : '进行中的目标'}
        </span>
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={save}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                save();
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                cancel();
              }
            }}
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-[13px] text-ink outline-hidden focus:border-border-strong"
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="min-w-0 flex-1 truncate text-left text-[13px] text-muted-foreground transition hover:text-ink"
            title={goal.text}
          >
            {goal.text}
          </button>
        )}
        {!editing ? <span className="shrink-0 text-[13px] text-muted-foreground">· {elapsedLabel}</span> : null}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="flex size-7 items-center justify-center rounded-sm text-muted-foreground transition hover:bg-surface-2 hover:text-ink"
            title="编辑目标"
            aria-label="编辑目标"
          >
            <Pencil className="size-3.5" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            onClick={goal.status === 'paused' ? onResume : onPause}
            className="flex size-7 items-center justify-center rounded-sm text-muted-foreground transition hover:bg-surface-2 hover:text-ink"
            title={goal.status === 'paused' ? '继续执行目标' : '暂停执行目标'}
            aria-label={goal.status === 'paused' ? '继续执行目标' : '暂停执行目标'}
          >
            {goal.status === 'paused' ? <PlayCircle className="size-3.5" strokeWidth={1.75} /> : <PauseCircle className="size-3.5" strokeWidth={1.75} />}
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="flex size-7 items-center justify-center rounded-sm text-muted-foreground transition hover:bg-red-50 hover:text-red-600"
            title="删除目标"
            aria-label="删除目标"
          >
            <Trash2 className="size-3.5" strokeWidth={1.75} />
          </button>
        </div>
      </div>
    </div>
  );
}

function useGoalElapsedLabel(goal: GoalComposerState): string {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (goal.status !== 'active') return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [goal.status, goal.startedAt]);

  if (goal.status === 'paused') return '已暂停';
  return formatElapsed(now - goal.startedAt);
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

function PlanReplyComposer({
  prompt,
  running,
  onSubmit,
  onDismiss,
}: {
  prompt: PlanReplyPrompt;
  running: boolean;
  onSubmit: (text: string, options?: ChatSendOptions) => boolean;
  onDismiss: (messageId: string) => void;
}) {
  const [customText, setCustomText] = useState('');
  const [questionIndex, setQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState<PlanReplyAnswer[]>([]);
  const [selectedOptionId, setSelectedOptionId] = useState(() => prompt.questions[0]?.options[0]?.id);
  const composingRef = useRef(false);
  const compositionCommitGuardRef = useRef(false);
  const compositionCommitGuardTimerRef = useRef<number | null>(null);
  const currentQuestion = prompt.questions[questionIndex];
  const selectedOption = currentQuestion?.options.find((option) => option.id === selectedOptionId) ?? currentQuestion?.options[0];
  const canSubmitCustom = customText.trim().length > 0;
  const hasQuestions = prompt.questions.length > 0;
  const showQuestionCount = prompt.questions.length > 1;
  const lastQuestion = questionIndex >= prompt.questions.length - 1;

  useEffect(() => {
    setCustomText('');
    setQuestionIndex(0);
    setAnswers([]);
    setSelectedOptionId(prompt.questions[0]?.options[0]?.id);
  }, [prompt.messageId]);

  useEffect(() => {
    return () => {
      if (compositionCommitGuardTimerRef.current) {
        window.clearTimeout(compositionCommitGuardTimerRef.current);
      }
    };
  }, []);

  const startComposition = () => {
    composingRef.current = true;
    compositionCommitGuardRef.current = false;
    if (compositionCommitGuardTimerRef.current) {
      window.clearTimeout(compositionCommitGuardTimerRef.current);
      compositionCommitGuardTimerRef.current = null;
    }
  };

  const endComposition = () => {
    composingRef.current = false;
    compositionCommitGuardRef.current = true;
    if (compositionCommitGuardTimerRef.current) {
      window.clearTimeout(compositionCommitGuardTimerRef.current);
    }
    compositionCommitGuardTimerRef.current = window.setTimeout(() => {
      compositionCommitGuardRef.current = false;
      compositionCommitGuardTimerRef.current = null;
    }, 30);
  };

  const submitCustom = () => {
    const text = customText.trim();
    if (!text || running) return;
    if (currentQuestion) {
      submitQuestionAnswer({
        question: currentQuestion.question,
        label: `其它要求: ${text}`,
      });
      return;
    }
    if (onSubmit(`其它要求: ${text}`)) {
      setCustomText('');
    }
  };

  const submitQuestionAnswer = (answer: PlanReplyAnswer) => {
    if (running) return;
    const nextAnswers = [...answers.slice(0, questionIndex), answer];
    if (!lastQuestion) {
      const nextIndex = questionIndex + 1;
      setAnswers(nextAnswers);
      setQuestionIndex(nextIndex);
      setSelectedOptionId(prompt.questions[nextIndex]?.options[0]?.id);
      setCustomText('');
      return;
    }
    const response = formatPlanQuestionAnswers(nextAnswers);
    if (onSubmit(response)) {
      setCustomText('');
    }
  };

  const submitPrimary = () => {
    if (running) return;
    if (selectedOption) {
      submitQuestionAnswer({
        question: currentQuestion?.question ?? '',
        optionId: selectedOption.id,
        label: selectedOption.label,
      });
      return;
    }
    if (!hasQuestions && prompt.needsExecuteConfirmation) {
      onSubmit('执行', { runMode: 'normal' });
    }
  };

  return (
    <div className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-4">
        <div className="min-w-0 text-[15px] font-semibold leading-6 text-ink">
          {currentQuestion?.question ?? '是否按这个计划继续执行？'}
        </div>
        {showQuestionCount ? (
          <div className="flex shrink-0 items-center gap-2 text-[13px] text-muted-foreground">
            <ChevronLeft className="size-4" strokeWidth={1.75} />
            <span>{questionIndex + 1} of {prompt.questions.length}</span>
            <ChevronRight className="size-4" strokeWidth={1.75} />
          </div>
        ) : null}
      </div>

      {currentQuestion ? (
        <div className="px-3 py-2">
          {currentQuestion.options.map((option, index) => {
            const selected = option.id === selectedOption?.id;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => setSelectedOptionId(option.id)}
                className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-[14px] leading-5 transition ${
                  selected ? 'bg-surface-2 text-ink' : 'text-ink hover:bg-surface-2/70'
                }`}
              >
                <span
                  className={`flex size-6 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold ${
                    selected ? 'bg-ink text-surface' : 'bg-surface-2 text-muted-foreground'
                  }`}
                >
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1">
                  {option.label}
                  {option.recommended ? <span className="ml-1 text-muted-foreground">(Recommended)</span> : null}
                </span>
                {selected ? (
                  <span className="ml-auto flex shrink-0 items-center gap-1 text-muted-foreground/65">
                    <ArrowUp className="size-3.5" strokeWidth={1.8} />
                    <ArrowDown className="size-3.5" strokeWidth={1.8} />
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}

      <form
        className="flex items-center gap-2 border-t border-border bg-surface py-3 pl-6 pr-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmitCustom) submitCustom();
          else submitPrimary();
        }}
      >
        <PenLine className="size-5 shrink-0 rounded-full border border-border bg-surface-2 p-1 text-muted-foreground" strokeWidth={1.75} />
        <input
          value={customText}
          onChange={(event) => setCustomText(event.target.value)}
          onCompositionStart={startComposition}
          onCompositionEnd={endComposition}
          onKeyDown={(event) => {
            if (isComposerCompositionKeyEvent(event, {
              composing: composingRef.current,
              commitGuard: compositionCommitGuardRef.current,
            })) {
              return;
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              onDismiss(prompt.messageId);
            }
          }}
          placeholder="否，请告知Zleap如何调整"
          className="h-8 min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-hidden placeholder:text-muted-foreground/70"
        />
        <span className="ml-auto" />
        <button
          type="button"
          onClick={() => onDismiss(prompt.messageId)}
          className="hidden shrink-0 px-1 text-[12px] leading-none text-muted-foreground transition hover:text-ink sm:inline"
        >
          忽略&nbsp;<kbd className="rounded-sm bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-ink">ESC</kbd>
        </button>
        <button
          type="submit"
          disabled={running || (!canSubmitCustom && hasQuestions && !selectedOption)}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-pill bg-[#2f8cff] px-4 text-[13px] font-semibold text-white shadow-xs transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {canSubmitCustom ? '发送' : '继续'}
          <CornerDownLeft className="size-3.5" strokeWidth={2} />
        </button>
      </form>
    </div>
  );
}

type PlanReplyAnswer = {
  question: string;
  optionId?: string;
  label: string;
};

function formatPlanQuestionAnswers(answers: PlanReplyAnswer[]): string {
  return [
    '计划问题回答:',
    ...answers.map((answer, index) => {
      const selected = answer.optionId ? `${answer.optionId}. ${answer.label}` : answer.label;
      return `${index + 1}. ${answer.question}\n   ${selected}`;
    }),
  ].join('\n');
}

function PermissionModeChip({
  mode,
  onChange,
}: {
  mode: PermissionMode;
  onChange?: (mode: PermissionMode) => void;
}) {
  const { t } = useTranslation();
  const fullAccess = mode === 'full_access';
  const Icon = fullAccess ? ShieldCheck : Shield;
  const label = fullAccess ? t('chat.permission.full') : t('chat.permission.approval');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={`${TOOLBAR_DROPDOWN_CHIP} max-w-[150px] border border-transparent text-[14px] ${
            fullAccess
              ? 'bg-orange-50 text-orange-600 hover:bg-orange-100 hover:text-orange-700'
              : 'bg-surface-2/70 text-muted-foreground hover:bg-muted/80 hover:text-ink'
          }`}
          style={{ fontSize: 14 }}
          aria-label={t('chat.permission.aria')}
          title={label}
        >
          <Icon className={TOOLBAR_ICON} strokeWidth={1.9} />
          <span className="truncate font-medium">{label}</span>
          <ChevronDown className={TOOLBAR_DROPDOWN_CHEVRON} strokeWidth={2.5} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 p-1.5">
        <PermissionOption
          icon={<Shield className="size-4" strokeWidth={1.9} />}
          title={t('chat.permission.approval')}
          description={t('chat.permission.approvalDesc')}
          selected={!fullAccess}
          onSelect={() => onChange?.('request_approval')}
        />
        <PermissionOption
          icon={<ShieldCheck className="size-4" strokeWidth={1.9} />}
          title={t('chat.permission.full')}
          description={t('chat.permission.fullDesc')}
          selected={fullAccess}
          onSelect={() => onChange?.('full_access')}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ComposerActionMenu({
  runMode,
  onRunModeChange,
  skills,
  selectedSkill,
  onSkillChange,
  onAddFiles,
}: {
  runMode: RunMode;
  onRunModeChange: (mode: Exclude<RunMode, 'normal'>) => void;
  skills: SkillView[];
  selectedSkill?: SkillView;
  onSkillChange: (id: string | undefined) => void;
  onAddFiles: () => void;
}) {
  const { t } = useTranslation();
  const triggerTitle = `${t('chat.addFile')} / ${t('chat.modeCommand', { defaultValue: '模式' })} · ${RUN_MODE_SHORTCUT} ${t('chat.runModeShortcutHint', { defaultValue: '切换模式' })}`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={TOOLBAR_ICON_BTN} title={triggerTitle} aria-label={t('chat.addFile')}>
          <Plus className={TOOLBAR_ICON} strokeWidth={1.75} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48 p-1.5">
        <DropdownMenuItem onClick={onAddFiles} className="gap-2 px-2 py-2">
          <Paperclip className="size-4 text-muted-foreground" strokeWidth={1.75} />
          <span>{t('chat.addPhotoFile', { defaultValue: '添加照片和文件' })}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <RunModeToggleItem
          icon={<ListChecks className="size-4 text-muted-foreground" strokeWidth={1.75} />}
          label={t('chat.planMode', { defaultValue: '计划模式' })}
          checked={runMode === 'plan'}
          onToggle={() => onRunModeChange('plan')}
        />
        <RunModeToggleItem
          icon={<Target className="size-4 text-muted-foreground" strokeWidth={1.75} />}
          label={t('chat.goalMode', { defaultValue: '追求目标' })}
          checked={runMode === 'goal'}
          onToggle={() => onRunModeChange('goal')}
        />
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="gap-2 px-2 py-2">
            <Puzzle className="size-4 text-muted-foreground" strokeWidth={1.75} />
            <span className="min-w-0 flex-1 truncate">{t('nav.skill', { defaultValue: '技能' })}</span>
            {selectedSkill ? <span className="max-w-24 truncate text-xs text-muted-foreground">{selectedSkill.label}</span> : null}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-72 w-56 overflow-y-auto p-1.5">
            {selectedSkill ? (
              <>
                <DropdownMenuItem onClick={() => onSkillChange(undefined)} className="gap-2 px-2 py-2">
                  <X className="size-4 text-muted-foreground" strokeWidth={1.75} />
                  <span>{t('chat.clearSkill', { defaultValue: '不使用技能' })}</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            ) : null}
            {skills.length > 0 ? (
              skills.map((skill) => (
                <DropdownMenuItem
                  key={skill.id}
                  onClick={() => onSkillChange(skill.id)}
                  className="flex items-start gap-2 px-2 py-2"
                >
                  <Puzzle className="mt-0.5 size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-ink">{skill.label}</span>
                    {skill.description ? <span className="block truncate text-[11px] text-muted-foreground">{skill.description}</span> : null}
                  </span>
                  {selectedSkill?.id === skill.id ? <Check className="mt-0.5 size-4 shrink-0 text-ink" strokeWidth={2.2} /> : null}
                </DropdownMenuItem>
              ))
            ) : (
              <DropdownMenuItem disabled className="px-2 py-2 text-muted-foreground">
                {t('skill.empty', { defaultValue: '还没有技能' })}
              </DropdownMenuItem>
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RunModeToggleItem({
  icon,
  label,
  checked,
  onToggle,
}: {
  icon: ReactNode;
  label: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <DropdownMenuItem
      onSelect={(event) => {
        event.preventDefault();
        onToggle();
      }}
      className="flex items-center gap-3 px-2 py-2"
    >
      <span className="flex size-5 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-5 text-ink">{label}</span>
      <Switch
        checked={checked}
        onCheckedChange={onToggle}
        onClick={(event) => event.stopPropagation()}
        aria-label={checked ? '已开启' : '未开启'}
      />
    </DropdownMenuItem>
  );
}

function ComposerStatusChip({ icon, label, onClear, title }: { icon: ReactNode; label: string; onClear: () => void; title?: string }) {
  return (
    <span className={`${TOOLBAR_LABEL_CHIP} max-w-[140px] bg-surface-2/70 !text-[14px] text-muted-foreground`} title={title}>
      {icon}
      <span className="truncate font-medium">{label}</span>
      <button type="button" onClick={onClear} className="rounded-xs opacity-60 transition hover:opacity-100" aria-label={label}>
        <X className="size-3" />
      </button>
    </span>
  );
}

function PermissionOption({
  icon,
  title,
  description,
  selected,
  onSelect,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem
      onClick={onSelect}
      className="flex items-start gap-3 rounded-md px-2 py-2.5"
    >
      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium leading-5 text-ink">{title}</span>
        <span className="block text-[11px] leading-4 text-muted-foreground">{description}</span>
      </span>
      {selected ? <Check className="mt-0.5 size-4 shrink-0 text-ink" strokeWidth={2.2} /> : null}
    </DropdownMenuItem>
  );
}

function ProjectPickerChip({
  selectedProject,
  projects,
  projectId,
  onProjectChange,
  onCreateProject,
  label,
  variant,
  align,
  className,
}: {
  selectedProject?: ProjectOption;
  projects: ProjectOption[];
  projectId?: string;
  onProjectChange?: (id: string | undefined) => void;
  onCreateProject?: () => void;
  label: string;
  variant: 'icon' | 'label';
  align: 'start' | 'end';
  className?: string;
}) {
  const { t } = useTranslation();
  const projectTheme = selectedProject ? parseProjectTheme(selectedProject) : undefined;
  return (
    <ContextChip
      variant={variant}
      label={label}
      ariaLabel={selectedProject?.name ?? t('chat.selectProject')}
      leading={
        selectedProject ? (
          <AvatarBadge
            name={selectedProject.name}
            emoji={projectTheme?.emoji}
            accent={projectTheme?.accent ?? ''}
            {...TOOLBAR_AVATAR_PROPS}
          />
        ) : (
          <FolderOpen className={`${TOOLBAR_ICON} opacity-70`} strokeWidth={1.75} />
        )
      }
      options={[
        { id: '', name: t('chat.clearProject') },
        ...projects.map((p) => ({ id: p.id, name: p.name, project: p })),
      ]}
      selectedId={projectId ?? ''}
      onSelect={(id) => onProjectChange?.(id || undefined)}
      align={align}
      className={className}
      footer={
        onCreateProject ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onCreateProject} className="gap-2">
              <FolderPlus className="size-4 text-muted-foreground" strokeWidth={1.75} />
              <span>{t('project.new')}</span>
            </DropdownMenuItem>
          </>
        ) : null
      }
      renderOptionLeading={(option) => {
        if (!option.project) return null;
        const theme = parseProjectTheme(option.project);
        return (
          <AvatarBadge
            name={option.name}
            emoji={theme.emoji}
            accent={theme.accent}
            {...TOOLBAR_AVATAR_PROPS}
          />
        );
      }}
    />
  );
}

type ChipOption = {
  id: string;
  name: string;
  agent?: AgentOption;
  project?: ProjectOption;
};

function ContextChip({
  label,
  leading,
  options,
  selectedId,
  onSelect,
  align = 'start',
  className,
  ariaLabel,
  hideChevron,
  variant = 'label',
  renderOptionLeading,
  footer,
}: {
  label: string;
  leading?: ReactNode;
  options: ChipOption[];
  selectedId?: string;
  onSelect: (id: string) => void;
  align?: 'start' | 'end';
  className?: string;
  ariaLabel?: string;
  hideChevron?: boolean;
  variant?: 'icon' | 'label';
  renderOptionLeading?: (option: ChipOption) => ReactNode;
  footer?: ReactNode;
}) {
  const showLabel = label.trim().length > 0;
  const isIcon = variant === 'icon';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel ?? (showLabel ? label : undefined)}
          className={`${isIcon ? TOOLBAR_DROPDOWN_CHIP : TOOLBAR_LABEL_CHIP} ${className ?? ''}`}
        >
          {isIcon ? <span className={TOOLBAR_ICON_SLOT}>{leading}</span> : leading}
          {showLabel ? <span className="truncate font-normal">{label}</span> : null}
          {hideChevron ? null : <ChevronDown className={TOOLBAR_DROPDOWN_CHEVRON} strokeWidth={2.5} />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="min-w-44">
        {options.map((option) => (
          <DropdownMenuItem
            key={option.id || 'clear'}
            onClick={() => onSelect(option.id)}
            className={option.id === selectedId ? 'font-medium text-foreground' : ''}
          >
            <span className="flex items-center gap-2">
              {renderOptionLeading?.(option)}
              {option.name}
            </span>
          </DropdownMenuItem>
        ))}
        {footer}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MentionMenu({
  items,
  activeIndex,
  onPick,
  onHover,
}: {
  items: MentionItem[];
  activeIndex: number;
  onPick: (item: MentionItem) => void;
  onHover: (index: number) => void;
}) {
  const { t } = useTranslation();
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    itemRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  return (
    <div className="max-h-64 overflow-y-auto rounded-2xl border border-border/70 bg-popover/95 p-1.5 shadow-[0_24px_64px_-38px_rgba(15,23,42,0.5)] backdrop-blur-xl">
      <div className="px-2.5 pb-1 pt-2 text-[10px] font-medium leading-none text-muted-foreground/70">
        {t('nav.avatar')}
      </div>
      {items.map((item, index) => (
        <button
          key={item.id}
          ref={(node) => {
            itemRefs.current[index] = node;
          }}
          type="button"
          className={cn(
            'flex min-h-7 w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-[13px] leading-[18px] transition-colors',
            index === activeIndex ? 'bg-muted/70 text-ink' : 'text-ink/90 hover:bg-muted/45',
          )}
          onMouseEnter={() => onHover(index)}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(item);
          }}
        >
          <AvatarBadge
            name={item.name}
            emoji={parseAvatarTheme(item.agent.metadata).emoji}
            accent={parseAvatarTheme(item.agent.metadata).accent}
            className="size-5"
            letterClassName="text-[9px]"
            emojiClassName="text-sm leading-none"
          />
          <span className="truncate text-[13px] font-normal leading-[18px]">{item.name}</span>
        </button>
      ))}
    </div>
  );
}

function ComposerCommandMenu({
  items,
  activeIndex,
  onPick,
  onHover,
}: {
  items: ComposerCommand[];
  activeIndex: number;
  onPick: (item: ComposerCommand) => void;
  onHover: (index: number) => void;
}) {
  let lastGroup: string | null = null;
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    itemRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  return (
    <div className="max-h-72 overflow-y-auto rounded-2xl border border-border/70 bg-popover/95 p-1.5 shadow-[0_24px_64px_-38px_rgba(15,23,42,0.5)] backdrop-blur-xl">
      {items.map((item, index) => {
        const showHeading = item.group !== lastGroup;
        lastGroup = item.group;
        return (
          <div key={item.id}>
            {showHeading ? (
              <div className="px-2.5 pb-1 pt-2 text-[10px] font-medium leading-none text-muted-foreground/70">
                {item.group}
              </div>
            ) : null}
            <button
              type="button"
              ref={(node) => {
                itemRefs.current[index] = node;
              }}
              disabled={item.disabled}
              className={cn(
                'flex min-h-7 w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-[13px] leading-[18px] transition-colors',
                index === activeIndex ? 'bg-muted/70 text-ink' : 'text-ink/90 hover:bg-muted/45',
                item.disabled && 'cursor-not-allowed opacity-45 hover:bg-transparent',
              )}
              onMouseEnter={() => onHover(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                onPick(item);
              }}
            >
              <span className="flex size-[18px] shrink-0 items-center justify-center text-muted-foreground/80 [&_svg]:size-3.5">
                {item.icon}
              </span>
              <span className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className="shrink-0 text-[13px] font-normal leading-[18px] text-ink/95">{item.label}</span>
                {item.description ? <span className="min-w-0 truncate text-[12px] leading-[18px] text-muted-foreground/58">{item.description}</span> : null}
              </span>
              {item.trailing ? <span className="max-w-24 truncate text-[12px] leading-[18px] text-muted-foreground/65">{item.trailing}</span> : null}
              {item.selected ? <Check className="size-3.5 shrink-0 text-ink/75" strokeWidth={2.25} /> : null}
            </button>
          </div>
        );
      })}
    </div>
  );
}
