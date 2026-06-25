export type ComposerToken = { start: number; query: string };

export type ComposerCommandSearchInput = {
  id: string;
  group: string;
  label: string;
  description?: string;
  keywords?: string[];
};

export type AgentMentionSearchInput = {
  id: string;
  name: string;
};

export function parseMention(text: string, cursor: number): ComposerToken | null {
  const head = text.slice(0, cursor);
  const match = /(?:^|[\s])@([^\s@]*)$/.exec(head);
  if (!match) return null;
  const query = match[1] ?? '';
  return { start: cursor - query.length - 1, query };
}

export function parseSlashCommand(text: string, cursor: number): ComposerToken | null {
  const head = text.slice(0, cursor);
  const match = /(?:^|[\s])\/([^\s]*)$/.exec(head);
  if (!match) return null;
  const query = match[1] ?? '';
  if (query.includes('/')) return null;
  return { start: cursor - query.length - 1, query };
}

export function filterComposerCommands<T extends ComposerCommandSearchInput>(commands: T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return commands;
  return commands.filter((command) => commandMatches(command, needle));
}

export function filterAgentMentions<T extends AgentMentionSearchInput>(agents: T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return agents;
  return agents.filter((agent) => agent.name.toLowerCase().includes(needle) || agent.id.toLowerCase().includes(needle));
}

function commandMatches(command: ComposerCommandSearchInput, needle: string): boolean {
  return [
    command.id,
    command.group,
    command.label,
    command.description,
    ...(command.keywords ?? []),
  ].some((value) => value?.toLowerCase().includes(needle));
}
