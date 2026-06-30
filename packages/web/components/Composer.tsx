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
import { SPRING_SNAPPY } from "@/lib/motion";
import { useDropzone } from 'react-dropzone';
import {
  ArrowUp,
  ArrowDown,
  ChevronRight,
  FolderOpen,
  FolderPlus,
  Gauge,
  Image,
  ListChecks,
  Maximize2,
  Monitor,
  Paperclip,
  PlayCircle,
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
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { AvatarBadge, NAV_AVATAR_BADGE_PROPS } from './AvatarBadge';
import { parseAvatarTheme } from '@/lib/avatars';
import { fetchRuntimeContext } from '@/lib/services';
import type { RuntimeContextView } from '@/lib/services';
import { IMAGE_ATTACHMENT_LIMITS } from '@/lib/chatAttachments';
import { useComposerAttachments } from '@/hooks/useComposerAttachments';
import { filterAgentMentions, filterComposerCommands, parseMention, parseSlashCommand } from '@/lib/composerCommands';
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
import { ImagePreviewDialog } from './UserMessage';
import { Switch } from './ui/switch';
import { GoalHeader } from './composer/GoalHeader';
import { PlanReplyComposer } from './composer/PlanReplyComposer';
import {
  ComposerActionMenu,
  ComposerCommandMenu,
  ComposerStatusChip,
  ContextChip,
  MentionMenu,
  PermissionModeChip,
  ProjectPickerChip,
} from './composer/menus';
import {
  MAX_ROWS,
  RUN_MODE_CYCLE,
  RUN_MODE_SHORTCUT,
  TOOLBAR_AVATAR_PROPS,
  TOOLBAR_DROPDOWN_CHEVRON,
  TOOLBAR_DROPDOWN_CHIP,
  TOOLBAR_HIT,
  TOOLBAR_ICON,
  TOOLBAR_ICON_BTN,
  TOOLBAR_ICON_SLOT,
  TOOLBAR_LABEL_CHIP,
  TOOLBAR_STOP_BTN,
} from './composer/toolbar';
import type {
  AgentOption,
  ComposerCommand,
  CreatedProject,
  GoalComposerState,
  MentionItem,
  ProjectOption,
} from './composer/types';

export type { GoalComposerState };

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
  onCreateProject?: () => void;
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
  onCreateProject,
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
  const openProjectDialog = useCallback(() => {
    if (onCreateProject) {
      onCreateProject();
    } else {
      setProjectDialogOpen(true);
    }
  }, [onCreateProject]);
  // An @-mentioned space: sticky until cleared, so follow-up turns keep going to
  // the same sub-space (deterministic dispatch decided by the user, not the LLM).
  const [targetSpaceId, setTargetSpaceId] = useState<string | undefined>(undefined);
  const targetSpace = spaces.find((s) => s.id === targetSpaceId);
  const selectedSkill = selectedSkillId ? skills.find((skill) => skill.id === selectedSkillId) : undefined;
  const compactionActive = contextCompaction?.status === 'running' || contextCompaction?.status === 'retrying' || contextCompaction?.status === 'failed';
  const compactionLabel = contextCompaction?.status === 'retrying'
    ? t('composer.compactingRetry', {
        defaultValue: '正在压缩上下文 · 重试 {{attempt}}/{{max}}',
        attempt: contextCompaction.attempt ?? 1,
        max: contextCompaction.maxAttempts ?? 3,
      })
    : contextCompaction?.status === 'failed'
      ? t('composer.compactionFailed', { defaultValue: '上下文压缩失败' })
      : t('composer.compacting', { defaultValue: '正在压缩上下文' });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const openImagePickerRef = useRef<() => void>(() => undefined);
  const { attachments, readyAttachments, preparing: attachmentsPreparing, failed: attachmentsFailed, addImageFiles, removeAttachment, clearAttachments } = useComposerAttachments(
    t,
    () => requestAnimationFrame(() => textareaRef.current?.focus()),
  );
  const [previewAttachmentId, setPreviewAttachmentId] = useState<string | null>(null);
  const previewAttachment = useMemo(() => {
    const attachment = attachments.find((item) => item.id === previewAttachmentId);
    return attachment?.status === 'ready' ? attachment.attachment : null;
  }, [attachments, previewAttachmentId]);
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
        group: t('composer.groupMode', { defaultValue: '模式' }),
        label: t('chat.normalMode', { defaultValue: '普通模式' }),
        description: t('chat.normalModeDesc', { defaultValue: '关闭计划/目标模式' }),
        keywords: ['default', 'mode'],
        icon: <PlayCircle className="size-4" strokeWidth={1.75} />,
        selected: runMode === 'normal',
        run: () => onRunModeChange?.('normal'),
      },
      {
        id: 'plan',
        group: t('composer.groupMode', { defaultValue: '模式' }),
        label: t('chat.planMode', { defaultValue: '计划模式' }),
        description: t('chat.planModeDesc', { defaultValue: '先产出计划，不直接执行' }),
        keywords: ['mode'],
        icon: <ListChecks className="size-4" strokeWidth={1.75} />,
        selected: runMode === 'plan',
        run: () => onRunModeChange?.('plan'),
      },
      {
        id: 'goal',
        group: t('composer.groupMode', { defaultValue: '模式' }),
        label: t('chat.goalMode', { defaultValue: '目标模式' }),
        description: t('chat.goalModeDesc', { defaultValue: '把下一条消息设为持续目标' }),
        keywords: ['mode'],
        icon: <Target className="size-4" strokeWidth={1.75} />,
        selected: runMode === 'goal',
        run: () => onRunModeChange?.('goal'),
      },
      {
        id: 'approval',
        group: t('composer.groupPermission', { defaultValue: '权限' }),
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
        group: t('composer.groupPermission', { defaultValue: '权限' }),
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
        group: t('composer.groupTool', { defaultValue: '工具' }),
        label: t('chat.addPhotoFile', { defaultValue: '添加照片和文件' }),
        description: t('chat.addFile'),
        keywords: ['file', 'attach'],
        icon: <Paperclip className="size-4" strokeWidth={1.75} />,
        run: () => openImagePickerRef.current(),
      },
      {
        id: 'context',
        group: t('composer.groupTool', { defaultValue: '工具' }),
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
        group: t('composer.groupSpace', { defaultValue: '空间' }),
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
        group: t('composer.groupSpace', { defaultValue: '空间' }),
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
        group: t('composer.groupSkill', { defaultValue: '技能' }),
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
        group: t('composer.groupSkill', { defaultValue: '技能' }),
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
        group: t('composer.groupProject', { defaultValue: '项目' }),
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
          group: t('composer.groupProject', { defaultValue: '项目' }),
          label: t('project.create', { defaultValue: '新建项目' }),
          description: t('project.pathPlaceholder', { defaultValue: '选择一个项目目录' }),
          keywords: ['project', 'new'],
          icon: <FolderPlus className="size-4" strokeWidth={1.75} />,
          run: openProjectDialog,
        });
      }
      for (const project of projects) {
        items.push({
          id: `project:${project.id}`,
          group: t('composer.groupProject', { defaultValue: '项目' }),
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
        group: t('composer.groupModel', { defaultValue: '模型' }),
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
    openProjectDialog,
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
    const controller = new AbortController();
    void fetchRuntimeContext(controller.signal).then((context) => {
      if (!controller.signal.aborted) setRuntimeContext(context);
    });
    return () => controller.abort();
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
            className: 'relative z-10 overflow-hidden rounded-xl border bg-card transition-[box-shadow,border-color,background-color] duration-[var(--duration-base)] ease-out',
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
                    className="inline-flex h-6 items-center gap-1.5 rounded-pill border border-border bg-muted/60 pl-2 pr-1.5 text-xs text-foreground"
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
                    <div key={attachment.id} className="group relative h-20 w-20 overflow-hidden rounded-md border border-border bg-muted">
                      <img src={attachment.previewUrl} alt={attachment.name} className="h-full w-full object-cover" />
                      <button
                        type="button"
                        disabled={attachment.status !== 'ready'}
                        onClick={() => setPreviewAttachmentId(attachment.id)}
                        className="absolute inset-0 z-10 flex cursor-zoom-in items-center justify-center bg-foreground/0 text-white transition hover:bg-foreground/10 disabled:cursor-default disabled:hover:bg-foreground/0"
                        aria-label={t('chat.previewImageAttachment', { defaultValue: '预览图片' })}
                      >
                        {attachment.status === 'ready' ? (
                          <span className="flex size-6 items-center justify-center rounded-full bg-black/45 opacity-0 shadow-sm transition group-hover:opacity-100">
                            <Maximize2 className="size-3.5" strokeWidth={1.75} />
                          </span>
                        ) : null}
                      </button>
                      {attachment.status === 'pending' ? (
                        <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/60 text-2xs font-medium text-muted-foreground backdrop-blur-[1px]">
                          {t('chat.imagePreparingShort', { defaultValue: '准备中' })}
                        </div>
                      ) : null}
                      {attachment.status === 'error' ? (
                        <div className="absolute inset-0 z-20 flex items-center justify-center bg-destructive/85 px-1 text-center text-2xs font-medium leading-4 text-destructive-foreground">
                          {t('chat.imageFailedShort', { defaultValue: '失败' })}
                        </div>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => removeAttachment(attachment.id)}
                        className="absolute right-1 top-1 z-30 flex size-5 items-center justify-center rounded-full bg-background/90 text-muted-foreground opacity-0 shadow-sm transition hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                        aria-label={t('chat.removeImageAttachment', { defaultValue: '移除图片' })}
                      >
                        <X className="size-3" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              {isDragActive ? (
                <div className="mb-2 flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
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
                    ? 'no-scrollbar max-h-48 w-full resize-none bg-transparent px-2 py-1 text-base leading-7 text-foreground placeholder:text-muted-foreground/55 outline-hidden'
                    : 'no-scrollbar max-h-48 w-full resize-none bg-transparent px-2 py-1 text-sm leading-6 text-foreground placeholder:text-muted-foreground/55 outline-hidden'
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
                        'max-w-[220px] bg-warning/10 text-warning hover:bg-warning/10',
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
                      onCreateProject={openProjectDialog}
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
                      transition={SPRING_SNAPPY}
                      className={`flex ${TOOLBAR_HIT} w-7 shrink-0 items-center justify-center rounded-pill bg-accent-grad text-primary-foreground shadow-sm disabled:cursor-not-allowed`}
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
                onCreateProject={openProjectDialog}
                label={selectedProject?.name ?? t('chat.enterProjectWork')}
                variant="label"
                align="start"
                className="max-w-[min(48%,260px)] bg-transparent px-0 text-sm! text-muted-foreground shadow-none hover:bg-muted/70"
              />
              {runtimeContext?.mode === 'local' ? (
                <span
                  className={`${TOOLBAR_LABEL_CHIP} bg-transparent px-0 text-sm! text-muted-foreground shadow-none`}
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
    {onCreateProject ? null : <ProjectDialog open={projectDialogOpen} onOpenChange={setProjectDialogOpen} onSaved={handleProjectSaved} />}
    {previewAttachment ? (
      <ImagePreviewDialog
        attachment={previewAttachment}
        open={Boolean(previewAttachment)}
        onOpenChange={(open) => {
          if (!open) setPreviewAttachmentId(null);
        }}
      />
    ) : null}
    </>
  );
}
