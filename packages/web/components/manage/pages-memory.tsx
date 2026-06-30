'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { Check, Loader2, Pencil, Plus, RefreshCw, Sparkles, Trash2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { postJson, patchJson, deleteJson, webApiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { DeleteConfirmDialog } from '@/components/ui/delete-confirm-dialog';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { Resources } from '@/lib/useResources';
import {
  ManageDetailGrid,
  ManageDetailItem,
  ManageDialog,
  ManageDialogFooterActions,
  ManageDrawer,
  ManageEmptyState as EmptyState,
  ManageField,
  ManageForm,
  ManageList,
  ManageListRow,
  ManagePageShell as PageShell,
  ManagePreviewBlock,
  ManageSearchBar as SearchBar,
  ManageStatusBadge,
} from './manage-ui';
import type { PageProps } from './pageTypes';

type MemoryItem = {
  id: string;
  kind?: MemoryKind;
  workKind?: 'process' | 'result';
  memory?: string;
  tags?: string[];
  agentId?: string;
  userId?: string;
  spaceId?: string;
  subject?: 'user' | 'agent';
  source?: string;
  status?: string;
  messageIds?: string[];
  entities?: Array<{ type: string; name: string; role?: string }>;
  createdAt?: string;
  updatedAt?: string;
};

type MemoryCandidateItem = MemoryItem & {
  status?: string;
};

type MemoryKind = 'impression' | 'event' | 'experience';
type MemoryActorView = { userId: string; role?: string };
type MemoryDreamRunView = {
  id: string;
  status: string;
  startedAt?: string;
  finishedAt?: string;
  summary?: string;
  error?: string;
  metadata?: Record<string, unknown>;
};
type MemoryDreamView = {
  status: string;
  taskId?: string;
  lastRunAt?: string;
  running?: boolean;
  runs?: MemoryDreamRunView[];
};

export function MemoryPage({ resources, avatarId, onBack }: PageProps) {
  const { t } = useTranslation();
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [candidates, setCandidates] = useState<MemoryCandidateItem[]>([]);
  const [actor, setActor] = useState<MemoryActorView | null>(null);
  const [dream, setDream] = useState<MemoryDreamView | null>(null);
  const [dreamRunning, setDreamRunning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<MemoryItem | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [selectedMemoryId, setSelectedMemoryId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'experiences' | 'people' | 'events'>('experiences');

  const load = () => {
    let cancelled = false;
    setLoading(true);
    webApiFetch(`/api/memory?agentId=${encodeURIComponent(avatarId)}`)
      .then((r) => r.json())
      .then((d: { memories?: MemoryItem[]; candidates?: MemoryCandidateItem[]; actor?: MemoryActorView; dream?: MemoryDreamView }) => {
        if (!cancelled) {
          setItems(d.memories ?? []);
          setCandidates(d.candidates ?? []);
          setActor(d.actor ?? null);
          setDream(d.dream ?? null);
        }
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  };

  useEffect(() => {
    return load();
  }, [avatarId]);

  const searchableText = (m: MemoryItem) =>
    `${memoryText(m)} ${m.kind ?? ''} ${m.userId ?? ''} ${m.spaceId ?? ''} ${m.source ?? ''} ${(m.tags ?? []).join(' ')}`.toLowerCase();
  const filtered = items.filter((m) => searchableText(m).includes(q.toLowerCase()));
  const filteredCandidates = candidates.filter((m) => searchableText(m).includes(q.toLowerCase()));
  const people = filtered.filter((m) => m.kind === 'impression');
  const events = filtered.filter((m) => m.kind === 'event');
  const experiences = filtered.filter((m) => m.kind === 'experience');
  const pendingDelete = items.find((m) => m.id === pendingDeleteId) ?? null;
  const selectedMemory = selectedMemoryId ? items.find((m) => m.id === selectedMemoryId) ?? null : null;
  const spaceLabel = (spaceId?: string) => {
    if (!spaceId) return t('memory.global');
    return resources.spaces.find((space) => space.id === spaceId || space.storageId === spaceId)?.label ?? spaceId;
  };

  const remove = async (id: string) => {
    await deleteJson('/api/memory', { id });
    toast.success(t('memory.deleted'));
    if (selectedMemoryId === id) setSelectedMemoryId(null);
    load();
  };

  const reviewCandidate = async (candidateId: string, action: 'promote' | 'reject') => {
    await patchJson('/api/memory', { agentId: avatarId, candidateId, action });
    toast.success(action === 'promote' ? t('memory.candidatePromoted') : t('memory.candidateRejected'));
    load();
  };

  const runDream = async () => {
    setDreamRunning(true);
    try {
      const response = (await postJson('/api/memory', { action: 'run_dream', agentId: avatarId })) as {
        summary?: MemoryDreamView;
        dream?: MemoryDreamView;
      };
      setDream(response.summary ?? response.dream ?? null);
      toast.success(t('memory.dreamCompleted', { defaultValue: 'Dream 已完成' }));
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setDreamRunning(false);
    }
  };

  return (
    <PageShell
      icon={<Sparkles className="size-4" />}
      title={t('memory.title')}
      onBack={onBack}
      actions={
        <Button size="icon-lg" onClick={() => setCreateOpen(true)} title={t('memory.new')} aria-label={t('memory.new')}>
          <Plus className="size-4" />
        </Button>
      }
      toolbar={<SearchBar value={q} onChange={setQ} placeholder={t('memory.search')} />}
    >
      <MemoryDreamStatus dream={dream} running={dreamRunning} onRun={runDream} />
      {filteredCandidates.length > 0 ? (
        <div className="mb-4 space-y-1.5">
          <div className="px-1 text-sm font-semibold text-muted-foreground">{t('memory.candidates')}</div>
          <ManageList>
            {filteredCandidates.map((m) => {
              const title = memoryText(m) || m.id;
              const updatedAt = m.updatedAt ?? m.createdAt;
              const fullUpdatedAt = formatMemoryDate(updatedAt);
              return (
                <ManageListRow
                  key={m.id}
                  title={<span title={title}>{title}</span>}
                  meta={
                    <time dateTime={updatedAt} title={fullUpdatedAt}>
                      {formatMemoryTime(updatedAt)}
                    </time>
                  }
                  actions={
                    <>
                      <Button variant="ghost" size="icon-sm" onClick={() => reviewCandidate(m.id, 'promote')} title={t('memory.approve')} aria-label={t('memory.approve')}>
                        <Check className="size-4" />
                      </Button>
                      <Button variant="ghost" size="icon-sm" onClick={() => reviewCandidate(m.id, 'reject')} title={t('memory.reject')} aria-label={t('memory.reject')}>
                        <X className="size-4" />
                      </Button>
                    </>
                  }
                />
              );
            })}
          </ManageList>
        </div>
      ) : null}
      {!loading ? (
        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as typeof activeTab)} className="flex w-full flex-col gap-4">
          <TabsList className="grid h-10 w-full grid-cols-3 rounded-xl border border-border/70 bg-muted/25 p-1">
            <TabsTrigger value="experiences" className="gap-2">
              {t('memory.experiences')}
              <Badge variant="secondary" className="h-5 px-1.5 text-xs font-normal">{experiences.length}</Badge>
            </TabsTrigger>
            <TabsTrigger value="people" className="gap-2">
              {t('memory.people')}
              <Badge variant="secondary" className="h-5 px-1.5 text-xs font-normal">{people.length}</Badge>
            </TabsTrigger>
            <TabsTrigger value="events" className="gap-2">
              {t('memory.events')}
              <Badge variant="secondary" className="h-5 px-1.5 text-xs font-normal">{events.length}</Badge>
            </TabsTrigger>
          </TabsList>
          <TabsContent value="experiences" className="mt-0 w-full">
            <MemoryTable
              rows={experiences}
              empty={t('memory.experiencesEmpty')}
              onOpen={(item) => setSelectedMemoryId(item.id)}
              onEdit={setEditTarget}
              onDelete={setPendingDeleteId}
            />
          </TabsContent>
          <TabsContent value="people" className="mt-0 w-full">
            <MemoryTable
              rows={people}
              empty={t('memory.peopleEmpty')}
              onOpen={(item) => setSelectedMemoryId(item.id)}
              onEdit={setEditTarget}
              onDelete={setPendingDeleteId}
            />
          </TabsContent>
          <TabsContent value="events" className="mt-0 w-full">
            <EventMemoryList
              rows={events}
              empty={t('memory.eventsEmpty')}
              onOpen={(item) => setSelectedMemoryId(item.id)}
              onDelete={setPendingDeleteId}
            />
          </TabsContent>
        </Tabs>
      ) : (
        <EmptyState icon={<Sparkles className="size-5" />}>{t('common.loading')}</EmptyState>
      )}
      <MemoryDialog open={createOpen} onOpenChange={setCreateOpen} avatarId={avatarId} resources={resources} actor={actor} onSaved={() => load()} />
      <MemoryDetailDrawer
        item={selectedMemory}
        spaceLabel={spaceLabel}
        onClose={() => setSelectedMemoryId(null)}
        onEdit={(item) => setEditTarget(item)}
        onDelete={(id) => setPendingDeleteId(id)}
      />
      <MemoryDialog
        open={Boolean(editTarget)}
        onOpenChange={(open) => !open && setEditTarget(null)}
        avatarId={avatarId}
        resources={resources}
        actor={actor}
        editTarget={editTarget}
        onSaved={() => {
          setEditTarget(null);
          load();
        }}
      />
      <DeleteConfirmDialog
        open={pendingDeleteId !== null}
        onOpenChange={(open) => !open && setPendingDeleteId(null)}
        title={t('common.delete')}
        description={t('memory.deleteConfirm', { name: pendingDelete ? memoryText(pendingDelete) : pendingDeleteId || '' })}
        onConfirm={async () => {
          if (!pendingDeleteId) return;
          try {
            await remove(pendingDeleteId);
          } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err));
            throw err;
          }
        }}
      />
    </PageShell>
  );
}

function MemoryDreamStatus({
  dream,
  running,
  onRun,
}: {
  dream: MemoryDreamView | null;
  running: boolean;
  onRun: () => void;
}) {
  const { t } = useTranslation();
  const busy = running || dream?.running === true;
  const status = dreamStatusLabel(dream?.status, t);
  const lastRun = dream?.lastRunAt ? formatMemoryDate(dream.lastRunAt) : t('memory.dreamNever', { defaultValue: '还没有运行记录' });
  const latestError = dream?.runs?.find((run) => run.error)?.error;

  return (
    <div className="mb-4 flex flex-col gap-3 rounded-lg border border-border/70 bg-muted/20 px-3 py-2.5 text-xs sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
          <Sparkles className="size-4 text-primary" />
          <span>{t('memory.dreamTitle', { defaultValue: 'Dream 自动沉淀' })}</span>
          <Badge variant={dream?.status === 'failed' ? 'destructive' : 'secondary'} className="h-5 px-1.5 text-xs font-normal">
            {status}
          </Badge>
        </div>
        <div className="mt-1 truncate text-muted-foreground">
          {t('memory.dreamLastRun', { defaultValue: '上次运行' })}: {lastRun}
          {latestError ? ` · ${latestError}` : ''}
        </div>
      </div>
      <Button type="button" variant="outline" size="sm" onClick={onRun} disabled={busy} className="shrink-0 gap-2">
        {busy ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
        <span>{t('memory.runDreamNow', { defaultValue: '立即运行' })}</span>
      </Button>
    </div>
  );
}

function dreamStatusLabel(status: string | undefined, t: ReturnType<typeof useTranslation>['t']): string {
  switch (status) {
    case 'queued':
      return t('memory.dreamStatusQueued', { defaultValue: '排队中' });
    case 'running':
      return t('memory.dreamStatusRunning', { defaultValue: '运行中' });
    case 'completed':
      return t('memory.dreamStatusCompleted', { defaultValue: '已完成' });
    case 'failed':
      return t('memory.dreamStatusFailed', { defaultValue: '失败' });
    case 'skipped':
      return t('memory.dreamStatusSkipped', { defaultValue: '已跳过' });
    default:
      return t('memory.dreamStatusIdle', { defaultValue: '未运行' });
  }
}

function MemoryTable({
  rows,
  empty,
  onOpen,
  onEdit,
  onDelete,
}: {
  rows: MemoryItem[];
  empty: string;
  onOpen: (item: MemoryItem) => void;
  onEdit: (item: MemoryItem) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <section>
      {rows.length === 0 ? (
        <EmptyState icon={<Sparkles className="size-5" />}>{empty}</EmptyState>
      ) : (
        <ManageList>
          {rows.map((m) => (
            <MemoryRow
              key={m.id}
              item={m}
              editable={m.kind === 'impression'}
              onOpen={() => onOpen(m)}
              onEdit={() => onEdit(m)}
              onDelete={() => onDelete(m.id)}
            />
          ))}
        </ManageList>
      )}
    </section>
  );
}

function MemoryRow({
  item,
  editable,
  onOpen,
  onEdit,
  onDelete,
}: {
  item: MemoryItem;
  editable: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const primary = memoryText(item) || item.id;
  const updatedAt = item.updatedAt ?? item.createdAt;
  const fullUpdatedAt = formatMemoryDate(updatedAt);
  const eventWorkLabel = item.kind === 'event' ? memoryEventWorkKindLabel(item.workKind, t) : null;
  return (
    <ManageListRow
      title={
        <span className="flex min-w-0 items-center gap-2" title={primary}>
          {eventWorkLabel ? (
            <span className={cn('inline-flex h-5 shrink-0 items-center rounded-sm border px-1.5 text-2xs font-medium', memoryEventWorkKindClass(item.workKind))}>
              {eventWorkLabel}
            </span>
          ) : null}
          <span className="min-w-0 truncate">{primary}</span>
        </span>
      }
      onOpen={onOpen}
      meta={
        <time dateTime={updatedAt} title={fullUpdatedAt}>
          {formatMemoryTime(updatedAt)}
        </time>
      }
      actions={
        <>
          {editable ? (
            <Button variant="ghost" size="icon-sm" onClick={onEdit} title={t('common.edit')} aria-label={t('common.edit')}>
              <Pencil className="size-4" />
            </Button>
          ) : null}
        <Button variant="ghost" size="icon-sm" onClick={onDelete} title={t('common.delete')} aria-label={t('common.delete')}>
          <Trash2 className="size-4" />
        </Button>
        </>
      }
    />
  );
}

function EventMemoryList({
  rows,
  empty,
  onOpen,
  onDelete,
}: {
  rows: MemoryItem[];
  empty: string;
  onOpen: (item: MemoryItem) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <section>
      {rows.length === 0 ? (
        <EmptyState icon={<Sparkles className="size-5" />}>{empty}</EmptyState>
      ) : (
        <ManageList>
          {rows.map((m) => (
            <MemoryRow
              key={m.id}
              item={m}
              editable={false}
              onOpen={() => onOpen(m)}
              onEdit={() => undefined}
              onDelete={() => onDelete(m.id)}
            />
          ))}
        </ManageList>
      )}
    </section>
  );
}

function MemoryDetailDrawer({
  item,
  spaceLabel,
  onClose,
  onEdit,
  onDelete,
}: {
  item: MemoryItem | null;
  spaceLabel: (spaceId?: string) => string;
  onClose: () => void;
  onEdit: (item: MemoryItem) => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslation();
  if (!item) return null;
  const canEdit = item.kind === 'impression';
  return (
    <ManageDrawer
      open={Boolean(item)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={memoryText(item) || item.id}
      subtitle={memoryScopeLabel(item, t, spaceLabel)}
      badge={<ManageStatusBadge>{memoryKindLabel(item.kind, t)}</ManageStatusBadge>}
      actions={
        <>
          {canEdit ? (
            <Button variant="ghost" size="icon-sm" onClick={() => onEdit(item)} title={t('common.edit')} aria-label={t('common.edit')}>
              <Pencil />
            </Button>
          ) : null}
          <Button variant="ghost" size="icon-sm" onClick={() => onDelete(item.id)} title={t('common.delete')} aria-label={t('common.delete')}>
            <Trash2 />
          </Button>
        </>
      }
    >
      <div>
        <div className="mb-2 text-xs font-medium text-muted-foreground">{t('memory.memory')}</div>
        <ManagePreviewBlock className="whitespace-pre-wrap leading-6">{memoryText(item) || '-'}</ManagePreviewBlock>
      </div>

      <ManageDetailGrid>
        <ManageDetailItem label={t('memory.scope')} value={memoryScopeLabel(item, t, spaceLabel)} />
        {item.kind === 'impression' ? <ManageDetailItem label={t('memory.target')} value={memorySubjectLabel(item.subject, t)} /> : null}
        {item.kind !== 'experience' ? <ManageDetailItem label={t('memory.space')} value={spaceLabel(item.spaceId)} /> : null}
        <ManageDetailItem label={t('memory.updated')} value={formatMemoryDate(item.updatedAt ?? item.createdAt)} />
        <ManageDetailItem label={t('memory.source')} value={item.source ?? '-'} />
        {item.userId ? <ManageDetailItem label={t('memory.user')} value={item.userId} /> : null}
      </ManageDetailGrid>

      {item.tags?.length ? (
        <div>
          <div className="mb-2 text-xs font-medium text-muted-foreground">{t('memory.tags')}</div>
          <div className="flex flex-wrap gap-1.5">
            {item.tags.map((tag) => (
              <Badge key={tag} variant="secondary" className="h-5 px-1.5 text-xs font-normal">{tag}</Badge>
            ))}
          </div>
        </div>
      ) : null}

      {item.entities?.length ? (
        <div>
          <div className="mb-2 text-xs font-medium text-muted-foreground">{t('memory.entities')}</div>
          <div className="flex flex-wrap gap-1.5">
            {item.entities.map((entity, index) => (
              <Badge key={`${entity.type}:${entity.name}:${index}`} variant="outline" className="h-6 px-2 text-xs font-normal">
                {entity.type}: {entity.name}{entity.role ? ` · ${entity.role}` : ''}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}

      {item.messageIds?.length ? (
        <div>
          <div className="mb-2 text-xs font-medium text-muted-foreground">{t('memory.messageRefs')}</div>
          <div className="flex flex-wrap gap-1.5">
            {item.messageIds.map((id) => (
              <code key={id} className="rounded-md border border-border bg-muted/45 px-1.5 py-0.5 text-2xs text-muted-foreground">
                {shortMessageRef(id)}
              </code>
            ))}
          </div>
        </div>
      ) : null}
    </ManageDrawer>
  );
}

function shortMessageRef(id: string): string {
  const parts = id.split(':');
  return parts.length > 4 ? parts.slice(-3).join(':') : id;
}

function memoryText(item: MemoryItem | null | undefined): string {
  return item?.memory?.trim() ?? '';
}

function memoryKindLabel(kind: MemoryKind | undefined, t: ReturnType<typeof useTranslation>['t']): string {
  if (kind === 'event') return t('memory.kindEvent');
  if (kind === 'experience') return t('memory.kindExperience');
  return t('memory.kindImpression');
}

function memoryEventWorkKindLabel(workKind: MemoryItem['workKind'], t: ReturnType<typeof useTranslation>['t']): string {
  if (workKind === 'process') return t('memory.workKindProcess');
  if (workKind === 'result') return t('memory.workKindResult');
  return t('memory.workKindUnknown');
}

function memoryEventWorkKindClass(workKind: MemoryItem['workKind']): string {
  if (workKind === 'process') return 'border-info/30 bg-info/10 text-info';
  if (workKind === 'result') return 'border-success/30 bg-success/10 text-success';
  return 'border-border bg-muted/45 text-muted-foreground';
}

function memoryScopeLabel(m: MemoryItem, t: ReturnType<typeof useTranslation>['t'], spaceLabel: (spaceId?: string) => string): string {
  if (m.kind === 'experience') {
    return t('memory.scopeAgentShared');
  }
  if (m.kind === 'event') {
    return `${spaceLabel(m.spaceId)} · ${m.userId || t('memory.unknownUser')}`;
  }
  return `${t('memory.scopeUser')} · ${m.userId || t('memory.unknownUser')}`;
}

function memorySubjectLabel(subject: MemoryItem['subject'], t: ReturnType<typeof useTranslation>['t']): string {
  return subject === 'agent' ? t('memory.scopeAgent') : t('memory.scopeUser');
}

export function formatMemoryDate(value?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString();
}

function formatMemoryTime(value?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  const dateOptions: Intl.DateTimeFormatOptions =
    date.getFullYear() === now.getFullYear()
      ? { month: '2-digit', day: '2-digit' }
      : { year: 'numeric', month: '2-digit', day: '2-digit' };
  return date.toLocaleDateString([], dateOptions);
}

function MemoryDialog({
  open,
  onOpenChange,
  avatarId,
  resources,
  actor,
  editTarget,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  avatarId: string;
  resources: Resources;
  actor: MemoryActorView | null;
  editTarget?: MemoryItem | null;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const spaceOptions = memorySpaceOptions(resources.spaces);
  const defaultSpaceId = spaceOptions[0]?.id ?? '';
  const [kind, setKind] = useState<MemoryKind>('impression');
  const [personTarget, setPersonTarget] = useState<'user' | 'agent'>('user');
  const [targetUserId, setTargetUserId] = useState('');
  const [spaceId, setSpaceId] = useState('');
  const [memory, setMemory] = useState('');
  const [tags, setTags] = useState('');
  const [busy, setBusy] = useState(false);
  const editing = Boolean(editTarget);

  useEffect(() => {
    if (!open) return;
    const nextKind = editTarget?.kind ?? 'impression';
    setKind(nextKind);
    setPersonTarget(editTarget?.subject === 'agent' ? 'agent' : 'user');
    setTargetUserId(editTarget?.userId ?? actor?.userId ?? '');
    setSpaceId(editTarget?.spaceId ?? defaultSpaceId);
    setMemory(memoryText(editTarget ?? undefined));
    setTags((editTarget?.tags ?? []).join(', '));
  }, [open, editTarget, actor?.userId, defaultSpaceId]);

  const submit = async () => {
    if (!memory.trim()) {
      toast.error(t('memory.validation'));
      return;
    }
    if (!editing && kind === 'event' && !spaceId.trim()) {
      toast.error(t('memory.spaceRequired'));
      return;
    }
    setBusy(true);
    try {
      const payload = {
        memory: memory.trim(),
        tags: tags.split(/[,\s]+/).map((tag) => tag.trim()).filter(Boolean),
      };
      if (editing && editTarget) {
        await patchJson('/api/memory', { id: editTarget.id, ...payload });
        toast.success(t('memory.saved'));
      } else {
        await postJson('/api/memory', {
          ...payload,
          agentId: avatarId,
          kind,
          targetType: kind === 'impression' ? 'user' : kind === 'event' ? 'space_user' : 'agent',
          subject: kind === 'impression' ? personTarget : undefined,
          targetUserId: kind === 'event' || kind === 'impression' ? targetUserId.trim() || actor?.userId : undefined,
          spaceId: kind === 'event' ? spaceId.trim() : undefined,
        });
        toast.success(t('memory.created'));
      }
      onSaved();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ManageDialog
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? t('memory.edit') : t('memory.new')}
      description={editing ? t('memory.editDesc') : t('memory.newDesc')}
      footer={
        <ManageDialogFooterActions
          onCancel={() => onOpenChange(false)}
          onConfirm={submit}
          confirmLabel={editing ? t('common.save') : t('common.create')}
          busy={busy}
        />
      }
    >
      <ManageForm>
        <ManageField label={t('memory.kind')}>
          <Select value={kind} onValueChange={(value) => setKind(value as MemoryKind)} disabled={editing}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="impression">{t('memory.kindImpression')}</SelectItem>
                <SelectItem value="experience">{t('memory.kindExperience')}</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </ManageField>
          {!editing ? (
            <MemoryScopeFields
              kind={kind}
              personTarget={personTarget}
              onPersonTargetChange={setPersonTarget}
              targetUserId={targetUserId}
              onTargetUserIdChange={setTargetUserId}
              spaceId={spaceId}
              onSpaceIdChange={setSpaceId}
              spaces={spaceOptions}
              currentUserId={actor?.userId}
            />
          ) : editTarget ? (
            <ManagePreviewBlock className="text-sm text-muted-foreground">
              {t('memory.scope')}: {memoryScopeLabel(editTarget, t, (id) => resources.spaces.find((space) => space.id === id || space.storageId === id)?.label ?? id ?? t('memory.global'))}
            </ManagePreviewBlock>
          ) : null}
        <ManageField label={t('memory.memory')} htmlFor="memory-text">
          <Textarea id="memory-text" value={memory} onChange={(event) => setMemory(event.target.value)} placeholder={t('memory.memoryPlaceholder')} className="min-h-28 resize-y" autoFocus />
        </ManageField>
        <ManageField label={t('memory.tags')} htmlFor="memory-tags">
          <Input id="memory-tags" value={tags} onChange={(event) => setTags(event.target.value)} placeholder={t('memory.tagsPlaceholder')} />
        </ManageField>
      </ManageForm>
    </ManageDialog>
  );
}

const MAIN_MEMORY_SPACE_ID = 'main';

function memorySpaceOptions(spaces: Resources['spaces']): Resources['spaces'] {
  const mainSpace = spaces.find(
    (space) =>
      space.kind === 'main' ||
      space.id === MAIN_MEMORY_SPACE_ID ||
      space.storageId === MAIN_MEMORY_SPACE_ID ||
      space.canonicalId === MAIN_MEMORY_SPACE_ID,
  );
  const mainOption: Resources['spaces'][number] = mainSpace ?? {
    id: MAIN_MEMORY_SPACE_ID,
    storageId: MAIN_MEMORY_SPACE_ID,
    canonicalId: MAIN_MEMORY_SPACE_ID,
    kind: 'main',
    label: 'Main',
    toolIds: [],
  };
  const seen = new Set(spaceIdentityKeys(mainOption));
  return [mainOption, ...spaces.filter((space) => !spaceIdentityKeys(space).some((key) => seen.has(key)))];
}

function spaceIdentityKeys(space: Resources['spaces'][number]): string[] {
  return [space.id, space.storageId, space.canonicalId].filter((key): key is string => Boolean(key));
}

function MemoryScopeFields({
  kind,
  personTarget,
  onPersonTargetChange,
  targetUserId,
  onTargetUserIdChange,
  spaceId,
  onSpaceIdChange,
  spaces,
  currentUserId,
}: {
  kind: MemoryKind;
  personTarget: 'user' | 'agent';
  onPersonTargetChange: (value: 'user' | 'agent') => void;
  targetUserId: string;
  onTargetUserIdChange: (value: string) => void;
  spaceId: string;
  onSpaceIdChange: (value: string) => void;
  spaces: Resources['spaces'];
  currentUserId?: string;
}) {
  const { t } = useTranslation();
  const needsUser = kind === 'event' || kind === 'impression';
  const needsSpace = kind === 'event';
  return (
    <ManageForm className="gap-4 rounded-xl border border-border/70 bg-muted/20 p-3">
      {kind === 'impression' ? (
        <ManageField label={t('memory.target')}>
          <Select value={personTarget} onValueChange={(value) => onPersonTargetChange(value as 'user' | 'agent')}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="user">{t('memory.scopeUser')}</SelectItem>
                <SelectItem value="agent">{t('memory.scopeAgent')}</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </ManageField>
      ) : null}
      {needsSpace ? (
        <ManageField label={t('memory.space')}>
          {spaces.length > 0 ? (
            <Select value={spaceId} onValueChange={onSpaceIdChange}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t('memory.spacePlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {spaces.map((space) => (
                    <SelectItem key={space.id} value={space.id}>{space.label}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          ) : (
            <Input value={spaceId} onChange={(event) => onSpaceIdChange(event.target.value)} placeholder={t('memory.spacePlaceholder')} />
          )}
        </ManageField>
      ) : null}
      {needsUser ? (
        <ManageField label={t('memory.user')} htmlFor="memory-user">
          <Input
            id="memory-user"
            value={targetUserId}
            onChange={(event) => onTargetUserIdChange(event.target.value)}
            placeholder={currentUserId || t('memory.userPlaceholder')}
          />
        </ManageField>
      ) : null}
      <div className="text-sm text-muted-foreground">
        {kind === 'impression' ? t('memory.peopleRule') : kind === 'event' ? t('memory.eventsRule') : t('memory.experiencesRule')}
      </div>
    </ManageForm>
  );
}
