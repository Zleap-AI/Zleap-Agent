'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { slugify } from '@/lib/utils';
import { postJson, patchJson } from '@/lib/api';
import type { ModelConfigView } from '@/lib/useResources';
import { modelKind, type ModelKind } from '@/lib/models';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ManageDialog, ManageDialogFooterActions, ManageField, ManageForm, ManagePreviewBlock } from './manage-ui';

type ModelDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  avatarId?: string;
  /** When set, the dialog edits this model instead of creating a new one. */
  editTarget?: ModelConfigView | null;
  onSaved: () => void;
};

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

const MODEL_PROVIDERS = [
  { id: '302ai', label: '302', protocol: 'openai', providerId: 'openai-compatible', baseUrl: 'https://api.302.ai/v1' },
  { id: 'custom', label: 'Custom', protocol: 'openai', providerId: 'openai-compatible', baseUrl: '' },
] as const;
const MODEL_PROTOCOLS = ['openai', 'anthropic'] as const;
const DEFAULT_PROVIDER = MODEL_PROVIDERS[0];
const CUSTOM_PROVIDER = MODEL_PROVIDERS[1];

/** Create or edit a global model config. New configs become the default for their kind. */
export function ModelDialog({ open, onOpenChange, avatarId, editTarget, onSaved }: ModelDialogProps) {
  const { t } = useTranslation();
  const editing = Boolean(editTarget);
  const [kind, setKind] = useState<ModelKind>('llm');
  const [name, setName] = useState('');
  const [providerId, setProviderId] = useState<(typeof MODEL_PROVIDERS)[number]['id']>(DEFAULT_PROVIDER.id);
  const [protocol, setProtocol] = useState<(typeof MODEL_PROTOCOLS)[number]>('openai');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [contextWindow, setContextWindow] = useState('');
  const [maxOutput, setMaxOutput] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (editTarget) {
      const c = editTarget.config ?? {};
      const pk = str(c.providerKey);
      const provider = MODEL_PROVIDERS.find((p) => p.id === pk) ?? CUSTOM_PROVIDER;
      setKind(modelKind(editTarget));
      setName(str(c.displayName));
      setProviderId(provider.id);
      setProtocol((str(c.protocol) as (typeof MODEL_PROTOCOLS)[number]) || (editTarget.providerId === 'anthropic' ? 'anthropic' : 'openai'));
      setModel(editTarget.model);
      setBaseUrl(str(c.baseUrl));
      setApiKey('');
      setContextWindow(c.contextWindow != null ? String(c.contextWindow) : '');
      setMaxOutput(c.maxOutputTokens != null ? String(c.maxOutputTokens) : '');
      return;
    }
    setKind('llm');
    setName('');
    setProviderId(DEFAULT_PROVIDER.id);
    setProtocol(DEFAULT_PROVIDER.protocol);
    setModel('');
    setBaseUrl(DEFAULT_PROVIDER.baseUrl);
    setApiKey('');
    setContextWindow('');
    setMaxOutput('');
  }, [open, editTarget]);

  const changeProvider = (value: string) => {
    const next = MODEL_PROVIDERS.find((provider) => provider.id === value) ?? DEFAULT_PROVIDER;
    setProviderId(next.id);
    setProtocol(next.protocol);
    if (next.baseUrl) {
      setBaseUrl(next.baseUrl);
    } else if (value !== 'custom') {
      setBaseUrl('');
    }
  };

  const submit = async () => {
    const id = editing ? editTarget!.id : slugify(name || model);
    // On edit the API key may be left blank to keep the stored one.
    if (!id || !model.trim() || !baseUrl.trim() || (!editing && !apiKey.trim())) {
      toast.error(t('model.validation', { defaultValue: 'Name, model, Base URL, and API Key are required.' }));
      return;
    }
    const provider = MODEL_PROVIDERS.find((candidate) => candidate.id === providerId) ?? DEFAULT_PROVIDER;
    const resolvedProviderId = protocol === 'anthropic' ? 'anthropic' : provider.providerId;
    const config = compact({
      displayName: name.trim() || undefined,
      providerKey: provider.id,
      baseUrl: baseUrl.trim() || undefined,
      apiKey: apiKey.trim() || undefined,
      protocol,
      contextWindow: numeric(contextWindow),
      maxOutputTokens: numeric(maxOutput),
    });
    setBusy(true);
    try {
      if (editing) {
        await patchJson('/api/models', { id, kind, providerId: resolvedProviderId, model: model.trim(), config });
      } else {
        await postJson('/api/models', { avatarId, id, kind, providerId: resolvedProviderId, model: model.trim(), config });
      }
      toast.success(`${name || model} ✓`);
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
      expandable
      title={editing ? t('model.edit', { defaultValue: 'Edit Model' }) : t('model.new')}
      description={t('model.newDesc')}
      footer={
        <ManageDialogFooterActions
          onCancel={() => onOpenChange(false)}
          onConfirm={submit}
          confirmLabel={editing ? t('common.saveChanges') : t('common.create')}
          busy={busy}
        />
      }
    >
      <ManageForm>
        <ManageField label={t('model.kind')}>
          <Select value={kind} onValueChange={(value) => setKind(value as ModelKind)}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="llm">{t('model.kindLlm')}</SelectItem>
                <SelectItem value="embedding">{t('model.kindEmbedding')}</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </ManageField>

        <ManageField label={t('common.name')} htmlFor="model-name">
          <Input id="model-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Workspace GPT" autoFocus />
        </ManageField>

        <ManageField label={t('model.provider')}>
          <Select value={providerId} onValueChange={changeProvider}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {MODEL_PROVIDERS.map((provider) => (
                  <SelectItem key={provider.id} value={provider.id}>
                    {provider.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </ManageField>

        {providerId === 'custom' ? (
          <ManageField label={t('model.protocol', { defaultValue: 'Protocol' })}>
            <Select value={protocol} onValueChange={(value) => setProtocol(value as (typeof MODEL_PROTOCOLS)[number])}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {MODEL_PROTOCOLS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </ManageField>
        ) : null}

        <ManageField label={t('model.modelName')} htmlFor="model-model">
          <Input id="model-model" value={model} onChange={(e) => setModel(e.target.value)} placeholder={kind === 'embedding' ? 'text-embedding-3-small' : 'gpt-5.1'} />
        </ManageField>

        <ManageField label={t('model.baseUrl')} htmlFor="model-base">
          <Input id="model-base" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.302.ai/v1" className="font-mono text-xs" />
        </ManageField>

        <ManageField label={t('model.apiKey')} htmlFor="model-key">
          <Input id="model-key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={editing ? t('model.keyKeepHint', { defaultValue: 'Leave blank to keep the saved key' }) : 'sk-...'} className="font-mono text-xs" autoComplete="off" />
        </ManageField>

        {kind === 'llm' ? (
          <>
            <ManageField label={t('model.contextWindow')} htmlFor="model-ctx" description={t('model.contextWindowCompactionHint')}>
              <Input id="model-ctx" value={contextWindow} onChange={(e) => setContextWindow(e.target.value)} placeholder="128000" inputMode="numeric" />
            </ManageField>

            <ManageField label={t('model.maxOutput')} htmlFor="model-max">
              <Input id="model-max" value={maxOutput} onChange={(e) => setMaxOutput(e.target.value)} placeholder="8192" inputMode="numeric" />
            </ManageField>
          </>
        ) : null}

        <ManagePreviewBlock className="text-xs text-muted-foreground">{t('model.secretHint')}</ManagePreviewBlock>
      </ManageForm>
    </ManageDialog>
  );
}

function numeric(value: string): number | undefined {
  const n = Number(value.trim());
  return value.trim() && Number.isFinite(n) ? n : undefined;
}

function compact(obj: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return entries.length ? Object.fromEntries(entries) : undefined;
}
