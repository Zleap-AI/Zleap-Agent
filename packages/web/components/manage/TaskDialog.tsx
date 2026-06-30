'use client';

import { forwardRef, useEffect, useMemo, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import {
  Check,
  ChevronDown,
  Clock,
  Cpu,
  FolderOpen,
  Globe,
  Loader2,
  MessageSquare,
  MessageSquarePlus,
  MoreHorizontal,
  ShieldCheck,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { patchJson, postJson } from '@/lib/api';
import { llmModels, modelDisplayLabel } from '@/lib/models';
import {
  buildTaskCron,
  describeTaskCron,
  inferTaskSchedule,
  normalizeNumber,
  parseTaskTime,
  WEEKDAY_VALUES,
  type TaskFrequency,
} from '@/lib/taskSchedule';
import type { Resources } from '@/lib/useResources';
import type { Conversation as ManagedConversation } from '@/lib/useConversations';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FieldDescription } from '@/components/ui/field';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ManageField, ManageForm } from './manage-ui';

export type TaskDialogItem = {
  id: string;
  name: string;
  cron: string;
  timezone?: string;
  prompt: string;
  projectId?: string;
  conversationId?: string;
  modelId?: string;
  permissionMode?: string;
  targetSpace?: string;
};

type TaskPermissionMode = 'request_approval' | 'full_access';
type TaskTargetMode = 'project' | 'conversation';

const TASK_FREQUENCIES: TaskFrequency[] = ['daily', 'weekdays', 'weekly', 'monthly', 'hourly', 'every15', 'custom'];
const TASK_PERMISSION_MODES: TaskPermissionMode[] = ['request_approval', 'full_access'];
const HOUR_VALUES = Array.from({ length: 24 }, (_, index) => String(index).padStart(2, '0'));
const MINUTE_QUARTER_VALUES = ['00', '15', '30', '45'];
const DAY_OF_MONTH_VALUES = Array.from({ length: 31 }, (_, index) => String(index + 1));
const COMMON_TIMEZONES = ['Asia/Shanghai', 'UTC', 'America/Los_Angeles', 'America/New_York', 'Europe/London', 'Europe/Paris', 'Asia/Tokyo'];

const SCHEDULE_SELECT_PROPS = {
  position: 'popper' as const,
  align: 'start' as const,
  className: 'max-h-48',
};

type TaskDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task: TaskDialogItem | null;
  resources: Resources;
  avatarId: string;
  projectId?: string;
  conversations: ManagedConversation[];
  onCreateTaskConversation?: (title: string, projectId?: string) => string;
  onSaved: () => Promise<void>;
};

export function TaskDialog({
  open,
  onOpenChange,
  task,
  resources,
  avatarId,
  projectId,
  conversations,
  onCreateTaskConversation,
  onSaved,
}: TaskDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [frequency, setFrequency] = useState<TaskFrequency>('daily');
  const [time, setTime] = useState('09:00');
  const [weekday, setWeekday] = useState('1');
  const [dayOfMonth, setDayOfMonth] = useState('1');
  const [customCron, setCustomCron] = useState('0 9 * * *');
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const [targetMode, setTargetMode] = useState<TaskTargetMode>('conversation');
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>(projectId);
  const [selectedConversationId, setSelectedConversationId] = useState<string | undefined>();
  const [selectedModelId, setSelectedModelId] = useState<string | undefined>();
  const [permissionMode, setPermissionMode] = useState<TaskPermissionMode>('request_approval');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const inferred = inferTaskSchedule(task?.cron ?? '0 9 * * *');
    setName(task?.name ?? '');
    setPrompt(task?.prompt ?? '');
    setFrequency(inferred.frequency);
    setTime(inferred.time);
    setWeekday(inferred.weekday);
    setDayOfMonth(inferred.dayOfMonth);
    setCustomCron(task?.cron ?? '0 9 * * *');
    setTimezone(task?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC');
    const nextMode: TaskTargetMode = task?.projectId ? 'project' : 'conversation';
    setTargetMode(nextMode);
    setSelectedProjectId(task?.projectId ?? (nextMode === 'project' ? projectId : undefined));
    setSelectedConversationId(task?.conversationId);
    setSelectedModelId(task?.modelId);
    setPermissionMode(task?.permissionMode === 'full_access' ? 'full_access' : 'request_approval');
  }, [open, projectId, task]);

  const cron = buildTaskCron({ frequency, time, weekday, dayOfMonth, customCron });
  const [timeHour, timeMinute] = parseTaskTime(time);
  const hourValue = timeHour.padStart(2, '0');
  const minuteOptions = useMemo(
    () => [...new Set([timeMinute.padStart(2, '0'), ...MINUTE_QUARTER_VALUES])].sort((a, b) => Number(a) - Number(b)),
    [timeMinute],
  );
  const timezoneOptions = [...new Set([timezone, Intl.DateTimeFormat().resolvedOptions().timeZone, ...COMMON_TIMEZONES].filter(Boolean))];
  const modelOptions = llmModels(resources.models);
  const selectedProject = selectedProjectId ? resources.projects.find((project) => project.id === selectedProjectId) : undefined;
  const selectedConversation = selectedConversationId ? conversations.find((conversation) => conversation.id === selectedConversationId) : undefined;
  const selectedModel = selectedModelId ? modelOptions.find((model) => model.id === selectedModelId) : undefined;
  const sortedConversations = conversations.filter((conversation) => !conversation.archived).sort((a, b) => b.updatedAt - a.updatedAt);
  const resolvedTitle = name.trim() || task?.name || selectedConversation?.title || 'Task';
  const scheduleLabel = cron ? describeTaskCron(cron, t) : t('task.invalidCron', { defaultValue: 'Cron 格式需要 5 段。' });
  const cronInvalid = !cron;
  const projectMissing = targetMode === 'project' && !selectedProjectId;
  const canSubmit = Boolean(cron && prompt.trim() && !busy && !projectMissing);
  const submitDisabledReason = (() => {
    if (busy) return undefined;
    if (!prompt.trim()) return t('task.submitDisabledPrompt', { defaultValue: '请填写提示词' });
    if (!cron) return t('task.submitDisabledCron', { defaultValue: '请设置有效的执行计划' });
    if (projectMissing) return t('task.submitDisabledProject', { defaultValue: '请选择项目' });
    return undefined;
  })();

  const setHour = (hour: string) => setTime(`${hour}:${timeMinute.padStart(2, '0')}`);
  const setMinute = (minute: string) => setTime(`${hourValue}:${minute}`);

  const footerMenuProps = { side: 'top' as const, align: 'start' as const };

  const selectProjectTarget = () => {
    setTargetMode('project');
    setSelectedProjectId((current) => current ?? projectId ?? resources.projects[0]?.id);
    setSelectedConversationId(undefined);
  };
  const selectConversationTarget = () => {
    setTargetMode('conversation');
    setSelectedProjectId(undefined);
  };

  const submit = async () => {
    if (!cron || !prompt.trim()) {
      toast.error(t('task.validation'));
      return;
    }
    setBusy(true);
    try {
      const conversationId = selectedConversationId
        ?? task?.conversationId
        ?? onCreateTaskConversation?.(resolvedTitle, targetMode === 'project' ? selectedProjectId : undefined);
      if (task) {
        await patchJson('/api/tasks', {
          id: task.id,
          name: resolvedTitle,
          cron,
          prompt: prompt.trim(),
          timezone: timezone.trim(),
          avatarId,
          projectId: targetMode === 'project' ? (selectedProjectId ?? null) : null,
          conversationId: conversationId ?? null,
          modelId: selectedModelId ?? null,
          permissionMode,
          targetSpace: null,
        });
      } else {
        await postJson('/api/tasks', {
          name: resolvedTitle,
          cron,
          prompt: prompt.trim(),
          timezone: timezone.trim(),
          avatarId,
          projectId: targetMode === 'project' ? selectedProjectId : undefined,
          conversationId: conversationId ?? undefined,
          modelId: selectedModelId ?? undefined,
          permissionMode,
        });
      }
      toast.success(task ? t('task.saved') : t('task.created'));
      await onSaved();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const moreSettingsLabel = t('task.moreSettings', { defaultValue: '更多设置' });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="gap-0 overflow-hidden p-0 sm:max-w-[720px]"
        onEscapeKeyDown={(event) => {
          if (busy) {
            event.preventDefault();
            return;
          }
          onOpenChange(false);
        }}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{task ? t('task.edit') : t('task.new')}</DialogTitle>
          <DialogDescription>{t('task.dialogDesc')}</DialogDescription>
        </DialogHeader>

        <div className="absolute right-5 top-5 z-10 flex items-center gap-1.5">
          <Button variant="ghost" size="icon-sm" onClick={() => onOpenChange(false)} title={t('common.cancel')} aria-label={t('common.cancel')}>
            <X className="size-4" />
          </Button>
        </div>

        <div className="min-h-[360px] px-6 pb-4 pt-6">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('task.titlePlaceholder', { defaultValue: '例如：每日项目简报' })}
            aria-describedby="task-name-hint"
            autoFocus
            className="h-8 border-0 bg-transparent px-0 text-base font-semibold text-foreground shadow-none placeholder:text-muted-foreground/70 focus-visible:ring-0"
          />
          <p id="task-name-hint" className="sr-only">
            {t('task.nameOptionalHint', { defaultValue: '可选，留空将自动生成' })}
          </p>
          <Textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={t('task.promptComposerPlaceholder', { defaultValue: '添加提示词，例如：汇总今天的项目动态并给我。' })}
            className="mt-3 min-h-[240px] resize-none border-0 bg-transparent px-0 py-0 text-sm leading-6 shadow-none placeholder:text-muted-foreground/50 focus-visible:ring-0"
          />
        </div>

        <div className="flex min-h-14 flex-wrap items-center gap-2 border-t border-border/80 bg-muted/20 px-5 py-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <TaskDialogChip
                  icon={targetMode === 'project' ? <FolderOpen className="size-4" /> : <MessageSquare className="size-4" />}
                  label={targetMode === 'project' ? t('task.targetProject') : t('task.targetConversation')}
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent {...footerMenuProps} className="w-52 p-1.5">
                <div className="px-2 py-1 text-xs text-muted-foreground">{t('task.runtimeEnvironment')}</div>
                <DropdownMenuItem onClick={selectProjectTarget} className={cn('gap-2 rounded-md px-2 py-2', targetMode === 'project' && 'font-medium text-foreground')}>
                  <FolderOpen className="size-4 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm">{t('task.targetProject')}</span>
                    <span className="block truncate text-xs font-normal text-muted-foreground">{t('task.targetProjectDesc')}</span>
                  </span>
                  {targetMode === 'project' ? <Check className="size-4" /> : null}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={selectConversationTarget} className={cn('gap-2 rounded-md px-2 py-2', targetMode === 'conversation' && 'font-medium text-foreground')}>
                  <MessageSquare className="size-4 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm">{t('task.targetConversation')}</span>
                    <span className="block truncate text-xs font-normal text-muted-foreground">{t('task.targetConversationDesc')}</span>
                  </span>
                  {targetMode === 'conversation' ? <Check className="size-4" /> : null}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {targetMode === 'project' ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <TaskDialogChip
                    icon={<FolderOpen className="size-4" />}
                    label={selectedProject?.name ?? t('task.selectProject')}
                    invalid={projectMissing}
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent {...footerMenuProps} className="min-w-52">
                  {resources.projects.length === 0 ? (
                    <DropdownMenuItem disabled>{t('project.empty', { defaultValue: '暂无项目' })}</DropdownMenuItem>
                  ) : null}
                  {resources.projects.map((project) => (
                    <DropdownMenuItem key={project.id} onClick={() => setSelectedProjectId(project.id)} className={project.id === selectedProjectId ? 'font-medium text-foreground' : ''}>
                      <FolderOpen className="size-4 text-muted-foreground" />
                      {project.name}
                      {project.id === selectedProjectId ? <Check className="ml-auto size-4" /> : null}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <TaskDialogChip
                    icon={<MessageSquarePlus className="size-4" />}
                    label={selectedConversation?.title ?? (name.trim() || task?.name || t('task.newConversation'))}
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent {...footerMenuProps} className="min-w-56">
                  <DropdownMenuItem onClick={() => setSelectedConversationId(undefined)} className={!selectedConversationId ? 'font-medium text-foreground' : ''}>
                    <MessageSquarePlus className="size-4 text-muted-foreground" />
                    {t('task.newConversation')}
                    {!selectedConversationId ? <Check className="ml-auto size-4" /> : null}
                  </DropdownMenuItem>
                  {sortedConversations.map((conversation) => (
                    <DropdownMenuItem key={conversation.id} onClick={() => setSelectedConversationId(conversation.id)} className={conversation.id === selectedConversationId ? 'font-medium text-foreground' : ''}>
                      <MessageSquare className="size-4 text-muted-foreground" />
                      <span className="min-w-0 truncate">{conversation.title}</span>
                      {conversation.id === selectedConversationId ? <Check className="ml-auto size-4" /> : null}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            <Popover>
              <PopoverTrigger asChild>
                <TaskDialogChip icon={<Clock className="size-4" />} label={scheduleLabel} invalid={cronInvalid} />
              </PopoverTrigger>
              <PopoverContent side="top" align="start" className="w-72 p-3">
                <ManageForm>
                  <ManageField label={t('task.frequency', { defaultValue: '频率' })}>
                    <Select value={frequency} onValueChange={(value) => setFrequency(value as TaskFrequency)}>
                      <SelectTrigger className="w-full bg-background">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent {...SCHEDULE_SELECT_PROPS}>
                        {TASK_FREQUENCIES.map((value) => (
                          <SelectItem key={value} value={value}>
                            {t(`task.frequencyOptions.${value}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </ManageField>

                  {frequency === 'weekly' ? (
                    <ManageField label={t('task.weekday', { defaultValue: '星期' })}>
                      <Select value={weekday} onValueChange={setWeekday}>
                        <SelectTrigger className="w-full bg-background">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent {...SCHEDULE_SELECT_PROPS}>
                          {WEEKDAY_VALUES.map((value) => (
                            <SelectItem key={value} value={value}>
                              {t(`task.weekdays.${value}`)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </ManageField>
                  ) : null}

                  {frequency === 'monthly' ? (
                    <ManageField label={t('task.dayOfMonth', { defaultValue: '每月第几天' })}>
                      <Select value={normalizeNumber(dayOfMonth, 1, 31, 1)} onValueChange={setDayOfMonth}>
                        <SelectTrigger className="w-full bg-background">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent {...SCHEDULE_SELECT_PROPS}>
                          {DAY_OF_MONTH_VALUES.map((value) => (
                            <SelectItem key={value} value={value}>
                              {t('task.dayOption', { day: value })}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </ManageField>
                  ) : null}

                  {['daily', 'weekdays', 'weekly', 'monthly'].includes(frequency) ? (
                    <div className="grid grid-cols-2 gap-2">
                      <ManageField label={t('task.scheduleTimeHour', { defaultValue: '时' })}>
                        <Select value={hourValue} onValueChange={setHour}>
                          <SelectTrigger className="w-full bg-background font-mono">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent {...SCHEDULE_SELECT_PROPS}>
                            {HOUR_VALUES.map((value) => (
                              <SelectItem key={value} value={value} className="font-mono">
                                {value}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </ManageField>
                      <ManageField label={t('task.scheduleTimeMinute', { defaultValue: '分' })}>
                        <Select value={timeMinute.padStart(2, '0')} onValueChange={setMinute}>
                          <SelectTrigger className="w-full bg-background font-mono">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent {...SCHEDULE_SELECT_PROPS}>
                            {minuteOptions.map((value) => (
                              <SelectItem key={value} value={value} className="font-mono">
                                {value}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </ManageField>
                    </div>
                  ) : null}

                  {frequency === 'custom' ? (
                    <ManageField label={t('task.cron')}>
                      <Input
                        value={customCron}
                        onChange={(event) => setCustomCron(event.target.value)}
                        placeholder="0 9 * * *"
                        className={cn('bg-background font-mono text-xs', cronInvalid && 'border-destructive')}
                        aria-invalid={cronInvalid}
                      />
                      <FieldDescription>{t('task.customCronHint', { defaultValue: '5 段 cron 表达式：分 时 日 月 周' })}</FieldDescription>
                    </ManageField>
                  ) : null}

                  <div className="rounded-md bg-muted/50 px-2.5 py-2 text-xs">
                    <div className={cn('font-medium', cronInvalid ? 'text-destructive' : 'text-foreground')}>{scheduleLabel}</div>
                    <div className="mt-1 font-mono text-muted-foreground">{cron || t('task.invalidCron')}</div>
                  </div>
                </ManageForm>
              </PopoverContent>
            </Popover>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <TaskDialogChip icon={<MoreHorizontal className="size-4" />} label={moreSettingsLabel} />
              </DropdownMenuTrigger>
              <DropdownMenuContent {...footerMenuProps} className="min-w-56 p-1">
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger className="gap-2">
                    <Globe className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">{t('task.timezone', { defaultValue: '时区' })}</span>
                    <span className="max-w-[7rem] truncate text-xs text-muted-foreground">{timezone}</span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="min-w-56 max-h-48 overflow-y-auto">
                    {timezoneOptions.map((value) => (
                      <DropdownMenuItem key={value} onClick={() => setTimezone(value)} className={value === timezone ? 'font-medium text-foreground' : ''}>
                        <Globe className="size-4 text-muted-foreground" />
                        {value}
                        {value === timezone ? <Check className="ml-auto size-4" /> : null}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>

                <DropdownMenuSub>
                  <DropdownMenuSubTrigger className="gap-2">
                    <Cpu className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">{t('task.selectModel', { defaultValue: '模型' })}</span>
                    <span className="max-w-[7rem] truncate text-xs text-muted-foreground">
                      {selectedModel ? modelDisplayLabel(selectedModel) : t('task.defaultModel', { defaultValue: '使用默认模型' })}
                    </span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="min-w-60 max-h-48 overflow-y-auto">
                    <DropdownMenuItem onClick={() => setSelectedModelId(undefined)} className={!selectedModelId ? 'font-medium text-foreground' : ''}>
                      <Cpu className="size-4 text-muted-foreground" />
                      {t('task.defaultModel')}
                      {!selectedModelId ? <Check className="ml-auto size-4" /> : null}
                    </DropdownMenuItem>
                    {modelOptions.map((model) => (
                      <DropdownMenuItem key={model.id} onClick={() => setSelectedModelId(model.id)} className={model.id === selectedModelId ? 'font-medium text-foreground' : ''}>
                        <Cpu className="size-4 text-muted-foreground" />
                        <span className="min-w-0 truncate">{modelDisplayLabel(model)}</span>
                        {model.id === selectedModelId ? <Check className="ml-auto size-4" /> : null}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>

                <DropdownMenuSub>
                  <DropdownMenuSubTrigger className="gap-2">
                    <ShieldCheck className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">{t('task.permission', { defaultValue: '权限' })}</span>
                    <span className="max-w-[7rem] truncate text-xs text-muted-foreground">{t(`task.permissionMode.${permissionMode}`)}</span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="min-w-48">
                    {TASK_PERMISSION_MODES.map((value) => (
                      <DropdownMenuItem key={value} onClick={() => setPermissionMode(value)} className={value === permissionMode ? 'font-medium text-foreground' : ''}>
                        <ShieldCheck className="size-4 text-muted-foreground" />
                        {t(`task.permissionMode.${value}`)}
                        {value === permissionMode ? <Check className="ml-auto size-4" /> : null}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Button onClick={submit} disabled={!canSubmit} className="rounded-lg" title={submitDisabledReason}>
                  {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                  {task ? t('common.save') : t('common.create')}
                </Button>
              </span>
            </TooltipTrigger>
            {submitDisabledReason ? <TooltipContent>{submitDisabledReason}</TooltipContent> : null}
          </Tooltip>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export const TaskDialogChip = forwardRef<HTMLButtonElement, {
  icon: ReactNode;
  label: string;
  iconOnly?: boolean;
  responsiveLabel?: boolean;
  invalid?: boolean;
} & Omit<ComponentPropsWithoutRef<'button'>, 'children'>>(
function TaskDialogChip({
  icon,
  label,
  iconOnly = false,
  responsiveLabel = false,
  invalid = false,
  className,
  ...props
}, ref) {
  return (
    <button
      ref={ref}
      type="button"
      title={label}
      aria-invalid={invalid || undefined}
      className={cn(
        'inline-flex h-8 min-w-0 items-center gap-1.5 rounded-lg px-2 text-sm text-foreground transition-colors hover:bg-muted aria-expanded:bg-muted',
        iconOnly && 'w-8 justify-center px-0',
        responsiveLabel && 'max-sm:w-8 max-sm:justify-center max-sm:px-0',
        invalid && 'text-destructive ring-1 ring-destructive/40',
        className,
      )}
      {...props}
    >
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">{icon}</span>
      {iconOnly ? null : (
        <span className={cn('max-w-36 truncate', responsiveLabel && 'max-sm:hidden')}>{label}</span>
      )}
      {iconOnly ? null : (
        <ChevronDown className={cn('size-3.5 shrink-0 text-muted-foreground', responsiveLabel && 'max-sm:hidden')} />
      )}
    </button>
  );
});
TaskDialogChip.displayName = 'TaskDialogChip';
