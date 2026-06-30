import { describe, expect, it } from 'vitest';
import { previewToolCall } from '@zleap/agent/workspaces';

describe('previewToolCall (HITL approval previews)', () => {
  it('shows the command for bash', () => {
    const preview = previewToolCall('bash', { command: 'git status' });
    expect(preview).toBe('Run command\n$ git status');
  });

  it('shows path, line count, and added lines for write', () => {
    const preview = previewToolCall('write', { path: 'a.txt', content: 'one\ntwo' });
    expect(preview).toMatch(/^Write a\.txt \(2 lines\)/);
    expect(preview).toContain('+    one');
    expect(preview).toContain('+    two');
  });

  it('shows a +/- diff header for edit', () => {
    const preview = previewToolCall('edit', {
      path: 'a.txt',
      old_string: 'foo',
      new_string: 'bar',
    });
    expect(preview?.split('\n')[0]).toMatch(/^Edit a\.txt \(\+\d+ -\d+\)$/);
  });

  it('notes replace_all scope', () => {
    const preview = previewToolCall('edit', {
      path: 'a.txt',
      old_string: 'foo',
      new_string: 'bar',
      replace_all: true,
    });
    expect(preview?.split('\n')[0]).toContain('all matches');
  });

  it('shows a combined diff header for multiple edit replacements', () => {
    const preview = previewToolCall('edit', {
      path: 'a.txt',
      edits: [
        { old_string: 'foo', new_string: 'bar' },
        { old_string: 'one\ntwo', new_string: 'three\nfour' },
      ],
    });
    expect(preview?.split('\n')[0]).toMatch(/^Edit a\.txt \(2 edits, \+\d+ -\d+\)$/);
    expect(preview).toContain('-   1 foo');
    expect(preview).toContain('+   1 bar');
  });

  it('shows edit previews for camelCase replacement fields', () => {
    const preview = previewToolCall('edit', {
      path: 'a.txt',
      edits: [
        { oldString: 'foo', newString: 'bar' },
      ],
      replaceAll: true,
    });
    expect(preview?.split('\n')[0]).toContain('all matches');
    expect(preview).toContain('-   1 foo');
    expect(preview).toContain('+   1 bar');
  });

  it('returns undefined when required fields are missing or tool is unknown', () => {
    expect(previewToolCall('write', {})).toBeUndefined();
    expect(previewToolCall('bash', {})).toBeUndefined();
    expect(previewToolCall('read', { path: 'a.txt' })).toBeUndefined();
  });
});
