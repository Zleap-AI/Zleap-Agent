'use client';

import { useCallback, useEffect, useState } from 'react';
import { getJson } from './api';

/** A persona mask (docs/core.md §4) with optional UI preferences. */
export type AvatarView = {
  id: string;
  name: string;
  status?: string;
  currentVersion?: number;
  persona?: string;
  metadata?: { emoji?: string; accent?: string; boundSpaceIds?: string[] | null } & Record<string, unknown>;
};

/** A global Space (docs/core.md §3) — not owned by any avatar. */
export type SpaceProfile = {
  id: string;
  storageId: string;
  canonicalId?: string;
  kind: 'main' | 'work';
  label: string;
  description?: string;
  when?: string;
  routingCard?: string;
  instructions?: string;
  toolSetIds?: string[];
  directToolIds?: string[];
  toolIds: string[];
  /** MCP tools mounted on this space (bound as `mcp_tool` capabilities, not builtin toolIds). */
  mcpToolIds?: string[];
  skillIds?: string[];
  autoMountSkills?: boolean;
  icon?: string;
  accent?: string;
  modelConfigId?: string;
  status?: string;
};

export type ToolCacheView = {
  produces: boolean;
  kinds: string[];
  capture: 'auto' | 'none';
  readonly?: boolean;
};

export type ToolView = {
  id: string;
  label: string;
  description?: string;
  origin: 'builtin' | 'mcp';
  scope?: 'main' | 'workspace';
  serverId?: string;
  enabled?: boolean;
  cache?: ToolCacheView;
};
export type ToolSetView = {
  id: string;
  label: string;
  description: string;
  toolIds: string[];
  toolCount: number;
  enabled?: boolean;
};
export type SkillPackageFileView = {
  path: string;
  kind?: 'skill' | 'config' | 'script' | 'reference' | 'asset' | 'other';
  size?: number;
  sha256?: string;
  executable?: boolean;
};
export type SkillRiskAuditView = {
  status?: 'trusted' | 'review_required' | 'blocked' | 'clear' | 'review';
  findings?: Array<{ kind?: string; severity?: string; count?: number; message?: string }>;
};
export type SkillView = {
  id: string;
  version?: number;
  origin?: string;
  label: string;
  toolIds: string[];
  description?: string;
  instructions?: string;
  sourceType?: 'db' | 'project' | 'user' | 'admin' | 'system' | 'imported';
  sourcePath?: string;
  packageRoot?: string;
  sourceName?: string;
  frontmatter?: Record<string, unknown>;
  body?: string;
  files?: SkillPackageFileView[];
  openaiConfig?: Record<string, unknown>;
  claudeConfig?: Record<string, unknown>;
  license?: string;
  compatibility?: unknown;
  allowedTools?: string[];
  disallowedTools?: string[];
  invocationPolicy?: 'implicit' | 'explicit_only' | 'disabled';
  trustStatus?: 'trusted' | 'review_required' | 'blocked';
  riskAudit?: SkillRiskAuditView;
  schemaHash?: string;
  createdAt?: string;
  updatedAt?: string;
};
export type McpServerView = {
  id: string;
  name: string;
  transport: 'stdio' | 'sse' | 'http';
  status: 'active' | 'disabled' | 'error';
  config?: Record<string, unknown>;
};
export type McpToolView = { id: string; serverId: string; name: string; label?: string; description?: string };
export type ModelConfigView = { id: string; providerId: string; model: string; purpose: string; config?: Record<string, unknown> };
export type ProjectView = {
  id: string;
  name: string;
  path: string;
  note?: string;
  spec?: string;
  emoji?: string;
  accent?: string;
  createdAt: string;
  updatedAt: string;
};

export type Resources = {
  loading: boolean;
  error: string | null;
  persistence: { enabled: boolean; reachable: boolean };
  /** Active avatar id (the persona in use). */
  activeAvatarId: string;
  avatars: AvatarView[];
  spaces: SpaceProfile[];
  tools: ToolView[];
  toolSets: ToolSetView[];
  skills: SkillView[];
  projects: ProjectView[];
  models: ModelConfigView[];
  mcpServers: McpServerView[];
  mcpTools: McpToolView[];
  reload: () => Promise<void>;
};

/**
 * Single source of truth for the web management surface. Spaces remain global,
 * while avatars may carry UI binding preferences that filter chat-time space
 * choices. `reload` re-pulls after a mutation.
 */
export function useResources(avatarId?: string): Resources {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [persistence, setPersistence] = useState({ enabled: false, reachable: false });
  const [activeAvatarId, setActiveAvatarId] = useState(avatarId ?? 'zleap-default');
  const [avatars, setAvatars] = useState<AvatarView[]>([]);
  const [spaces, setSpaces] = useState<SpaceProfile[]>([]);
  const [tools, setTools] = useState<ToolView[]>([]);
  const [toolSets, setToolSets] = useState<ToolSetView[]>([]);
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [models, setModels] = useState<ModelConfigView[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerView[]>([]);
  const [mcpTools, setMcpTools] = useState<McpToolView[]>([]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    const suffix = avatarId ? `?avatarId=${encodeURIComponent(avatarId)}` : '';
    try {
      const [avatar, spaceBody, toolBody, modelBody, skillBody, mcpServerBody, mcpToolBody, projectBody] = await Promise.all([
        getJson<{ avatars?: AvatarView[]; avatarId?: string; persistence?: { enabled: boolean; reachable: boolean } }>(`/api/avatar${suffix}`),
        getJson<{ spaces?: SpaceProfile[] }>('/api/spaces'),
        getJson<{ tools?: ToolView[]; toolSets?: ToolSetView[] }>('/api/tools'),
        getJson<{ models?: ModelConfigView[] }>('/api/models'),
        getJson<{ skills?: SkillView[] }>('/api/skills'),
        getJson<{ servers?: McpServerView[] }>('/api/mcp/servers'),
        getJson<{ tools?: McpToolView[] }>('/api/mcp/tools'),
        getJson<{ projects?: ProjectView[] }>('/api/projects'),
      ]);
      setAvatars(avatar.avatars ?? []);
      setActiveAvatarId(avatar.avatarId ?? avatarId ?? 'zleap-default');
      setPersistence(avatar.persistence ?? { enabled: false, reachable: false });
      setSpaces(spaceBody.spaces ?? []);
      setTools(toolBody.tools ?? []);
      setToolSets(toolBody.toolSets ?? []);
      setModels(modelBody.models ?? []);
      setSkills(skillBody.skills ?? []);
      setMcpServers(mcpServerBody.servers ?? []);
      setMcpTools(mcpToolBody.tools ?? []);
      setProjects(projectBody.projects ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [avatarId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return {
    loading,
    error,
    persistence,
    activeAvatarId,
    avatars,
    spaces,
    tools,
    toolSets,
    skills,
    projects,
    models,
    mcpServers,
    mcpTools,
    reload,
  };
}
