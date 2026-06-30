'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import {
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  Globe,
  Loader2,
  Pencil,
  PlugZap,
  RefreshCw,
  SearchX,
  ShieldCheck,
  Trash2,
  Zap,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ArtifactPreviewContent } from '@/components/ArtifactPreviewContent';
import { postJson, patchJson, deleteJson, webApiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { DeleteConfirmDialog } from '@/components/ui/delete-confirm-dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { SkillView } from '@/lib/useResources';
import { SkillDialog } from './SkillDialog';
import { TaskDialogChip } from './TaskDialog';
import {
  ManageDetailGrid,
  ManageDetailItem,
  ManageAddButton,
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
  ManageSectionLabel as SectionLabel,
  ManageStatusBadge,
} from './manage-ui';
import type { PageProps } from './pageTypes';

type SkillScanSourceType = 'project' | 'user' | 'admin' | 'system' | 'imported';
type SkillFileEdit = {
  skill: SkillView;
  path: string;
  content: string;
  packageFile: boolean;
};

type SkillFilePreview = SkillFileEdit & {
  kind?: string;
};

type MarketplaceSkillResult = {
  id: string;
  slug: string;
  name: string;
  source: string;
  installs: number;
  sourceType: string;
  installUrl?: string | null;
  url: string;
  installed?: boolean;
  audit?: {
    status: 'pass' | 'warn' | 'fail' | 'unknown';
    audits?: Array<{ provider: string; status: string; summary?: string; riskLevel?: string }>;
  };
};

type MarketplaceSkillDetail = {
  id: string;
  source: string;
  slug: string;
  installs: number;
  files: Array<{ path: string; contents: string }>;
  skillMd?: string;
  audit?: MarketplaceSkillResult['audit'];
  url: string;
};

export function SkillPage({ resources, avatarId, currentProjectId, onChanged, onBack }: PageProps) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<SkillView | null>(null);
  const [selectedSkillId, setSelectedSkillId] = useState('');
  const [selectedSkillFile, setSelectedSkillFile] = useState<{ skillId: string; path: string } | null>(null);
  const [skillFilePreview, setSkillFilePreview] = useState<SkillFilePreview | null>(null);
  const [skillFilePreviewLoading, setSkillFilePreviewLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<SkillView | null>(null);
  const [fileEdit, setFileEdit] = useState<SkillFileEdit | null>(null);
  const [scanning, setScanning] = useState(false);
  const [togglingSkillId, setTogglingSkillId] = useState<string | null>(null);
  const [marketplaceResults, setMarketplaceResults] = useState<MarketplaceSkillResult[]>([]);
  const [marketplaceSearched, setMarketplaceSearched] = useState(false);
  const [marketplaceSearching, setMarketplaceSearching] = useState(false);
  const [marketplaceError, setMarketplaceError] = useState<string | null>(null);
  const [marketplaceDetail, setMarketplaceDetail] = useState<MarketplaceSkillDetail | null>(null);
  const [marketplaceSelectedId, setMarketplaceSelectedId] = useState('');
  const [marketplaceLoadingDetail, setMarketplaceLoadingDetail] = useState(false);
  const [marketplaceImportingId, setMarketplaceImportingId] = useState('');
  const autoScannedProjectKeys = useRef<Set<string>>(new Set());
  const currentProject = currentProjectId ? resources.projects.find((project) => project.id === currentProjectId) : undefined;
  const skillWritesAvailable = resources.persistence.reachable;
  const skillDatabaseRequiredMessage = t('skill.databaseRequired', {
    defaultValue: '技能需要数据库才能保存。请用 pnpm dev:web 启动 WebUI，或配置 ZLEAP_DATABASE_URL 后重启。',
  });
  const searchQuery = q.trim();
  const normalizedQuery = searchQuery.toLowerCase();
  const shouldSearchMarketplace = searchQuery.length >= 2;
  const filtered = resources.skills.filter((s) =>
    `${s.label} ${s.id} ${s.description ?? ''} ${s.sourceName ?? ''} ${(s.allowedTools ?? []).join(' ')} ${(s.disallowedTools ?? []).join(' ')}`
      .toLowerCase()
      .includes(normalizedQuery),
  );
  const selectedSkill = selectedSkillId ? resources.skills.find((skill) => skill.id === selectedSkillId) : undefined;
  const selectedMarketplaceSkill = marketplaceSelectedId ? marketplaceResults.find((skill) => skill.id === marketplaceSelectedId) : undefined;
  const showMarketplaceResults = shouldSearchMarketplace && (marketplaceSearching || marketplaceSearched || marketplaceResults.length > 0 || Boolean(marketplaceError));
  useEffect(() => {
    if (!selectedSkillId) return;
    if (!resources.skills.some((skill) => skill.id === selectedSkillId)) {
      setSelectedSkillId('');
      setSelectedSkillFile(null);
      setSkillFilePreview(null);
    }
  }, [resources.skills, selectedSkillId]);

  useEffect(() => {
    setExpanded((prev) => {
      const ids = new Set(resources.skills.map((skill) => skill.id));
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [resources.skills]);

  useEffect(() => {
    if (!shouldSearchMarketplace) {
      setMarketplaceResults([]);
      setMarketplaceSearched(false);
      setMarketplaceSearching(false);
      setMarketplaceError(null);
      setMarketplaceDetail(null);
      setMarketplaceSelectedId('');
      return;
    }

    setMarketplaceDetail(null);
    setMarketplaceSelectedId('');
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setMarketplaceSearching(true);
      setMarketplaceError(null);
      try {
        const params = new URLSearchParams({ q: searchQuery, limit: '12' });
        const response = await webApiFetch(`/api/skills/marketplace/search?${params.toString()}`);
        const data = (await response.json().catch(() => ({}))) as { skills?: MarketplaceSkillResult[]; error?: string; message?: string };
        if (!response.ok) throw new Error(data.message ?? data.error ?? `HTTP ${response.status}`);
        if (cancelled) return;
        setMarketplaceResults(data.skills ?? []);
        setMarketplaceSearched(true);
      } catch (err) {
        if (cancelled) return;
        setMarketplaceResults([]);
        setMarketplaceSearched(true);
        setMarketplaceError(skillMarketplaceErrorMessage(t, err));
      } finally {
        if (!cancelled) setMarketplaceSearching(false);
      }
    }, 350);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [searchQuery, shouldSearchMarketplace, t]);

  const removeSkill = async () => {
    if (!pendingDelete) return;
    try {
      await deleteJson('/api/skills', { id: pendingDelete.id, version: pendingDelete.version });
      toast.success(t('common.deleted', { defaultValue: '已删除' }));
      if (selectedSkillId === pendingDelete.id) {
        setSelectedSkillId('');
        setSelectedSkillFile(null);
        setSkillFilePreview(null);
      }
      setPendingDelete(null);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const scanSkills = async (options: { root?: string; projectRoot?: string; sourceType?: SkillScanSourceType; silent?: boolean } = {}) => {
    if (!skillWritesAvailable) {
      if (!options.silent) toast.error(skillDatabaseRequiredMessage);
      return;
    }
    setScanning(true);
    try {
      const projectRoot = options.projectRoot ?? (!options.root ? currentProject?.path : undefined);
      const body = options.root
        ? { avatarId, roots: [{ root: options.root, sourceType: options.sourceType ?? 'user' }] }
        : { avatarId, projectRoot };
      const result = (await postJson('/api/skills/scan', body)) as { skills?: SkillView[]; errors?: unknown[] };
      const count = result.skills?.length ?? 0;
      if (!options.silent || count > 0 || result.errors?.length) {
        toast.success(t('skill.scanned', { defaultValue: '已扫描 {{count}} 个技能', count }));
      }
      if (result.errors?.length) {
        toast.warning(t('skill.scanErrors', { defaultValue: '部分技能扫描失败' }));
      }
      onChanged();
    } catch (err) {
      toast.error(skillErrorMessage(t, err));
    } finally {
      setScanning(false);
    }
  };

  useEffect(() => {
    if (!currentProject?.path) return;
    const key = `${currentProject.id}:${currentProject.path}`;
    if (autoScannedProjectKeys.current.has(key)) return;
    autoScannedProjectKeys.current.add(key);
    void scanSkills({ projectRoot: currentProject.path, sourceType: 'project', silent: true });
    // `scanSkills` intentionally stays out of deps to avoid re-scanning after resource reloads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject?.id, currentProject?.path]);

  const loadSkillFile = async (skill: SkillView, path: string): Promise<SkillFilePreview> => {
    const kind = skillFileRows(skill).find((file) => file.path === path)?.kind;
    if (!skill.packageRoot) {
      return {
        skill,
        path,
        content: skill.body ?? skill.instructions ?? '',
        packageFile: false,
        kind,
      };
    }
    const params = new URLSearchParams({ path });
    if (skill.version) params.set('version', String(skill.version));
    const response = await webApiFetch(`/api/skills/${encodeURIComponent(skill.id)}/files?${params.toString()}`);
    const data = (await response.json().catch(() => ({}))) as { path?: string; content?: string; error?: string };
    if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
    return { skill, path: data.path ?? path, content: data.content ?? '', packageFile: true, kind };
  };

  const previewSkillFile = async (skill: SkillView, path: string) => {
    setMarketplaceSelectedId('');
    setMarketplaceDetail(null);
    setSelectedSkillId(skill.id);
    setSelectedSkillFile({ skillId: skill.id, path });
    setSkillFilePreview(null);
    setSkillFilePreviewLoading(true);
    try {
      setSkillFilePreview(await loadSkillFile(skill, path));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setSelectedSkillFile(null);
    } finally {
      setSkillFilePreviewLoading(false);
    }
  };

  const editSkillFile = async (skill: SkillView, path: string) => {
    try {
      setFileEdit(await loadSkillFile(skill, path));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const saveSkillFile = async (draft: SkillFileEdit) => {
    try {
      if (draft.packageFile) {
        await patchJson(`/api/skills/${encodeURIComponent(draft.skill.id)}/files`, {
          version: draft.skill.version,
          path: draft.path,
          content: draft.content,
        });
      } else {
        await patchJson(`/api/skills/${encodeURIComponent(draft.skill.id)}`, {
          version: draft.skill.version,
          instructions: draft.content,
        });
      }
      toast.success(t('common.saved', { defaultValue: '已保存' }));
      setFileEdit(null);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const toggleSkill = async (skill: SkillView, enabled: boolean) => {
    setTogglingSkillId(skill.id);
    try {
      await patchJson(`/api/skills/${encodeURIComponent(skill.id)}`, {
        version: skill.version,
        invocationPolicy: enabled ? (skill.invocationPolicy === 'disabled' ? 'implicit' : skill.invocationPolicy ?? 'implicit') : 'disabled',
      });
      await onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setTogglingSkillId(null);
    }
  };

  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const openMarketplaceDetail = async (skill: MarketplaceSkillResult) => {
    setSelectedSkillId('');
    setSelectedSkillFile(null);
    setSkillFilePreview(null);
    setMarketplaceSelectedId(skill.id);
    setMarketplaceDetail(null);
    setMarketplaceLoadingDetail(true);
    try {
      const params = new URLSearchParams({ id: skill.id });
      const response = await webApiFetch(`/api/skills/marketplace/detail?${params.toString()}`);
      const data = (await response.json().catch(() => ({}))) as { detail?: MarketplaceSkillDetail; error?: string; message?: string };
      if (!response.ok || !data.detail) throw new Error(data.message ?? data.error ?? `HTTP ${response.status}`);
      setMarketplaceDetail(data.detail);
    } catch (err) {
      toast.error(skillMarketplaceErrorMessage(t, err));
      setMarketplaceSelectedId('');
    } finally {
      setMarketplaceLoadingDetail(false);
    }
  };

  const closeMarketplaceDetail = () => {
    setMarketplaceDetail(null);
    setMarketplaceSelectedId('');
    setMarketplaceLoadingDetail(false);
  };

  const importMarketplaceSkill = async (skillId: string) => {
    if (!skillWritesAvailable) {
      toast.error(skillDatabaseRequiredMessage);
      return;
    }
    setMarketplaceImportingId(skillId);
    try {
      await postJson('/api/skills/marketplace/import', { id: skillId, avatarId });
      toast.success(t('skill.marketplaceImported', { defaultValue: '已导入到 Zleap' }));
      setMarketplaceResults((prev) => prev.map((skill) => (skill.id === skillId ? { ...skill, installed: true } : skill)));
      onChanged();
    } catch (err) {
      toast.error(skillMarketplaceErrorMessage(t, err));
    } finally {
      setMarketplaceImportingId('');
    }
  };

  return (
    <PageShell
      icon={<BookOpen className="size-4" />}
      title={t('skill.title')}
      subtitle={t('skill.subtitle')}
      onBack={onBack}
      actions={
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="icon-lg"
            onClick={() => scanSkills()}
            disabled={scanning || !skillWritesAvailable}
            title={
              skillWritesAvailable
                ? currentProject
                  ? t('skill.scanCurrentProject', { defaultValue: '扫描当前项目技能' })
                  : t('skill.scan', { defaultValue: '扫描技能' })
                : skillDatabaseRequiredMessage
            }
            aria-label={currentProject ? t('skill.scanCurrentProject', { defaultValue: '扫描当前项目技能' }) : t('skill.scan', { defaultValue: '扫描技能' })}
          >
            <RefreshCw className={cn('size-4', scanning && 'animate-spin')} />
          </Button>
          <ManageAddButton
            label={skillWritesAvailable ? t('skill.new') : skillDatabaseRequiredMessage}
            onClick={() => setDialogOpen(true)}
            disabled={!skillWritesAvailable}
          />
        </div>
      }
      toolbar={
        <SearchBar
          value={q}
          onChange={setQ}
          placeholder={t('skill.search')}
        />
      }
    >
      {filtered.length > 0 || showMarketplaceResults ? (
        <div className="flex flex-col gap-5">
          {filtered.length > 0 ? (
            <section className="flex flex-col gap-2">
              {showMarketplaceResults ? <SectionLabel>{t('skill.localResults', { defaultValue: '本地技能' })} · {filtered.length}</SectionLabel> : null}
              <ManageList className="gap-1">
                {filtered.map((skill) => (
                  <SkillRow
                    key={skill.id}
                    skill={skill}
                    expanded={expanded.has(skill.id)}
                    active={selectedSkillId === skill.id}
                    activeFilePath={selectedSkillFile?.skillId === skill.id ? selectedSkillFile.path : undefined}
                    toggling={togglingSkillId === skill.id}
                    onToggleExpand={() => toggleExpand(skill.id)}
                    onOpen={() => {
                      setMarketplaceSelectedId('');
                      setMarketplaceDetail(null);
                      setSelectedSkillFile(null);
                      setSkillFilePreview(null);
                      setSelectedSkillId(skill.id);
                    }}
                    onToggleEnabled={(enabled) => void toggleSkill(skill, enabled)}
                    onEdit={() => setEditTarget(skill)}
                    onPreviewFile={(path) => void previewSkillFile(skill, path)}
                    onEditFile={(path) => void editSkillFile(skill, path)}
                    onDelete={() => setPendingDelete(skill)}
                  />
                ))}
              </ManageList>
            </section>
          ) : null}

          {showMarketplaceResults ? (
            <section className="flex flex-col gap-2">
              <SectionLabel>
                {t('skill.remoteResults', { defaultValue: '远程技能' })} · {marketplaceSearching ? t('common.loading', { defaultValue: '加载中…' }) : marketplaceResults.length}
              </SectionLabel>
              {marketplaceError ? (
                <ManagePreviewBlock className="text-xs text-destructive">{marketplaceError}</ManagePreviewBlock>
              ) : marketplaceResults.length > 0 ? (
                <ManageList className="gap-1">
                  {marketplaceResults.map((skill) => (
                    <ManageListRow
                      key={`marketplace-${skill.id}`}
                      title={skill.name}
                      active={marketplaceSelectedId === skill.id}
                      leading={<Globe />}
                      badges={
                        <>
                          {skill.installed ? <ManageStatusBadge>{t('skill.installed', { defaultValue: '已导入' })}</ManageStatusBadge> : null}
                          <ManageStatusBadge variant="outline" size="sm">
                            {skill.sourceType}
                          </ManageStatusBadge>
                        </>
                      }
                      meta={formatSkillInstalls(skill.installs)}
                      onOpen={() => void openMarketplaceDetail(skill)}
                    />
                  ))}
                </ManageList>
              ) : marketplaceSearching ? (
                <ManagePreviewBlock className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 data-icon="inline-start" className="animate-spin" />
                  {t('skill.searchingRemote', { defaultValue: '正在搜索远程技能…' })}
                </ManagePreviewBlock>
              ) : marketplaceSearched ? (
                <EmptyState icon={<SearchX className="size-5" />}>{t('skill.marketplaceEmpty', { defaultValue: '没有找到匹配的远程技能。' })}</EmptyState>
              ) : null}
            </section>
          ) : null}
        </div>
      ) : (
        <EmptyState icon={<BookOpen className="size-5" />}>
          {resources.loading
            ? t('common.loading')
            : searchQuery
              ? t('skill.searchEmpty', { defaultValue: '没有找到匹配的技能' })
              : skillWritesAvailable
              ? t('skill.empty')
              : t('skill.databaseRequiredShort', { defaultValue: '需要先启动数据库' })}
        </EmptyState>
      )}

      <DeleteConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title={t('common.delete')}
        description={t('common.deleteConfirm', { name: pendingDelete?.label ?? '' })}
        onConfirm={removeSkill}
      />
      <SkillDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        avatarId={avatarId}
        resources={resources}
        onSaved={onChanged}
      />
      <SkillEditDialog
        skill={editTarget}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null);
        }}
        onSaved={onChanged}
      />
      <SkillFileEditDialog
        draft={fileEdit}
        onDraftChange={setFileEdit}
        onOpenChange={(open) => {
          if (!open) setFileEdit(null);
        }}
        onSave={saveSkillFile}
      />
      <ManageDrawer
        open={Boolean(selectedSkill)}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedSkillId('');
            setSelectedSkillFile(null);
            setSkillFilePreview(null);
          }
        }}
        title={selectedSkillFile?.path ?? selectedSkill?.label ?? t('skill.title')}
        subtitle={selectedSkillFile ? selectedSkill?.label : selectedSkill?.id}
        width="wide"
        badge={
          selectedSkillFile ? (
            <ManageStatusBadge>{skillFilePreview?.kind ?? (selectedSkill ? skillFileRows(selectedSkill).find((file) => file.path === selectedSkillFile.path)?.kind : undefined) ?? 'file'}</ManageStatusBadge>
          ) : selectedSkill ? (
            <ManageStatusBadge>{selectedSkill.invocationPolicy === 'disabled' ? t('common.disabled', { defaultValue: '已禁用' }) : t('common.enabled', { defaultValue: '已启用' })}</ManageStatusBadge>
          ) : undefined
        }
        actions={
          selectedSkill ? (
            selectedSkillFile ? (
              <Button variant="ghost" size="icon-sm" onClick={() => void editSkillFile(selectedSkill, selectedSkillFile.path)} title={t('common.edit')} aria-label={t('common.edit')}>
                <Pencil />
              </Button>
            ) : (
              <>
                <Button variant="ghost" size="icon-sm" onClick={() => setEditTarget(selectedSkill)} title={t('common.edit')} aria-label={t('common.edit')}>
                  <Pencil />
                </Button>
                <Button variant="ghost" size="icon-sm" onClick={() => setPendingDelete(selectedSkill)} title={t('common.delete')} aria-label={t('common.delete')}>
                  <Trash2 />
                </Button>
              </>
            )
          ) : null
        }
      >
        {selectedSkillFile ? (
          skillFilePreviewLoading ? (
            <ManagePreviewBlock className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 data-icon="inline-start" className="animate-spin" />
              {t('common.loading', { defaultValue: '加载中…' })}
            </ManagePreviewBlock>
          ) : skillFilePreview ? (
            <>
              <ManageDetailGrid>
                <ManageDetailItem label={t('skill.filePath', { defaultValue: '路径' })} value={skillFilePreview.path} />
                <ManageDetailItem label={t('skill.fileKind', { defaultValue: '类型' })} value={skillFilePreview.kind ?? 'file'} />
                <ManageDetailItem label={t('skill.source', { defaultValue: '来源' })} value={skillSourceLabel(skillFilePreview.skill)} />
                <ManageDetailItem label={t('skill.packageFile', { defaultValue: '包文件' })} value={skillFilePreview.packageFile ? 'yes' : 'no'} />
              </ManageDetailGrid>
              {skillFilePreview.content ? (
                <ArtifactPreviewContent content={skillFilePreview.content} path={skillFilePreview.path} compact />
              ) : (
                <ManagePreviewBlock className="text-sm text-muted-foreground">
                  {t('skill.emptyFile', { defaultValue: '文件为空。' })}
                </ManagePreviewBlock>
              )}
            </>
          ) : (
            <ManagePreviewBlock className="text-sm text-muted-foreground">
              {t('skill.filePreviewEmpty', { defaultValue: '暂无可预览内容。' })}
            </ManagePreviewBlock>
          )
        ) : selectedSkill ? (
          <>
            <ManageDetailGrid>
              <ManageDetailItem label={t('skill.files', { defaultValue: '文件' })} value={String(skillFileRows(selectedSkill).length)} />
              <ManageDetailItem label={t('skill.source', { defaultValue: '来源' })} value={skillSourceLabel(selectedSkill)} />
              <ManageDetailItem label={t('skill.trustStatus', { defaultValue: '信任状态' })} value={skillTrustLabel(selectedSkill.trustStatus)} />
              <ManageDetailItem label={t('skill.invocationPolicy', { defaultValue: '调用策略' })} value={selectedSkill.invocationPolicy ?? 'implicit'} />
            </ManageDetailGrid>
            <ManagePreviewBlock className="text-sm text-foreground">
              {selectedSkill.description || selectedSkill.body || selectedSkill.instructions || t('skill.noInstructions', { defaultValue: '暂无技能说明' })}
            </ManagePreviewBlock>
          </>
        ) : null}
      </ManageDrawer>
      <ManageDrawer
        open={Boolean(marketplaceSelectedId)}
        onOpenChange={(open) => {
          if (!open) closeMarketplaceDetail();
        }}
        title={marketplaceDetail?.id ?? selectedMarketplaceSkill?.name ?? t('skill.remoteSkill', { defaultValue: '远程技能' })}
        subtitle={selectedMarketplaceSkill ? `${selectedMarketplaceSkill.source} · ${selectedMarketplaceSkill.sourceType}` : undefined}
        width="wide"
        badge={
          selectedMarketplaceSkill?.installed ? (
            <ManageStatusBadge>{t('skill.installed', { defaultValue: '已导入' })}</ManageStatusBadge>
          ) : marketplaceDetail ? (
            <ManageStatusBadge variant={marketplaceDetail.audit?.status === 'fail' ? 'destructive' : 'secondary'}>
              {marketplaceDetail.audit?.status ?? 'unknown'}
            </ManageStatusBadge>
          ) : null
        }
        actions={
          selectedMarketplaceSkill ? (
            <>
              <Button variant="ghost" size="icon-sm" asChild title="skills.sh" aria-label="skills.sh">
                <a href={marketplaceDetail?.url ?? selectedMarketplaceSkill.url} target="_blank" rel="noreferrer">
                  <Globe />
                </a>
              </Button>
              <Button
                size="sm"
                disabled={!skillWritesAvailable || selectedMarketplaceSkill.installed || marketplaceImportingId === selectedMarketplaceSkill.id}
                onClick={() => void importMarketplaceSkill(selectedMarketplaceSkill.id)}
                title={skillWritesAvailable ? t('skill.marketplaceImport', { defaultValue: '导入到 Zleap' }) : skillDatabaseRequiredMessage}
              >
                {marketplaceImportingId === selectedMarketplaceSkill.id ? (
                  <Loader2 data-icon="inline-start" className="animate-spin" />
                ) : (
                  <Check data-icon="inline-start" />
                )}
                {selectedMarketplaceSkill.installed
                  ? t('skill.installed', { defaultValue: '已导入' })
                  : t('skill.marketplaceImportShort', { defaultValue: '导入' })}
              </Button>
            </>
          ) : null
        }
      >
        {marketplaceLoadingDetail ? (
          <ManagePreviewBlock className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 data-icon="inline-start" className="animate-spin" />
            {t('common.loading', { defaultValue: '加载中…' })}
          </ManagePreviewBlock>
        ) : marketplaceDetail ? (
          <>
            <ManageDetailGrid>
              <ManageDetailItem label={t('skill.installs', { defaultValue: '安装量' })} value={formatSkillInstalls(marketplaceDetail.installs)} />
              <ManageDetailItem label={t('skill.files', { defaultValue: '文件' })} value={String(marketplaceDetail.files.length)} />
              <ManageDetailItem label={t('skill.source', { defaultValue: '来源' })} value={marketplaceDetail.source} />
              <ManageDetailItem label={t('skill.slug', { defaultValue: '标识' })} value={marketplaceDetail.slug} />
            </ManageDetailGrid>
            <div>
              <div className="mb-2 text-xs font-medium text-muted-foreground">SKILL.md</div>
              <pre className="soft-scroll max-h-[calc(100vh-18rem)] overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted/35 p-3 font-mono text-xs leading-5 text-foreground">
                {marketplaceDetail.skillMd ?? t('skill.marketplaceNoSkillMd', { defaultValue: '没有可预览的 SKILL.md。' })}
              </pre>
            </div>
          </>
        ) : (
          <ManagePreviewBlock className="text-sm text-muted-foreground">
            {t('skill.marketplacePickOne', { defaultValue: '选择一个远程技能查看详情。' })}
          </ManagePreviewBlock>
        )}
      </ManageDrawer>
    </PageShell>
  );
}

function skillErrorMessage(t: ReturnType<typeof useTranslation>['t'], error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  if (code === 'database_required') {
    return t('skill.databaseRequired', {
      defaultValue: '技能需要数据库才能保存。请用 pnpm dev:web 启动 WebUI，或配置 ZLEAP_DATABASE_URL 后重启。',
    });
  }
  return code;
}

function formatSkillInstalls(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M installs`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K installs`;
  return `${value} installs`;
}

function skillMarketplaceErrorMessage(t: ReturnType<typeof useTranslation>['t'], error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'skills_marketplace_auth_required' || message.includes('OIDC')) {
    return t('skill.marketplaceAuthRequired', {
      defaultValue: 'skills.sh API 需要 OIDC，Zleap 会改用 npx skills 公开通道；如果仍失败，请确认本机可以运行 npx skills。',
    });
  }
  if (message === 'skills_cli_failed' || message.includes('npx skills')) {
    return t('skill.marketplaceCliFailed', {
      defaultValue: 'npx skills 执行失败，请确认本机已安装 Node.js，并且当前网络可以访问 skills.sh 和 GitHub。',
    });
  }
  return message;
}

function SkillRow({
  skill,
  expanded,
  active,
  activeFilePath,
  toggling,
  onToggleExpand,
  onOpen,
  onToggleEnabled,
  onEdit,
  onPreviewFile,
  onEditFile,
  onDelete,
}: {
  skill: SkillView;
  expanded: boolean;
  active: boolean;
  activeFilePath?: string;
  toggling: boolean;
  onToggleExpand: () => void;
  onOpen: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onEdit: () => void;
  onPreviewFile: (path: string) => void;
  onEditFile: (path: string) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const fileRows = skillFileRows(skill);
  const enabled = skill.invocationPolicy !== 'disabled';
  return (
    <div>
      <ManageListRow
        title={skill.label}
        leading={
          <button
            type="button"
            className="-m-1 flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              onToggleExpand();
            }}
            title={expanded ? t('common.collapse', { defaultValue: '收起' }) : t('common.expand', { defaultValue: '展开' })}
            aria-label={expanded ? t('common.collapse', { defaultValue: '收起' }) : t('common.expand', { defaultValue: '展开' })}
          >
            {expanded ? <ChevronDown /> : <ChevronRight />}
          </button>
        }
        badges={
          <ManageStatusBadge variant="secondary" size="sm">
            {fileRows.length} {t('skill.files', { defaultValue: '文件' })}
          </ManageStatusBadge>
        }
        active={active && !activeFilePath}
        disabled={!enabled}
        onOpen={onOpen}
        actions={
          <>
            <Button variant="ghost" size="icon-sm" onClick={onEdit} title={t('common.edit')} aria-label={t('common.edit')}>
              <Pencil />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={onDelete} title={t('common.delete')} aria-label={t('common.delete')} className="text-destructive hover:text-destructive">
              <Trash2 />
            </Button>
          </>
        }
        persistent={<Switch checked={enabled} disabled={toggling} onCheckedChange={onToggleEnabled} />}
      />

      {expanded ? (
        <div className="mb-1 ml-[18px] flex flex-col gap-0.5 border-l border-border py-0.5 pl-3">
          {fileRows.length > 0 ? (
            fileRows.map((file) => (
              <ManageListRow
                key={file.path}
                title={<span className="font-mono">{file.path}</span>}
                meta={file.kind ?? 'skill'}
                indent
                active={activeFilePath === file.path}
                leading={<FileText />}
                className="rounded-lg hover:bg-muted/50"
                onOpen={() => onPreviewFile(file.path)}
                actions={
                  <Button variant="ghost" size="icon-sm" onClick={() => onEditFile(file.path)} title={t('common.edit')} aria-label={t('common.edit')}>
                    <Pencil />
                  </Button>
                }
              />
            ))
          ) : (
            <div className="rounded-lg px-3 py-2 text-xs text-muted-foreground">
              {t('skill.noInstructions', { defaultValue: '暂无技能说明' })}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function SkillEditDialog({ skill, onOpenChange, onSaved }: { skill: SkillView | null; onOpenChange: (open: boolean) => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [allowedTools, setAllowedTools] = useState('');
  const [disallowedTools, setDisallowedTools] = useState('');
  const [trustStatus, setTrustStatus] = useState<NonNullable<SkillView['trustStatus']>>('trusted');
  const [invocationPolicy, setInvocationPolicy] = useState<NonNullable<SkillView['invocationPolicy']>>('implicit');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!skill) return;
    setLabel(skill.label);
    setDescription(skill.description ?? '');
    setInstructions(skill.body ?? skill.instructions ?? '');
    setAllowedTools((skill.allowedTools ?? skill.toolIds ?? []).join(', '));
    setDisallowedTools((skill.disallowedTools ?? []).join(', '));
    setTrustStatus(skill.trustStatus ?? 'trusted');
    setInvocationPolicy(skill.invocationPolicy ?? 'implicit');
  }, [skill]);

  const submit = async () => {
    if (!skill || busy) return;
    setBusy(true);
    try {
      await patchJson(`/api/skills/${encodeURIComponent(skill.id)}`, {
        version: skill.version,
        label,
        description,
        instructions,
        allowedTools: splitList(allowedTools),
        disallowedTools: splitList(disallowedTools),
        trustStatus,
        invocationPolicy,
      });
      toast.success(t('common.saved', { defaultValue: '已保存' }));
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
      open={skill !== null}
      onOpenChange={(open) => {
        if (busy && !open) return;
        onOpenChange(open);
      }}
      title={t('skill.edit', { defaultValue: '编辑技能' })}
      description={skill?.id}
      expandable
      bodyClassName="gap-5"
      footer={
        <ManageDialogFooterActions
          onCancel={() => onOpenChange(false)}
          onConfirm={submit}
          confirmLabel={t('common.save', { defaultValue: '保存' })}
          busy={busy}
          confirmDisabled={!label.trim()}
        />
      }
    >
      <ManageForm>
        <ManageField label={t('common.name')} htmlFor="skill-edit-label">
          <Input
            id="skill-edit-label"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder={t('common.name')}
            autoFocus
          />
        </ManageField>
        <ManageField label={t('common.description', { defaultValue: '描述' })} htmlFor="skill-edit-description">
          <Input
            id="skill-edit-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t('skill.descPlaceholder', { defaultValue: '一句话说明何时使用。' })}
          />
        </ManageField>
        <ManageField label={t('skill.instructions', { defaultValue: '步骤说明' })} htmlFor="skill-edit-instructions">
          <Textarea
            id="skill-edit-instructions"
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            placeholder={t('skill.instructionsPlaceholder', { defaultValue: 'agent 应遵循的分步流程…' })}
            className="min-h-[320px] resize-y font-mono text-xs leading-6"
          />
        </ManageField>
      </ManageForm>

      <div className="flex flex-wrap items-center gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <TaskDialogChip icon={<ShieldCheck className="size-4" />} label={skillTrustLabel(trustStatus)} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-48">
            <DropdownMenuGroup>
              {(['trusted', 'review_required', 'blocked'] as const).map((value) => (
                <DropdownMenuItem key={value} onClick={() => setTrustStatus(value)} className={value === trustStatus ? 'font-medium text-foreground' : ''}>
                  <ShieldCheck className="size-4 text-muted-foreground" />
                  {skillTrustLabel(value)}
                  {value === trustStatus ? <Check className="ml-auto size-4" /> : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <TaskDialogChip icon={<Zap className="size-4" />} label={invocationPolicy} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-48">
            <DropdownMenuGroup>
              {(['implicit', 'explicit_only', 'disabled'] as const).map((value) => (
                <DropdownMenuItem key={value} onClick={() => setInvocationPolicy(value)} className={value === invocationPolicy ? 'font-medium text-foreground' : ''}>
                  <Zap className="size-4 text-muted-foreground" />
                  {value}
                  {value === invocationPolicy ? <Check className="ml-auto size-4" /> : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <Popover>
          <PopoverTrigger asChild>
            <TaskDialogChip icon={<PlugZap className="size-4" />} label={t('skill.toolsUsed', { defaultValue: '可用工具' })} />
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80 p-3">
            <ManageForm>
              <ManageField label={t('skill.allowedTools', { defaultValue: '允许工具' })} htmlFor="skill-edit-allowed-tools">
                <Input
                  id="skill-edit-allowed-tools"
                  value={allowedTools}
                  onChange={(event) => setAllowedTools(event.target.value)}
                  placeholder="read, grep"
                  className="font-mono text-xs"
                />
              </ManageField>
              <ManageField label={t('skill.disallowedTools', { defaultValue: '禁用工具' })} htmlFor="skill-edit-disallowed-tools">
                <Input
                  id="skill-edit-disallowed-tools"
                  value={disallowedTools}
                  onChange={(event) => setDisallowedTools(event.target.value)}
                  placeholder="bash"
                  className="font-mono text-xs"
                />
              </ManageField>
            </ManageForm>
          </PopoverContent>
        </Popover>
      </div>
    </ManageDialog>
  );
}

function SkillFileEditDialog({
  draft,
  onDraftChange,
  onOpenChange,
  onSave,
}: {
  draft: SkillFileEdit | null;
  onDraftChange: (draft: SkillFileEdit | null) => void;
  onOpenChange: (open: boolean) => void;
  onSave: (draft: SkillFileEdit) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!draft || busy) return;
    setBusy(true);
    try {
      await onSave(draft);
    } finally {
      setBusy(false);
    }
  };
  return (
    <ManageDialog
      open={draft !== null}
      onOpenChange={(open) => {
        if (busy && !open) return;
        onOpenChange(open);
      }}
      title={<span className="font-mono text-sm">{draft?.path ?? 'SKILL.md'}</span>}
      description={draft?.skill.label}
      expandable
      bodyClassName="gap-0"
      footer={
        <ManageDialogFooterActions
          onCancel={() => onOpenChange(false)}
          onConfirm={submit}
          confirmLabel={t('common.save', { defaultValue: '保存' })}
          busy={busy}
          confirmDisabled={!draft}
        />
      }
    >
      <Textarea
        value={draft?.content ?? ''}
        onChange={(event) => {
          if (!draft) return;
          onDraftChange({ ...draft, content: event.target.value });
        }}
        className="min-h-[460px] resize-y font-mono text-xs leading-6"
      />
    </ManageDialog>
  );
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function skillFileRows(skill: SkillView): Array<{ path: string; kind?: string }> {
  if (skill.files?.length) {
    return [...skill.files]
      .sort((a, b) => {
        if (a.path === 'SKILL.md') return -1;
        if (b.path === 'SKILL.md') return 1;
        return a.path.localeCompare(b.path);
      })
      .map((file) => ({ path: file.path, kind: file.kind }));
  }
  if (skill.body || skill.instructions) {
    return [{ path: 'SKILL.md', kind: 'skill' }];
  }
  return [];
}

function skillSourceLabel(skill: SkillView): string {
  return skill.sourceType === 'project'
    ? 'Project'
    : skill.sourceType === 'user'
      ? 'User'
      : skill.sourceType === 'admin'
        ? 'Admin'
        : skill.sourceType === 'system'
          ? 'System'
          : skill.sourceType === 'imported'
            ? 'Imported'
            : 'DB';
}

function skillTrustLabel(status: SkillView['trustStatus']): string {
  return status === 'blocked' ? 'Blocked' : status === 'review_required' ? 'Review' : 'Trusted';
}
