'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Globe,
  Image as ImageIcon,
  Pencil,
  PlugZap,
  Plus,
  RefreshCw,
  Search,
  Send,
  Server,
  Terminal,
  Trash2,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { postJson, patchJson, deleteJson } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { DeleteConfirmDialog } from '@/components/ui/delete-confirm-dialog';
import { Switch } from '@/components/ui/switch';
import type { McpServerView, ToolView } from '@/lib/useResources';
import { McpServerDialog } from './McpServerDialog';
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
  ManageSectionLabel as SectionLabel,
  ManageStatusBadge,
} from './manage-ui';
import type { PageProps } from './pageTypes';

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
      <ManageStatusBadge variant="secondary" size="sm">
        {t('tool.cache.title', { defaultValue: '工作缓存' })}
        {firstKind ? ` · ${cacheKindLabel(firstKind, t)}` : ''}
      </ManageStatusBadge>
      {tool.cache.readonly ? (
        <ManageStatusBadge variant="outline" size="sm">
          {t('tool.cache.readonly', { defaultValue: '系统默认' })}
        </ManageStatusBadge>
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
    <div className="text-xs text-muted-foreground">
      <div className="flex items-center gap-2">
        <span className="font-medium text-foreground">{t('tool.cache.title', { defaultValue: '工作缓存' })}</span>
        {readonly ? (
          <ManageStatusBadge variant="outline" size="sm">
            {t('tool.cache.readonly', { defaultValue: '系统默认' })}
          </ManageStatusBadge>
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
                  'rounded-full border px-2 py-0.5 text-2xs transition',
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
  const [previewToolId, setPreviewToolId] = useState<string | null>(null);

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
  const previewTool = previewToolId ? toolsById.get(previewToolId) : undefined;

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
                  <ManageStatusBadge variant="secondary" size="sm">
                    {set.toolCount} {t('tool.items')}
                  </ManageStatusBadge>
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
                      <ManageListRow
                        key={id}
                        title={tool?.label ?? id}
                        badges={tool ? <ToolCacheBadges tool={tool} /> : undefined}
                        disabled={!toolOn}
                        indent
                        className="rounded-lg hover:bg-muted/50"
                        onOpen={tool ? () => setPreviewToolId(id) : undefined}
                        persistent={<Switch checked={toolOn} disabled={!setOn} onCheckedChange={(value) => setEnabled('tool', id, value)} />}
                      />
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
                <ManageListRow
                  key={x.id}
                  title={x.label}
                  leading={<Zap className="size-4" />}
                  badges={<ToolCacheBadges tool={x} />}
                  disabled={!on}
                  onOpen={() => setPreviewToolId(x.id)}
                  persistent={<Switch checked={on} onCheckedChange={(value) => setEnabled('tool', x.id, value)} />}
                />
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
                    <ManageStatusBadge variant="secondary" size="sm">{s.transport}</ManageStatusBadge>
                    {s.status !== 'active' ? (
                      <ManageStatusBadge variant="outline" size="sm">{s.status}</ManageStatusBadge>
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
                          <ManageListRow
                            key={tool.id}
                            title={tool.label}
                            leading={<PlugZap className="size-4" />}
                            badges={<ToolCacheBadges tool={tool} />}
                            disabled={!on}
                            indent
                            className="rounded-lg hover:bg-muted/50"
                            onOpen={() => setPreviewToolId(tool.id)}
                            persistent={<Switch checked={on} onCheckedChange={(value) => setEnabled('tool', tool.id, value)} />}
                          />
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

      <ManageDrawer
        open={Boolean(previewTool)}
        onOpenChange={(open) => !open && setPreviewToolId(null)}
        title={previewTool?.label ?? previewTool?.id ?? ''}
      >
        {previewTool ? (
          <>
            {previewTool.description ? (
              <ManagePreviewBlock className="text-sm leading-relaxed text-foreground">{previewTool.description}</ManagePreviewBlock>
            ) : null}
            <ManageDetailGrid>
              <ManageDetailItem
                label={t('tool.origin', { defaultValue: '来源' })}
                value={previewTool.origin === 'mcp' ? 'MCP' : t('tool.originBuiltin', { defaultValue: '内置' })}
              />
              <ManageDetailItem label={t('tool.scope', { defaultValue: '范围' })} value={previewTool.scope ?? 'main'} />
              <ManageDetailItem label={t('tool.idLabel', { defaultValue: '标识' })} value={previewTool.id} />
              <ManageDetailItem
                label={t('tool.status', { defaultValue: '状态' })}
                value={
                  previewTool.enabled !== false
                    ? t('common.enabled', { defaultValue: '已启用' })
                    : t('common.disabled', { defaultValue: '已禁用' })
                }
              />
            </ManageDetailGrid>
            <ToolCacheInlineSettings tool={previewTool} onChange={(cache) => setToolCache(previewTool, cache)} />
          </>
        ) : null}
      </ManageDrawer>
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

