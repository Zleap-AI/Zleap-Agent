export type ToolSetDefinition = {
  id: string;
  label: string;
  description: string;
  toolIds: string[];
};

export type ToolSetView = ToolSetDefinition & {
  toolCount: number;
};

export const MAIN_SPACE_ONLY_TOOL_IDS = ['enterWorkspace', 'readMessage', 'task_manage', 'recall', 'deliver'] as const;

export const SUPPORTED_BUILTIN_TOOL_IDS = [
  'ls',
  'find',
  'read',
  'grep',
  'write',
  'append',
  'edit',
  'bash',
  'get_time',
  'web_search',
  'read_webpage',
] as const;

const SUPPORTED_BUILTIN_TOOL_ID_SET = new Set<string>(SUPPORTED_BUILTIN_TOOL_IDS);

export const DEFAULT_TOOL_SETS: ToolSetDefinition[] = [
  {
    id: 'system',
    label: 'System',
    description: 'Time and runtime context utilities.',
    toolIds: ['get_time'],
  },
  {
    id: 'files',
    label: 'File',
    description: 'List, read, search, write, append, and patch local project files.',
    toolIds: ['ls', 'find', 'read', 'grep', 'write', 'append', 'edit'],
  },
  {
    id: 'terminal',
    label: 'Command',
    description: 'Run shell commands in the execution environment.',
    toolIds: ['bash'],
  },
  {
    id: 'web-search',
    label: 'Web Search',
    description: 'Search the web and read webpages.',
    toolIds: ['web_search', 'read_webpage'],
  },
];

export function listToolSetViews(): ToolSetView[] {
  return DEFAULT_TOOL_SETS.map((set) => ({ ...set, toolCount: set.toolIds.length }));
}

export function expandToolSetIds(toolSetIds: string[] = []): string[] {
  const ids = new Set<string>();
  for (const setId of toolSetIds) {
    const set = DEFAULT_TOOL_SETS.find((candidate) => candidate.id === setId);
    if (!set) continue;
    for (const toolId of set.toolIds) {
      ids.add(toolId);
    }
  }
  return [...ids];
}

export function normalizeToolSetIds(toolSetIds: string[] = []): string[] {
  const known = new Set(DEFAULT_TOOL_SETS.map((set) => set.id));
  return [...new Set(toolSetIds.filter((id) => known.has(id)))];
}

export function isSupportedBuiltinToolId(toolId: string): boolean {
  return SUPPORTED_BUILTIN_TOOL_ID_SET.has(toolId);
}
