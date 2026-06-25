'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { webApiFetch } from '../../lib/api';
import { isConfiguredLlmModel } from '../../lib/models';
import { clearOnboardingSkipped, hasSkippedOnboarding, markOnboardingSkipped } from '../../lib/onboarding';

export default function OnboardingPage() {
  const router = useRouter();
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
        const res = await webApiFetch('/api/models');
        const data = (await res.json()) as { models: Array<{ config?: { hasApiKey?: boolean; baseUrl?: string }; model?: string; purpose?: string }> };
        const configured = data.models.some(isConfiguredLlmModel);
        if (configured) {
          clearOnboardingSkipped();
          router.replace('/');
          return;
        }
        const firstModel = data.models.find((m) => m.purpose !== 'embedding') ?? data.models[0];
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
      await webApiFetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'onboarding-main',
          providerId: 'openai-compatible',
          model: model.trim(),
          kind: 'llm',
          config: {
            baseUrl: baseUrl.trim(),
            apiKey: apiKey.trim(),
          },
          isDefault: true,
        }),
      }).then(async (response) => {
        if (response.ok) return;
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `保存失败：HTTP ${response.status}`);
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
        <p className="text-sm text-muted-foreground">正在检查配置…</p>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 shadow-sm">
        <h1 className="text-xl font-semibold">欢迎使用 Zleap</h1>
        <p className="mt-2 text-sm text-muted-foreground">连接你的 LLM API 即可开始。配置保存在本地数据库，可随时在设置中修改。</p>
        <form className="mt-6 space-y-4" onSubmit={onSubmit}>
          <label className="block space-y-1 text-sm">
            <span>Base URL</span>
            <input
              className="w-full rounded-lg border border-input bg-background px-3 py-2"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              required
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span>API Key</span>
            <input
              className="w-full rounded-lg border border-input bg-background px-3 py-2"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              required
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span>模型名称</span>
            <input
              className="w-full rounded-lg border border-input bg-background px-3 py-2"
              placeholder="例如 gpt-4o-mini"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              required
            />
          </label>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <button
            type="submit"
            disabled={saving}
            className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
          >
            {saving ? '保存中…' : '开始使用'}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={onSkip}
            className="w-full rounded-lg border border-input bg-background px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-60"
          >
            稍后配置
          </button>
        </form>
      </div>
    </main>
  );
}
