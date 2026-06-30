'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { Check, Cpu, KeyRound, Loader2, Pencil, Play, Trash2 } from 'lucide-react';
import { postJson, patchJson, deleteJson, webApiFetch } from '@/lib/api';
import { isDefaultForKind, modelKind } from '@/lib/models';
import { Button } from '@/components/ui/button';
import { DeleteConfirmDialog } from '@/components/ui/delete-confirm-dialog';
import { Input } from '@/components/ui/input';
import type { ModelConfigView } from '@/lib/useResources';
import { ModelDialog } from './ModelDialog';
import {
  ManageDetailGrid,
  ManageDetailItem,
  ManageAddButton,
  ManageDrawer,
  ManageEmptyState as EmptyState,
  ManageList,
  ManageListRow,
  ManagePageShell as PageShell,
  ManageSearchBar as SearchBar,
  ManageSectionLabel as SectionLabel,
  ManageStatusBadge,
} from './manage-ui';
import type { PageProps } from './pageTypes';

export function ModelPage({ resources, avatarId, onChanged, onBack }: PageProps) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ModelConfigView | null>(null);
  const [pendingDeleteModel, setPendingDeleteModel] = useState<ModelConfigView | null>(null);
  const [previewModel, setPreviewModel] = useState<ModelConfigView | null>(null);
  const [testingModelId, setTestingModelId] = useState<string | null>(null);
  const filtered = resources.models.filter((m) =>
    `${m.id} ${m.providerId} ${m.model} ${m.purpose}`.toLowerCase().includes(q.toLowerCase()),
  );
  const openCreate = () => {
    setEditTarget(null);
    setDialogOpen(true);
  };
  const openEdit = (m: ModelConfigView) => {
    setEditTarget(m);
    setDialogOpen(true);
  };
  const setDefault = async (id: string) => {
    try {
      await patchJson('/api/models', { id, isDefault: true });
      toast.success(t('model.defaultSaved'));
      onChanged();
    } catch (err) {
      toast.error(modelErrorMessage(t, err));
    }
  };
  const testModel = async (id: string) => {
    if (testingModelId) return;
    setTestingModelId(id);
    try {
      await postJson('/api/models/test', { id });
      toast.success(t('model.testOk'));
    } catch (err) {
      toast.error(modelErrorMessage(t, err));
    } finally {
      setTestingModelId(null);
    }
  };
  const deleteModel = async () => {
    if (!pendingDeleteModel) return;
    try {
      await deleteJson('/api/models', { id: pendingDeleteModel.id });
      toast.success(t('common.deleted'));
      setPendingDeleteModel(null);
      onChanged();
    } catch (err) {
      toast.error(modelErrorMessage(t, err));
      throw err;
    }
  };
  const previewCfg = previewModel?.config ?? {};
  const previewName = typeof previewCfg.displayName === 'string' ? previewCfg.displayName : previewModel?.id ?? '';
  const previewIsDefault = previewModel ? isDefaultForKind(previewModel, resources.models) : false;
  const previewKind = previewModel ? modelKind(previewModel) : 'llm';
  const previewBaseUrl = typeof previewCfg.baseUrl === 'string' ? previewCfg.baseUrl : '';
  return (
    <PageShell
      icon={<Cpu className="size-4" />}
      title={t('model.title')}
      subtitle={t('model.subtitle')}
      onBack={onBack}
      actions={<ManageAddButton label={t('model.new')} onClick={openCreate} />}
      toolbar={
        <SearchBar
          value={q}
          onChange={setQ}
          placeholder={t('model.search')}
        />
      }
    >
      <SectionLabel>{t('model.sharedServices', { defaultValue: '基础服务' })}</SectionLabel>
      <div className="mb-4">
        <ModelApi302KeyCard onSaved={onChanged} />
      </div>
      <SectionLabel>{t('model.configs', { defaultValue: '模型配置' })} · {filtered.length}</SectionLabel>
      {filtered.length > 0 ? (
        <ManageList>
          {filtered.map((m) => {
            const cfg = m.config ?? {};
            const name = typeof cfg.displayName === 'string' ? cfg.displayName : m.id;
            const isDefault = isDefaultForKind(m, resources.models);
            const kind = modelKind(m);
            const isTesting = testingModelId === m.id;
            return (
              <ManageListRow
                key={m.id}
                title={name}
                badges={
                  <>
                  <ManageStatusBadge variant="outline" size="sm">
                    {kind === 'embedding' ? t('model.kindEmbedding') : t('model.kindLlm')}
                  </ManageStatusBadge>
                  {isDefault ? <ManageStatusBadge variant="secondary" size="sm">{t('model.default')}</ManageStatusBadge> : null}
                  </>
                }
                meta={m.providerId}
                onOpen={() => setPreviewModel(m)}
                actions={
                  <>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => testModel(m.id)}
                      disabled={testingModelId !== null}
                      title={t('model.test')}
                      aria-label={t('model.test')}
                    >
                      {isTesting ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
                    </Button>
                    <Button variant="ghost" size="icon-sm" onClick={() => openEdit(m)} title={t('common.edit')} aria-label={t('common.edit')}>
                      <Pencil className="size-4" />
                    </Button>
                    {!isDefault ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setDefault(m.id)}
                        title={t('model.setDefault', { defaultValue: '设为默认' })}
                        aria-label={t('model.setDefault', { defaultValue: '设为默认' })}
                      >
                        <Check className="size-4" />
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setPendingDeleteModel(m)}
                      title={t('common.delete')}
                      aria-label={t('common.delete')}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </>
                }
              />
            );
          })}
        </ManageList>
      ) : (
        <EmptyState icon={<Cpu className="size-5" />}>{resources.loading ? t('common.loading') : t('model.empty')}</EmptyState>
      )}
      <ManageDrawer
        open={Boolean(previewModel)}
        onOpenChange={(open) => !open && setPreviewModel(null)}
        title={previewName}
        subtitle={previewModel?.model}
        badge={
          previewModel ? (
            <ManageStatusBadge variant="outline" size="sm">
              {previewKind === 'embedding' ? t('model.kindEmbedding') : t('model.kindLlm')}
            </ManageStatusBadge>
          ) : null
        }
        footer={
          previewModel ? (
            <div className="flex w-full items-center justify-between gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => {
                  const target = previewModel;
                  setPreviewModel(null);
                  setPendingDeleteModel(target);
                }}
              >
                {t('common.delete')}
              </Button>
              <div className="flex items-center gap-2">
                {!previewIsDefault ? (
                  <Button variant="outline" size="sm" onClick={() => setDefault(previewModel.id)}>
                    {t('model.setDefault', { defaultValue: '设为默认' })}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  onClick={() => {
                    const target = previewModel;
                    setPreviewModel(null);
                    openEdit(target);
                  }}
                >
                  {t('common.edit')}
                </Button>
              </div>
            </div>
          ) : null
        }
      >
        {previewModel ? (
          <ManageDetailGrid>
            <ManageDetailItem
              label={t('model.kind', { defaultValue: '类型' })}
              value={previewKind === 'embedding' ? t('model.kindEmbedding') : t('model.kindLlm')}
            />
            <ManageDetailItem label={t('model.provider', { defaultValue: 'Provider' })} value={previewModel.providerId} />
            <ManageDetailItem label={t('model.modelId', { defaultValue: '模型' })} value={previewModel.model} />
            <ManageDetailItem
              label={t('model.default')}
              value={previewIsDefault ? t('common.yes', { defaultValue: '是' }) : t('common.no', { defaultValue: '否' })}
            />
            {previewBaseUrl ? <ManageDetailItem label={t('model.baseUrl')} value={previewBaseUrl} /> : null}
          </ManageDetailGrid>
        ) : null}
      </ManageDrawer>
      <ModelDialog open={dialogOpen} onOpenChange={setDialogOpen} avatarId={avatarId} editTarget={editTarget} onSaved={onChanged} />
      <DeleteConfirmDialog
        open={Boolean(pendingDeleteModel)}
        onOpenChange={(open) => !open && setPendingDeleteModel(null)}
        title={t('model.deleteTitle', { defaultValue: '删除模型配置' })}
        description={t('model.deleteConfirm', {
          name:
            (pendingDeleteModel?.config?.displayName && typeof pendingDeleteModel.config.displayName === 'string'
              ? pendingDeleteModel.config.displayName
              : pendingDeleteModel?.id) ?? '',
          defaultValue: '确定删除「{{name}}」这个模型配置？删除后，使用它的空间需要重新选择模型；这个配置里的 API Key 也会一起删除。',
        })}
        confirmLabel={t('model.deleteConfirmAction', { defaultValue: '确认删除' })}
        onConfirm={deleteModel}
      />
    </PageShell>
  );
}

function modelErrorMessage(t: ReturnType<typeof useTranslation>['t'], error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  if (code === 'model_api_key_required' || code === 'base_url_or_api_key_missing') {
    return t('model.errorApiKeyRequired', {
      defaultValue: '还没有可用的 API Key。请先在模型页填写 302.AI API Key，或编辑这个模型单独填写 Key。',
    });
  }
  if (code === 'model_not_found') {
    return t('model.errorNotFound', { defaultValue: '没有找到这个模型配置，请刷新页面后再试。' });
  }
  return code;
}

function ModelApi302KeyCard({ onSaved }: { onSaved: () => void }) {
  const { t } = useTranslation();
  const [api302Key, setApi302Key] = useState('');
  const [api302BaseUrl, setApi302BaseUrl] = useState('');
  const [api302ModelBaseUrl, setApi302ModelBaseUrl] = useState('');
  const [api302Configured, setApi302Configured] = useState(false);
  const [saving302, setSaving302] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void webApiFetch('/api/integrations/302')
      .then(async (response) =>
        response.ok
          ? ((await response.json()) as { configured?: boolean; apiBaseUrl?: string; modelBaseUrl?: string })
          : null,
      )
      .then((body) => {
        if (!cancelled && body) {
          setApi302Configured(body.configured === true);
          setApi302BaseUrl(body.apiBaseUrl ?? '');
          setApi302ModelBaseUrl(body.modelBaseUrl ?? '');
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const save302ApiKey = async () => {
    const key = api302Key.trim();
    if (!key && !api302Configured) {
      toast.error(t('model.api302KeyRequired', { defaultValue: '请先填写 302.AI API Key' }));
      return;
    }
    setSaving302(true);
    try {
      const body = (await postJson('/api/integrations/302', {
        ...(key ? { apiKey: key } : {}),
        apiBaseUrl: api302BaseUrl,
        modelBaseUrl: api302ModelBaseUrl,
      })) as { configured?: boolean; apiBaseUrl?: string; modelBaseUrl?: string };
      setApi302Configured(body.configured === true);
      setApi302BaseUrl(body.apiBaseUrl ?? api302BaseUrl);
      setApi302ModelBaseUrl(body.modelBaseUrl ?? api302ModelBaseUrl);
      setApi302Key('');
      toast.success(t('model.api302Saved', { defaultValue: '302.AI 通用配置已保存' }));
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving302(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-primary">
          <KeyRound className="size-4" />
        </span>
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex items-center gap-2">
            <div className="text-sm font-semibold text-foreground">302.AI</div>
            <ManageStatusBadge variant={api302Configured ? 'secondary' : 'outline'}>
              {api302Configured
                ? t('model.api302Configured', { defaultValue: '已配置' })
                : t('model.api302NotConfigured', { defaultValue: '未配置' })}
            </ManageStatusBadge>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            {t('model.api302Hint', {
              defaultValue:
                '默认使用 302 官方地址；只填 Key 就能启用 qwen3.6-flash、Qwen/Qwen3-Embedding-0.6B 和 web-search。Key 只保存在本地后端，不会回显。',
            })}
          </p>
          <div className="grid gap-2">
            <label className="grid gap-1 text-xs font-medium text-muted-foreground">
              API Key
              <Input
                type="password"
                value={api302Key}
                onChange={(event) => setApi302Key(event.target.value)}
                placeholder={api302Configured ? t('model.api302KeyKeep', { defaultValue: '已配置，留空保留' }) : 'sk-...'}
                className="h-8 font-mono text-xs"
                autoComplete="off"
              />
            </label>
            <div className="grid gap-2">
              <label className="grid gap-1 text-xs font-medium text-muted-foreground">
                API Base URL
                <Input
                  type="url"
                  value={api302BaseUrl}
                  onChange={(event) => setApi302BaseUrl(event.target.value)}
                  placeholder="https://api.302.ai"
                  className="h-8 font-mono text-xs"
                  autoComplete="off"
                />
              </label>
              <label className="grid gap-1 text-xs font-medium text-muted-foreground">
                Model Base URL
                <Input
                  type="url"
                  value={api302ModelBaseUrl}
                  onChange={(event) => setApi302ModelBaseUrl(event.target.value)}
                  placeholder="https://api.302.ai/v1"
                  className="h-8 font-mono text-xs"
                  autoComplete="off"
                />
              </label>
            </div>
            <div className="flex justify-end">
              <Button size="sm" onClick={save302ApiKey} disabled={saving302}>
                {saving302 ? t('common.saving', { defaultValue: '保存中' }) : t('common.save', { defaultValue: '保存' })}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
