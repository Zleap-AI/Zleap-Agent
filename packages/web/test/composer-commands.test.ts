import { describe, expect, it } from 'vitest';
import { filterAgentMentions, filterComposerCommands, parseMention, parseSlashCommand } from '../lib/composerCommands';

describe('composer command parsing', () => {
  it('parses slash commands at token boundaries', () => {
    expect(parseSlashCommand('/', 1)).toEqual({ start: 0, query: '' });
    expect(parseSlashCommand('hello /plan', 11)).toEqual({ start: 6, query: 'plan' });
    expect(parseSlashCommand('hello\n/goal', 11)).toEqual({ start: 6, query: 'goal' });
  });

  it('does not parse URLs or filesystem paths as slash commands', () => {
    expect(parseSlashCommand('open http://localhost', 21)).toBeNull();
    expect(parseSlashCommand('/Users/lijunqin/project', 22)).toBeNull();
    expect(parseSlashCommand('cd /tmp/project', 15)).toBeNull();
  });

  it('filters commands by label, id, group, description, and keywords', () => {
    const commands = [
      { id: 'plan', group: '模式', label: '计划模式', keywords: ['mode'] },
      { id: 'space:web', group: '空间', label: '网络搜索', description: 'web' },
      { id: 'model:gpt', group: '模型', label: 'GPT-5.5' },
    ];

    expect(filterComposerCommands(commands, '计划').map((item) => item.id)).toEqual(['plan']);
    expect(filterComposerCommands(commands, 'space').map((item) => item.id)).toEqual(['space:web']);
    expect(filterComposerCommands(commands, 'gpt').map((item) => item.id)).toEqual(['model:gpt']);
  });
});

describe('agent mention parsing', () => {
  it('parses @ mentions and filters only agent candidates', () => {
    expect(parseMention('@小智', 3)).toEqual({ start: 0, query: '小智' });
    expect(filterAgentMentions([
      { id: 'xiaozhi', name: '小智' },
      { id: 'researcher', name: '研究员' },
    ], 'xiao')).toEqual([{ id: 'xiaozhi', name: '小智' }]);
  });
});
