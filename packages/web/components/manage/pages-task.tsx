'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { Clock, Loader2, MoreHorizontal, PauseCircle, Pencil, Play, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { postJson, patchJson, deleteJson, webApiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { DeleteConfirmDialog } from '@/components/ui/delete-confirm-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { llmModels, modelDisplayLabel } from '@/lib/models';
import { describeTaskCron } from '@/lib/taskSchedule';
import type { Resources } from '@/lib/useResources';
import type { Conversation as ManagedConversation } from '@/lib/useConversations';
import { TaskDialog } from './TaskDialog';
import {
  ManageDetailGrid,
  ManageDetailItem,
  ManageDrawer,
  ManageEmptyState as EmptyState,
  ManageList,
  ManageListRow,
  ManagePageShell as PageShell,
  ManagePreviewBlock,
  ManageSearchBar as SearchBar,
  ManageStatusBadge,
} from './manage-ui';
import type { PageProps } from './pageTypes';

type TaskRunItem = {
  id: string;
  mode: 'manual' | 'scheduled';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'skipped';
  scheduledFor?: string;
  startedAt: string;
  finishedAt?: string;
  conversationId?: string;
  summary?: string;
  error?: string;
};
type TaskItem = {
  id: string;
  name: string;
  cron: string;
  timezone?: string;
  prompt: string;
  enabled: boolean;
  builtin?: boolean;
  deletable?: boolean;
  avatarId?: string;
  projectId?: string;
  conversationId?: string;
  modelId?: string;
  permissionMode?: string;
  targetSpace?: string;
  lastRunAt?: string;
  runs?: TaskRunItem[];
  createdAt?: string;
  updatedAt?: string;
};
const TASK_RUN_HISTORY_LIMIT = 5;

export function TaskPage({
  resources,
  avatarId,
  currentProjectId,
  conversations = [],
  onCreateTaskConversation,
  onOpenTaskConversation,
  onBack,
}: PageProps) {
  const { t } = useTranslation();
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<TaskItem | null>(null);
  const [historyTaskId, setHistoryTaskId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TaskItem | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const response = await webApiFetch('/api/tasks');
      const data = (await response.json().catch(() => ({}))) as { tasks?: TaskItem[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      setTasks(data.tasks ?? []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (tasks.some((task) => task.runs?.some((run) => run.status === 'queued' || run.status === 'running'))) {
        void load();
      }
    }, 4000);
    return () => window.clearInterval(timer);
  }, [tasks]);

  const filtered = tasks.filter((task) => {
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    return [task.name, task.prompt, task.cron].some((value) => value.toLowerCase().includes(needle));
  });
  const historyTask = tasks.find((task) => task.id === historyTaskId) ?? null;

  const runTask = async (task: TaskItem) => {
    try {
      await postJson('/api/tasks/run', { id: task.id });
      toast.success(t('task.runRequested'));
      await load();
      setHistoryTaskId(task.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const toggleTask = async (task: TaskItem) => {
    try {
      await patchJson('/api/tasks', { id: task.id, enabled: !task.enabled });
      toast.success(task.enabled ? t('task.disabled') : t('task.enabled'));
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const removeTask = async () => {
    if (!pendingDelete) return;
    if (pendingDelete.deletable === false) {
      toast.error(t('common.locked'));
      setPendingDelete(null);
      return;
    }
    try {
      await deleteJson('/api/tasks', { id: pendingDelete.id });
      toast.success(t('common.deleted', { defaultValue: '已删除' }));
      setPendingDelete(null);
      if (historyTaskId === pendingDelete.id) setHistoryTaskId(null);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <PageShell
      icon={<Clock className="size-4" />}
      title={t('task.title')}
      subtitle={t('task.subtitle')}
      onBack={onBack}
      actions={
        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="icon-lg" onClick={() => void load()} title={t('common.refresh')} aria-label={t('common.refresh')}>
            <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
          </Button>
          <Button
            size="icon-lg"
            onClick={() => {
              setEditingTask(null);
              setDialogOpen(true);
            }}
            title={t('task.new')}
            aria-label={t('task.new')}
          >
            <Plus className="size-4" />
          </Button>
        </div>
      }
      toolbar={
        <SearchBar
          value={q}
          onChange={setQ}
          placeholder={t('task.search')}
        />
      }
    >
      {filtered.length > 0 ? (
        <ManageList className="gap-1">
          {filtered.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              active={historyTaskId === task.id}
              onOpenHistory={() => setHistoryTaskId(task.id)}
              onRun={() => void runTask(task)}
              onToggle={() => void toggleTask(task)}
              onEdit={() => { setEditingTask(task); setDialogOpen(true); }}
              onDelete={() => {
                if (task.deletable === false) return;
                setPendingDelete(task);
              }}
            />
          ))}
        </ManageList>
      ) : (
        <EmptyState icon={<Clock className="size-5" />}>{loading ? t('common.loading') : t('task.empty')}</EmptyState>
      )}
      <TaskHistoryDrawer
        task={historyTask}
        resources={resources}
        conversations={conversations}
        onOpenConversation={onOpenTaskConversation}
        onClose={() => setHistoryTaskId(null)}
      />
      <TaskDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditingTask(null);
        }}
        task={editingTask}
        resources={resources}
        avatarId={avatarId}
        projectId={currentProjectId}
        conversations={conversations}
        onCreateTaskConversation={onCreateTaskConversation}
        onSaved={load}
      />
      <DeleteConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title={t('common.delete')}
        description={t('common.deleteConfirm', { name: pendingDelete?.name ?? '' })}
        onConfirm={removeTask}
      />
    </PageShell>
  );
}

function TaskCard({
  task,
  active,
  onOpenHistory,
  onRun,
  onToggle,
  onEdit,
  onDelete,
}: {
  task: TaskItem;
  active: boolean;
  onOpenHistory: () => void;
  onRun: () => void;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  }) {
  const { t } = useTranslation();
  const scheduleLabel = describeTaskCron(task.cron, t);
  return (
    <ManageListRow
      title={task.name}
      leading={
        <span
          className={cn(
            'size-3 rounded-full border',
            task.enabled ? 'border-muted-foreground/60 bg-background' : 'border-muted-foreground/25 bg-muted',
          )}
        />
      }
      active={active}
      onOpen={onOpenHistory}
      meta={scheduleLabel}
      actions={
        <>
          <Button variant="ghost" size="icon-sm" onClick={onRun} title={t('task.runNow')} aria-label={t('task.runNow')}>
            <Play className="size-4" />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onEdit} title={t('common.edit')} aria-label={t('common.edit')}>
            <Pencil className="size-4" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" title={t('task.more')} aria-label={t('task.more')}>
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-32">
              <DropdownMenuItem onSelect={onToggle}>
                <PauseCircle className="size-4" />
                {task.enabled ? t('task.pause') : t('task.resume')}
              </DropdownMenuItem>
              {task.deletable !== false ? (
                <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                  <Trash2 className="size-4" />
                  {t('common.delete')}
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
    />
  );
}

function TaskHistoryDrawer({
  task,
  resources,
  conversations,
  onOpenConversation,
  onClose,
}: {
  task: TaskItem | null;
  resources: Resources;
  conversations: ManagedConversation[];
  onOpenConversation?: (input: { conversationId: string; title: string; prompt?: string; avatarId?: string; projectId?: string }) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [runs, setRuns] = useState<TaskRunItem[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(false);
  useEffect(() => {
    if (!task) {
      setRuns([]);
      return;
    }
    let cancelled = false;
    setRuns((task.runs ?? []).slice(0, TASK_RUN_HISTORY_LIMIT));
    setLoadingRuns(true);
    void webApiFetch(`/api/tasks/${encodeURIComponent(task.id)}/runs?limit=${TASK_RUN_HISTORY_LIMIT}`)
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as { runs?: TaskRunItem[]; error?: string };
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
        if (!cancelled) setRuns((body.runs ?? []).slice(0, TASK_RUN_HISTORY_LIMIT));
      })
      .catch((error) => {
        if (!cancelled) toast.error(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setLoadingRuns(false);
      });
    return () => {
      cancelled = true;
    };
  }, [task]);
  if (!task) return null;
  const scheduleLabel = describeTaskCron(task.cron, t);
  const selectedProject = task.projectId ? resources.projects.find((project) => project.id === task.projectId) : undefined;
  const selectedConversation = task.conversationId ? conversations.find((conversation) => conversation.id === task.conversationId) : undefined;
  const selectedModel = task.modelId ? llmModels(resources.models).find((model) => model.id === task.modelId) : undefined;
  const lastRun = runs.find((run) => run.startedAt || run.scheduledFor);
  const targetLabel = task.projectId
    ? (selectedProject?.name ?? task.projectId)
    : (selectedConversation?.title ?? t('task.newConversation', { defaultValue: '新对话' }));
  const runtimeLabel = task.projectId
    ? t('task.targetProject', { defaultValue: '项目' })
    : t('task.targetConversation', { defaultValue: '对话' });
  const openRunConversation = (run: TaskRunItem) => {
    const conversationId = run.conversationId ?? task.conversationId;
    if (!conversationId || !onOpenConversation) return;
    onOpenConversation({
      conversationId,
      title: task.name,
      prompt: task.prompt,
      avatarId: task.avatarId,
      projectId: task.projectId,
    });
    onClose();
  };
  return (
    <ManageDrawer
      open={Boolean(task)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={task.name}
      subtitle={t('task.details', { defaultValue: '任务详情' })}
      badge={<ManageStatusBadge variant={task.enabled ? 'secondary' : 'outline'}>{task.enabled ? t('task.enabled') : t('task.disabled')}</ManageStatusBadge>}
    >
      <div className="flex min-w-0 items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Clock />
        </span>
        <ManagePreviewBlock className="min-w-0 flex-1 whitespace-pre-wrap">{task.prompt || '-'}</ManagePreviewBlock>
      </div>

      <ManageDetailGrid>
        <ManageDetailItem label={t('task.nextRun', { defaultValue: '下次运行' })} value={task.enabled ? scheduleLabel : '-'} />
        <ManageDetailItem label={t('task.lastRun', { defaultValue: '上次运行时间' })} value={lastRun ? formatRelativeTime(lastRun.startedAt ?? lastRun.scheduledFor) : '-'} />
        <ManageDetailItem label={t('task.runtimeEnvironment', { defaultValue: '运行环境' })} value={runtimeLabel} />
        <ManageDetailItem label={runtimeLabel} value={targetLabel} />
        <ManageDetailItem label={t('task.schedule', { defaultValue: '重复次数' })} value={scheduleLabel} />
        <ManageDetailItem label={t('task.selectModel', { defaultValue: '模型' })} value={selectedModel ? modelDisplayLabel(selectedModel) : t('task.defaultModel', { defaultValue: '默认模型' })} />
        <ManageDetailItem label={t('task.permission', { defaultValue: '权限' })} value={t(`task.permissionMode.${task.permissionMode === 'full_access' ? 'full_access' : 'request_approval'}`)} />
        <ManageDetailItem label={t('task.timezone', { defaultValue: '时区' })} value={task.timezone ?? '-'} />
      </ManageDetailGrid>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <div className="text-xs font-medium text-muted-foreground">{t('task.history', { defaultValue: '运行历史记录' })}</div>
          {loadingRuns ? <Loader2 className="animate-spin text-muted-foreground" /> : null}
        </div>
        {runs.length > 0 ? (
          <ManageList>
            {runs.slice(0, TASK_RUN_HISTORY_LIMIT).map((run) => {
              const conversationId = run.conversationId ?? task.conversationId;
              const runStatusLabel = t(`task.runStatus.${run.status}`);
              const runDetail = run.error || run.summary;
              return (
                <button
                  key={run.id}
                  type="button"
                  disabled={!conversationId || !onOpenConversation}
                  onClick={() => openRunConversation(run)}
                  title={runDetail ? `${runStatusLabel}: ${runDetail}` : runStatusLabel}
                  className="group flex min-w-0 w-full items-center gap-3 rounded-lg px-1.5 py-2 text-left text-sm transition-colors hover:bg-muted/60 disabled:cursor-default disabled:hover:bg-transparent"
                >
                  <span className={cn('size-2 shrink-0 rounded-full', taskRunStatusDot(run.status))} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-foreground/80 group-hover:text-foreground">{task.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {targetLabel} · {runStatusLabel}{runDetail ? ` · ${runDetail}` : ''}
                    </span>
                  </span>
                  <span className="max-w-20 shrink-0 truncate text-xs text-muted-foreground">{formatRelativeTime(run.startedAt ?? run.scheduledFor)}</span>
                </button>
              );
            })}
          </ManageList>
        ) : (
          <EmptyState icon={<Clock className="size-5" />}>{t('task.noHistory')}</EmptyState>
        )}
      </section>
    </ManageDrawer>
  );
}

function formatRelativeTime(value?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  const diffMs = Date.now() - date.getTime();
  if (Number.isNaN(date.getTime())) return value;
  const abs = Math.abs(diffMs);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (abs < 60_000) return rtf.format(Math.round(-diffMs / 1000), 'second');
  if (abs < 3_600_000) return rtf.format(Math.round(-diffMs / 60_000), 'minute');
  if (abs < 86_400_000) return rtf.format(Math.round(-diffMs / 3_600_000), 'hour');
  return rtf.format(Math.round(-diffMs / 86_400_000), 'day');
}

function taskRunStatusDot(status: TaskRunItem['status']): string {
  if (status === 'completed') return 'bg-muted-foreground/35';
  if (status === 'failed') return 'bg-destructive';
  if (status === 'skipped') return 'bg-warning';
  if (status === 'running') return 'bg-success';
  return 'bg-info';
}
