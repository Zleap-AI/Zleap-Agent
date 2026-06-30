import {
  LEGACY_SESSION_SPACE_ID,
  MemoryOrchestrator,
  applyPeopleMemoryPolicy,
  type ActorContext,
  type AgentNote,
  type MemoryScopeContext,
  type RecordRef,
} from '@zleap/core';
import { createRecordMemoryPort, type ZleapStore } from '@zleap/store';

/** Build the dual-line orchestrator over a store (A 线 notes + B 线 records). */
export function memoryOrchestratorFromStore(store: ZleapStore): MemoryOrchestrator {
  const records = createRecordMemoryPort({
    core: store.core,
    embed: (texts) => Promise.all(texts.map((text) => store.embedText(text))),
    embedQuery: (text) => store.embedText(text),
  });
  return new MemoryOrchestrator({ notes: store.notes, records });
}

/** Management scope: agent + actor, anchored on the runtime main/session space. */
export function mainMemoryScope(agentId: string, actor?: Pick<ActorContext, 'userId' | 'role'>): MemoryScopeContext {
  return {
    agentId,
    userId: actor?.userId,
    actorRole: actor?.role,
    spaceId: LEGACY_SESSION_SPACE_ID,
  };
}

export function serializeNote(note: AgentNote) {
  const policy = applyPeopleMemoryPolicy({ kind: note.kind, subject: note.subject ?? 'user' });
  return {
    id: note.id,
    kind: note.kind,
    modelKind: policy.kind,
    memory: note.memory,
    tags: [] as string[],
    agentId: note.agentId,
    userId: note.userId,
    spaceId: note.spaceId,
    subject: note.kind === 'impression' ? (note.subject ?? 'user') : undefined,
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString(),
  };
}

type SerializableRecord = RecordRef & {
  messageIds?: string[];
  entities?: Array<{ type: string; name: string; role?: string }>;
};

export function serializeRecord(record: SerializableRecord, scope?: Pick<MemoryScopeContext, 'agentId' | 'userId' | 'spaceId'>) {
  const kind = record.kind === 'experience' ? 'experience' : 'event';
  const policy = applyPeopleMemoryPolicy({ kind: record.kind === 'experience' ? 'experience' : 'work' });
  return {
    id: record.id,
    kind,
    modelKind: policy.kind,
    memory: record.memory,
    tags: record.keywords,
    agentId: scope?.agentId,
    userId: kind === 'experience' ? undefined : scope?.userId,
    spaceId: kind === 'experience' ? undefined : scope?.spaceId,
    source: kind === 'experience' ? 'core experience' : 'core event',
    workKind: kind === 'event' ? record.workKind : undefined,
    messageIds: record.messageIds ?? [],
    entities: record.entities ?? [],
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.createdAt.toISOString(),
  };
}
