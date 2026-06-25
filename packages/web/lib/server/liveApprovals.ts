import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ActorContext } from '@zleap/core';

export type LiveApprovalRequest = {
  approvalId: string;
  name: string;
  args: string;
  preview?: string;
};

export type LiveApprovalDecision = {
  approved: boolean;
};

export type ResolveLiveApprovalInput = {
  actor: Pick<ActorContext, 'userId' | 'tenantId'>;
  conversationId?: string;
  approvalId: string;
  toolName: string;
  approved: boolean;
  preview?: string;
};

type PendingApproval = {
  request: LiveApprovalRequest;
  resolve: (decision: LiveApprovalDecision | undefined) => void;
  timer: ReturnType<typeof setTimeout>;
  abort?: () => void;
};

type ApprovalRecordStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'aborted';

type ApprovalQueueRecord = {
  key: string;
  actor: { userId: string; tenantId?: string };
  conversationId?: string;
  request: LiveApprovalRequest;
  status: ApprovalRecordStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};

type ApprovalQueueFile = {
  version: 1;
  records: Record<string, ApprovalQueueRecord>;
};

const DEFAULT_APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;
const pendingApprovals = new Map<string, PendingApproval>();
let writeQueue = Promise.resolve();

export function approvalTimeoutMs(): number {
  const raw = process.env.ZLEAP_APPROVAL_TIMEOUT_MS;
  if (!raw) {
    return DEFAULT_APPROVAL_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_APPROVAL_TIMEOUT_MS;
}

export async function clearApprovalQueue(): Promise<void> {
  for (const key of [...pendingApprovals.keys()]) {
    clearPending(key);
  }
  await rm(approvalQueuePath(), { force: true });
}

export function liveApprovalKey(input: {
  actor: Pick<ActorContext, 'userId' | 'tenantId'>;
  conversationId?: string;
  approvalId: string;
}): string {
  return [input.actor.tenantId ?? '', input.actor.userId, input.conversationId ?? '', input.approvalId].join('\0');
}

export function waitForLiveApproval(input: {
  actor: Pick<ActorContext, 'userId' | 'tenantId'>;
  conversationId?: string;
  request: LiveApprovalRequest;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<LiveApprovalDecision | undefined> {
  const key = liveApprovalKey({ actor: input.actor, conversationId: input.conversationId, approvalId: input.request.approvalId });
  clearPending(key);
  const timeoutMs = input.timeoutMs ?? approvalTimeoutMs();
  persistApprovalRecord({
    key,
    actor: { userId: input.actor.userId, ...(input.actor.tenantId ? { tenantId: input.actor.tenantId } : {}) },
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    request: input.request,
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
  });

  return new Promise((resolve) => {
    const finish = (decision: LiveApprovalDecision | undefined, status: ApprovalRecordStatus = 'expired') => {
      const current = pendingApprovals.get(key);
      if (!current) {
        resolve(decision);
        return;
      }
      pendingApprovals.delete(key);
      clearTimeout(current.timer);
      if (current.abort && input.signal) {
        input.signal.removeEventListener('abort', current.abort);
      }
      if (!decision) {
        updateApprovalRecordStatus(key, status);
      }
      resolve(decision);
    };
    const timer = setTimeout(() => finish(undefined, 'expired'), timeoutMs);
    const abort = input.signal
      ? () => {
          finish(undefined, 'aborted');
        }
      : undefined;
    if (abort) {
      input.signal!.addEventListener('abort', abort, { once: true });
    }
    pendingApprovals.set(key, { request: input.request, resolve: finish, timer, abort });
  });
}

export async function resolveLiveApproval(input: ResolveLiveApprovalInput): Promise<'resolved' | 'not_found' | 'mismatch'> {
  const key = liveApprovalKey({ actor: input.actor, conversationId: input.conversationId, approvalId: input.approvalId });
  const pending = pendingApprovals.get(key);
  const decisionStatus: ApprovalRecordStatus = input.approved ? 'approved' : 'rejected';
  if (!pending) {
    const queue = await readApprovalQueue();
    const record = queue.records[key];
    if (!record || record.status !== 'pending' || new Date(record.expiresAt).getTime() < Date.now()) {
      if (record?.status === 'pending') {
        await updateApprovalRecordStatus(key, 'expired');
      }
      return 'not_found';
    }
    if (!approvalDecisionMatchesRecord(record.request, input)) {
      return 'mismatch';
    }
    await updateApprovalRecordStatus(key, decisionStatus);
    return 'resolved';
  }
  if (!approvalDecisionMatchesRecord(pending.request, input)) {
    return 'mismatch';
  }
  await updateApprovalRecordStatus(key, decisionStatus);
  pending.resolve({ approved: input.approved });
  return 'resolved';
}

function clearPending(key: string): void {
  const existing = pendingApprovals.get(key);
  if (!existing) {
    return;
  }
  pendingApprovals.delete(key);
  clearTimeout(existing.timer);
  existing.resolve(undefined);
}

function approvalDecisionMatchesRecord(request: LiveApprovalRequest, input: ResolveLiveApprovalInput): boolean {
  if (request.name !== input.toolName) {
    return false;
  }
  if (request.preview !== undefined || input.preview !== undefined) {
    return request.preview === input.preview;
  }
  return true;
}

function approvalQueuePath(): string {
  return process.env.ZLEAP_APPROVAL_QUEUE_PATH ?? join(homedir(), '.zleap', 'approval-queue.json');
}

async function readApprovalQueue(): Promise<ApprovalQueueFile> {
  try {
    const parsed = JSON.parse(await readFile(approvalQueuePath(), 'utf8')) as Partial<ApprovalQueueFile>;
    return {
      version: 1,
      records: parsed.records && typeof parsed.records === 'object' ? parsed.records as ApprovalQueueFile['records'] : {},
    };
  } catch {
    return { version: 1, records: {} };
  }
}

function persistApprovalRecord(record: ApprovalQueueRecord): void {
  writeQueue = writeQueue
    .then(async () => {
      const queue = await readApprovalQueue();
      queue.records[record.key] = record;
      await writeApprovalQueue(queue);
    })
    .catch(() => undefined);
}

async function updateApprovalRecordStatus(key: string, status: ApprovalRecordStatus): Promise<void> {
  writeQueue = writeQueue.then(async () => {
    const queue = await readApprovalQueue();
    const record = queue.records[key];
    if (!record) {
      return;
    }
    queue.records[key] = { ...record, status, updatedAt: new Date().toISOString() };
    await writeApprovalQueue(queue);
  });
  await writeQueue.catch(() => undefined);
}

async function writeApprovalQueue(queue: ApprovalQueueFile): Promise<void> {
  const file = approvalQueuePath();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(queue, null, 2)}\n`, 'utf8');
}
