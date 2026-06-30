import { describe, expect, it } from 'vitest';
import {
  formatToolErrorMessage,
  formatToolSuccessHint,
  primaryToolArg,
} from '../src/ui/toolDisplay.js';

describe('toolDisplay', () => {
  it('prefers q over reason for web_search args', () => {
    const args = JSON.stringify({ q: '2026 AI 动态', reason: '需要最新资讯' });
    expect(primaryToolArg(args)).toBe('2026 AI 动态');
  });

  it('formats web search API key errors in Chinese', () => {
    expect(formatToolErrorMessage('web_search_api_key_required: 请配置 Key')).toContain('未配置网页搜索 API Key');
    expect(formatToolErrorMessage('302_api_failed:401 unauthorized')).toContain('HTTP 401');
    expect(formatToolErrorMessage('{')).toBe('工具执行失败');
  });

  it('summarizes successful web search results', () => {
    const result = JSON.stringify({
      scope: 'webpage',
      total: 12,
      results: [
        { title: 'Gemini 3.5 发布', url: 'https://example.com/a' },
        { title: '具身智能周报', url: 'https://example.com/b' },
      ],
    });
    expect(formatToolSuccessHint('web_search', result)).toContain('2 条');
    expect(formatToolSuccessHint('web_search', result)).toContain('Gemini');
  });

  it('shows empty search hint', () => {
    const result = JSON.stringify({ scope: 'webpage', results: [] });
    expect(formatToolSuccessHint('web_search', result)).toBe('0 条结果');
  });
});
