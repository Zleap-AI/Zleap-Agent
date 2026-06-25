import { afterEach, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalWorkspaceRoot = process.env.ZLEAP_FILE_WORKSPACE_ROOT;
let testWorkspaceRoot: string | undefined;

beforeEach(async () => {
  testWorkspaceRoot = await mkdtemp(join(tmpdir(), 'zleap-test-workspaces-'));
  process.env.ZLEAP_FILE_WORKSPACE_ROOT = testWorkspaceRoot;
});

afterEach(async () => {
  if (originalWorkspaceRoot === undefined) {
    delete process.env.ZLEAP_FILE_WORKSPACE_ROOT;
  } else {
    process.env.ZLEAP_FILE_WORKSPACE_ROOT = originalWorkspaceRoot;
  }

  if (testWorkspaceRoot) {
    await rm(testWorkspaceRoot, { recursive: true, force: true });
    testWorkspaceRoot = undefined;
  }
});
