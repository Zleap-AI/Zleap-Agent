import type { AgentNote } from './notes.js';
import { applyPeopleMemoryPolicy, DEFAULT_MODEL_MEMORY_LIMIT, type MemoryKind } from './peoplePolicy.js';
import type { RecordHit, RecordRef } from './record-port.js';

export type MemoryRecordForModel = {
  id: string;
  kind: MemoryKind;
  sourceKind?: 'impression' | 'work' | 'experience';
  text: string;
  updatedAt: string;
  createdAt?: string;
  about?: 'user' | 'agent';
  evidenceIds?: readonly string[];
  workKind?: RecordRef['workKind'];
  score?: number;
};

export type ListMemoryModelPayload = {
  impressions: Array<Record<string, unknown>>;
  experiences: Array<Record<string, unknown>>;
  recentItems: Array<Record<string, unknown>>;
};

export type MemoryBlocksForModel = {
  impressions: readonly AgentNote[];
  experiences: readonly RecordRef[];
  recentItems: ReadonlyArray<RecordRef | RecordHit>;
};

export function projectMemoriesForModel(
  records: readonly MemoryRecordForModel[],
  limit = DEFAULT_MODEL_MEMORY_LIMIT,
): string[] {
  return selectMemoriesForModel(records, limit).map((record) => `[${record.kind}] ${record.text}`);
}

export function projectListMemoryPayloadForModel(
  blocks: MemoryBlocksForModel,
  limit = DEFAULT_MODEL_MEMORY_LIMIT,
): ListMemoryModelPayload {
  return {
    impressions: selectMemoriesForModel(blocks.impressions.map(noteToMemoryRecordForModel), limit)
      .map((record) => ({
        id: record.id,
        modelKind: record.kind,
        memory: record.text,
        about: record.about ?? 'user',
        createdAt: record.createdAt ?? record.updatedAt,
        updatedAt: record.updatedAt,
      })),
    experiences: selectMemoriesForModel(blocks.experiences.map((record) =>
      recordRefToMemoryRecordForModel(record, 'experience')), limit)
      .map(recordToPayload),
    recentItems: selectMemoriesForModel(blocks.recentItems.map((record) =>
      recordRefToMemoryRecordForModel(record, 'work')), limit)
      .map(recordToPayload),
  };
}

export function noteToMemoryRecordForModel(note: AgentNote): MemoryRecordForModel {
  const policy = applyPeopleMemoryPolicy({ kind: note.kind, subject: note.subject ?? 'user' });
  return {
    id: note.id,
    kind: policy.kind,
    sourceKind: note.kind,
    text: note.memory,
    about: policy.about,
    createdAt: note.createdAt.toISOString(),
    updatedAt: (note.updatedAt ?? note.createdAt).toISOString(),
  };
}

export function recordRefToMemoryRecordForModel(
  record: RecordRef | RecordHit,
  fallbackKind: 'work' | 'experience' = 'work',
): MemoryRecordForModel {
  const recordKind = record.kind ?? fallbackKind;
  const policy = applyPeopleMemoryPolicy({ kind: recordKind });
  return {
    id: record.id,
    kind: policy.kind,
    sourceKind: recordKind,
    text: record.memory,
    evidenceIds: record.messageIds ?? [],
    workKind: record.workKind,
    score: 'score' in record && typeof record.score === 'number' ? record.score : undefined,
    createdAt: record.createdAt.toISOString(),
    updatedAt: (record.updatedAt ?? record.createdAt).toISOString(),
  };
}

function selectMemoriesForModel(
  records: readonly MemoryRecordForModel[],
  limit: number,
): MemoryRecordForModel[] {
  const safeLimit = Math.max(0, Math.min(limit, DEFAULT_MODEL_MEMORY_LIMIT));
  return records
    .filter((record) => record.text.trim().length > 0)
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
    .slice(0, safeLimit);
}

function recordToPayload(record: MemoryRecordForModel): Record<string, unknown> {
  return {
    id: record.id,
    kind: record.sourceKind ?? record.kind,
    modelKind: record.kind,
    memory: record.text,
    ...(record.workKind ? { workKind: record.workKind } : {}),
    ...(record.evidenceIds?.length ? { evidenceIds: record.evidenceIds } : {}),
    ...(record.score !== undefined ? { score: record.score } : {}),
    createdAt: record.createdAt ?? record.updatedAt,
    updatedAt: record.updatedAt,
  };
}
