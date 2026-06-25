import { describe, expect, it } from 'vitest';
import {
  buildWorkspaceSummaryMessages,
  prependWorkspaceSummaryToUserMessage,
  validateWorkspaceSummaryXml,
  workspaceCompactionThresholds,
} from '../src/compaction/summary.js';

describe('workspaceCompactionThresholds', () => {
  it('uses 50 percent trigger and 10 percent tail from model contextWindow', () => {
    const result = workspaceCompactionThresholds({ contextWindow: 128_000 });
    expect(result).toEqual({
      contextWindow: 128_000,
      triggerTokens: 64_000,
      tailTokens: 12_800,
      triggerRatio: 0.5,
      tailRatio: 0.1,
      maxAttempts: 3,
    });
  });

  it('uses fallback contextWindow when model contextWindow is missing', () => {
    const result = workspaceCompactionThresholds({});
    expect(result.triggerTokens).toBe(16_000);
    expect(result.tailTokens).toBe(3_200);
  });
});

describe('prependWorkspaceSummaryToUserMessage', () => {
  it('puts workspace_summary before current_user_message', () => {
    const content = prependWorkspaceSummaryToUserMessage(
      '帮我继续做 PPT',
      '<workspace_summary space="main"><progress>已搜索资料</progress></workspace_summary>',
      'main',
    );
    expect(content).toBe([
      '<workspace_summary space="main"><progress>已搜索资料</progress></workspace_summary>',
      '<current_user_message>',
      '帮我继续做 PPT',
      '</current_user_message>',
    ].join('\n'));
  });

  it('does not add an empty summary block when summary is blank', () => {
    expect(prependWorkspaceSummaryToUserMessage('你好', '', 'main')).toBe('你好');
  });
});

describe('validateWorkspaceSummaryXml', () => {
  it('rejects summaries for the wrong workspace', () => {
    expect(() => validateWorkspaceSummaryXml('<workspace_summary space="cli"></workspace_summary>', 'main')).toThrow(
      'workspace summary must be wrapped',
    );
  });
});

describe('buildWorkspaceSummaryMessages', () => {
  it('asks for one workspace_summary XML block and preserves readMessage recovery ids', () => {
    const messages = buildWorkspaceSummaryMessages({
      spaceId: 'cli',
      previousSummaryXml: '<workspace_summary space="cli"><progress>旧进展</progress></workspace_summary>',
      foldedEntryRefs: [{ id: 'web:web-1:entry:tool-1', role: 'tool' }],
      foldedMessages: [
        { role: 'user', content: '生成 PPT' },
        { role: 'assistant', content: [{ type: 'text', text: '我会写脚本' }] },
      ],
    });
    const raw = typeof messages[0]?.content === 'string' ? messages[0].content : '';
    expect(raw).toContain('<previous_workspace_summary>');
    expect(raw).toContain('<folded_messages>');
    expect(raw).toContain('<recoverable_history>');
    expect(raw).toContain('web:web-1:entry:tool-1');
    expect(raw).toContain('<workspace_summary space="cli">');
  });
});
