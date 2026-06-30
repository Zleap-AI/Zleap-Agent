'use client';

import * as React from 'react';
import { Check, ChevronDown, ChevronRight, ChevronsUpDown, Minus, Plus, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { McpServerView, ToolSetView, ToolView } from '@/lib/useResources';

const UNGROUPED = '__ungrouped';
const MCP_GROUP_PREFIX = 'mcp:';

type ToolTreeSelectProps = {
  toolSets: ToolSetView[];
  tools: ToolView[];
  mcpServers?: McpServerView[];
  /** Whole toolsets mounted (expand to all their tools at runtime). */
  selectedToolSetIds: string[];
  /** Individually mounted tools (a subset of a set, or ungrouped/MCP tools). */
  selectedToolIds: string[];
  onChange: (next: { toolSetIds: string[]; toolIds: string[] }) => void;
  onOpenToolPage?: () => void;
};

type TreeState = 'all' | 'some' | 'none';
type ToolGroup = { id: string; label: string; description?: string; isSet: boolean; toolIds: string[] };

/**
 * One picker for a space's tools, structured as a tree: a top-level toolset can be
 * checked as a WHOLE (→ toolSetIds), or expanded to check just a few of its tools
 * (→ direct toolIds). Builtin tools in no set live under "Other"; MCP tools
 * are grouped by their MCP server so users can see the actual tool source.
 * Built from library primitives (Popover) with its own search + scroll.
 */
export function ToolTreeSelect({ toolSets, tools, mcpServers = [], selectedToolSetIds, selectedToolIds, onChange, onOpenToolPage }: ToolTreeSelectProps) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState('');
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());

  const toolById = React.useMemo(() => new Map(tools.map((tool) => [tool.id, tool])), [tools]);
  const setMembership = React.useMemo(() => new Set(toolSets.flatMap((set) => set.toolIds)), [toolSets]);
  const mcpServerById = React.useMemo(() => new Map(mcpServers.map((server) => [server.id, server])), [mcpServers]);

  // Build the tree: each toolset is a group; loose MCP tools are grouped by
  // server, while only loose builtin tools fall under "Other".
  // Tools/toolsets switched OFF on the Tool page (enabled === false) are hidden,
  // so a disabled capability can't be mounted onto a space.
  const groups = React.useMemo(() => {
    const fromSets: ToolGroup[] = toolSets
      .filter((set) => set.enabled !== false)
      .map((set) => ({
        id: set.id,
        label: set.label,
        description: set.description,
        isSet: true,
        toolIds: set.toolIds.filter((id) => toolById.get(id) && toolById.get(id)!.enabled !== false),
      }))
      .filter((group) => group.toolIds.length > 0);
    const ungrouped: string[] = [];
    const mcpGroups = new Map<string, ToolGroup>();
    for (const tool of tools) {
      if (setMembership.has(tool.id) || tool.enabled === false) continue;
      if (tool.origin !== 'mcp') {
        ungrouped.push(tool.id);
        continue;
      }
      const serverId = tool.serverId ?? 'unknown';
      const groupId = `${MCP_GROUP_PREFIX}${serverId}`;
      const existing = mcpGroups.get(groupId);
      if (existing) {
        existing.toolIds.push(tool.id);
      } else {
        mcpGroups.set(groupId, {
          id: groupId,
          label: mcpServerById.get(serverId)?.name ?? tool.serverId ?? 'MCP',
          isSet: false,
          toolIds: [tool.id],
        });
      }
    }
    if (ungrouped.length) {
      fromSets.push({ id: UNGROUPED, label: t('space.otherTools'), isSet: false, toolIds: ungrouped });
    }
    fromSets.push(...mcpGroups.values());
    return fromSets;
  }, [toolSets, tools, toolById, setMembership, mcpServerById, t]);

  const selectedSets = React.useMemo(() => new Set(selectedToolSetIds), [selectedToolSetIds]);
  const selectedTools = React.useMemo(() => new Set(selectedToolIds), [selectedToolIds]);
  const groupById = React.useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);

  const isToolOn = (group: ToolGroup, toolId: string) =>
    (group.isSet && selectedSets.has(group.id)) || selectedTools.has(toolId);

  const groupState = (group: ToolGroup): TreeState => {
    if (group.isSet && selectedSets.has(group.id)) return 'all';
    const on = group.toolIds.filter((id) => selectedTools.has(id)).length;
    if (on === 0) return 'none';
    return on === group.toolIds.length ? 'all' : 'some';
  };

  const emit = (sets: Set<string>, toolIds: Set<string>) =>
    onChange({ toolSetIds: [...sets], toolIds: [...toolIds] });

  const toggleGroup = (group: ToolGroup) => {
    const sets = new Set(selectedSets);
    const tIds = new Set(selectedTools);
    const state = groupState(group);
    if (group.isSet) {
      if (state === 'all') {
        sets.delete(group.id);
      } else {
        sets.add(group.id);
        group.toolIds.forEach((id) => tIds.delete(id)); // folded into the set
      }
    } else {
      // ungrouped: select/clear all its tools individually
      if (state === 'all') group.toolIds.forEach((id) => tIds.delete(id));
      else group.toolIds.forEach((id) => tIds.add(id));
    }
    emit(sets, tIds);
  };

  const toggleTool = (groupId: string, toolId: string) => {
    const tIds = new Set(selectedTools);
    if (tIds.has(toolId)) tIds.delete(toolId);
    else tIds.add(toolId);
    emit(new Set(selectedSets), tIds);
  };

  const totalCount = selectedToolSetIds.reduce((sum, id) => sum + (groupById.get(id)?.toolIds.length ?? 0), 0) + selectedToolIds.length;

  const query = q.trim().toLowerCase();
  const visibleGroups = groups
    .map((group) => {
      const groupHit = `${group.label} ${group.description ?? ''}`.toLowerCase().includes(query);
      const childHits = group.toolIds.filter((id) => {
        const tool = toolById.get(id);
        return `${tool?.label ?? id} ${id} ${tool?.description ?? ''}`.toLowerCase().includes(query);
      });
      const childrenToShow = !query || groupHit ? group.toolIds : childHits;
      return { group, childrenToShow, visible: !query || groupHit || childHits.length > 0 };
    })
    .filter((entry) => entry.visible);

  const isExpanded = (id: string) => Boolean(query) || expanded.has(id);
  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-1.5">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" role="combobox" aria-expanded={open} className="h-8 w-full justify-between font-normal text-muted-foreground">
            {totalCount > 0 ? t('space.toolsSummary', { count: totalCount }) : t('space.mountTools')}
            <ChevronsUpDown className="opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-(--radix-popover-trigger-width) p-0" align="start">
          <div className="flex items-center gap-2 border-b px-2.5">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('space.searchTools')}
              className="h-9 border-0 px-0 shadow-none focus-visible:ring-0"
            />
          </div>
          {onOpenToolPage ? (
            <div className="border-b p-1">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onOpenToolPage();
                }}
                className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-foreground transition hover:bg-accent"
              >
                <Plus className="size-4 text-muted-foreground" />
                <span className="truncate">{t('space.addTools')}</span>
              </button>
            </div>
          ) : null}
          <div className="max-h-72 overflow-y-auto p-1">
            {visibleGroups.length === 0 ? (
              <div className="px-2 py-6 text-center text-sm text-muted-foreground">{t('space.noTools')}</div>
            ) : (
              visibleGroups.map(({ group, childrenToShow }) => {
                const state = groupState(group);
                const open = isExpanded(group.id);
                return (
                  <div key={group.id}>
                    <div className="flex items-center gap-1 rounded-md px-1 hover:bg-accent">
                      <button
                        type="button"
                        onClick={() => toggleExpand(group.id)}
                        className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                        aria-label="Toggle"
                      >
                        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleGroup(group)}
                        className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left text-sm"
                      >
                        <TriBox state={state} />
                        <span className="flex-1 truncate font-medium">{group.label}</span>
                        <span className="text-xs text-muted-foreground">{group.toolIds.length}</span>
                      </button>
                    </div>
                    {open ? (
                      <div className="ml-6 border-l pl-1">
                        {childrenToShow.map((toolId) => {
                          const tool = toolById.get(toolId);
                          const on = isToolOn(group, toolId);
                          const locked = group.isSet && selectedSets.has(group.id);
                          return (
                            <button
                              key={toolId}
                              type="button"
                              disabled={locked}
                              onClick={() => toggleTool(group.id, toolId)}
                              className={cn(
                                'flex w-full items-start gap-2 rounded-md px-1.5 py-1.5 text-left text-sm hover:bg-accent',
                                locked && 'cursor-not-allowed opacity-60 hover:bg-transparent',
                              )}
                            >
                              <span className="pt-0.5">
                                <TriBox state={on ? 'all' : 'none'} />
                              </span>
                              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                <span className="truncate">{tool?.label ?? toolId}</span>
                                {tool?.description ? (
                                  <span className="line-clamp-2 text-xs leading-4 text-muted-foreground">{tool.description}</span>
                                ) : null}
                              </span>
                              {tool?.origin === 'mcp' ? <span className="pt-0.5 text-2xs text-muted-foreground">mcp</span> : null}
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </PopoverContent>
      </Popover>

      {selectedToolSetIds.length > 0 || selectedToolIds.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {selectedToolSetIds.map((id) => {
            const set = toolSets.find((s) => s.id === id);
            return (
              <Badge key={`set:${id}`} variant="secondary" className="h-6 gap-1.5 px-2.5 pr-1.5 text-xs font-normal">
                <span className="font-medium">{set?.label ?? id}</span>
                <span className="text-2xs text-muted-foreground">{groupById.get(id)?.toolIds.length ?? set?.toolIds.length ?? 0}</span>
                <button
                  type="button"
                  onClick={() => emit(new Set([...selectedSets].filter((x) => x !== id)), selectedTools)}
                  className="rounded-xs opacity-60 transition hover:opacity-100"
                  aria-label={`Remove ${id}`}
                >
                  <X className="size-3" />
                </button>
              </Badge>
            );
          })}
          {selectedToolIds.map((id) => (
            <Badge key={`tool:${id}`} variant="outline" className="h-6 gap-1 px-2.5 pr-1.5 text-xs font-normal">
              {toolById.get(id)?.label ?? id}
              <button
                type="button"
                onClick={() => emit(new Set(selectedSets), new Set([...selectedTools].filter((x) => x !== id)))}
                className="rounded-xs opacity-60 transition hover:opacity-100"
                aria-label={`Remove ${id}`}
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TriBox({ state }: { state: TreeState }) {
  return (
    <span
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors',
        state === 'none' ? 'border-input' : 'border-primary bg-primary text-primary-foreground',
      )}
    >
      {state === 'all' ? <Check className="size-3" /> : state === 'some' ? <Minus className="size-3" /> : null}
    </span>
  );
}
