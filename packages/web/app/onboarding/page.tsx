'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { fetchModels, saveModel } from '@/lib/services';
import { isConfiguredLlmModel } from '../../lib/models';
import { clearOnboardingSkipped, hasSkippedOnboarding, markOnboardingSkipped } from '../../lib/onboarding';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export default function OnboardingPage() {
  const router = useRouter();
  const { t } = useTranslation();
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    void (async () => {
      if (hasSkippedOnboarding()) {
        router.replace('/');
        return;
      }
      try {
        const models = await fetchModels();
        const configured = models.some(isConfiguredLlmModel);
        if (configured) {
          clearOnboardingSkipped();
          router.replace('/');
          return;
        }
        const firstModel = models.find((m) => m.purpose !== 'embedding') ?? models[0];
        const first = firstModel?.config;
        if (first?.baseUrl) setBaseUrl(String(first.baseUrl));
        if (firstModel?.model) setModel(String(firstModel.model));
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    })();
  }, [router]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      await saveModel({
        id: 'onboarding-main',
        providerId: 'openai-compatible',
        model: model.trim(),
        kind: 'llm',
        config: { baseUrl: baseUrl.trim(), apiKey: apiKey.trim() },
        isDefault: true,
      });
      clearOnboardingSkipped();
      router.replace('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function onSkip() {
    markOnboardingSkipped();
    router.replace('/');
  }

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background text-foreground">
        <p className="text-sm text-muted-foreground">{t('onboarding.checking', { defaultValue: '正在检查配置…' })}</p>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 shadow-sm">
        <h1 className="text-xl font-semibold">{t('onboarding.welcome', { defaultValue: '欢迎使用 Zleap' })}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t('onboarding.intro', { defaultValue: '连接你的 LLM API 即可开始。配置保存在本地数据库，可随时在设置中修改。' })}
        </p>
        <form className="mt-6 space-y-4" onSubmit={onSubmit}>
          <label className="block space-y-1 text-sm">
            <span>Base URL</span>
            <Input className="h-10" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required />
          </label>
          <label className="block space-y-1 text-sm">
            <span>API Key</span>
            <Input className="h-10" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} required />
          </label>
          <label className="block space-y-1 text-sm">
            <span>{t('onboarding.modelName', { defaultValue: '模型名称' })}</span>
            <Input
              className="h-10"
              placeholder={t('onboarding.modelPlaceholder', { defaultValue: '例如 gpt-4o-mini' })}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              required
            />
          </label>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <Button type="submit" disabled={saving} className="h-10 w-full">
            {saving ? t('onboarding.saving', { defaultValue: '保存中…' }) : t('onboarding.start', { defaultValue: '开始使用' })}
          </Button>
          <Button type="button" variant="outline" disabled={saving} onClick={onSkip} className="h-10 w-full font-medium text-muted-foreground">
            {t('onboarding.later', { defaultValue: '稍后配置' })}
          </Button>
        </form>
      </div>
    </main>
  );
}
