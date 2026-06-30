import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach } from 'vitest';
import { describe, expect, it } from 'vitest';
import { POST } from '../app/api/chat/approval/route';
import { liveApprovalKey, waitForLiveApproval } from '../lib/server/liveApprovals';

const previousQueuePath = process.env.ZLEAP_APPROVAL_QUEUE_PATH;

afterEach(() => {
  if (previousQueuePath === undefined) {
    delete process.env.ZLEAP_APPROVAL_QUEUE_PATH;
  } else {
    process.env.ZLEAP_APPROVAL_QUEUE_PATH = previousQueuePath;
  }
});

describe('/api/chat/approval route', () => {
  it('resolves a pending live approval for the same actor and conversation', async () => {
    const { root, queuePath } = await useTempApprovalQueue();
    const actor = { userId: 'u1', role: 'user' as const, tenantId: 't1' };
    try {
      const pending = waitForLiveApproval({
        actor,
        conversationId: 'conversation-1',
        request: {
          approvalId: 'approval_1',
          name: 'write',
          args: '{"path":"report.md"}',
          preview: 'Write report.md (12 lines)',
        },
        timeoutMs: 1000,
      });

      const response = await POST(actorRequest({
        conversationId: 'conversation-1',
        approvalId: 'approval_1',
        toolName: 'write',
        approved: true,
        preview: 'Write report.md (12 lines)',
      }));

      await expectStatus(response, 200);
      await expect(response.json()).resolves.toEqual({ ok: true });
      await expect(pending).resolves.toEqual({ approved: true });
      const queue = JSON.parse(await readFile(queuePath, 'utf8')) as { records: Record<string, { status: string }> };
      expect(Object.values(queue.records).map((record) => record.status)).toContain('approved');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('can resolve a durable pending approval even when no in-memory waiter exists', async () => {
    const { root, queuePath } = await useTempApprovalQueue();
    const actor = { userId: 'u1', tenantId: 't1' };
    const key = liveApprovalKey({ actor, conversationId: 'conversation-1', approvalId: 'approval_2' });
    try {
      await writeFile(queuePath, `${JSON.stringify({
        version: 1,
        records: {
          [key]: {
            key,
            actor,
            conversationId: 'conversation-1',
            request: {
              approvalId: 'approval_2',
              name: 'bash',
              args: '{"cmd":"npm test"}',
              preview: 'npm test',
            },
            status: 'pending',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        },
      }, null, 2)}\n`, 'utf8');

      const response = await POST(actorRequest({
        conversationId: 'conversation-1',
        approvalId: 'approval_2',
        toolName: 'bash',
        approved: false,
        preview: 'npm test',
      }));

      await expectStatus(response, 200);
      await expect(response.json()).resolves.toEqual({ ok: true });
      const queue = JSON.parse(await readFile(queuePath, 'utf8')) as { records: Record<string, { status: string }> };
      expect(queue.records[key]?.status).toBe('rejected');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function useTempApprovalQueue(): Promise<{ root: string; queuePath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'zleap-approval-queue-'));
  const queuePath = join(root, 'queue.json');
  await writeFile(queuePath, `${JSON.stringify({ version: 1, records: {} }, null, 2)}\n`, 'utf8');
  process.env.ZLEAP_APPROVAL_QUEUE_PATH = queuePath;
  await writeFile(join(dirname(queuePath), '.keep'), '', 'utf8');
  return { root, queuePath };
}

function actorRequest(body: unknown): Request {
  return new Request('http://localhost/api/chat/approval', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-zleap-user-id': 'u1',
      'x-zleap-actor-role': 'user',
      'x-zleap-tenant-id': 't1',
    },
    body: JSON.stringify(body),
  });
}

async function expectStatus(response: Response, status: number): Promise<void> {
  expect(response.status).toBe(status);
}
