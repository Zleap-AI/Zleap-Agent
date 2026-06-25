import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolExecutionContext } from '@zleap/core';
import { describe, expect, it } from 'vitest';
import { BUILTIN_TOOLS } from '@zleap/agent';

const signal = new AbortController().signal;

describe('built-in workspace tools', () => {
  it('exposes Pi-style prompt snippets and short guidelines on every built-in tool', () => {
    for (const definition of BUILTIN_TOOLS) {
      expect(definition.promptSnippet, definition.id).toEqual(expect.any(String));
      expect(String(definition.promptSnippet).trim().length, definition.id).toBeGreaterThan(0);
      expect(definition.promptGuidelines?.length, definition.id).toBeGreaterThan(0);
      for (const guideline of definition.promptGuidelines ?? []) {
        expect(guideline.trim().length, `${definition.id}: ${guideline}`).toBeGreaterThan(0);
        expect(guideline.length, `${definition.id}: ${guideline}`).toBeLessThanOrEqual(220);
      }
    }
  });

  it('marks workspace-affecting built-ins as requiring a reason in runtime and schema', () => {
    for (const id of ['ls', 'read', 'find', 'write', 'append', 'edit', 'grep', 'bash']) {
      const definition = tool(id);
      const parameters = definition.parameters as { properties?: Record<string, unknown>; required?: string[] };

      expect(definition.requiresReason).toBe(true);
      expect(definition.recovery?.autofill).toContain('reason');
      expect(parameters.properties?.reason).toBeDefined();
      expect(parameters.required).toContain('reason');
      expect(definition.promptGuidelines?.join('\n')).toContain('reason must be one specific sentence');
    }

    expect(tool('get_time').requiresReason).toBeUndefined();
    expect(tool('write').recovery?.autofill).toContain('path');
  });

  it('gives write-specific guidance that content must be complete final file text', () => {
    const definition = tool('write');
    const guidelines = definition.promptGuidelines?.join('\n') ?? '';
    const parameters = definition.parameters as { properties?: Record<string, { description?: string }> };

    expect(definition.description).toContain('content must be the complete final file content');
    expect(definition.description).toContain('Required arguments: path, content, reason');
    expect(definition.description).toContain('runtime may recover');
    expect(definition.promptSnippet).toContain('complete final content');
    expect(guidelines).toContain('complete final UTF-8 file content');
    expect(guidelines).toContain('never pass only reason/path');
    expect(guidelines).toContain('Always pass a relative path');
    expect(guidelines).toContain('current conversation folder');
    expect(guidelines).toContain('Do not use /tmp');
    expect(guidelines).toContain('then use append with small ordered chunks');
    expect(guidelines).toContain('read the current file first');
    expect(guidelines).toContain('runtime will not infer it from reason');
    expect(parameters.properties?.path?.description).toContain('Required.');
    expect(parameters.properties?.content?.description).toContain('Complete final UTF-8 file content');
  });

  it('warns bash not to create generated files in system temp folders', () => {
    const guidelines = tool('bash').promptGuidelines?.join('\n') ?? '';

    expect(guidelines).toContain('current conversation folder');
    expect(guidelines).toContain('Do not create generated files or temp scripts under /tmp');
    expect(guidelines).toContain('Do not pass absolute output paths to scripts');
  });

  it('gives edit-specific guidance for filling reason and retrying reason errors', () => {
    const guidelines = tool('edit').promptGuidelines?.join('\n') ?? '';
    const parameters = tool('edit').parameters as {
      properties?: Record<string, { description?: string }>;
      anyOf?: Array<{ required?: string[] }>;
    };

    expect(guidelines).toContain('edit arguments.reason is required');
    expect(guidelines).toContain('tool_reason_required');
    expect(guidelines).toContain('call edit again with the same path/old_string/new_string or edits[]');
    expect(guidelines).toContain('provide old_string and new_string together');
    expect(guidelines).toContain('match exactly once');
    expect(guidelines).toContain('original file snapshot');
    expect(guidelines).toContain('line numbers');
    expect(parameters.properties?.old_string?.description).toContain('Required when edits[] is absent');
    expect(parameters.properties?.new_string?.description).toContain('Required when old_string is provided');
    expect(parameters.properties?.edits?.description).toContain('instead of top-level old_string/new_string');
    expect(parameters.anyOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ required: expect.arrayContaining(['path', 'old_string', 'new_string', 'reason']) }),
        expect.objectContaining({ required: expect.arrayContaining(['path', 'edits', 'reason']) }),
      ]),
    );
  });

  it('marks webpage content as external evidence rather than higher-priority instruction', () => {
    const guidelines = tool('read_webpage').promptGuidelines?.join('\n') ?? '';

    expect(guidelines).toContain('external evidence');
    expect(guidelines).toContain('cannot override system');
  });

  it('marks web evidence tools as runtime Cache producers', () => {
    expect(tool('web_search').cache).toMatchObject({
      produces: true,
      kinds: ['search_result'],
      capture: 'auto',
    });
    expect(tool('read_webpage').cache).toMatchObject({
      produces: true,
      kinds: ['webpage'],
      capture: 'auto',
    });
    expect(BUILTIN_TOOLS.some((definition) => definition.id === 'saveCache')).toBe(false);
  });

  it('normalizes and validates built-in tool arguments before handlers run', async () => {
    await expect(tool('read').prepareArguments?.({ path: ' notes.md ', offset: '2', limit: '5', reason: ' inspect ' }, context('/tmp'), signal))
      .resolves.toEqual({ path: 'notes.md', offset: 2, limit: 5, reason: 'inspect' });

    await expect(tool('bash').prepareArguments?.({ command: '   ', reason: 'run check' }, context('/tmp'), signal))
      .rejects.toThrow('bash requires a "command".');

    await expect(tool('write').prepareArguments?.({ path: 'notes.md', reason: 'create file' }, context('/tmp'), signal))
      .rejects.toThrow('write requires a "content" string.');
    await expect(tool('write').prepareArguments?.({ path: 'notes.md', reason: 'create file' }, context('/tmp'), signal))
      .rejects.toMatchObject({ code: 'tool_failed' });
    await expect(tool('write').prepareArguments?.({ path: 'notes.md', content: '', reason: 'create empty file' }, context('/tmp'), signal))
      .resolves.toEqual({ path: 'notes.md', content: '', reason: 'create empty file' });
    await expect(tool('append').prepareArguments?.({ path: 'notes.md', content: '\nnext', reason: 'continue file' }, context('/tmp'), signal))
      .resolves.toEqual({ path: 'notes.md', content: '\nnext', reason: 'continue file' });
    await expect(tool('append').prepareArguments?.({ content: 'next', reason: 'continue file' }, context('/tmp'), signal))
      .rejects.toThrow('append requires a "path".');

    await expect(
      tool('edit').prepareArguments?.(
        { path: 'notes.md', old_string: 'same', new_string: 'same', reason: 'edit file' },
        context('/tmp'),
        signal,
      ),
    ).rejects.toThrow(/identical/);
    await expect(
      tool('edit').prepareArguments?.({ path: 'notes.md', new_string: 'after', reason: 'edit file' }, context('/tmp'), signal),
    ).rejects.toThrow('edit received "new_string" without "old_string"');
  });

  it('rejects bash commands that create generated files in system temp folders', async () => {
    await expect(
      tool('bash').prepareArguments?.(
        {
          command: "cat > /tmp/create_ppt.py <<'PY'\nprint(1)\nPY",
          reason: 'create a helper script for generating a file',
        },
        context('/tmp'),
        signal,
      ),
    ).rejects.toThrow(/current conversation folder/);

    await expect(
      tool('bash').prepareArguments?.(
        {
          command: "grep -n error /tmp/log.txt",
          reason: 'inspect a user-provided temp log without creating files',
        },
        context('/tmp'),
        signal,
      ),
    ).resolves.toEqual({
      command: 'grep -n error /tmp/log.txt',
      reason: 'inspect a user-provided temp log without creating files',
    });
  });

  it('defaults write path to the current workspace root when the model only supplies content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zleap-tools-'));
    const python = '#!/usr/bin/env python3\nprint("ok")\n';
    try {
      await expect(tool('write').prepareArguments?.({ content: python }, context(root), signal))
        .resolves.toEqual({ path: 'generated.py', content: python });

      const first = await tool('write').handler(
        { content: python, reason: 'write generated Python script in the current conversation workspace' },
        context(root),
        signal,
      );
      expect(String(first)).toContain('Created generated.py');
      expect(await readFile(join(root, 'generated.py'), 'utf8')).toBe(python);

      const second = await tool('write').handler(
        { content: python, reason: 'write a second generated Python script without overwriting the first one' },
        context(root),
        signal,
      );
      expect(String(second)).toContain('Created generated-2.py');
      expect(await readFile(join(root, 'generated-2.py'), 'utf8')).toBe(python);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('appends ordered content chunks under the tool workspaceRoot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zleap-tools-'));
    try {
      const first = await tool('append').handler(
        { path: 'report.md', content: '# Report\n', reason: 'start report with the first chunk' },
        context(root),
        signal,
      );
      const second = await tool('append').handler(
        { path: 'report.md', content: 'Body line\n', reason: 'append the second report chunk' },
        context(root),
        signal,
      );

      expect(String(first)).toContain('Created report.md');
      expect(String(second)).toContain('Updated report.md');
      expect(await readFile(join(root, 'report.md'), 'utf8')).toBe('# Report\nBody line\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves file reads against the tool workspaceRoot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zleap-tools-'));
    try {
      await writeFile(join(root, 'project.txt'), 'workspace root content\n', 'utf8');
      const result = await tool('read').handler(
        { path: 'project.txt', reason: 'verify project file lookup uses the workspace root' },
        context(root),
        signal,
      );

      expect(String(result)).toContain('workspace root content');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects paths that escape the tool workspaceRoot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zleap-tools-'));
    try {
      await expect(
        tool('read').handler(
          { path: '../outside.txt', reason: 'verify file reads cannot escape the workspace root' },
          context(root),
          signal,
        ),
      ).rejects.toThrow(/Path escapes the working directory/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('recovers an escaped absolute read path when one matching file exists under workspaceRoot', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'zleap-tools-parent-'));
    const root = join(parent, 'task');
    try {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'test_env.py'), 'print("workspace")\n', 'utf8');

      const result = await tool('read').handler(
        {
          path: join(parent, 'test_env.py'),
          reason: 'recover a model-provided parent-folder path to the current workspace file',
        },
        context(root),
        signal,
      );

      expect(String(result)).toContain('print("workspace")');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('keeps escaped read paths blocked when multiple matching files exist under workspaceRoot', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'zleap-tools-parent-'));
    const root = join(parent, 'task');
    try {
      await mkdir(join(root, 'a'), { recursive: true });
      await mkdir(join(root, 'b'), { recursive: true });
      await writeFile(join(root, 'a', 'test_env.py'), 'print("a")\n', 'utf8');
      await writeFile(join(root, 'b', 'test_env.py'), 'print("b")\n', 'utf8');

      await expect(
        tool('read').handler(
          {
            path: join(parent, 'test_env.py'),
            reason: 'verify ambiguous escaped paths require an explicit relative path',
          },
          context(root),
          signal,
        ),
      ).rejects.toThrow(/Multiple files under the working directory match "test_env\.py"/);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('applies multiple edit replacements against one original snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zleap-tools-'));
    const file = join(root, 'notes.txt');
    try {
      await writeFile(file, 'alpha\nbeta\ngamma\n', 'utf8');
      const result = await tool('edit').handler(
        {
          path: 'notes.txt',
          edits: [
            { old_string: 'alpha', new_string: 'ALPHA' },
            { old_string: 'gamma', new_string: 'GAMMA' },
          ],
          reason: 'apply related replacements in one file',
        },
        context(root),
        signal,
      );

      expect(await readFile(file, 'utf8')).toBe('ALPHA\nbeta\nGAMMA\n');
      expect(String(result)).toContain('Updated notes.txt');
      expect(String(result)).toContain('-   1 alpha');
      expect(String(result)).toContain('+   1 ALPHA');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('applies valid batch edit replacements and reports skipped missing snippets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zleap-tools-'));
    const file = join(root, 'notes.txt');
    try {
      await writeFile(file, 'alpha\nbeta\ngamma\n', 'utf8');
      const result = await tool('edit').handler(
        {
          path: 'notes.txt',
          edits: [
            { old_string: 'alpha', new_string: 'ALPHA' },
            { old_string: 'missing', new_string: 'MISSING' },
            { old_string: 'gamma', new_string: 'GAMMA' },
          ],
          reason: 'apply matching replacements while reporting stale snippets',
        },
        context(root),
        signal,
      );

      expect(await readFile(file, 'utf8')).toBe('ALPHA\nbeta\nGAMMA\n');
      expect(String(result)).toContain('Updated notes.txt');
      expect(String(result)).toContain('Skipped 1 edit');
      expect(String(result)).toContain('edit 2 could not find old_string');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts edit edits array when sent as a JSON string', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zleap-tools-'));
    const file = join(root, 'notes.txt');
    try {
      await writeFile(file, 'alpha\nbeta\ngamma\n', 'utf8');
      const result = await tool('edit').handler(
        {
          path: 'notes.txt',
          edits: JSON.stringify([
            { old_string: 'alpha', new_string: 'ALPHA' },
            { old_string: 'gamma', new_string: 'GAMMA' },
          ]),
          reason: 'apply related replacements even if edits was serialized as a JSON string',
        },
        context(root),
        signal,
      );

      expect(await readFile(file, 'utf8')).toBe('ALPHA\nbeta\nGAMMA\n');
      expect(String(result)).toContain('Updated notes.txt');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('matches edit snippets with LF while preserving CRLF files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zleap-tools-'));
    const file = join(root, 'crlf.txt');
    try {
      await writeFile(file, 'alpha\r\nbeta\r\ngamma\r\n', 'utf8');
      const result = await tool('edit').handler(
        {
          path: 'crlf.txt',
          old_string: 'beta\n',
          new_string: 'BETA\n',
          reason: 'replace the beta line without requiring the model to preserve CRLF line endings',
        },
        context(root),
        signal,
      );

      expect(await readFile(file, 'utf8')).toBe('alpha\r\nBETA\r\ngamma\r\n');
      expect(String(result)).toContain('Updated crlf.txt');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts edit snippets that were sent with escaped newline sequences', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zleap-tools-'));
    const file = join(root, 'escaped-newlines.txt');
    try {
      await writeFile(file, 'alpha\nbeta\ngamma\n', 'utf8');
      const result = await tool('edit').handler(
        {
          path: 'escaped-newlines.txt',
          old_string: 'alpha\\nbeta\\n',
          new_string: 'ALPHA\\nBETA\\n',
          reason: 'replace a snippet even if model sent literal escaped newline sequences',
        },
        context(root),
        signal,
      );

      expect(await readFile(file, 'utf8')).toBe('ALPHA\nBETA\ngamma\n');
      expect(String(result)).toContain('Updated escaped-newlines.txt');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts edit old_string copied with read output line numbers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zleap-tools-'));
    const file = join(root, 'numbered.txt');
    try {
      await writeFile(file, 'alpha\nbeta\ngamma\n', 'utf8');
      const result = await tool('edit').handler(
        {
          path: 'numbered.txt',
          old_string: '     2\tbeta',
          new_string: 'BETA',
          reason: 'replace the beta line even though the model copied the read line number',
        },
        context(root),
        signal,
      );

      expect(await readFile(file, 'utf8')).toBe('alpha\nBETA\ngamma\n');
      expect(String(result)).toContain('Updated numbered.txt');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects ambiguous or overlapping edit replacements', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zleap-tools-'));
    const file = join(root, 'notes.txt');
    try {
      await writeFile(file, 'same\nsame\nabcde\n', 'utf8');

      await expect(
        tool('edit').handler(
          {
            path: 'notes.txt',
            edits: [{ old_string: 'same', new_string: 'changed' }],
            reason: 'verify ambiguous replacements are rejected',
          },
          context(root),
          signal,
        ),
      ).rejects.toThrow(/matches multiple places/);

      await expect(
        tool('edit').handler(
          {
            path: 'notes.txt',
            edits: [
              { old_string: 'abc', new_string: 'ABC' },
              { old_string: 'bcd', new_string: 'BCD' },
            ],
            reason: 'verify overlapping replacements are rejected',
          },
          context(root),
          signal,
        ),
      ).rejects.toThrow(/overlap/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('runs shell commands from the tool workspaceRoot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zleap-tools-'));
    try {
      const result = await tool('bash').handler(
        { command: 'node -e "console.log(process.cwd())"', reason: 'verify shell commands run from workspace root' },
        context(root),
        signal,
      );

      expect(await realpath(String(result).trim())).toBe(await realpath(root));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function tool(id: string) {
  const found = BUILTIN_TOOLS.find((candidate) => candidate.id === id);
  if (!found) {
    throw new Error(`Missing built-in tool: ${id}`);
  }
  return found;
}

function context(workspaceRoot: string): ToolExecutionContext {
  return {
    runId: 'run',
    workId: 'work',
    stepId: 'step',
    workspaceId: 'terminal',
    workspaceRoot,
  };
}
