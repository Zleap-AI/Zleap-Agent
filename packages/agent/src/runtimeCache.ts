import { randomUUID } from 'node:crypto';
import type {
  RuntimeCacheEntryRecord,
  RuntimeCacheKind,
  RuntimeCacheStore,
  ToolCacheCapability,
} from '@zleap/core';
import { truncate } from './util/text.js';

export type RuntimeCacheScope = {
  userId?: string;
  agentId?: string;
  threadId?: string;
  conversationId?: string;
  runId?: string;
};

export type RuntimeCacheCaptureInput = RuntimeCacheScope & {
  workId?: string;
  stepId?: string;
  workspaceId?: string;
  toolCallId?: string;
  toolId: string;
  toolInput: unknown;
  toolResult: unknown;
  capability?: ToolCacheCapability;
};

export type RuntimeCacheIndexEntry = {
  id: string;
  kind: RuntimeCacheKind;
  title: string;
  summary: string;
  sourceTool?: string;
  sourceWorkspace?: string;
  createdAt: string;
};

export type RuntimeCacheModelIndex = {
  entries: RuntimeCacheIndexEntry[];
};

export type RuntimeCacheReadResult =
  | { found: true; entry: RuntimeCacheEntryRecord }
  | { found: false; error: string };

type RuntimeCacheStoreProvider =
  | { runtimeCache?: RuntimeCacheStore }
  | null
  | undefined
  | (() => Promise<{ runtimeCache?: RuntimeCacheStore } | null | undefined>);

type RuntimeCacheDeps = {
  store?: RuntimeCacheStoreProvider;
  now?: () => Date;
};

export class RuntimeCacheManager {
  private readonly entries = new Map<string, RuntimeCacheEntryRecord>();

  constructor(private readonly deps: RuntimeCacheDeps = {}) {}

  async captureToolResult(input: RuntimeCacheCaptureInput): Promise<RuntimeCacheEntryRecord | null> {
    const capability = input.capability;
    if (!capability?.produces || capability.capture === 'none') {
      return null;
    }

    const content = stringifyCacheContent(input.toolResult, capability.maxContentChars ?? 120_000);
    if (!content.trim()) {
      return null;
    }

    const createdAt = this.deps.now?.() ?? new Date();
    const entry: RuntimeCacheEntryRecord = {
      id: createCacheId(),
      userId: input.userId,
      agentId: input.agentId,
      threadId: input.threadId,
      conversationId: input.conversationId,
      runId: input.runId,
      workId: input.workId,
      stepId: input.stepId,
      workspaceId: input.workspaceId,
      toolCallId: input.toolCallId,
      toolId: input.toolId,
      kind: input.capability?.kinds?.[0] ?? 'tool_result',
      title: inferCacheTitle(input.toolId, input.toolInput, input.toolResult),
      summary: inferCacheSummary(input.toolResult),
      content,
      metadata: { toolInput: compactToolInput(input.toolInput) },
      createdAt,
    };

    this.entries.set(entry.id, entry);
    await (await this.store())?.runtimeCache?.saveEntry(entry);
    return entry;
  }

  async listForModel(scope: RuntimeCacheScope, limit = 20): Promise<RuntimeCacheModelIndex> {
    const entries = await this.listEntries(scope, limit);
    return {
      entries: entries.map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        title: entry.title,
        summary: entry.summary,
        sourceTool: entry.toolId,
        sourceWorkspace: entry.workspaceId,
        createdAt: entry.createdAt.toISOString(),
      })),
    };
  }

  async readForModel(scope: RuntimeCacheScope, id: string): Promise<RuntimeCacheReadResult> {
    const normalizedId = id.trim();
    if (!normalizedId) {
      return { found: false, error: 'cache_id_required' };
    }
    const persisted = await (await this.store())?.runtimeCache?.getEntry({ ...scope, id: normalizedId });
    if (persisted) {
      return { found: true, entry: persisted };
    }
    const memory = this.entries.get(normalizedId);
    if (memory && scopeMatches(memory, scope)) {
      return { found: true, entry: memory };
    }
    return { found: false, error: 'cache_entry_not_found_or_not_visible' };
  }

  private async listEntries(scope: RuntimeCacheScope, limit: number): Promise<RuntimeCacheEntryRecord[]> {
    const persisted = await (await this.store())?.runtimeCache?.listEntries({ ...scope, limit }).catch(() => undefined);
    const memory = [...this.entries.values()].filter((entry) => scopeMatches(entry, scope));
    const byId = new Map<string, RuntimeCacheEntryRecord>();
    for (const entry of [...(persisted ?? []), ...memory]) {
      byId.set(entry.id, entry);
    }
    return [...byId.values()]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, Math.max(1, Math.min(limit, 100)));
  }

  private async store(): Promise<{ runtimeCache?: RuntimeCacheStore } | null | undefined> {
    return typeof this.deps.store === 'function' ? this.deps.store() : this.deps.store;
  }
}

function createCacheId(): string {
  return `cache_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

function stringifyCacheContent(value: unknown, maxChars: number): string {
  let raw: string;
  if (typeof value === 'string') {
    raw = value;
  } else {
    try {
      raw = JSON.stringify(value, null, 2);
    } catch {
      raw = String(value);
    }
  }
  return raw.length > maxChars ? `${raw.slice(0, maxChars)}\n[cache content truncated by runtime]` : raw;
}

function inferCacheTitle(toolId: string, toolInput: unknown, toolResult: unknown): string {
  const input = objectLike(toolInput);
  const result = objectLike(toolResult);
  const title =
    stringField(result, 'title') ??
    stringField(result, 'q') ??
    stringField(input, 'q') ??
    stringField(input, 'url') ??
    stringField(result, 'url');
  return truncate(`${toolId}: ${title ?? 'runtime cache'}`, 120);
}

function inferCacheSummary(value: unknown): string {
  if (typeof value === 'string') {
    return truncate(value.replace(/\s+/g, ' ').trim(), 500);
  }
  const object = objectLike(value);
  const summary =
    stringField(object, 'summary') ??
    stringField(object, 'description') ??
    stringField(object, 'content') ??
    stringifyCacheContent(value, 500);
  return truncate(summary.replace(/\s+/g, ' ').trim(), 500);
}

function compactToolInput(value: unknown): unknown {
  const raw = stringifyCacheContent(value, 2_000);
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function scopeMatches(entry: RuntimeCacheEntryRecord, scope: RuntimeCacheScope): boolean {
  return matchesOptional(entry.userId, scope.userId) &&
    matchesOptional(entry.agentId, scope.agentId) &&
    matchesOptional(entry.threadId, scope.threadId) &&
    matchesOptional(entry.conversationId, scope.conversationId) &&
    matchesOptional(entry.runId, scope.runId);
}

function matchesOptional(entryValue: string | undefined, scopeValue: string | undefined): boolean {
  return !scopeValue || entryValue === scopeValue;
}

function objectLike(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === 'string' && field.trim() ? field.trim() : undefined;
}
