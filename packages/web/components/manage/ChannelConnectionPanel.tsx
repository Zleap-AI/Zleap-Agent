'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { LogOut, PlugZap, QrCode, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { postJson, webApiFetch } from '@/lib/api';
import { qrImageSrc } from '@/lib/connectionQr';
import { Button } from '@/components/ui/button';
import { ManagePreviewBlock, ManageStatusBadge } from './manage-ui';

type ConnectionPrompt =
  | { kind: 'qr'; image: string; caption?: string }
  | { kind: 'url'; url: string; userCode?: string }
  | { kind: 'none' };

type ChannelPhase = 'disabled' | 'connecting' | 'awaiting_user' | 'connected' | 'error';

type ChannelConnectionState = {
  channel: string;
  enabled: boolean;
  phase: ChannelPhase;
  prompt?: ConnectionPrompt;
  account?: string;
  error?: string;
  updatedAt?: string;
};

function isQrPrompt(prompt: ConnectionPrompt | undefined | null): prompt is Extract<ConnectionPrompt, { kind: 'qr' }> {
  return prompt?.kind === 'qr' && Boolean(prompt.image?.trim());
}

/**
 * Channel-agnostic connection panel. Reads the unified connection state and
 * issues connect/refresh/logout commands, so web is a thin client over the same
 * contract the CLI will reuse. The QR (WeChat) or authorization URL (Feishu CLI
 * device flow) appears automatically once the channel is enabled and the gateway
 * reconciles it — no process restart required.
 */
export function ChannelConnectionPanel({ channel, enabled }: { channel: string; enabled: boolean }) {
  const { t } = useTranslation();
  const [state, setState] = useState<ChannelConnectionState | null>(null);
  const [busy, setBusy] = useState(false);
  const [qrLoadFailed, setQrLoadFailed] = useState(false);
  /** Last good QR — kept while the gateway regenerates so refresh doesn't flash blank. */
  const lastQrRef = useRef<Extract<ConnectionPrompt, { kind: 'qr' }> | null>(null);

  const phase: ChannelPhase = state?.phase ?? 'disabled';

  if (isQrPrompt(state?.prompt)) {
    lastQrRef.current = state.prompt;
  }

  const displayQr = isQrPrompt(state?.prompt) ? state.prompt : lastQrRef.current;
  const showQr = Boolean(displayQr) && (phase === 'awaiting_user' || phase === 'connecting');
  const showGenerating = phase === 'awaiting_user' && !displayQr;

  useEffect(() => {
    if (!enabled) {
      setState(null);
      lastQrRef.current = null;
      return;
    }
    let cancelled = false;
    const tick = () => {
      void webApiFetch(`/api/connections/${channel}`)
        .then(async (response) => (response.ok ? ((await response.json()) as ChannelConnectionState) : null))
        .then((body) => {
          if (!cancelled && body) {
            setState(body);
            if (isQrPrompt(body.prompt)) {
              setQrLoadFailed(false);
            }
          }
        })
        .catch(() => {});
    };
    tick();
    const pending = phase === 'awaiting_user' || phase === 'connecting' || busy;
    const interval = window.setInterval(tick, pending ? 2000 : 15000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [channel, enabled, phase, busy]);

  const command = async (action: 'connect' | 'refresh' | 'logout', okMessage: string) => {
    setBusy(true);
    try {
      await postJson(`/api/connections/${channel}`, { action });
      toast.success(okMessage);
      // Poll separately — POST returns state immediately, often before the
      // gateway has published the new QR (or after reauth wiped prompt).
      const response = await webApiFetch(`/api/connections/${channel}`);
      if (response.ok) {
        const body = (await response.json()) as ChannelConnectionState;
        setState(body);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!enabled) {
    return null;
  }

  const connected = phase === 'connected';
  const prompt = state?.prompt;
  const waitingForGatewayState = enabled && state !== null && state.enabled === false && phase === 'disabled';
  const statusLabel = waitingForGatewayState
    ? t('connection.phase.waiting_gateway', { defaultValue: '等待网关' })
    : t(`connection.phase.${phase}`, { defaultValue: phase });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">{t('connection.status', { defaultValue: '连接状态' })}</span>
        <ManageStatusBadge variant={connected ? 'secondary' : 'outline'}>
          {statusLabel}
        </ManageStatusBadge>
        {connected && state?.account ? (
          <span className="text-xs text-muted-foreground">
            {t('connection.account', { defaultValue: '账号' })}：<span className="font-mono text-foreground">{state.account}</span>
          </span>
        ) : null}
      </div>

      {showQr && displayQr ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-border/60 bg-muted/30 p-4">
          {qrLoadFailed ? (
            <div className="flex size-56 items-center justify-center rounded bg-card text-muted-foreground">
              <QrCode className="size-10" />
            </div>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={qrImageSrc(displayQr.image)}
              alt="login QR"
              className="size-56 rounded bg-white p-2 object-contain"
              onError={() => setQrLoadFailed(true)}
            />
          )}
          <p className="text-center text-xs leading-relaxed text-muted-foreground">
            {phase === 'connecting'
              ? t('connection.regenerating', { defaultValue: '正在刷新二维码…' })
              : (displayQr.caption ?? t('connection.scanQr', { defaultValue: '请用微信扫一扫登录' }))}
          </p>
        </div>
      ) : null}

      {phase === 'awaiting_user' && prompt?.kind === 'url' ? (
        <div className="flex flex-col items-start gap-3 rounded-lg border border-border/60 bg-muted/30 p-4">
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t('connection.openUrlHint', { defaultValue: '点击下方链接，在浏览器中确认授权后即可接入：' })}
          </p>
          <Button size="sm" variant="outline" onClick={() => window.open(prompt.url, '_blank', 'noopener')}>
            <PlugZap className="size-3.5" />
            {t('connection.openUrl', { defaultValue: '前往授权' })}
          </Button>
          {prompt.userCode ? (
            <p className="text-xs text-muted-foreground">
              {t('connection.userCode', { defaultValue: '校验码' })}：<span className="font-mono text-foreground">{prompt.userCode}</span>
            </p>
          ) : null}
        </div>
      ) : null}

      {showGenerating ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-border/60 bg-muted/30 p-4">
          <div className="flex size-56 items-center justify-center rounded bg-card text-muted-foreground">
            <QrCode className="size-10 animate-pulse" />
          </div>
          <p className="text-center text-xs leading-relaxed text-muted-foreground">
            {t('connection.generating', { defaultValue: '正在生成登录凭证…（需网关已启用并运行）' })}
          </p>
        </div>
      ) : null}

      {phase === 'error' && state?.error ? (
        <ManagePreviewBlock className="text-xs text-warning">
          {t('connection.error', { defaultValue: '连接异常' })}：{state.error}
        </ManagePreviewBlock>
      ) : null}

      {waitingForGatewayState ? (
        <ManagePreviewBlock className="text-xs text-warning">
          {t('connection.gatewayNotRunning', {
            defaultValue:
              '配置已启用，但还没有收到网关进程的连接状态。请确认网关进程正在运行；开发环境可执行 pnpm dev:gateway。网关上报后会自动显示二维码或授权入口。',
          })}
        </ManagePreviewBlock>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            connected
              ? command('refresh', t('connection.reloginRequested', { defaultValue: '已请求重新登录' }))
              : command('connect', t('connection.connectRequested', { defaultValue: '已请求连接，请稍候' }))
          }
        >
          <RefreshCw className={cn('size-3.5', busy && 'animate-spin')} />
          {connected
            ? t('connection.relogin', { defaultValue: '重新登录' })
            : t('connection.connect', { defaultValue: '连接 / 刷新二维码' })}
        </Button>
        {connected && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => command('logout', t('connection.loggedOut', { defaultValue: '已退出登录' }))}
          >
            <LogOut className="size-3.5" />
            {t('connection.logout', { defaultValue: '退出登录' })}
          </Button>
        )}
      </div>
    </div>
  );
}
