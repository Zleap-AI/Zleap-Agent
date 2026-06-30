'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import {
  KeyRound,
  MessageCircle,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Terminal,
  X,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { postJson, webApiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { Resources } from '@/lib/useResources';
import { ChannelConnectionPanel } from './ChannelConnectionPanel';
import {
  ManageDetailGrid,
  ManageDetailItem,
  ManageAddButton,
  ManageDialog,
  ManageDialogFooterActions,
  ManageDrawer,
  ManageField,
  ManageForm,
  ManageList,
  ManageListRow,
  ManagePageShell as PageShell,
  ManagePreviewBlock,
  ManageSearchBar as SearchBar,
  ManageSectionLabel as SectionLabel,
  ManageSeparator,
  ManageStatusBadge,
} from './manage-ui';

export type { PageKey, PageProps } from './pageTypes';
import type { PageKey, PageProps } from './pageTypes';
import { ArtifactPage } from './pages-artifact';
import { AvatarPage } from './pages-avatar';
import { SpacePage } from './pages-space';
import { TaskPage } from './pages-task';
import { MemoryPage, formatMemoryDate } from './pages-memory';
import { ModelPage } from './pages-model';
import { SkillPage } from './pages-skill';
import { ToolPage } from './pages-tool';

const GATEWAY_CARD_CLASS = 'rounded-xl border border-border bg-card p-4 text-sm';
const GATEWAY_CARD_BODY_CLASS =
  'min-w-0 flex-1 space-y-3 text-sm [&_[role=combobox]]:text-sm [&_button]:text-sm [&_input]:text-sm [&_label]:text-sm [&_p]:text-sm';
type GatewayCardPresentation = 'card' | 'dialog';

type GatewayFormActions = {
  save: () => void | Promise<void>;
  test?: () => void | Promise<void>;
  saving: boolean;
  testing?: boolean;
};

type GatewayIntegrationCardProps = {
  presentation?: GatewayCardPresentation;
  onSaved?: () => void;
  registerActions?: (actions: GatewayFormActions | null) => void;
};

function gatewayCardClass(presentation: GatewayCardPresentation): string {
  return presentation === 'card' ? GATEWAY_CARD_CLASS : 'text-sm';
}

function useRegisterGatewayFormActions(
  embedded: boolean,
  registerActions: GatewayIntegrationCardProps['registerActions'],
  handlers: GatewayFormActions,
) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  useEffect(() => {
    if (!embedded) {
      registerActions?.(null);
      return;
    }
    registerActions?.({
      save: () => handlersRef.current.save(),
      test: handlersRef.current.test ? () => handlersRef.current.test?.() : undefined,
      saving: handlersRef.current.saving,
      testing: handlersRef.current.testing,
    });
    return () => registerActions?.(null);
  }, [embedded, registerActions, handlers.saving, handlers.testing]);
}

function gatewayFieldsClass(embedded: boolean): string {
  return cn('grid gap-3', embedded ? 'grid-cols-1' : 'sm:grid-cols-2');
}

function gatewayNeedsConnectionFlow(id: GatewayIntegrationId): boolean {
  return id === 'wechat' || id === 'feishu-cli';
}

function ComingSoonAction({ label }: { label: string }) {
  const { t } = useTranslation();
  return (
    <Button
      variant="outline"
      size="icon-lg"
      onClick={() => toast.info(t('common.comingSoon'))}
      title={label}
      aria-label={label}
      className="border-border bg-muted text-muted-foreground shadow-none hover:bg-muted/80 hover:text-foreground"
    >
      <Plus className="size-4" />
    </Button>
  );
}

/* ── shared gateway-card presentation ─────────────────────────────────────
   The three integration cards (Feishu / WeChat / Feishu CLI) keep their own
   state + save logic (different endpoints/fields), but share this chrome and
   these field blocks verbatim. Extracted so the visual contract lives once. */

function GatewayCardShell({
  presentation,
  icon,
  title,
  badge,
  hint,
  children,
  footer,
}: {
  presentation: GatewayCardPresentation;
  icon: ReactNode;
  title: string;
  badge?: ReactNode;
  hint: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const showChrome = presentation === 'card';
  return (
    <div className={gatewayCardClass(presentation)}>
      <div className={cn('flex items-start', showChrome && 'gap-3')}>
        {showChrome ? (
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-primary">{icon}</span>
        ) : null}
        <div className={GATEWAY_CARD_BODY_CLASS}>
          {showChrome ? (
            <>
              <div className="flex items-center gap-2">
                <div className="text-sm font-semibold text-foreground">{title}</div>
                {badge}
              </div>
              <p className="text-xs leading-5 text-muted-foreground">{hint}</p>
            </>
          ) : null}
          {children}
          {footer}
        </div>
      </div>
    </div>
  );
}

/** Full-access permission warning — identical copy across all gateway cards. */
function GatewayFullAccessWarning() {
  const { t } = useTranslation();
  return (
    <p className="text-xs leading-5 text-warning">
      {t('feishu.permissionFullAccessHint', {
        defaultValue: '完全访问：自动批准所有工具（含终端命令、文件写入、MCP），IM 无人工审批环节，请仅在可信群聊启用。',
      })}
    </p>
  );
}

/** Feishu/Lark domain select — shared by the Feishu and Feishu CLI cards. */
function GatewayDomainField({ value, onChange }: { value: 'feishu' | 'lark'; onChange: (value: 'feishu' | 'lark') => void }) {
  const { t } = useTranslation();
  return (
    <ManageField label={t('feishu.domain', { defaultValue: '域名' })}>
      <Select value={value} onValueChange={(next) => onChange(next === 'lark' ? 'lark' : 'feishu')}>
        <SelectTrigger className="h-8 w-full text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="feishu">{t('feishu.domainFeishu', { defaultValue: '飞书（国内）' })}</SelectItem>
          <SelectItem value="lark">{t('feishu.domainLark', { defaultValue: 'Lark（国际）' })}</SelectItem>
        </SelectContent>
      </Select>
    </ManageField>
  );
}

/** App ID + App Secret pair — shared by the Feishu and Feishu CLI cards. */
function GatewayAppCredentials({
  appId,
  onAppId,
  appSecret,
  onAppSecret,
  hasAppSecret,
}: {
  appId: string;
  onAppId: (value: string) => void;
  appSecret: string;
  onAppSecret: (value: string) => void;
  hasAppSecret: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      <ManageField label="App ID">
        <Input value={appId} onChange={(event) => onAppId(event.target.value)} placeholder="cli_xxxxxxxxxxxx" className="h-8 font-mono text-xs" autoComplete="off" />
      </ManageField>
      <ManageField label="App Secret">
        <Input
          type="password"
          value={appSecret}
          onChange={(event) => onAppSecret(event.target.value)}
          placeholder={hasAppSecret ? t('feishu.secretKept', { defaultValue: '已保存（留空不变）' }) : '••••••••'}
          className="h-8 font-mono text-xs"
          autoComplete="off"
        />
      </ManageField>
    </>
  );
}

/* ── pages ────────────────────────────────────────────────────────────── */

type FeishuIntegrationView = {
  configured?: boolean;
  appId?: string;
  domain?: 'feishu' | 'lark';
  groupPolicy?: string;
  permissionMode?: 'request_approval' | 'full_access';
  allowedUsers?: string[];
  botOpenId?: string;
  botName?: string;
  hasAppSecret?: boolean;
  updatedAt?: string;
};

const FEISHU_GROUP_POLICIES = ['open', 'allowlist', 'blacklist', 'admin_only', 'disabled'] as const;
const FEISHU_PERMISSION_MODES = ['request_approval', 'full_access'] as const;

function FeishuIntegrationCard({ presentation = 'card', onSaved, registerActions }: GatewayIntegrationCardProps) {
  const { t } = useTranslation();
  const embedded = presentation === 'dialog';
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [domain, setDomain] = useState<'feishu' | 'lark'>('feishu');
  const [groupPolicy, setGroupPolicy] = useState('open');
  const [permissionMode, setPermissionMode] = useState<'request_approval' | 'full_access'>('request_approval');
  const [allowedUsers, setAllowedUsers] = useState('');
  const [botName, setBotName] = useState('');
  const [botOpenId, setBotOpenId] = useState('');
  const [configured, setConfigured] = useState(false);
  const [hasAppSecret, setHasAppSecret] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void webApiFetch('/api/integrations/feishu')
      .then(async (response) => (response.ok ? ((await response.json()) as FeishuIntegrationView) : null))
      .then((body) => {
        if (cancelled || !body) return;
        setConfigured(body.configured === true);
        setHasAppSecret(body.hasAppSecret === true);
        setAppId(body.appId ?? '');
        setDomain(body.domain === 'lark' ? 'lark' : 'feishu');
        setGroupPolicy(body.groupPolicy ?? 'open');
        setPermissionMode(body.permissionMode === 'full_access' ? 'full_access' : 'request_approval');
        setAllowedUsers((body.allowedUsers ?? []).join(', '));
        setBotName(body.botName ?? '');
        setBotOpenId(body.botOpenId ?? '');
      })
      .catch(() => { });
    return () => {
      cancelled = true;
    };
  }, []);

  const payload = () => ({
    appId: appId.trim(),
    appSecret: appSecret.trim(),
    domain,
    groupPolicy,
    permissionMode,
    allowedUsers: allowedUsers.trim(),
    botName: botName.trim(),
    botOpenId: botOpenId.trim(),
  });

  const saveFeishu = async () => {
    if (!appId.trim()) {
      toast.error(t('feishu.appIdRequired', { defaultValue: '请先填写 App ID' }));
      return;
    }
    if (!appSecret.trim() && !hasAppSecret) {
      toast.error(t('feishu.appSecretRequired', { defaultValue: '请先填写 App Secret' }));
      return;
    }
    setSaving(true);
    try {
      const result = (await postJson('/api/integrations/feishu', payload())) as FeishuIntegrationView;
      setConfigured(result.configured === true);
      setHasAppSecret(result.hasAppSecret === true);
      setAppSecret('');
      toast.success(t('feishu.saved', { defaultValue: '飞书配置已保存，网关将自动生效' }));
      onSaved?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const testFeishu = async () => {
    setTesting(true);
    try {
      const result = (await postJson('/api/integrations/feishu/test', {
        appId: appId.trim(),
        appSecret: appSecret.trim(),
        domain,
      })) as { ok?: boolean; error?: string };
      if (result.ok) {
        toast.success(t('feishu.testOk', { defaultValue: '连接成功，凭证有效' }));
      } else {
        toast.error(t('feishu.testFailed', { defaultValue: '连接失败' }) + (result.error ? `：${result.error}` : ''));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };

  useRegisterGatewayFormActions(embedded, registerActions, { save: saveFeishu, test: testFeishu, saving, testing });

  return (
    <GatewayCardShell
      presentation={presentation}
      icon={<KeyRound className="size-4" />}
      title={t('feishu.title', { defaultValue: '飞书网关' })}
      badge={
        <ManageStatusBadge variant={configured ? 'secondary' : 'outline'}>
          {configured ? t('feishu.configured', { defaultValue: '已配置' }) : t('feishu.notConfigured', { defaultValue: '未配置' })}
        </ManageStatusBadge>
      }
      hint={t('feishu.hint', {
        defaultValue:
          '填入飞书自建应用的 App ID / App Secret 即可接入（长连接模式，无需公网回调）。凭证保存在后端数据库，不会展示给模型。保存后网关将自动生效。',
      })}
      footer={
        !embedded && configured ? (
          <>
            <ManageSeparator />
            <ChannelConnectionPanel channel="feishu" enabled={configured} />
          </>
        ) : null
      }
    >
      <ManageForm className="gap-3">
        <div className={gatewayFieldsClass(embedded)}>
          <GatewayAppCredentials appId={appId} onAppId={setAppId} appSecret={appSecret} onAppSecret={setAppSecret} hasAppSecret={hasAppSecret} />
          <GatewayDomainField value={domain} onChange={setDomain} />
          <ManageField label={t('feishu.groupPolicy', { defaultValue: '群聊准入' })}>
            <Select value={groupPolicy} onValueChange={setGroupPolicy}>
              <SelectTrigger className="h-8 w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FEISHU_GROUP_POLICIES.map((policy) => (
                  <SelectItem key={policy} value={policy}>
                    {t(`feishu.policy.${policy}`, { defaultValue: policy })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </ManageField>
          <ManageField label={t('feishu.permissionMode', { defaultValue: '权限模式' })}>
            <Select value={permissionMode} onValueChange={(value) => setPermissionMode(value === 'full_access' ? 'full_access' : 'request_approval')}>
              <SelectTrigger className="h-8 w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FEISHU_PERMISSION_MODES.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {t(`feishu.permission.${mode}`, { defaultValue: mode })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </ManageField>
          <ManageField label={t('feishu.botName', { defaultValue: '机器人名' })} description={t('feishu.botNameHint', { defaultValue: '选填，群内 @ 兜底匹配' })}>
            <Input value={botName} onChange={(event) => setBotName(event.target.value)} className="h-8 text-xs" autoComplete="off" />
          </ManageField>
          <ManageField label={t('feishu.botOpenId', { defaultValue: 'Bot open_id' })} description={t('feishu.botOpenIdHint', { defaultValue: '选填，精确 @ 匹配' })}>
            <Input value={botOpenId} onChange={(event) => setBotOpenId(event.target.value)} className="h-8 font-mono text-xs" autoComplete="off" />
          </ManageField>
        </div>
        {permissionMode === 'full_access' && <GatewayFullAccessWarning />}
        {(groupPolicy === 'allowlist' || groupPolicy === 'blacklist') && (
          <ManageField label={t('feishu.allowedUsers', { defaultValue: 'open_id 名单（逗号/空格分隔）' })}>
            <Input value={allowedUsers} onChange={(event) => setAllowedUsers(event.target.value)} className="h-8 font-mono text-xs" autoComplete="off" />
          </ManageField>
        )}
        {!embedded ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={saveFeishu} disabled={saving}>
              {saving ? t('common.saving', { defaultValue: '保存中' }) : t('common.save', { defaultValue: '保存' })}
            </Button>
            <Button size="sm" variant="outline" onClick={testFeishu} disabled={testing}>
              {testing ? t('feishu.testing', { defaultValue: '测试中' }) : t('feishu.test', { defaultValue: '测试连接' })}
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="outline" className="w-full" onClick={testFeishu} disabled={testing || saving}>
            {testing ? t('feishu.testing', { defaultValue: '测试中' }) : t('feishu.test', { defaultValue: '测试连接' })}
          </Button>
        )}
      </ManageForm>
    </GatewayCardShell>
  );
}

type WeChatIntegrationView = {
  enabled?: boolean;
  permissionMode?: 'request_approval' | 'full_access';
  groupPolicy?: string;
  allowedUsers?: string[];
  updatedAt?: string;
};

const WECHAT_GROUP_POLICIES = ['open', 'allowlist', 'blacklist', 'admin_only', 'disabled'] as const;

function WeChatIntegrationCard({ presentation = 'card', onSaved, registerActions }: GatewayIntegrationCardProps) {
  const { t } = useTranslation();
  const embedded = presentation === 'dialog';
  const [enabled, setEnabled] = useState(false);
  // Persisted enabled (DB). The connection panel/QR is driven by this, not the
  // unsaved toggle — the gateway only attaches a channel once it's saved enabled.
  const [savedEnabled, setSavedEnabled] = useState(false);
  const [permissionMode, setPermissionMode] = useState<'request_approval' | 'full_access'>('request_approval');
  const [groupPolicy, setGroupPolicy] = useState('open');
  const [allowedUsers, setAllowedUsers] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void webApiFetch('/api/integrations/wechat')
      .then(async (response) => (response.ok ? ((await response.json()) as WeChatIntegrationView) : null))
      .then((body) => {
        if (cancelled || !body) return;
        setEnabled(body.enabled === true);
        setSavedEnabled(body.enabled === true);
        setPermissionMode(body.permissionMode === 'full_access' ? 'full_access' : 'request_approval');
        setGroupPolicy(body.groupPolicy ?? 'open');
        setAllowedUsers((body.allowedUsers ?? []).join(', '));
      })
      .catch(() => { });
    return () => {
      cancelled = true;
    };
  }, []);

  const saveWeChat = async () => {
    setSaving(true);
    try {
      const result = (await postJson('/api/integrations/wechat', {
        enabled,
        permissionMode,
        groupPolicy,
        allowedUsers: allowedUsers.trim(),
      })) as WeChatIntegrationView;
      setEnabled(result.enabled === true);
      setSavedEnabled(result.enabled === true);
      toast.success(t('wechat.saved', { defaultValue: '微信配置已保存，网关将自动生效并出现二维码' }));
      onSaved?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  useRegisterGatewayFormActions(embedded, registerActions, { save: saveWeChat, saving });

  return (
    <GatewayCardShell
      presentation={presentation}
      icon={<MessageCircle className="size-4" />}
      title={t('wechat.title', { defaultValue: '微信网关' })}
      hint={t('wechat.hint', {
        defaultValue:
          '基于腾讯官方 iLink Bot 协议（微信 ClawBot），扫码登录、长轮询收发，无需公网回调。开启并保存后，下方会自动出现登录二维码，用微信扫码即可接入，无需重启网关。凭证保存在后端数据库，不会展示给模型。',
      })}
      footer={
        savedEnabled ? (
          <>
            <ManageSeparator />
            <ChannelConnectionPanel channel="wechat" enabled={savedEnabled} />
          </>
        ) : null
      }
    >
      <ManageForm className="gap-3">
        <div className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5">
          <Label className="text-xs font-medium text-foreground">{t('wechat.enable', { defaultValue: '启用微信网关' })}</Label>
          <Switch checked={enabled} onCheckedChange={setEnabled} />
        </div>
        <div className={gatewayFieldsClass(embedded)}>
          <ManageField label={t('wechat.permissionMode', { defaultValue: '权限模式' })}>
            <Select
              value={permissionMode}
              onValueChange={(value) => setPermissionMode(value === 'full_access' ? 'full_access' : 'request_approval')}
            >
              <SelectTrigger className="h-8 w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FEISHU_PERMISSION_MODES.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {t(`feishu.permission.${mode}`, { defaultValue: mode })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </ManageField>
          <ManageField label={t('wechat.groupPolicy', { defaultValue: '群聊准入' })}>
            <Select value={groupPolicy} onValueChange={setGroupPolicy}>
              <SelectTrigger className="h-8 w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WECHAT_GROUP_POLICIES.map((policy) => (
                  <SelectItem key={policy} value={policy}>
                    {t(`feishu.policy.${policy}`, { defaultValue: policy })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </ManageField>
        </div>
        {permissionMode === 'full_access' && <GatewayFullAccessWarning />}
        {(groupPolicy === 'allowlist' || groupPolicy === 'blacklist') && (
          <ManageField label={t('wechat.allowedUsers', { defaultValue: 'user_id 名单（逗号/空格分隔）' })}>
            <Input
              value={allowedUsers}
              onChange={(event) => setAllowedUsers(event.target.value)}
              className="h-8 font-mono text-xs"
              autoComplete="off"
            />
          </ManageField>
        )}
        {enabled && !savedEnabled ? (
          <p className="text-xs leading-5 text-warning">
            {t('connection.saveFirst', { defaultValue: '已开启，点击底部「保存」后网关自动接入，下方会出现登录二维码。' })}
          </p>
        ) : null}
        {!embedded ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={saveWeChat} disabled={saving}>
              {saving ? t('common.saving', { defaultValue: '保存中' }) : t('common.save', { defaultValue: '保存' })}
            </Button>
          </div>
        ) : null}
      </ManageForm>
    </GatewayCardShell>
  );
}

type FeishuCliIntegrationView = {
  enabled?: boolean;
  identity?: 'user' | 'bot';
  domain?: 'feishu' | 'lark';
  permissionMode?: 'request_approval' | 'full_access';
  groupPolicy?: string;
  allowedUsers?: string[];
  eventKey?: string;
  botOpenId?: string;
  botName?: string;
  appId?: string;
  hasAppSecret?: boolean;
};

const FEISHU_CLI_IDENTITIES = ['user', 'bot'] as const;

function FeishuCliIntegrationCard({ presentation = 'card', onSaved, registerActions }: GatewayIntegrationCardProps) {
  const { t } = useTranslation();
  const embedded = presentation === 'dialog';
  const [enabled, setEnabled] = useState(false);
  const [identity, setIdentity] = useState<'user' | 'bot'>('user');
  const [domain, setDomain] = useState<'feishu' | 'lark'>('feishu');
  const [permissionMode, setPermissionMode] = useState<'request_approval' | 'full_access'>('request_approval');
  const [groupPolicy, setGroupPolicy] = useState('disabled');
  const [allowedUsers, setAllowedUsers] = useState('');
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [botName, setBotName] = useState('');
  const [botOpenId, setBotOpenId] = useState('');
  const [hasAppSecret, setHasAppSecret] = useState(false);
  const [savedEnabled, setSavedEnabled] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void webApiFetch('/api/integrations/feishu-cli')
      .then(async (response) => (response.ok ? ((await response.json()) as FeishuCliIntegrationView) : null))
      .then((body) => {
        if (cancelled || !body) return;
        setEnabled(body.enabled === true);
        setSavedEnabled(body.enabled === true);
        setIdentity(body.identity === 'bot' ? 'bot' : 'user');
        setDomain(body.domain === 'lark' ? 'lark' : 'feishu');
        setPermissionMode(body.permissionMode === 'full_access' ? 'full_access' : 'request_approval');
        setGroupPolicy(body.groupPolicy ?? 'disabled');
        setAllowedUsers((body.allowedUsers ?? []).join(', '));
        setAppId(body.appId ?? '');
        setBotName(body.botName ?? '');
        setBotOpenId(body.botOpenId ?? '');
        setHasAppSecret(body.hasAppSecret === true);
      })
      .catch(() => { });
    return () => {
      cancelled = true;
    };
  }, []);

  const saveFeishuCli = async () => {
    setSaving(true);
    try {
      const result = (await postJson('/api/integrations/feishu-cli', {
        enabled,
        identity,
        domain,
        permissionMode,
        groupPolicy,
        allowedUsers: allowedUsers.trim(),
        appId: appId.trim(),
        appSecret: appSecret.trim(),
        botName: botName.trim(),
        botOpenId: botOpenId.trim(),
      })) as FeishuCliIntegrationView;
      setEnabled(result.enabled === true);
      setSavedEnabled(result.enabled === true);
      setHasAppSecret(result.hasAppSecret === true);
      setAppSecret('');
      toast.success(t('feishuCli.saved', { defaultValue: '飞书 CLI 配置已保存，网关将自动生效' }));
      onSaved?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  useRegisterGatewayFormActions(embedded, registerActions, { save: saveFeishuCli, saving });

  return (
    <GatewayCardShell
      presentation={presentation}
      icon={<Terminal className="size-4" />}
      title={t('feishuCli.title', { defaultValue: '飞书 CLI 网关' })}
      hint={t('feishuCli.hint', {
        defaultValue:
          '基于官方飞书 CLI（@larksuite/cli）的第二种接入方式：子进程长驻订阅事件（event +subscribe）。bot 身份仅需 App ID/Secret 即可收发；user 身份走 OAuth 设备码授权。保存后网关自动生效，user 身份下方会出现授权链接。凭证由 lark-cli 自管，不会展示给模型。',
      })}
      footer={
        savedEnabled ? (
          <>
            <ManageSeparator />
            <ChannelConnectionPanel channel="feishu-cli" enabled={savedEnabled} />
          </>
        ) : null
      }
    >
      <ManageForm className="gap-3">
        <div className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5">
          <Label className="text-xs font-medium text-foreground">{t('feishuCli.enable', { defaultValue: '启用飞书 CLI 网关' })}</Label>
          <Switch checked={enabled} onCheckedChange={setEnabled} />
        </div>
        <div className={gatewayFieldsClass(embedded)}>
          <GatewayAppCredentials appId={appId} onAppId={setAppId} appSecret={appSecret} onAppSecret={setAppSecret} hasAppSecret={hasAppSecret} />
          <ManageField label={t('feishuCli.identity', { defaultValue: '身份' })}>
            <Select value={identity} onValueChange={(value) => setIdentity(value === 'bot' ? 'bot' : 'user')}>
              <SelectTrigger className="h-8 w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FEISHU_CLI_IDENTITIES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`feishuCli.identityOption.${value}`, { defaultValue: value })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </ManageField>
          <GatewayDomainField value={domain} onChange={setDomain} />
          <ManageField label={t('feishu.groupPolicy', { defaultValue: '群聊准入' })}>
            <Select value={groupPolicy} onValueChange={setGroupPolicy}>
              <SelectTrigger className="h-8 w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FEISHU_GROUP_POLICIES.map((policy) => (
                  <SelectItem key={policy} value={policy}>
                    {t(`feishu.policy.${policy}`, { defaultValue: policy })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </ManageField>
          <ManageField label={t('feishu.permissionMode', { defaultValue: '权限模式' })}>
            <Select
              value={permissionMode}
              onValueChange={(value) => setPermissionMode(value === 'full_access' ? 'full_access' : 'request_approval')}
            >
              <SelectTrigger className="h-8 w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FEISHU_PERMISSION_MODES.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {t(`feishu.permission.${mode}`, { defaultValue: mode })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </ManageField>
          <ManageField label={t('feishu.botName', { defaultValue: '机器人名' })} description={t('feishu.botNameHint', { defaultValue: '选填，群内 @ 兜底匹配' })}>
            <Input value={botName} onChange={(event) => setBotName(event.target.value)} className="h-8 text-xs" autoComplete="off" />
          </ManageField>
          <ManageField label={t('feishu.botOpenId', { defaultValue: 'Bot open_id' })} description={t('feishu.botOpenIdHint', { defaultValue: '选填，精确 @ 匹配' })}>
            <Input value={botOpenId} onChange={(event) => setBotOpenId(event.target.value)} className="h-8 font-mono text-xs" autoComplete="off" />
          </ManageField>
        </div>
        {identity === 'user' && (
          <p className="text-xs leading-5 text-warning">
            {t('feishuCli.userIdentityHint', {
              defaultValue:
                '用户身份：在授权范围内以你的身份执行，存在提示注入风险；官方建议勿放开放群聊。群聊建议改用 bot 身份。',
            })}
          </p>
        )}
        {permissionMode === 'full_access' && <GatewayFullAccessWarning />}
        {(groupPolicy === 'allowlist' || groupPolicy === 'blacklist') && (
          <ManageField label={t('feishu.allowedUsers', { defaultValue: 'open_id 名单（逗号/空格分隔）' })}>
            <Input value={allowedUsers} onChange={(event) => setAllowedUsers(event.target.value)} className="h-8 font-mono text-xs" autoComplete="off" />
          </ManageField>
        )}
        {enabled && !savedEnabled ? (
          <p className="text-xs leading-5 text-warning">
            {t('connection.saveFirstCli', { defaultValue: '已开启，点击底部「保存」后网关自动接入，下方会出现授权入口。' })}
          </p>
        ) : null}
        {!embedded ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={saveFeishuCli} disabled={saving}>
              {saving ? t('common.saving', { defaultValue: '保存中' }) : t('common.save', { defaultValue: '保存' })}
            </Button>
          </div>
        ) : null}
      </ManageForm>
    </GatewayCardShell>
  );
}

type GatewayIntegrationId = 'feishu' | 'wechat' | 'feishu-cli';
type GatewayIntegrationListItem = {
  id: GatewayIntegrationId;
  title: string;
  eyebrow: string;
  description: string;
  badge: string;
  icon: LucideIcon;
};

type GatewayConnectionPhase = 'disabled' | 'connecting' | 'awaiting_user' | 'connected' | 'error';
type GatewayConnectionStateView = {
  enabled?: boolean;
  phase?: GatewayConnectionPhase;
  account?: string;
  error?: string;
  updatedAt?: string;
};
type GatewayIntegrationStatus = {
  configured: boolean;
  enabled: boolean;
  appId?: string;
  domain?: 'feishu' | 'lark';
  identity?: 'user' | 'bot';
  permissionMode?: 'request_approval' | 'full_access';
  groupPolicy?: string;
  hasSecret?: boolean;
  updatedAt?: string;
  connection?: GatewayConnectionStateView;
};

function gatewayRowMeta(status: GatewayIntegrationStatus | undefined, item: GatewayIntegrationListItem): string {
  if (status?.connection?.account) return status.connection.account;
  if (status?.appId) return status.appId;
  return item.eyebrow;
}

function GatewayIntegrationRow({
  item,
  status,
  active,
  onView,
  onConfigure,
}: {
  item: GatewayIntegrationListItem;
  status?: GatewayIntegrationStatus;
  active: boolean;
  onView: () => void;
  onConfigure: () => void;
}) {
  const { t } = useTranslation();
  const Icon = item.icon;
  return (
    <ManageListRow
      active={active}
      onOpen={onView}
      leading={<Icon />}
      title={item.title}
      badges={
        <>
          <GatewayStatusBadge status={status} />
          {item.id === 'feishu' ? (
            <ManageStatusBadge variant="secondary" size="sm">{item.badge}</ManageStatusBadge>
          ) : (
            <ManageStatusBadge variant="outline" size="sm">{item.badge}</ManageStatusBadge>
          )}
        </>
      }
      meta={gatewayRowMeta(status, item)}
      actions={
        <Button variant="ghost" size="icon-sm" onClick={onConfigure} title={t('common.edit')} aria-label={t('common.edit')}>
          <Pencil className="size-4" />
        </Button>
      }
    />
  );
}

function GatewayStatusBadge({ status }: { status?: GatewayIntegrationStatus }) {
  const { t } = useTranslation();
  const tone = gatewayStatusTone(status);
  return (
    <ManageStatusBadge
      variant={tone === 'ok' ? 'secondary' : 'outline'}
      className={cn(
        tone === 'error' && 'border-warning/30 bg-warning/10 text-warning',
      )}
    >
      {gatewayStatusLabel(status, t)}
    </ManageStatusBadge>
  );
}

function gatewayStatusTone(status?: GatewayIntegrationStatus): 'ok' | 'muted' | 'error' {
  if (status?.connection?.phase === 'connected') return 'ok';
  if (status?.connection?.phase === 'error') return 'error';
  if (status?.enabled || status?.configured) return 'ok';
  return 'muted';
}

function gatewayStatusLabel(status: GatewayIntegrationStatus | undefined, t: ReturnType<typeof useTranslation>['t']): string {
  const phase = status?.connection?.phase;
  if (phase === 'connected') return t('connection.phase.connected', { defaultValue: '已连接' });
  if (phase === 'connecting') return t('connection.phase.connecting', { defaultValue: '连接中' });
  if (phase === 'awaiting_user') return t('connection.phase.awaiting_user', { defaultValue: '待确认' });
  if (phase === 'error') return t('connection.phase.error', { defaultValue: '异常' });
  if (status?.enabled) return t('gateway.enabled', { defaultValue: '已启用' });
  if (status?.configured) return t('gateway.configured', { defaultValue: '已配置' });
  return t('gateway.notConfigured', { defaultValue: '未配置' });
}

function GatewayIntegrationForm({
  active,
  onSaved,
  registerActions,
}: {
  active: GatewayIntegrationId;
  onSaved?: () => void;
  registerActions?: (actions: GatewayFormActions | null) => void;
}) {
  if (active === 'wechat') return <WeChatIntegrationCard presentation="dialog" onSaved={onSaved} registerActions={registerActions} />;
  if (active === 'feishu-cli') return <FeishuCliIntegrationCard presentation="dialog" onSaved={onSaved} registerActions={registerActions} />;
  return <FeishuIntegrationCard presentation="dialog" onSaved={onSaved} registerActions={registerActions} />;
}

function GatewayDetailDrawer({
  item,
  status,
  onClose,
  onConfigure,
}: {
  item: GatewayIntegrationListItem | null;
  status?: GatewayIntegrationStatus;
  onClose: () => void;
  onConfigure: () => void;
}) {
  const { t } = useTranslation();
  if (!item) return null;
  return (
    <ManageDrawer
      open={Boolean(item)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={item.title}
      subtitle={item.eyebrow}
      badge={<GatewayStatusBadge status={status} />}
      actions={
        <Button variant="ghost" size="icon-sm" onClick={onConfigure} title={t('common.edit')} aria-label={t('common.edit')}>
          <Pencil />
        </Button>
      }
    >
      <ManagePreviewBlock className="text-xs leading-relaxed text-muted-foreground">{item.description}</ManagePreviewBlock>
      <ManageDetailGrid>
        <ManageDetailItem label={t('connection.status', { defaultValue: '连接状态' })} value={gatewayStatusLabel(status, t)} />
        <ManageDetailItem label={t('gateway.type', { defaultValue: '接入类型' })} value={item.eyebrow} />
        <ManageDetailItem label={t('feishu.permissionMode', { defaultValue: '权限模式' })} value={permissionModeLabel(status?.permissionMode, t)} />
        <ManageDetailItem label={t('feishu.groupPolicy', { defaultValue: '群聊准入' })} value={groupPolicyLabel(status?.groupPolicy, t)} />
        {status?.domain ? (
          <ManageDetailItem label={t('feishu.domain', { defaultValue: '域名' })} value={status.domain === 'lark' ? t('feishu.domainLark', { defaultValue: 'Lark（国际）' }) : t('feishu.domainFeishu', { defaultValue: '飞书（国内）' })} />
        ) : null}
        {status?.identity ? <ManageDetailItem label={t('feishuCli.identity', { defaultValue: '身份' })} value={t(`feishuCli.identityOption.${status.identity}`, { defaultValue: status.identity })} /> : null}
        {status?.appId ? <ManageDetailItem label="App ID" value={status.appId} /> : null}
        {status?.connection?.account ? <ManageDetailItem label={t('connection.account', { defaultValue: '账号' })} value={status.connection.account} /> : null}
        {status?.updatedAt || status?.connection?.updatedAt ? (
          <ManageDetailItem label={t('memory.updated', { defaultValue: '更新时间' })} value={formatMemoryDate(status.connection?.updatedAt ?? status.updatedAt)} />
        ) : null}
      </ManageDetailGrid>
      {status?.connection?.error ? <ManagePreviewBlock className="text-xs text-destructive">{status.connection.error}</ManagePreviewBlock> : null}
      {(status?.enabled || status?.configured) ? (
        <>
          <ManageSeparator />
          <ChannelConnectionPanel channel={item.id} enabled={status?.enabled === true || status?.configured === true} />
        </>
      ) : null}
    </ManageDrawer>
  );
}

function permissionModeLabel(mode: GatewayIntegrationStatus['permissionMode'], t: ReturnType<typeof useTranslation>['t']): string {
  return mode ? t(`feishu.permission.${mode}`, { defaultValue: mode }) : '-';
}

function groupPolicyLabel(policy: string | undefined, t: ReturnType<typeof useTranslation>['t']): string {
  return policy ? t(`feishu.policy.${policy}`, { defaultValue: policy }) : '-';
}

function GatewayConfigDialog({
  open,
  onOpenChange,
  items,
  initialType,
  onTypeChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: GatewayIntegrationListItem[];
  initialType: GatewayIntegrationId;
  onTypeChange: (id: GatewayIntegrationId) => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [type, setType] = useState<GatewayIntegrationId>(initialType);
  const [formActions, setFormActions] = useState<GatewayFormActions | null>(null);
  useEffect(() => {
    if (open) setType(initialType);
  }, [initialType, open]);
  useEffect(() => {
    if (open) setFormActions(null);
  }, [open, type]);
  const selected = items.find((item) => item.id === type) ?? items[0];
  const handleSaved = () => {
    onSaved();
    if (!gatewayNeedsConnectionFlow(type)) {
      onOpenChange(false);
    }
  };
  const busy = formActions?.saving === true || formActions?.testing === true;
  return (
    <ManageDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('gateway.configureIntegration', { defaultValue: '配置网关接入' })}
      description={selected?.description ?? t('gateway.newIntegrationDesc', { defaultValue: '选择一种接入类型，然后完成凭证与权限配置。' })}
      expandable
      footer={
        <ManageDialogFooterActions
          onCancel={() => onOpenChange(false)}
          onConfirm={() => void formActions?.save()}
          busy={busy}
          confirmDisabled={!formActions}
          confirmLabel={formActions?.saving ? t('common.saving', { defaultValue: '保存中' }) : t('common.save', { defaultValue: '保存' })}
        />
      }
    >
      <ManageForm>
        <ManageField label={t('gateway.type', { defaultValue: '网关类型' })}>
          <Select
            value={type}
            onValueChange={(value) => {
              const next = value as GatewayIntegrationId;
              setType(next);
              onTypeChange(next);
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {items.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    <span className="flex items-center gap-2">
                      {item.title}
                      <span className="text-xs text-muted-foreground">{item.eyebrow}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </ManageField>
        <GatewayIntegrationForm key={type} active={type} onSaved={handleSaved} registerActions={setFormActions} />
      </ManageForm>
    </ManageDialog>
  );
}

async function readGatewayJson<T>(url: string): Promise<T | null> {
  try {
    const response = await webApiFetch(url);
    return response.ok ? ((await response.json()) as T) : null;
  } catch {
    return null;
  }
}

async function fetchGatewayStatuses(): Promise<Record<GatewayIntegrationId, GatewayIntegrationStatus>> {
  const [feishu, wechat, feishuCli] = await Promise.all([
    readGatewayJson<FeishuIntegrationView>('/api/integrations/feishu'),
    readGatewayJson<WeChatIntegrationView>('/api/integrations/wechat'),
    readGatewayJson<FeishuCliIntegrationView>('/api/integrations/feishu-cli'),
  ]);
  const statuses: Record<GatewayIntegrationId, GatewayIntegrationStatus> = {
    feishu: {
      configured: feishu?.configured === true,
      enabled: feishu?.configured === true,
      appId: feishu?.appId,
      domain: feishu?.domain,
      permissionMode: feishu?.permissionMode,
      groupPolicy: feishu?.groupPolicy,
      hasSecret: feishu?.hasAppSecret,
      updatedAt: feishu?.updatedAt,
    },
    wechat: {
      configured: wechat?.enabled === true,
      enabled: wechat?.enabled === true,
      permissionMode: wechat?.permissionMode,
      groupPolicy: wechat?.groupPolicy,
      updatedAt: wechat?.updatedAt,
    },
    'feishu-cli': {
      configured: feishuCli?.enabled === true || Boolean(feishuCli?.appId),
      enabled: feishuCli?.enabled === true,
      appId: feishuCli?.appId,
      domain: feishuCli?.domain,
      identity: feishuCli?.identity,
      permissionMode: feishuCli?.permissionMode,
      groupPolicy: feishuCli?.groupPolicy,
      hasSecret: feishuCli?.hasAppSecret,
    },
  };
  await Promise.all(
    (Object.keys(statuses) as GatewayIntegrationId[]).map(async (id) => {
      if (!statuses[id].enabled && !statuses[id].configured) return;
      const connection = await readGatewayJson<GatewayConnectionStateView>(`/api/connections/${id}`);
      if (connection) statuses[id].connection = connection;
    }),
  );
  return statuses;
}

export function GatewayPage({ onBack }: PageProps) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [active, setActive] = useState<GatewayIntegrationId | null>(null);
  const [configDialogOpen, setConfigDialogOpen] = useState(false);
  const [configType, setConfigType] = useState<GatewayIntegrationId>('feishu');
  const [refreshing, setRefreshing] = useState(false);
  const [statuses, setStatuses] = useState<Record<GatewayIntegrationId, GatewayIntegrationStatus>>({
    feishu: { configured: false, enabled: false },
    wechat: { configured: false, enabled: false },
    'feishu-cli': { configured: false, enabled: false },
  });
  const integrations: GatewayIntegrationListItem[] = [
    {
      id: 'feishu',
      title: t('feishu.title', { defaultValue: '飞书网关' }),
      eyebrow: t('gateway.longConnection', { defaultValue: '长连接 Bot' }),
      description: t('feishu.hint', {
        defaultValue:
          '填入飞书自建应用的 App ID / App Secret 即可接入（长连接模式，无需公网回调）。凭证保存在后端数据库，不会展示给模型。',
      }),
      badge: t('gateway.recommended', { defaultValue: '推荐' }),
      icon: KeyRound,
    },
    {
      id: 'wechat',
      title: t('wechat.title', { defaultValue: '微信网关' }),
      eyebrow: t('gateway.scanLogin', { defaultValue: '扫码登录' }),
      description: t('wechat.hint', {
        defaultValue:
          '基于腾讯官方 iLink Bot 协议（微信 ClawBot），扫码登录、长轮询收发，无需公网回调。开启并保存后会自动出现登录二维码。',
      }),
      badge: t('gateway.qrLogin', { defaultValue: '二维码' }),
      icon: MessageCircle,
    },
    {
      id: 'feishu-cli',
      title: t('feishuCli.title', { defaultValue: '飞书 CLI 网关' }),
      eyebrow: t('gateway.oauthDevice', { defaultValue: 'OAuth / CLI' }),
      description: t('feishuCli.hint', {
        defaultValue:
          '基于官方飞书 CLI 的第二种接入方式：子进程长驻订阅事件，支持 OAuth 设备码授权与 bot 身份。',
      }),
      badge: t('gateway.advanced', { defaultValue: '高级' }),
      icon: Terminal,
    },
  ];
  const filteredIntegrations = integrations.filter((item) =>
    `${item.title} ${item.eyebrow} ${item.description} ${item.badge}`.toLowerCase().includes(q.toLowerCase()),
  );
  const activeIntegration = active ? integrations.find((item) => item.id === active) ?? null : null;
  const refreshStatuses = () => {
    setRefreshing(true);
    void fetchGatewayStatuses()
      .then(setStatuses)
      .catch(() => undefined)
      .finally(() => setRefreshing(false));
  };
  useEffect(() => {
    refreshStatuses();
  }, []);
  const openConfig = (id: GatewayIntegrationId) => {
    setConfigType(id);
    setActive(null);
    setConfigDialogOpen(true);
  };
  const configuredCount = integrations.filter((item) => statuses[item.id].configured || statuses[item.id].enabled).length;
  return (
    <PageShell
      icon={<Server className="size-4" />}
      title={t('gateway.title', { defaultValue: '网关' })}
      subtitle={t('gateway.subtitle', { defaultValue: '配置飞书、微信等 IM 网关接入。' })}
      onBack={onBack}
      actions={
        <>
          <Button
            variant="outline"
            size="icon-lg"
            onClick={refreshStatuses}
            disabled={refreshing}
            title={t('common.refresh', { defaultValue: '刷新' })}
            aria-label={t('common.refresh', { defaultValue: '刷新' })}
          >
            <RefreshCw className={cn('size-4', refreshing && 'animate-spin')} />
          </Button>
          <ManageAddButton
            label={t('gateway.newIntegration', { defaultValue: '新增网关接入' })}
            onClick={() => openConfig(integrations.find((item) => !statuses[item.id].configured)?.id ?? configType)}
          />
        </>
      }
      toolbar={<SearchBar value={q} onChange={setQ} placeholder={t('gateway.search', { defaultValue: '搜索网关…' })} />}
    >
      {/* <SectionLabel>
        {t('gateway.integrations', { defaultValue: '网关接入' })} · {filteredIntegrations.length}
        {configuredCount > 0 ? (
          <span className="ml-1 font-normal text-muted-foreground">
            ({t('gateway.configuredCount', { defaultValue: '{{count}} 已配置', count: configuredCount })})
          </span>
        ) : null}
      </SectionLabel> */}
      <ManageList>
        {filteredIntegrations.map((item) => (
          <GatewayIntegrationRow
            key={item.id}
            item={item}
            status={statuses[item.id]}
            active={item.id === active}
            onView={() => setActive(item.id)}
            onConfigure={() => openConfig(item.id)}
          />
        ))}
      </ManageList>
      <GatewayDetailDrawer
        item={activeIntegration}
        status={active ? statuses[active] : undefined}
        onClose={() => setActive(null)}
        onConfigure={() => {
          if (active) openConfig(active);
        }}
      />
      <GatewayConfigDialog
        open={configDialogOpen}
        onOpenChange={setConfigDialogOpen}
        items={integrations}
        initialType={configType}
        onTypeChange={setConfigType}
        onSaved={refreshStatuses}
      />
    </PageShell>
  );
}
export const RESOURCE_PAGES: Record<PageKey, (props: PageProps) => ReactNode> = {
  task: TaskPage,
  gateway: GatewayPage,
  model: ModelPage,
  tool: ToolPage,
  skill: SkillPage,
  memory: MemoryPage,
  artifact: ArtifactPage,
  avatar: AvatarPage,
  space: SpacePage,
};
