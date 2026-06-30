import { describe, expect, it } from 'vitest';

/** Mirror detection logic from SystemMessage for unit tests. */
const KV_LINE = /^ {2}(\S+)\s{2,}(.+)$/;

function isStructuredBlock(text: string): boolean {
  const lines = text.split('\n');
  if (lines.length <= 1) {
    return false;
  }
  return lines.some((line) => KV_LINE.test(line) || /^[^\s].+[：:]$/.test(line.trim()));
}

describe('SystemMessage structured detection', () => {
  it('treats single-line notify as plain', () => {
    expect(isStructuredBlock('已恢复「最近ai agent发展」（4 条）。')).toBe(false);
  });

  it('treats /status blocks as structured', () => {
    const block = ['状态', '  模型       qwen3.6-flash', '  数据库     已连接'].join('\n');
    expect(isStructuredBlock(block)).toBe(true);
  });
});
