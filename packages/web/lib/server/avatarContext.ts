import {
  DEFAULT_AVATAR_ID,
  buildSkillMemoryMetadata,
  createDefaultSuperAgentSeed,
  toCanonicalSpaceId,
  type AvatarRecord,
  type AvatarVersionRecord,
  type CapabilitySnapshotItem,
  type CapabilityType,
  type McpServerRecord,
  type McpToolDefinitionRecord,
  type ModelConfigRecord,
  type SecretRef,
  type SkillDefinitionRecord,
  type SpaceKind,
  type SuperAgentStorageAdapter,
} from '@zleap/core';
import { discoverMcpTools } from '@zleap/agent';
import { seedSuperAgentDefaults, type ZleapStore } from '@zleap/store';
import { MAIN_SPACE_ONLY_TOOL_IDS, expandToolSetIds, isSupportedBuiltinToolId, normalizeToolSetIds } from './toolSets';

/**
 * Web config data layer — the agent's persistence read/write done DIRECTLY on
 * the store. Runtime run assembly lives in `@zleap/avatar`; this module is only
 * the Web settings adapter for avatars/spaces. Spaces are global (id = slug);
 * avatars carry persona and lightweight UI preferences only. Editing a space's
 * mounts bumps its version (the store has no "unbind", so a fresh version is how
 * we replace a binding set).
 */

/** A global Space (docs/core.md §3) — owned by no avatar. */
export type SpaceProfile = {
  id: string;
  storageId: string;
  kind: SpaceKind;
  version: number;
  label: string;
  description?: string;
  routingCard?: string;
  instructions?: string;
  modelConfigId?: string;
  icon?: string;
  accent?: string;
  summaryModelConfigId?: string;
  toolSetIds: string[];
  directToolIds: string[];
  toolIds: string[];
  skillIds: string[];
  autoMountSkills: boolean;
  capabilities: CapabilitySnapshotItem[];
};

/** A persona mask (docs/core.md §4). Spaces stay global; avatar metadata may
 *  store UI binding preferences for which global spaces this assistant shows. */
export type AvatarView = {
  id: string;
  name: string;
  status: AvatarRecord['status'];
  currentVersion: number;
  persona?: string;
  metadata?: Record<string, unknown>;
};

export class AvatarNotFoundError extends Error {
  constructor(readonly avatarId: string) {
    super(`Avatar not found: ${avatarId}`);
    this.name = 'AvatarNotFoundError';
  }
}

export function cleanAvatarId(avatarId: string | undefined): string {
  return avatarId?.trim() || DEFAULT_AVATAR_ID;
}

export function avatarErrorResponse(error: unknown, fallbackStatus = 400): Response {
  if (error instanceof AvatarNotFoundError) {
    return Response.json({ error: 'avatar_not_found', avatarId: error.avatarId }, { status: 404 });
  }
  return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: fallbackStatus });
}

/* ── avatar = persona only ───────────────────────────────────────────── */

function avatarView(avatar: AvatarRecord, version?: AvatarVersionRecord): AvatarView {
  return {
    id: avatar.id,
    name: avatar.name,
    status: avatar.status,
    currentVersion: avatar.currentVersion,
    persona: version?.persona,
    metadata: version?.metadata,
  };
}

/** Resolve one avatar's persona and UI preferences. Space records remain global. */
export async function resolveAvatar(store: ZleapStore | null, avatarId: string | undefined): Promise<{ avatar: AvatarRecord; version: AvatarVersionRecord }> {
  const id = cleanAvatarId(avatarId);
  const seed = () => {
    const s = createDefaultSuperAgentSeed({ avatarId: id });
    return { avatar: s.avatar, version: s.avatarVersion };
  };
  if (!store) {
    if (id !== DEFAULT_AVATAR_ID) throw new AvatarNotFoundError(id);
    return seed();
  }
  if (id === DEFAULT_AVATAR_ID) await seedSuperAgentDefaults(store, { avatarId: id });
  const avatar = await store.avatars.getAvatar(id);
  const version = await store.avatars.getAvatarVersion(id);
  if (!avatar || !version) {
    if (id !== DEFAULT_AVATAR_ID) throw new AvatarNotFoundError(id);
    return seed();
  }
  return { avatar, version };
}

export async function listAvatars(store: ZleapStore | null, avatarId: string | undefined): Promise<AvatarView[]> {
  if (!store) {
    const { avatar, version } = await resolveAvatar(null, avatarId);
    return [avatarView(avatar, version)];
  }
  const records = await store.avatars.listAvatars({ status: 'active' });
  return Promise.all(records.map(async (a) => avatarView(a, await store.avatars.getAvatarVersion(a.id))));
}

/** Seed defaults and assert the avatar exists; returns its id. */
export async function ensureAvatar(store: ZleapStore, avatarId: string | undefined): Promise<string> {
  const id = cleanAvatarId(avatarId);
  if (id === DEFAULT_AVATAR_ID) {
    await seedSuperAgentDefaults(store, { avatarId: id });
  } else if (!(await store.avatars.getAvatar(id))) {
    throw new AvatarNotFoundError(id);
  }
  return id;
}

/* ── spaces = global, independent of any avatar ──────────────────────── */

/** Every global space (docs/core.md §3) with its mounts — not scoped to an avatar. */
export async function listSpaceProfiles(store: ZleapStore | null): Promise<SpaceProfile[]> {
  if (!store) {
    return sortSpaceProfiles(createDefaultSuperAgentSeed().spaces.map(({ space, version, bindings }) => {
      const toolIds = bindings.filter((b) => b.capabilityType === 'tool').map((b) => b.capabilityId).filter(isSupportedBuiltinToolId);
      const capabilities = bindings
        .map((b) => ({ type: b.capabilityType, id: b.capabilityId, version: b.capabilityVersion }))
        .filter((capability) => capabilityAllowedForConfig(capability, { allowMainOnlyTools: space.kind === 'main' }));
      const metadata = spaceVersionMetadata(version.metadata);
      return {
        id: space.slug,
        storageId: space.id,
        kind: space.kind,
        version: version.version,
        label: version.label,
        description: version.description,
        routingCard: version.routingCard,
        instructions: version.instructions,
        icon: metadata.icon,
        accent: metadata.accent,
        modelConfigId: version.modelConfigId,
        summaryModelConfigId: version.summaryModelConfigId,
        toolSetIds: metadata.toolSetIds,
        directToolIds: metadata.directToolIds.length ? metadata.directToolIds : toolIds,
        toolIds,
        skillIds: bindings.filter((b) => b.capabilityType === 'skill').map((b) => b.capabilityId),
        autoMountSkills: metadata.autoMountSkills,
        capabilities,
      };
    }));
  }
  await seedSuperAgentDefaults(store, { avatarId: DEFAULT_AVATAR_ID });
  const records = await store.spaces.listSpaces({ status: 'active' });
  const out: SpaceProfile[] = [];
  for (const space of records) {
    const v = await store.spaces.getSpaceVersion(space.id);
    if (!v) continue;
    const snapshot = await store.spaces.getSpaceSnapshot({ avatarId: DEFAULT_AVATAR_ID, spaceId: space.id, version: v.version });
    const toolIds = snapshot.capabilities.filter((c) => c.type === 'tool').map((c) => c.id).filter(isSupportedBuiltinToolId);
    const capabilities = snapshot.capabilities.filter((capability) =>
      capabilityAllowedForConfig(capability, { allowMainOnlyTools: space.kind === 'main' }),
    );
    const metadata = spaceVersionMetadata(v.metadata);
    out.push({
      id: space.slug,
      storageId: space.id,
      kind: space.kind,
      version: v.version,
      label: v.label,
      description: v.description,
      routingCard: v.routingCard,
      instructions: v.instructions,
      icon: metadata.icon,
      accent: metadata.accent,
      modelConfigId: v.modelConfigId,
      summaryModelConfigId: v.summaryModelConfigId,
      toolSetIds: metadata.toolSetIds,
      directToolIds: metadata.directToolIds.length ? metadata.directToolIds : toolIds,
      toolIds,
      skillIds: capabilities.filter((c) => c.type === 'skill').map((c) => c.id),
      autoMountSkills: metadata.autoMountSkills,
      capabilities,
    });
  }
  return sortSpaceProfiles(out);
}

function sortSpaceProfiles(spaces: SpaceProfile[]): SpaceProfile[] {
  return spaces
    .map((space, index) => ({ space, index }))
    .sort((a, b) => spaceSortRank(a.space) - spaceSortRank(b.space) || a.index - b.index)
    .map(({ space }) => space);
}

function spaceSortRank(space: Pick<SpaceProfile, 'kind'>): number {
  return space.kind === 'main' ? 0 : 1;
}

/* ── writes (direct store) ───────────────────────────────────────────── */

type CapabilityInput = { type: CapabilityType; id: string; version?: number; config?: Record<string, unknown> };

function spaceVersionMetadata(metadata: Record<string, unknown> | undefined): {
  toolSetIds: string[];
  directToolIds: string[];
  autoMountSkills: boolean;
  icon?: string;
  accent?: string;
} {
  const rawToolSetIds = Array.isArray(metadata?.toolSetIds) ? metadata.toolSetIds : [];
  const rawDirectToolIds = Array.isArray(metadata?.directToolIds) ? metadata.directToolIds : [];
  return {
    toolSetIds: normalizeToolSetIds(rawToolSetIds.filter((id): id is string => typeof id === 'string')),
    directToolIds: rawDirectToolIds.filter((id): id is string => typeof id === 'string').filter(isSupportedBuiltinToolId),
    autoMountSkills: metadata?.autoMountSkills !== false,
    icon: typeof metadata?.icon === 'string' ? metadata.icon : undefined,
    accent: typeof metadata?.accent === 'string' ? metadata.accent : undefined,
  };
}

function capabilityAllowedForConfig(capability: Pick<CapabilityInput, 'type' | 'id'>, options: { allowMainOnlyTools?: boolean } = {}): boolean {
  if (capability.type !== 'tool') return true;
  if (MAIN_SPACE_ONLY_TOOL_IDS.includes(capability.id as (typeof MAIN_SPACE_ONLY_TOOL_IDS)[number])) {
    return Boolean(options.allowMainOnlyTools);
  }
  return isSupportedBuiltinToolId(capability.id);
}

function normalizeCapabilities(
  toolIds: string[] = [],
  capabilities: CapabilityInput[] = [],
  toolSetIds: string[] = [],
  options: { allowMainOnlyTools?: boolean } = {},
): CapabilityInput[] {
  const expandedToolIds = [...expandToolSetIds(toolSetIds), ...toolIds].filter(isSupportedBuiltinToolId);
  const all: CapabilityInput[] = [
    ...capabilities.filter((capability) => capabilityAllowedForConfig(capability, options)),
    ...expandedToolIds.map((id): CapabilityInput => ({ type: 'tool', id })),
  ];
  const seen = new Set<string>();
  return all.filter((c) => {
    const key = `${c.type}:${c.id}:${c.version ?? 1}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function defaultCapabilityMap(now: Date) {
  return new Map(createDefaultSuperAgentSeed({ now }).capabilities.map((c) => [`${c.type}:${c.id}:${c.version}`, c]));
}

export type CreateNamedAvatarInput = {
  id: string;
  name: string;
  description?: string;
  persona?: string;
  metadata?: Record<string, unknown>;
};

export async function createNamedAvatar(store: ZleapStore, input: CreateNamedAvatarInput): Promise<AvatarView> {
  const now = new Date();
  const seed = createDefaultSuperAgentSeed({ avatarId: input.id, now });
  await store.transaction(async (tx) => {
    await tx.avatars.saveAvatar({ ...seed.avatar, slug: input.id, name: input.name, updatedAt: now });
    await tx.avatars.saveAvatarVersion({
      ...seed.avatarVersion,
      name: input.name,
      description: input.description ?? seed.avatarVersion.description,
      persona: input.persona ?? seed.avatarVersion.persona,
      metadata: input.metadata ?? seed.avatarVersion.metadata,
    });
  });
  const { avatar, version } = await resolveAvatar(store, input.id);
  return avatarView(avatar, version);
}

export type CreateSpaceArgs = {
  id: string;
  kind?: SpaceKind;
  label: string;
  description?: string;
  routingCard?: string;
  instructions?: string;
  modelConfigId?: string;
  icon?: string;
  accent?: string;
  toolSetIds?: string[];
  toolIds?: string[];
  autoMountSkills?: boolean;
  capabilities?: CapabilityInput[];
  metadata?: Record<string, unknown>;
};

export async function createSpace(store: ZleapStore, input: CreateSpaceArgs): Promise<void> {
  const slug = toCanonicalSpaceId(input.id.trim());
  if (!slug || slug.includes(':')) throw new Error('Space id must be a slug without ":".');
  if (slug === 'main') throw new Error('Main Space already exists.');
  if (await store.spaces.getSpace(slug)) throw new Error(`Space already exists: ${slug}`);

  const now = new Date();
  const toolSetIds = normalizeToolSetIds(input.toolSetIds);
  const directToolIds = input.toolIds ?? [];
  const caps = normalizeCapabilities(directToolIds, input.capabilities, toolSetIds, { allowMainOnlyTools: slug === 'main' });
  const defaults = defaultCapabilityMap(now);
  await store.transaction(async (tx) => {
    await tx.spaces.saveSpace({ id: slug, slug, kind: input.kind ?? 'work', currentVersion: 1, status: 'active', createdAt: now, updatedAt: now });
    await tx.spaces.saveSpaceVersion({
      spaceId: slug,
      version: 1,
      label: input.label,
      description: input.description,
      routingCard: input.routingCard,
      instructions: input.instructions,
      modelConfigId: input.modelConfigId,
      metadata: {
        ...(input.metadata ?? {}),
        toolSetIds,
        directToolIds,
        autoMountSkills: input.autoMountSkills !== false,
        icon: input.icon,
        accent: input.accent,
      },
      createdAt: now,
    });
    await bindAll(tx, slug, 1, caps, defaults, now);
  });
}

export type SpaceMetadataPatch = {
  label?: string;
  description?: string;
  routingCard?: string;
  instructions?: string;
  modelConfigId?: string | null;
  icon?: string;
  accent?: string;
  autoMountSkills?: boolean;
};

/** Update a space's metadata or mounts (or both) by writing a new version. */
export async function updateSpace(
  store: ZleapStore,
  spaceId: string,
  patch: SpaceMetadataPatch & { toolSetIds?: string[]; toolIds?: string[]; capabilities?: CapabilityInput[]; rebind?: boolean },
): Promise<void> {
  const slug = toCanonicalSpaceId(spaceId);
  const space = await store.spaces.getSpace(slug);
  if (!space) throw new Error(`Space not found: ${slug}`);
  const current = await store.spaces.getSpaceVersion(space.id);
  if (!current) throw new Error(`Space version not found: ${space.id}`);

  const now = new Date();
  const nextVersion = space.currentVersion + 1;
  const toolSetIds = patch.rebind ? normalizeToolSetIds(patch.toolSetIds) : undefined;
  const directToolIds = patch.rebind ? (patch.toolIds ?? []) : undefined;
  const caps = patch.rebind
    ? normalizeCapabilities(directToolIds, patch.capabilities, toolSetIds, { allowMainOnlyTools: space.kind === 'main' })
    : undefined;
  const defaults = defaultCapabilityMap(now);
  const currentMetadata = current.metadata ?? {};
  const themePatch: Record<string, unknown> = {};
  if (patch.icon !== undefined) themePatch.icon = patch.icon;
  if (patch.accent !== undefined) themePatch.accent = patch.accent;
  if (patch.autoMountSkills !== undefined) themePatch.autoMountSkills = patch.autoMountSkills !== false;

  await store.transaction(async (tx) => {
    await tx.spaces.saveSpace({ ...space, currentVersion: nextVersion, updatedAt: now });
    await tx.spaces.saveSpaceVersion({
      ...current,
      version: nextVersion,
      label: patch.label?.trim() || current.label,
      description: patch.description ?? current.description,
      routingCard: patch.routingCard ?? current.routingCard,
      instructions: patch.instructions ?? current.instructions,
      modelConfigId: patch.modelConfigId === undefined ? current.modelConfigId : (patch.modelConfigId ?? undefined),
      metadata: patch.rebind
        ? { ...currentMetadata, toolSetIds, directToolIds, ...themePatch }
        : { ...currentMetadata, ...themePatch },
      createdAt: now,
    });
    if (caps) {
      await bindAll(tx, space.id, nextVersion, caps, defaults, now);
    } else {
      const existing = await tx.spaces.listCapabilityBindings({ spaceId: space.id, version: current.version });
      for (const b of existing) {
        await tx.spaces.bindCapability({ ...b, id: `${space.id}:${nextVersion}:${b.capabilityType}:${b.capabilityId}`, spaceVersion: nextVersion, createdAt: now });
      }
    }
  });
}

export async function archiveSpace(store: ZleapStore, spaceId: string): Promise<void> {
  const slug = toCanonicalSpaceId(spaceId);
  const space = await store.spaces.getSpace(slug);
  if (!space) throw new Error(`Space not found: ${slug}`);
  if (space.kind === 'main') throw new Error('main_space_protected');
  const now = new Date();
  await store.spaces.saveSpace({ ...space, status: 'archived', updatedAt: now });
}

export async function archiveAvatar(store: ZleapStore, avatarId: string): Promise<void> {
  const id = avatarId.trim();
  if (id === DEFAULT_AVATAR_ID) throw new Error('default_avatar_protected');
  const avatar = await store.avatars.getAvatar(id);
  if (!avatar) throw new Error(`Avatar not found: ${id}`);
  const now = new Date();
  await store.avatars.saveAvatar({ ...avatar, status: 'archived', updatedAt: now });
}

async function bindAll(
  tx: SuperAgentStorageAdapter,
  spaceId: string,
  spaceVersion: number,
  caps: CapabilityInput[],
  defaults: ReturnType<typeof defaultCapabilityMap>,
  now: Date,
): Promise<void> {
  for (const [index, capability] of caps.entries()) {
    const def = defaults.get(`${capability.type}:${capability.id}:${capability.version ?? 1}`);
    if (def) await tx.spaces.saveCapability(def);
    await tx.spaces.bindCapability({
      id: `${spaceId}:${spaceVersion}:${capability.type}:${capability.id}`,
      spaceId,
      spaceVersion,
      capabilityType: capability.type,
      capabilityId: capability.id,
      capabilityVersion: capability.version ?? 1,
      enabled: true,
      config: capability.config,
      orderIndex: index,
      createdAt: now,
    });
  }
}

/** Append one capability to a space's current mounts (used by skill/mcp bind). */
async function appendSpaceCapability(store: ZleapStore, spaceId: string, cap: CapabilityInput): Promise<void> {
  const slug = toCanonicalSpaceId(spaceId);
  const spaces = await listSpaceProfiles(store);
  const space = spaces.find((s) => s.id === slug || s.storageId === slug);
  if (!space) throw new Error(`Space not found: ${slug}`);
  const merged = [
    ...space.capabilities.filter((c) => !(c.type === cap.type && c.id === cap.id)).map((c) => ({ type: c.type, id: c.id, version: c.version })),
    cap,
  ];
  await updateSpace(store, space.storageId, { rebind: true, capabilities: merged });
}

export type CreateSkillArgs = { id: string; label: string; description?: string; instructions?: string; toolIds?: string[]; bindToSpaceId?: string };

export async function createSkill(store: ZleapStore, input: CreateSkillArgs): Promise<SkillDefinitionRecord> {
  const now = new Date();
  const version = 1;
  const metadata = buildSkillMemoryMetadata({ id: input.id, version, instructions: input.instructions });
  const record: SkillDefinitionRecord = {
    id: input.id,
    version,
    origin: 'user',
    label: input.label,
    description: input.description,
    instructions: input.instructions,
    toolIds: input.toolIds ?? [],
    metadata,
    sourceType: 'db',
    invocationPolicy: 'implicit',
    trustStatus: 'trusted',
    createdAt: now,
    updatedAt: now,
  };
  await saveSkillRecord(store, record, input.bindToSpaceId);
  return record;
}

export async function saveSkillRecord(store: ZleapStore, record: SkillDefinitionRecord, bindToSpaceId?: string): Promise<SkillDefinitionRecord> {
  const metadata = buildSkillMemoryMetadata({
    id: record.id,
    version: record.version,
    instructions: record.body ?? record.instructions,
    metadata: record.metadata,
  });
  const skillRecord: SkillDefinitionRecord = {
    ...record,
    metadata,
    updatedAt: record.updatedAt ?? record.createdAt,
  };
  await store.transaction(async (tx) => {
    await tx.skills.saveSkill(skillRecord);
    await tx.spaces.saveCapability({
      id: skillRecord.id,
      type: 'skill',
      version: skillRecord.version,
      origin: skillRecord.origin,
      label: skillRecord.label,
      description: skillRecord.description,
      descriptor: {
        instructions: skillRecord.body ?? skillRecord.instructions,
        toolIds: skillRecord.toolIds,
        sourceType: skillRecord.sourceType,
        sourceName: skillRecord.sourceName,
        packageRoot: skillRecord.packageRoot,
        files: skillRecord.files,
        allowedTools: skillRecord.allowedTools,
        disallowedTools: skillRecord.disallowedTools,
        invocationPolicy: skillRecord.invocationPolicy,
        trustStatus: skillRecord.trustStatus,
        riskAudit: skillRecord.riskAudit,
        procedureId: metadata.procedureId,
        lifecycle: metadata.lifecycle,
        sections: metadata.sections,
        sensitivity: metadata.sensitivity,
        tokenBudget: metadata.tokenBudget,
      },
      implementationRef: String(metadata.procedureId),
      createdAt: skillRecord.createdAt,
    });
  });
  if (bindToSpaceId) await appendSpaceCapability(store, bindToSpaceId, { type: 'skill', id: skillRecord.id, version: skillRecord.version });
  return skillRecord;
}

export type CreateMcpServerArgs = {
  id: string;
  userId?: string;
  tenantId?: string;
  name: string;
  transport: 'stdio' | 'sse' | 'http';
  config?: Record<string, unknown>;
  secretRefs?: SecretRef[];
  status?: 'active' | 'disabled' | 'error';
  bindToSpaceId?: string;
};

/** Outcome of an auto-discovery pass against a server's `tools/list`. */
export type McpDiscoveryResult = { ok: boolean; count: number; error?: string; tools: McpToolDefinitionRecord[] };

export type CreateMcpServerResult = { server: McpServerRecord; discovery: McpDiscoveryResult };

export async function createMcpServer(store: ZleapStore, input: CreateMcpServerArgs): Promise<CreateMcpServerResult> {
  const now = new Date();
  const record: McpServerRecord = {
    id: input.id,
    userId: input.userId,
    tenantId: input.tenantId,
    name: input.name,
    transport: input.transport,
    config: input.config,
    secretRefs: input.secretRefs,
    status: input.status ?? 'active',
    createdAt: now,
    updatedAt: now,
  };
  await store.transaction(async (tx) => {
    await tx.mcp.saveServer(record);
    await tx.spaces.saveCapability({
      id: record.id,
      type: 'mcp_server',
      version: 1,
      origin: 'mcp',
      label: record.name,
      description: `MCP server (${record.transport})`,
      descriptor: { transport: record.transport, status: record.status, hasSecrets: Boolean(record.secretRefs?.length) },
      implementationRef: `mcp:${record.id}`,
      createdAt: now,
    });
  });
  if (input.bindToSpaceId) await appendSpaceCapability(store, input.bindToSpaceId, { type: 'mcp_server', id: record.id, version: 1 });
  // Auto-discover its tools so they land in the global catalog immediately — no
  // hand-entered schemas. Best-effort: a server that can't be reached yet (missing
  // secret, bad command) still gets created; the user fixes it and hits Refresh.
  const discovery = await discoverServerTools(store, record.id, { userId: input.userId, tenantId: input.tenantId });
  return { server: record, discovery };
}

/**
 * Connect to a configured MCP server, list its tools, and reconcile the cached
 * catalog: upsert every discovered tool (no binding — the user mounts them per
 * space like any other tool) and drop tools the server no longer exposes. Reused
 * by both server creation and the manual "refresh tools" action.
 */
export async function discoverServerTools(
  store: ZleapStore,
  serverId: string,
  owner?: { userId?: string; tenantId?: string },
): Promise<McpDiscoveryResult> {
  const server = await store.mcp.getServer(serverId, owner);
  if (!server) throw new Error(`MCP server not found: ${serverId}`);
  try {
    const discovered = await discoverMcpTools(server);
    const tools: McpToolDefinitionRecord[] = [];
    for (const tool of discovered) {
      tools.push(
        await registerMcpTool(store, {
          serverId,
          userId: owner?.userId,
          tenantId: owner?.tenantId,
          name: tool.name,
          description: tool.description,
          inputSchema: cleanInputSchema(tool.inputSchema),
          outputSchema: tool.outputSchema,
        }),
      );
    }
    // Reconcile: a tool the server dropped should leave the catalog. Dangling
    // space bindings are skipped at runtime (registerMcpToolsForSpace), so no
    // per-space rebind is needed here.
    const keep = new Set(tools.map((tool) => tool.id));
    for (const existing of await store.mcp.listTools({ serverId })) {
      if (!keep.has(existing.id)) await store.mcp.deleteTool(existing.id);
    }
    return { ok: true, count: tools.length, tools };
  } catch (error) {
    return { ok: false, count: 0, error: error instanceof Error ? error.message : 'discovery failed', tools: [] };
  }
}

/** Strip provider-unfriendly bits from an MCP tool's JSON Schema before caching. */
function cleanInputSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return { type: 'object' };
  const { $schema: _drop, ...rest } = schema as Record<string, unknown>;
  return Object.keys(rest).length ? rest : { type: 'object' };
}

export type RegisterMcpToolArgs = {
  id?: string;
  serverId: string;
  userId?: string;
  tenantId?: string;
  name: string;
  version?: number;
  label?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  bindToSpaceId?: string;
};

export async function registerMcpTool(store: ZleapStore, input: RegisterMcpToolArgs): Promise<McpToolDefinitionRecord> {
  if (!(await store.mcp.getServer(input.serverId, { userId: input.userId, tenantId: input.tenantId }))) {
    throw new Error(`MCP server not found: ${input.serverId}`);
  }
  const now = new Date();
  const version = input.version ?? 1;
  const record: McpToolDefinitionRecord = {
    id: input.id ?? `${input.serverId}:${input.name}`,
    serverId: input.serverId,
    name: input.name,
    version,
    label: input.label,
    description: input.description,
    inputSchema: input.inputSchema,
    outputSchema: input.outputSchema,
    createdAt: now,
  };
  await store.transaction(async (tx) => {
    await tx.mcp.saveTool(record);
    await tx.spaces.saveCapability({
      id: record.id,
      type: 'mcp_tool',
      version: record.version,
      origin: 'mcp',
      label: record.label ?? record.name,
      description: record.description,
      descriptor: { serverId: record.serverId, name: record.name, inputSchema: record.inputSchema, outputSchema: record.outputSchema },
      implementationRef: `mcp:${record.serverId}:${record.name}@${record.version}`,
      createdAt: now,
    });
  });
  if (input.bindToSpaceId) await appendSpaceCapability(store, input.bindToSpaceId, { type: 'mcp_tool', id: record.id, version: record.version });
  return record;
}

export type CreateModelConfigArgs = { id: string; providerId: string; model: string; purpose?: ModelConfigRecord['purpose']; config?: Record<string, unknown> };

export async function createModelConfig(store: ZleapStore, input: CreateModelConfigArgs): Promise<ModelConfigRecord> {
  // Per-model API keys are stored on the record by design (user opted in): the
  // engine prefers config.apiKey over the server env key. The key is redacted
  // when model configs are read back to the browser (see /api/models GET).
  const now = new Date();
  const record: ModelConfigRecord = {
    id: input.id,
    providerId: input.providerId,
    model: input.model,
    purpose: input.purpose ?? 'workspace',
    config: input.config,
    createdAt: now,
    updatedAt: now,
  };
  await store.models.saveModelConfig(record);
  return record;
}

export async function configureSpaceModel(
  store: ZleapStore,
  input: { spaceId: string; modelConfigId?: string; summaryModelConfigId?: string },
): Promise<void> {
  const slug = toCanonicalSpaceId(input.spaceId);
  const space = await store.spaces.getSpace(slug);
  if (!space) throw new Error(`Space not found: ${slug}`);
  const current = await store.spaces.getSpaceVersion(space.id);
  if (!current) throw new Error(`Space version not found: ${space.id}`);
  const now = new Date();
  const nextVersion = space.currentVersion + 1;
  await store.transaction(async (tx) => {
    await tx.spaces.saveSpace({ ...space, currentVersion: nextVersion, updatedAt: now });
    await tx.spaces.saveSpaceVersion({
      ...current,
      version: nextVersion,
      modelConfigId: input.modelConfigId ?? current.modelConfigId,
      summaryModelConfigId: input.summaryModelConfigId ?? current.summaryModelConfigId,
      createdAt: now,
    });
    const existing = await tx.spaces.listCapabilityBindings({ spaceId: space.id, version: current.version });
    for (const b of existing) {
      await tx.spaces.bindCapability({ ...b, id: `${space.id}:${nextVersion}:${b.capabilityType}:${b.capabilityId}`, spaceVersion: nextVersion, createdAt: now });
    }
  });
}
