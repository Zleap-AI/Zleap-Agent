import { describe, expect, it } from 'vitest';
import { filterSlashCommands, isSlashPaletteOpen, SLASH_COMMANDS } from '../src/commands/registry.js';
import { parseBuiltinCommand } from '../src/commands/builtin.js';
import { buildDefaultSeedWorkspaceDetails, buildWorkspaceDetailsFromAvatarProfile } from '@zleap/agent/workspaces';

describe('slash command registry', () => {
  it('opens the palette only for first-line slash queries', () => {
    expect(isSlashPaletteOpen('/')).toBe(true);
    expect(isSlashPaletteOpen('/model')).toBe(true);
    expect(isSlashPaletteOpen('hello\n/')).toBe(false);
    expect(isSlashPaletteOpen('hello')).toBe(false);
  });

  it('lists all commands for bare slash and filters by prefix', () => {
    expect(filterSlashCommands('/').map((command) => command.name)).toContain('/model');
    expect(filterSlashCommands('/mod').map((command) => command.name)).toEqual(['/mode', '/model']);
    expect(filterSlashCommands('/zzz')).toEqual([]);
  });

  it('registers and parses the observability/session commands', () => {
    for (const name of ['/status', '/context', '/compact', '/spaces', '/resume']) {
      expect(SLASH_COMMANDS.some((command) => command.name === name)).toBe(true);
      expect(parseBuiltinCommand(name)).toBe(name);
    }
    expect(parseBuiltinCommand('/nope')).toBeUndefined();
  });

  it('projects the default Space seed into runtime workspace views', () => {
    const spaces = buildDefaultSeedWorkspaceDetails();
    const main = spaces.find((space) => space.canonicalId === 'main');

    expect(spaces.map((space) => space.canonicalId)).toEqual(['main', 'cli', 'web-search']);
    expect(main).toMatchObject({ id: 'session', canonicalId: 'main', kind: 'main' });
    expect(main?.toolIds).toContain('switchWorkspace');
    expect(main?.toolIds).not.toContain('enterWorkspace');
    expect(main?.toolIds).toContain('task_manage');
  });

  it('projects configured Avatar Space tool bindings into runtime workspace views', () => {
    const spaces = buildWorkspaceDetailsFromAvatarProfile({
      spaces: [
        {
          id: 'main',
          kind: 'main',
          label: 'Main',
          routingCard: 'main routing',
          toolIds: ['switchWorkspace'],
        },
        {
          id: 'terminal',
          kind: 'work',
          label: 'Terminal',
          routingCard: 'terminal routing',
          toolIds: ['read', 'grep'],
          skillIds: ['repo-research'],
        },
      ],
    });

    expect(spaces.find((space) => space.canonicalId === 'main')).toMatchObject({ id: 'session', kind: 'main' });
    expect(spaces.find((space) => space.id === 'terminal')?.toolIds).toEqual(['read', 'grep']);
    expect(spaces.find((space) => space.id === 'terminal')?.skillIds).toEqual(['repo-research']);
  });
});
