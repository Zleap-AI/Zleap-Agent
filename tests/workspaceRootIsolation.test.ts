import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

let previousWorkspaceRoot: string | undefined;

describe('test file workspace isolation', () => {
  it('uses a temporary file workspace root in tests', async () => {
    const root = process.env.ZLEAP_FILE_WORKSPACE_ROOT;
    expect(root).toMatch(/zleap-test-workspaces-/);
    expect(root).not.toContain('/Documents/Zleap');

    previousWorkspaceRoot = root;
    await mkdir(join(root!, 'created-by-test'), { recursive: true });
    await writeFile(join(root!, 'created-by-test', 'artifact.txt'), 'temporary\n');
    await expect(access(join(root!, 'created-by-test', 'artifact.txt'))).resolves.toBeUndefined();
  });

  it('removes the previous test workspace root before the next test starts', async () => {
    expect(previousWorkspaceRoot).toBeDefined();
    await expect(access(previousWorkspaceRoot!)).rejects.toThrow();
  });
});
