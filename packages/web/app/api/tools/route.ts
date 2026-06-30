import { createDefaultSuperAgentSeed } from '@zleap/core';
import { isActorResponse, requireHttpActor } from '../../../lib/server/actor';
import { storeFromEnv } from '../../../lib/server/avatarStore';
import { listToolSetViews, type ToolSetView } from '../../../lib/server/toolSets';
import { readToolState, setToolCacheState, setToolEnabled, type ToolCacheState } from '../../../lib/server/toolStateStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export type ToolView = {
  id: string;
  label: string;
  description?: string;
  origin: 'builtin' | 'mcp';
  scope?: 'main' | 'workspace';
  serverId?: string;
  /** False when the user has switched this tool off (catalog availability). */
  enabled?: boolean;
  cache?: ToolCacheView;
};

export type ToolCacheView = ToolCacheState & { readonly?: boolean };

export type ToolSetWithState = ToolSetView & { enabled?: boolean };

export type ToolsResponse = {
  tools: ToolView[];
  toolSets: ToolSetWithState[];
  persistence: { enabled: boolean; reachable: boolean };
};

/**
 * The global Tool catalog the web management surface lists: code built-in tools
 * (from the default capability seed) plus every persisted MCP tool snapshot.
 * Built-ins are read-only as definitions; their on/off state is user-owned and
 * persisted via PATCH (lib/server/toolStateStore).
 */
export async function GET(req: Request): Promise<Response> {
  const actor = requireHttpActor(req);
  if (isActorResponse(actor)) return actor;
  const state = await readToolState();
  const disabledSets = new Set(state.disabledToolSetIds);
  const disabledTools = new Set(state.disabledToolIds);

  const seed = createDefaultSuperAgentSeed();
  const builtin: ToolView[] = seed.capabilities
    .filter((capability) => capability.type === 'tool')
    .filter((capability) => capabilityVisibleInCatalog(capability.descriptor))
    .map((capability) => ({
      id: capability.id,
      label: capability.label ?? capability.id,
      description: capability.description,
      scope: capabilityScope(capability.descriptor),
      origin: 'builtin' as const,
      enabled: !disabledTools.has(capability.id),
      cache: normalizeToolCache(capability.descriptor, state.cacheByToolId[capability.id], true),
    }));

  const toolSets: ToolSetWithState[] = listToolSetViews().map((set) => ({ ...set, enabled: !disabledSets.has(set.id) }));

  const store = await storeFromEnv();
  if (!store) {
    return Response.json({ tools: builtin, toolSets, persistence: { enabled: false, reachable: false } } satisfies ToolsResponse);
  }
  try {
    const visibleServers = await store.mcp.listServers({ userId: actor.userId, tenantId: actor.tenantId });
    const mcpTools = (await Promise.all(visibleServers.map((server) => store.mcp.listTools({ serverId: server.id })))).flat();
    const mcp: ToolView[] = mcpTools.map((tool) => ({
      id: tool.id,
      label: tool.label ?? tool.name,
      description: tool.description,
      origin: 'mcp' as const,
      serverId: tool.serverId,
      enabled: !disabledTools.has(tool.id),
      cache: normalizeToolCache(undefined, state.cacheByToolId[tool.id], false),
    }));
    return Response.json({ tools: [...builtin, ...mcp], toolSets, persistence: { enabled: true, reachable: true } } satisfies ToolsResponse);
  } finally {
    await store.close().catch(() => {});
  }
}

/** Toggle a toolset or a single tool on/off. */
export async function PATCH(req: Request): Promise<Response> {
  const actor = requireHttpActor(req, { roles: ['admin'] });
  if (isActorResponse(actor)) return actor;
  const body = (await req.json().catch(() => ({}))) as { scope?: 'toolset' | 'tool' | 'tool-cache'; id?: string; enabled?: boolean; cache?: ToolCacheState };
  if (body.scope === 'tool-cache') {
    if (!body.id?.trim() || !isToolCacheState(body.cache)) {
      return Response.json({ error: 'id_cache_required' }, { status: 400 });
    }
    const state = await setToolCacheState(body.id.trim(), body.cache);
    return Response.json({ ok: true, state });
  }
  if ((body.scope !== 'toolset' && body.scope !== 'tool') || !body.id?.trim() || typeof body.enabled !== 'boolean') {
    return Response.json({ error: 'scope_id_enabled_required' }, { status: 400 });
  }
  const state = await setToolEnabled(body.scope, body.id.trim(), body.enabled);
  return Response.json({ ok: true, state });
}

function capabilityScope(descriptor: unknown): 'main' | 'workspace' {
  if (descriptor && typeof descriptor === 'object' && 'scope' in descriptor) {
    const scope = (descriptor as { scope?: unknown }).scope;
    if (scope === 'main' || scope === 'workspace') return scope;
  }
  return 'workspace';
}

function capabilityVisibleInCatalog(descriptor: unknown): boolean {
  if (descriptor && typeof descriptor === 'object' && 'exposed' in descriptor) {
    return (descriptor as { exposed?: unknown }).exposed !== false;
  }
  return capabilityScope(descriptor) !== 'main';
}

function normalizeToolCache(descriptor: unknown, override?: ToolCacheState, readonly = false): ToolCacheView | undefined {
  if (override) {
    return { ...override, readonly };
  }
  const cache = descriptor && typeof descriptor === 'object' && 'cache' in descriptor
    ? (descriptor as { cache?: unknown }).cache
    : undefined;
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) {
    return undefined;
  }
  const record = cache as Record<string, unknown>;
  const kinds = Array.isArray(record.kinds) ? record.kinds.filter((kind): kind is string => typeof kind === 'string') : [];
  return {
    produces: record.produces === true,
    kinds,
    capture: record.capture === 'none' ? 'none' : 'auto',
    readonly,
  };
}

function isToolCacheState(value: unknown): value is ToolCacheState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.produces === 'boolean' &&
    Array.isArray(record.kinds) &&
    record.kinds.every((kind) => typeof kind === 'string') &&
    (record.capture === 'auto' || record.capture === 'none');
}
