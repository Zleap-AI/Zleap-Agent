'use client';

import { forwardRef, useEffect, useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import {
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Cpu,
  FileText,
  FolderOpen,
  Globe,
  Image as ImageIcon,
  KeyRound,
  Loader2,
  MessageCircle,
  MoreHorizontal,
  PauseCircle,
  Pencil,
  Play,
  Plus,
  PlugZap,
  RefreshCw,
  Search,
  Send,
  Server,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { artifactContentType } from '@/lib/artifactPreview';
import { postJson, patchJson, deleteJson, webApiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { DeleteConfirmDialog } from '@/components/ui/delete-confirm-dialog';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { isDefaultForKind, llmModels, modelDisplayLabel, modelKind } from '@/lib/models';
import type { McpServerView, ModelConfigView, Resources, SkillView, ToolView } from '@/lib/useResources';
import type { Conversation as ManagedConversation } from '@/lib/useConversations';
import { ModelDialog } from './ModelDialog';
import { McpServerDialog } from './McpServerDialog';
import { SkillDialog } from './SkillDialog';
import { TaskDialog, TaskDialogChip, describeTaskCron } from './TaskDialog';
import { ChannelConnectionPanel } from './ChannelConnectionPanel';
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
  ManageSectionLabel as SectionLabel,
  ManageSeparator,
  ManageStatusBadge,
} from './manage-ui';

export type PageKey = 'task' | 'gateway' | 'model' | 'tool' | 'skill' | 'memory' | 'artifact';

export type PageProps = {
  resources: Resources;
  avatarId: string;
  currentProjectId?: string;
  conversations?: ManagedConversation[];
  onCreateTaskConversation?: (title: string, projectId?: string) => string;
  onOpenTaskConversation?: (input: { conversationId: string; title: string; prompt?: string; avatarId?: string; projectId?: string }) => void;
  onChanged: () => void;
  onBack?: () => void;
};

const GATEWAY_CARD_CLASS = 'rounded-xl border border-border bg-surface-1 p-4 text-sm';
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

/* ── pages ────────────────────────────────────────────────────────────── */

const TOOL_SET_ICONS: Record<string, LucideIcon> = {
  files: FileText,
  terminal: Terminal,
  'web-search': Search,
  web: Globe,
  browser: Globe,
  media: ImageIcon,
  external: Send,
};

const CACHE_KIND_OPTIONS = [
  { value: 'search_result', label: '搜索结果' },
  { value: 'webpage', label: '网页内容' },
  { value: 'file_output', label: '文件产物' },
  { value: 'workspace_result', label: '工作区结果' },
  { value: 'tool_result', label: '工具结果' },
  { value: 'note', label: '文本片段' },
];

function ToolCacheBadges({ tool }: { tool: ToolView }) {
  const { t } = useTranslation();
  if (tool.cache?.produces !== true) {
    return null;
  }
  const firstKind = tool.cache.kinds[0];
  return (
    <>
      <Badge variant="secondary" className="h-4 px-1.5 text-[10px] font-normal">
        {t('tool.cache.title', { defaultValue: '工作缓存' })}
        {firstKind ? ` · ${cacheKindLabel(firstKind, t)}` : ''}
      </Badge>
      {tool.cache.readonly ? (
        <Badge variant="outline" className="h-4 px-1.5 text-[10px] font-normal">
          {t('tool.cache.readonly', { defaultValue: '系统默认' })}
        </Badge>
      ) : null}
    </>
  );
}

function ToolCacheInlineSettings({
  tool,
  onChange,
}: {
  tool: ToolView;
  onChange: (cache: NonNullable<ToolView['cache']>) => void;
}) {
  const { t } = useTranslation();
  const cache = tool.cache ?? { produces: false, kinds: [], capture: 'none' as const };
  const readonly = cache.readonly === true;
  if (!cache.produces && tool.origin !== 'mcp') {
    return null;
  }
  const selectedKinds = new Set(cache.kinds);
  const updateProduces = (produces: boolean) => {
    onChange({
      produces,
      kinds: produces ? (cache.kinds.length ? cache.kinds : ['tool_result']) : [],
      capture: produces ? 'auto' : 'none',
      readonly: cache.readonly,
    });
  };
  const toggleKind = (kind: string) => {
    if (!cache.produces || readonly) {
      return;
    }
    const next = new Set(selectedKinds);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    onChange({
      produces: true,
      kinds: next.size ? [...next] : ['tool_result'],
      capture: 'auto',
      readonly: cache.readonly,
    });
  };
  return (
    <div className="ml-[18px] rounded-lg px-3 py-2 text-xs text-muted-foreground">
      <div className="flex items-center gap-2">
        <span className="font-medium text-foreground">{t('tool.cache.title', { defaultValue: '工作缓存' })}</span>
        {readonly ? (
          <Badge variant="outline" className="h-4 px-1.5 text-[10px] font-normal">
            {t('tool.cache.readonly', { defaultValue: '系统默认' })}
          </Badge>
        ) : null}
        <Switch checked={cache.produces} disabled={readonly} onCheckedChange={updateProduces} />
      </div>
      <div className="mt-1 leading-relaxed">
        {t('tool.cache.description', {
          defaultValue: '工具执行成功后由 runtime 自动保存可复用结果，供其他工作区按需读取。模型不能主动写缓存。',
        })}
      </div>
      {cache.produces ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {CACHE_KIND_OPTIONS.map((option) => {
            const active = selectedKinds.has(option.value);
            return (
              <button
                key={option.value}
                type="button"
                disabled={readonly}
                onClick={() => toggleKind(option.value)}
                className={cn(
                  'rounded-full border px-2 py-0.5 text-[11px] transition',
                  active ? 'border-primary/30 bg-primary/10 text-primary' : 'border-border bg-background text-muted-foreground',
                  readonly ? 'cursor-default' : 'hover:border-primary/40 hover:text-primary',
                )}
              >
                {cacheKindLabel(option.value, t)}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function cacheKindLabel(kind: string, t: (key: string, options?: Record<string, unknown>) => string): string {
  return t(`tool.cache.kinds.${kind}`, {
    defaultValue: CACHE_KIND_OPTIONS.find((option) => option.value === kind)?.label ?? kind,
  });
}

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
  const showChrome = presentation === 'card';
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
      .catch(() => {});
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
    <div className={gatewayCardClass(presentation)}>
      <div className={cn('flex items-start', showChrome && 'gap-3')}>
        {showChrome ? (
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-primary">
            <KeyRound className="size-4" />
          </span>
        ) : null}
        <div className={GATEWAY_CARD_BODY_CLASS}>
          {showChrome ? (
            <>
              <div className="flex items-center gap-2">
                <div className="text-sm font-semibold text-foreground">{t('feishu.title', { defaultValue: '飞书网关' })}</div>
                <Badge variant={configured ? 'secondary' : 'outline'} className="h-5 px-1.5 text-[10px] font-normal">
                  {configured ? t('feishu.configured', { defaultValue: '已配置' }) : t('feishu.notConfigured', { defaultValue: '未配置' })}
                </Badge>
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
                {t('feishu.hint', {
                  defaultValue:
                    '填入飞书自建应用的 App ID / App Secret 即可接入（长连接模式，无需公网回调）。凭证保存在后端数据库，不会展示给模型。保存后网关将自动生效。',
                })}
              </p>
            </>
          ) : null}
          <ManageForm className="gap-3">
          <div className={gatewayFieldsClass(embedded)}>
            <ManageField label="App ID">
              <Input
                value={appId}
                onChange={(event) => setAppId(event.target.value)}
                placeholder="cli_xxxxxxxxxxxx"
                className="h-8 font-mono text-xs"
                autoComplete="off"
              />
            </ManageField>
            <ManageField label="App Secret">
              <Input
                type="password"
                value={appSecret}
                onChange={(event) => setAppSecret(event.target.value)}
                placeholder={hasAppSecret ? t('feishu.secretKept', { defaultValue: '已保存（留空不变）' }) : '••••••••'}
                className="h-8 font-mono text-xs"
                autoComplete="off"
              />
            </ManageField>
            <ManageField label={t('feishu.domain', { defaultValue: '域名' })}>
              <Select value={domain} onValueChange={(value) => setDomain(value === 'lark' ? 'lark' : 'feishu')}>
                <SelectTrigger className="h-8 w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="feishu">{t('feishu.domainFeishu', { defaultValue: '飞书（国内）' })}</SelectItem>
                  <SelectItem value="lark">{t('feishu.domainLark', { defaultValue: 'Lark（国际）' })}</SelectItem>
                </SelectContent>
              </Select>
            </ManageField>
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
          {permissionMode === 'full_access' && (
            <p className="text-xs leading-5 text-amber-600 dark:text-amber-500">
              {t('feishu.permissionFullAccessHint', {
                defaultValue: '完全访问：自动批准所有工具（含终端命令、文件写入、MCP），IM 无人工审批环节，请仅在可信群聊启用。',
              })}
            </p>
          )}
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
          {!embedded && configured ? (
            <>
              <ManageSeparator />
              <ChannelConnectionPanel channel="feishu" enabled={configured} />
            </>
          ) : null}
        </div>
      </div>
    </div>
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
  const showChrome = presentation === 'card';
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
      .catch(() => {});
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
    <div className={gatewayCardClass(presentation)}>
      <div className={cn('flex items-start', showChrome && 'gap-3')}>
        {showChrome ? (
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-primary">
            <MessageCircle className="size-4" />
          </span>
        ) : null}
        <div className={GATEWAY_CARD_BODY_CLASS}>
          {showChrome ? (
            <>
              <div className="flex items-center gap-2">
                <div className="text-sm font-semibold text-foreground">{t('wechat.title', { defaultValue: '微信网关' })}</div>
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
                {t('wechat.hint', {
                  defaultValue:
                    '基于腾讯官方 iLink Bot 协议（微信 ClawBot），扫码登录、长轮询收发，无需公网回调。开启并保存后，下方会自动出现登录二维码，用微信扫码即可接入，无需重启网关。凭证保存在后端数据库，不会展示给模型。',
                })}
              </p>
            </>
          ) : null}
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
          {permissionMode === 'full_access' && (
            <p className="text-xs leading-5 text-amber-600 dark:text-amber-500">
              {t('feishu.permissionFullAccessHint', {
                defaultValue: '完全访问：自动批准所有工具（含终端命令、文件写入、MCP），IM 无人工审批环节，请仅在可信群聊启用。',
              })}
            </p>
          )}
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
            <p className="text-xs leading-5 text-amber-600 dark:text-amber-500">
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
          {savedEnabled ? (
            <>
              <ManageSeparator />
              <ChannelConnectionPanel channel="wechat" enabled={savedEnabled} />
            </>
          ) : null}
        </div>
      </div>
    </div>
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
  const showChrome = presentation === 'card';
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
      .catch(() => {});
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
    <div className={gatewayCardClass(presentation)}>
      <div className={cn('flex items-start', showChrome && 'gap-3')}>
        {showChrome ? (
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-primary">
            <Terminal className="size-4" />
          </span>
        ) : null}
        <div className={GATEWAY_CARD_BODY_CLASS}>
          {showChrome ? (
            <>
              <div className="flex items-center gap-2">
                <div className="text-sm font-semibold text-foreground">
                  {t('feishuCli.title', { defaultValue: '飞书 CLI 网关' })}
                </div>
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
                {t('feishuCli.hint', {
                  defaultValue:
                    '基于官方飞书 CLI（@larksuite/cli）的第二种接入方式：子进程长驻订阅事件（event +subscribe）。bot 身份仅需 App ID/Secret 即可收发；user 身份走 OAuth 设备码授权。保存后网关自动生效，user 身份下方会出现授权链接。凭证由 lark-cli 自管，不会展示给模型。',
                })}
              </p>
            </>
          ) : null}
          <ManageForm className="gap-3">
          <div className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5">
            <Label className="text-xs font-medium text-foreground">{t('feishuCli.enable', { defaultValue: '启用飞书 CLI 网关' })}</Label>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </div>
          <div className={gatewayFieldsClass(embedded)}>
            <ManageField label="App ID">
              <Input
                value={appId}
                onChange={(event) => setAppId(event.target.value)}
                placeholder="cli_xxxxxxxxxxxx"
                className="h-8 font-mono text-xs"
                autoComplete="off"
              />
            </ManageField>
            <ManageField label="App Secret">
              <Input
                type="password"
                value={appSecret}
                onChange={(event) => setAppSecret(event.target.value)}
                placeholder={hasAppSecret ? t('feishu.secretKept', { defaultValue: '已保存（留空不变）' }) : '••••••••'}
                className="h-8 font-mono text-xs"
                autoComplete="off"
              />
            </ManageField>
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
            <ManageField label={t('feishu.domain', { defaultValue: '域名' })}>
              <Select value={domain} onValueChange={(value) => setDomain(value === 'lark' ? 'lark' : 'feishu')}>
                <SelectTrigger className="h-8 w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="feishu">{t('feishu.domainFeishu', { defaultValue: '飞书（国内）' })}</SelectItem>
                  <SelectItem value="lark">{t('feishu.domainLark', { defaultValue: 'Lark（国际）' })}</SelectItem>
                </SelectContent>
              </Select>
            </ManageField>
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
            <p className="text-xs leading-5 text-amber-600 dark:text-amber-500">
              {t('feishuCli.userIdentityHint', {
                defaultValue:
                  '用户身份：在授权范围内以你的身份执行，存在提示注入风险；官方建议勿放开放群聊。群聊建议改用 bot 身份。',
              })}
            </p>
          )}
          {permissionMode === 'full_access' && (
            <p className="text-xs leading-5 text-amber-600 dark:text-amber-500">
              {t('feishu.permissionFullAccessHint', {
                defaultValue: '完全访问：自动批准所有工具（含终端命令、文件写入、MCP），IM 无人工审批环节，请仅在可信群聊启用。',
              })}
            </p>
          )}
          {(groupPolicy === 'allowlist' || groupPolicy === 'blacklist') && (
            <ManageField label={t('feishu.allowedUsers', { defaultValue: 'open_id 名单（逗号/空格分隔）' })}>
              <Input value={allowedUsers} onChange={(event) => setAllowedUsers(event.target.value)} className="h-8 font-mono text-xs" autoComplete="off" />
            </ManageField>
          )}
          {enabled && !savedEnabled ? (
            <p className="text-xs leading-5 text-amber-600 dark:text-amber-500">
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
          {savedEnabled ? (
            <>
              <ManageSeparator />
              <ChannelConnectionPanel channel="feishu-cli" enabled={savedEnabled} />
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ModelApi302KeyCard({ onSaved }: { onSaved: () => void }) {
  const { t } = useTranslation();
  const [api302Key, setApi302Key] = useState('');
  const [api302Configured, setApi302Configured] = useState(false);
  const [saving302, setSaving302] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void webApiFetch('/api/integrations/302')
      .then(async (response) => (response.ok ? ((await response.json()) as { configured?: boolean }) : null))
      .then((body) => {
        if (!cancelled && body) setApi302Configured(body.configured === true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const save302ApiKey = async () => {
    const key = api302Key.trim();
    if (!key) {
      toast.error(t('model.api302KeyRequired', { defaultValue: '请先填写 302.AI API Key' }));
      return;
    }
    setSaving302(true);
    try {
      await postJson('/api/integrations/302', { apiKey: key });
      setApi302Configured(true);
      setApi302Key('');
      toast.success(t('model.api302Saved', { defaultValue: '302.AI API Key 已保存' }));
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving302(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-surface-1 p-4">
      <div className="flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-primary">
          <KeyRound className="size-4" />
        </span>
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex items-center gap-2">
            <div className="text-sm font-semibold text-foreground">302.AI API Key</div>
            <Badge variant={api302Configured ? 'secondary' : 'outline'} className="h-5 px-1.5 text-[10px] font-normal">
              {api302Configured
                ? t('model.api302Configured', { defaultValue: '已配置' })
                : t('model.api302NotConfigured', { defaultValue: '未配置' })}
            </Badge>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            {t('model.api302Hint', {
              defaultValue:
                '填一次 302.AI API Key，会自动补齐 qwen3.6-flash、Qwen/Qwen3-Embedding-0.6B 和 web-search 工具。Key 只保存在本地后端，不会展示给模型。',
            })}
          </p>
          <div className="flex gap-2">
            <Input
              type="password"
              value={api302Key}
              onChange={(event) => setApi302Key(event.target.value)}
              placeholder="sk-..."
              className="h-8 font-mono text-xs"
              autoComplete="off"
            />
            <Button size="sm" onClick={save302ApiKey} disabled={saving302}>
              {saving302 ? t('common.saving', { defaultValue: '保存中' }) : t('common.save', { defaultValue: '保存' })}
            </Button>
          </div>
        </div>
      </div>
    </div>
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
            <ManageStatusBadge variant="secondary">{item.badge}</ManageStatusBadge>
          ) : (
            <Badge variant="outline" className="h-4 px-1.5 text-[10px] font-normal">
              {item.badge}
            </Badge>
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
        tone === 'error' && 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300',
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
          <Button
            size="icon-lg"
            onClick={() => openConfig(integrations.find((item) => !statuses[item.id].configured)?.id ?? configType)}
            title={t('gateway.newIntegration', { defaultValue: '新增网关接入' })}
            aria-label={t('gateway.newIntegration', { defaultValue: '新增网关接入' })}
          >
            <Plus className="size-4" />
          </Button>
        </>
      }
      toolbar={<SearchBar value={q} onChange={setQ} placeholder={t('gateway.search', { defaultValue: '搜索网关…' })} />}
    >
      <SectionLabel>
        {t('gateway.integrations', { defaultValue: '网关接入' })} · {filteredIntegrations.length}
        {configuredCount > 0 ? (
          <span className="ml-1 font-normal text-muted-foreground">
            ({t('gateway.configuredCount', { defaultValue: '{{count}} 已配置', count: configuredCount })})
          </span>
        ) : null}
      </SectionLabel>
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

export function ToolPage({ resources, avatarId, onBack }: PageProps) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [serverDialog, setServerDialog] = useState(false);
  const [editingServer, setEditingServer] = useState<McpServerView | null>(null);
  const [pendingDeleteServer, setPendingDeleteServer] = useState<McpServerView | null>(null);
  // Which server is mid tool-refresh (spins its button); null = none.
  const [refreshing, setRefreshing] = useState<string | null>(null);
  // Optimistic on/off overrides keyed `toolset:id` / `tool:id`, cleared on reload.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});

  const refreshServer = async (id: string) => {
    setRefreshing(id);
    try {
      const res = (await postJson(`/api/mcp/servers/${encodeURIComponent(id)}/discover`, {})) as {
        discovery?: { ok: boolean; count: number; error?: string };
      };
      const discovery = res.discovery;
      if (discovery?.ok) {
        toast.success(t('mcp.refreshed', { defaultValue: 'Discovered {{count}} tools', count: discovery.count }));
      } else {
        toast.error(discovery?.error ?? t('mcp.refreshFailed', { defaultValue: 'Tool discovery failed.' }));
      }
      await resources.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(null);
    }
  };
  const lowerQ = q.toLowerCase();
  const toolsById = new Map(resources.tools.map((tool) => [tool.id, tool]));

  const eff = (key: string, base: boolean) => (key in overrides ? overrides[key]! : base);
  const setEnabled = async (scope: 'toolset' | 'tool', id: string, enabled: boolean) => {
    const key = `${scope}:${id}`;
    setOverrides((prev) => ({ ...prev, [key]: enabled }));
    try {
      await patchJson('/api/tools', { scope, id, enabled });
      await resources.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setOverrides((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  };
  const setToolCache = async (tool: ToolView, cache: NonNullable<ToolView['cache']>) => {
    try {
      await patchJson('/api/tools', { scope: 'tool-cache', id: tool.id, cache });
      await resources.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };
  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const openCreateServer = () => {
    setEditingServer(null);
    setServerDialog(true);
  };
  const openEditServer = (server: McpServerView) => {
    setEditingServer(server);
    setServerDialog(true);
  };
  const removeServer = async () => {
    if (!pendingDeleteServer) return;
    try {
      await deleteJson('/api/mcp/servers', { id: pendingDeleteServer.id });
      toast.success(t('common.deleted'));
      setPendingDeleteServer(null);
      await resources.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      throw err;
    }
  };

  const filteredToolSets = resources.toolSets.filter((set) => {
    const haystack = [
      set.label,
      set.id,
      set.description,
      ...set.toolIds,
      ...set.toolIds.map((id) => toolsById.get(id)?.label ?? ''),
      ...set.toolIds.map((id) => toolsById.get(id)?.description ?? ''),
    ].join(' ').toLowerCase();
    return haystack.includes(lowerQ);
  });
  const groupedToolIds = new Set(resources.toolSets.flatMap((set) => set.toolIds));
  const ungroupedBuiltin = resources.tools
    .filter((x) => x.origin === 'builtin' && !groupedToolIds.has(x.id))
    .filter((x) => `${x.label} ${x.id} ${x.description ?? ''}`.toLowerCase().includes(lowerQ));
  const mcpToolsByServer = new Map<string, ToolView[]>();
  for (const tool of resources.tools) {
    if (tool.origin !== 'mcp' || !tool.serverId) continue;
    const current = mcpToolsByServer.get(tool.serverId) ?? [];
    current.push(tool);
    mcpToolsByServer.set(tool.serverId, current);
  }
  const filteredMcpServers = resources.mcpServers
    .map((server) => {
      const tools = mcpToolsByServer.get(server.id) ?? [];
      const serverHit = `${server.name} ${server.id} ${server.transport} ${server.status}`.toLowerCase().includes(lowerQ);
      const matchingTools = tools.filter((tool) => `${tool.label} ${tool.id} ${tool.description ?? ''}`.toLowerCase().includes(lowerQ));
      return {
        server,
        tools: !lowerQ || serverHit ? tools : matchingTools,
        toolCount: tools.length,
        visible: !lowerQ || serverHit || matchingTools.length > 0,
      };
    })
    .filter((entry) => entry.visible);

  return (
    <PageShell
      icon={<PlugZap className="size-4" />}
      title={t('tool.title')}
      subtitle={t('tool.subtitle')}
      onBack={onBack}
      actions={
        <Button size="icon-lg" onClick={openCreateServer} title={t('tool.addMcp')} aria-label={t('tool.addMcp')}>
          <Plus className="size-4" />
        </Button>
      }
      toolbar={<SearchBar value={q} onChange={setQ} placeholder={t('tool.search')} />}
    >
      <SectionLabel>{t('tool.toolsets')} · {filteredToolSets.length}</SectionLabel>
      <ManageList>
        {filteredToolSets.map((set) => {
          const Icon = TOOL_SET_ICONS[set.id] ?? PlugZap;
          const setOn = eff(`toolset:${set.id}`, set.enabled !== false);
          const open = expanded.has(set.id) || Boolean(lowerQ);
          return (
            <div key={set.id}>
              <ManageListRow
                title={set.label}
                leading={
                  <>
                    {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                    <Icon className="size-4" />
                  </>
                }
                badges={
                  <Badge variant="secondary" className="h-4 px-1.5 text-[10px] font-normal">
                    {set.toolCount} {t('tool.items')}
                  </Badge>
                }
                expanded={open}
                disabled={!setOn}
                onOpen={() => toggleExpand(set.id)}
                persistent={
                  <Switch checked={setOn} onCheckedChange={(value) => setEnabled('toolset', set.id, value)} />
                }
              />
              {open ? (
                <ManageList className="mb-1 ml-[26px] border-l border-border py-0.5 pl-2">
                  {set.toolIds.map((id) => {
                    const tool = toolsById.get(id);
                    const toolOn = setOn && eff(`tool:${id}`, tool?.enabled !== false);
                    return (
                      <div key={id}>
                        <ManageListRow
                          title={tool?.label ?? id}
                          badges={tool ? <ToolCacheBadges tool={tool} /> : undefined}
                          disabled={!toolOn}
                          indent
                          className="rounded-lg hover:bg-muted/50"
                          persistent={<Switch checked={toolOn} disabled={!setOn} onCheckedChange={(value) => setEnabled('tool', id, value)} />}
                        />
                        {tool ? <ToolCacheInlineSettings tool={tool} onChange={(cache) => setToolCache(tool, cache)} /> : null}
                      </div>
                    );
                  })}
                </ManageList>
              ) : null}
            </div>
          );
        })}
      </ManageList>
      {filteredToolSets.length === 0 ? (
        <EmptyState icon={<PlugZap className="size-5" />}>{resources.loading ? t('common.loading') : t('tool.emptyToolsets')}</EmptyState>
      ) : null}

      {ungroupedBuiltin.length > 0 ? (
        <>
          <SectionLabel>{t('tool.ungrouped')} · {ungroupedBuiltin.length}</SectionLabel>
          <ManageList>
            {ungroupedBuiltin.map((x) => {
              const on = eff(`tool:${x.id}`, x.enabled !== false);
              return (
                <div key={x.id}>
                  <ManageListRow
                    title={x.label}
                    leading={<Zap className="size-4" />}
                    badges={<ToolCacheBadges tool={x} />}
                    disabled={!on}
                    persistent={<Switch checked={on} onCheckedChange={(value) => setEnabled('tool', x.id, value)} />}
                  />
                  <ToolCacheInlineSettings tool={x} onChange={(cache) => setToolCache(x, cache)} />
                </div>
              );
            })}
          </ManageList>
        </>
      ) : null}

      <SectionLabel>{t('mcp.servers', { defaultValue: 'MCP Servers' })} · {filteredMcpServers.length}</SectionLabel>
      {filteredMcpServers.length > 0 ? (
        <ManageList>
          {filteredMcpServers.map(({ server: s, tools, toolCount }) => {
            const busy = refreshing === s.id;
            const open = expanded.has(`mcp:${s.id}`) || Boolean(lowerQ);
            return (
              <div key={s.id}>
                <ManageListRow
                  title={s.name}
                  leading={
                    <>
                      {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                      <Server className="size-4" />
                    </>
                  }
                  badges={
                    <>
                    <Badge variant="secondary" className="h-4 px-1.5 text-[10px] font-normal">{s.transport}</Badge>
                    {s.status !== 'active' ? (
                      <Badge variant="outline" className="h-4 px-1.5 text-[10px] font-normal">{s.status}</Badge>
                    ) : null}
                    </>
                  }
                  meta={`${toolCount} ${t('tool.items')}`}
                  expanded={open}
                  onOpen={() => toggleExpand(`mcp:${s.id}`)}
                  actions={
                    <>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => openEditServer(s)}
                        title={t('common.edit')}
                        aria-label={t('common.edit')}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={busy}
                        onClick={() => refreshServer(s.id)}
                        title={t('mcp.refresh', { defaultValue: 'Refresh tools' })}
                        aria-label={t('mcp.refresh', { defaultValue: 'Refresh tools' })}
                      >
                        <RefreshCw className={cn('size-4', busy && 'animate-spin')} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setPendingDeleteServer(s)}
                        title={t('common.delete')}
                        aria-label={t('common.delete')}
                        className="text-destructive hover:text-destructive"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </>
                  }
                />
                {open ? (
                  <ManageList className="mb-1 ml-[26px] border-l border-border py-0.5 pl-2">
                    {tools.length > 0 ? (
                      tools.map((tool) => {
                        const on = eff(`tool:${tool.id}`, tool.enabled !== false);
                        return (
                          <div key={tool.id}>
                            <ManageListRow
                              title={tool.label}
                              leading={<PlugZap className="size-4" />}
                              badges={<ToolCacheBadges tool={tool} />}
                              disabled={!on}
                              indent
                              className="rounded-lg hover:bg-muted/50"
                              persistent={<Switch checked={on} onCheckedChange={(value) => setEnabled('tool', tool.id, value)} />}
                            />
                            <ToolCacheInlineSettings tool={tool} onChange={(cache) => setToolCache(tool, cache)} />
                          </div>
                        );
                      })
                    ) : (
                      <div className="rounded-lg px-3 py-2 text-xs text-muted-foreground">{t('tool.emptyMcp')}</div>
                    )}
                  </ManageList>
                ) : null}
              </div>
            );
          })}
        </ManageList>
      ) : (
        <EmptyState icon={<Server className="size-5" />}>{t('mcp.emptyServers', { defaultValue: 'No MCP servers yet. Add one to discover its tools.' })}</EmptyState>
      )}

      <DeleteConfirmDialog
        open={pendingDeleteServer !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteServer(null);
        }}
        title={t('common.delete')}
        description={t('common.deleteConfirm', { name: pendingDeleteServer?.name ?? '' })}
        onConfirm={removeServer}
      />
      <McpServerDialog
        open={serverDialog}
        onOpenChange={(open) => {
          setServerDialog(open);
          if (!open) setEditingServer(null);
        }}
        avatarId={avatarId}
        server={editingServer}
        onSaved={resources.reload}
      />
    </PageShell>
  );
}

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
          <Button
            size="icon-lg"
            onClick={() => setDialogOpen(true)}
            disabled={!skillWritesAvailable}
            title={skillWritesAvailable ? t('skill.new') : skillDatabaseRequiredMessage}
            aria-label={t('skill.new')}
          >
            <Plus className="size-4" />
          </Button>
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
                          <Badge variant="outline" className="h-4 px-1.5 text-[10px] font-normal">
                            {skill.sourceType}
                          </Badge>
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
                <EmptyState>{t('skill.marketplaceEmpty', { defaultValue: '没有找到匹配的远程技能。' })}</EmptyState>
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
              <pre className="soft-scroll max-h-[calc(100vh-15rem)] overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted/35 p-3 font-mono text-xs leading-5 text-foreground">
                {skillFilePreview.content || t('skill.emptyFile', { defaultValue: '文件为空。' })}
              </pre>
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
          <Badge variant="secondary" className="h-4 px-1.5 text-[10px] font-normal">
            {fileRows.length} {t('skill.files', { defaultValue: '文件' })}
          </Badge>
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
      size="editor"
      expandable
      bodyClassName="gap-5"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} disabled={busy || !label.trim()}>
            {busy ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Check data-icon="inline-start" />}
            {t('common.save', { defaultValue: '保存' })}
          </Button>
        </>
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
            <ManageForm className="gap-3">
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
      size="editor"
      expandable
      bodyClassName="gap-0"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} disabled={busy || !draft}>
            {busy ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Check data-icon="inline-start" />}
            {t('common.save', { defaultValue: '保存' })}
          </Button>
        </>
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

export function ModelPage({ resources, avatarId, onChanged, onBack }: PageProps) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ModelConfigView | null>(null);
  const [pendingDeleteModel, setPendingDeleteModel] = useState<ModelConfigView | null>(null);
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
  return (
    <PageShell
      icon={<Cpu className="size-4" />}
      title={t('model.title')}
      subtitle={t('model.subtitle')}
      onBack={onBack}
      actions={
        <Button size="icon-lg" onClick={openCreate} title={t('model.new')} aria-label={t('model.new')}>
          <Plus className="size-4" />
        </Button>
      }
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
                  <Badge variant="outline" className="h-4 px-1.5 text-[10px] font-normal">
                    {kind === 'embedding' ? t('model.kindEmbedding') : t('model.kindLlm')}
                  </Badge>
                  {isDefault ? <Badge variant="secondary" className="h-4 px-1.5 text-[10px] font-normal">{t('model.default')}</Badge> : null}
                  </>
                }
                meta={m.providerId}
                onOpen={() => openEdit(m)}
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
            <span className={cn('inline-flex h-5 shrink-0 items-center rounded-sm border px-1.5 text-[11px] font-medium', memoryEventWorkKindClass(item.workKind))}>
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
              <code key={id} className="rounded-md border border-border bg-muted/45 px-1.5 py-0.5 text-[11px] text-muted-foreground">
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
  if (workKind === 'process') return 'border-sky-200 bg-sky-50 text-sky-700';
  if (workKind === 'result') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
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

function formatMemoryDate(value?: string): string {
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
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} disabled={busy}>
            <Check data-icon="inline-start" /> {editing ? t('common.save') : t('common.create')}
          </Button>
        </>
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

type ArtifactType = 'html' | 'image' | 'video' | 'text' | 'md';
type ArtifactItem = { id: string; title?: string; summary?: string; kind?: string; status?: string; contentUri?: string; createdAt?: string };

function inferType(item: ArtifactItem): ArtifactType {
  const name = `${item.title ?? ''} ${item.summary ?? ''} ${item.contentUri ?? ''}`.toLowerCase();
  if (/\.(html?|htm)\b/.test(name)) return 'html';
  if (/\.(png|jpe?g|gif|svg|webp)\b/.test(name)) return 'image';
  if (/\.(mp4|mov|webm)\b/.test(name)) return 'video';
  if (/\.md\b/.test(name)) return 'md';
  return 'text';
}

function artifactLocalPath(item: ArtifactItem): string | undefined {
  const uri = item.contentUri?.trim();
  if (!uri) return item.summary?.startsWith('/') ? item.summary : undefined;
  if (uri.startsWith('file://')) {
    try {
      return decodeURIComponent(new URL(uri).pathname);
    } catch {
      return uri.replace(/^file:\/\//, '');
    }
  }
  return undefined;
}

function openGalleryArtifact(item: ArtifactItem): void {
  const localPath = artifactLocalPath(item);
  if (!localPath) {
    if (item.contentUri && /^https?:\/\//i.test(item.contentUri)) {
      window.open(item.contentUri, '_blank', 'noopener,noreferrer');
    }
    return;
  }

  void webApiFetch(`/api/artifacts/local?path=${encodeURIComponent(localPath)}`)
    .then(async (response) => {
      const data = (await response.json().catch(() => ({}))) as { content?: unknown; error?: unknown };
      if (!response.ok) {
        throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${response.status}`);
      }
      if (typeof data.content !== 'string') {
        throw new Error('artifact_content_missing');
      }
      const blob = new Blob([data.content], { type: artifactContentType(localPath) });
      const url = URL.createObjectURL(blob);
      const opened = window.open(url, '_blank', 'noopener,noreferrer');
      if (!opened) {
        toast.error('浏览器拦截了新标签，请允许弹窗后重试。');
      }
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    })
    .catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : String(error));
    });
}

export function ArtifactPage({ onBack }: PageProps) {
  const { t } = useTranslation();
  const [items, setItems] = useState<ArtifactItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [pendingDelete, setPendingDelete] = useState<ArtifactItem | null>(null);

  const load = () => {
    setLoading(true);
    webApiFetch('/api/artifacts')
      .then((r) => r.json())
      .then((d: { artifacts?: ArtifactItem[] }) => {
        setItems(d.artifacts ?? []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    webApiFetch('/api/artifacts')
      .then((r) => r.json())
      .then((d: { artifacts?: ArtifactItem[] }) => {
        if (!cancelled) setItems(d.artifacts ?? []);
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = items.filter((a) =>
    `${a.title ?? ''} ${a.summary ?? ''} ${a.kind ?? ''} ${a.status ?? ''}`.toLowerCase().includes(q.toLowerCase()),
  );
  const removeArtifact = async () => {
    if (!pendingDelete) return;
    const localPath = artifactLocalPath(pendingDelete);
    await deleteJson('/api/artifacts', { path: localPath, contentUri: pendingDelete.contentUri });
    toast.success(t('common.deleted', { defaultValue: '已删除' }));
    setPendingDelete(null);
    load();
  };

  return (
    <PageShell
      icon={<ImageIcon className="size-4" />}
      title={t('artifact.title')}
      subtitle={t('artifact.subtitle')}
      onBack={onBack}
      toolbar={<SearchBar value={q} onChange={setQ} placeholder={t('artifact.search')} />}
    >
      {filtered.length > 0 ? (
        <ManageList>
          {filtered.map((a) => {
            const ty = inferType(a);
            const localPath = artifactLocalPath(a);
            const canOpen = Boolean(localPath || (a.contentUri && /^https?:\/\//i.test(a.contentUri)));
            return (
              <div
                key={a.id}
                className={cn(
                  'group flex min-h-12 items-center gap-3 rounded-xl px-3 py-2 transition-colors hover:bg-muted/70',
                  canOpen && 'cursor-pointer',
                )}
                onClick={() => {
                  if (canOpen) openGalleryArtifact(a);
                }}
              >
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="shrink-0 truncate text-sm font-semibold text-foreground">{a.title || a.summary || a.id}</span>
                  {a.status ? <Badge variant="secondary" className="h-4 px-1.5 text-[10px] font-normal">{a.status}</Badge> : null}
                  <span className="truncate text-sm text-muted-foreground">{localPath ?? a.summary}</span>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">{ty}</span>
                <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100" onClick={(event) => event.stopPropagation()}>
                  {canOpen ? (
                    <Button variant="ghost" size="icon-sm" onClick={() => openGalleryArtifact(a)} title={t('common.open', { defaultValue: '打开' })} aria-label={t('common.open', { defaultValue: '打开' })}>
                      <FileText className="size-4" />
                    </Button>
                  ) : null}
                  <Button variant="ghost" size="icon-sm" onClick={() => setPendingDelete(a)} title={t('common.delete')} aria-label={t('common.delete')}>
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            );
          })}
        </ManageList>
      ) : (
        <EmptyState icon={<FileText className="size-5" />}>{loading ? t('common.loading') : t('artifact.empty')}</EmptyState>
      )}
      <DeleteConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title={t('common.delete')}
        description={t('common.deleteConfirm', { name: pendingDelete?.title ?? pendingDelete?.summary ?? '' })}
        onConfirm={async () => {
          try {
            await removeArtifact();
          } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err));
            throw err;
          }
        }}
      />
    </PageShell>
  );
}

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

export function TaskPage({ resources, avatarId, currentProjectId, conversations = [], onCreateTaskConversation, onOpenTaskConversation, onBack }: PageProps) {
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
      <div className="flex items-start gap-3">
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
                  className="group flex w-full items-center gap-3 rounded-lg px-1.5 py-2 text-left text-sm transition-colors hover:bg-muted/60 disabled:cursor-default disabled:hover:bg-transparent"
                >
                  <span className={cn('size-2 shrink-0 rounded-full', taskRunStatusDot(run.status))} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-foreground/80 group-hover:text-foreground">{task.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {targetLabel} · {runStatusLabel}{runDetail ? ` · ${runDetail}` : ''}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatRelativeTime(run.startedAt ?? run.scheduledFor)}</span>
                </button>
              );
            })}
          </ManageList>
        ) : (
          <EmptyState>{t('task.noHistory')}</EmptyState>
        )}
      </section>
    </ManageDrawer>
  );
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
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
  if (status === 'failed') return 'bg-red-400';
  if (status === 'skipped') return 'bg-amber-400';
  if (status === 'running') return 'bg-emerald-500';
  return 'bg-blue-400';
}

export const RESOURCE_PAGES: Record<PageKey, (props: PageProps) => ReactNode> = {
  task: TaskPage,
  gateway: GatewayPage,
  model: ModelPage,
  tool: ToolPage,
  skill: SkillPage,
  memory: MemoryPage,
  artifact: ArtifactPage,
};
