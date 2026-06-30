import { describe, expect, it } from 'vitest';
import {
  applyPeopleMemoryPolicy,
  projectListMemoryPayloadForModel,
  projectMemoriesForModel,
  type AgentNote,
  type MemoryRecordForModel,
  type RecordHit,
  type RecordRef,
} from '../src/index.js';

describe('memory model projection', () => {
  it('projects newest-first memory lines and caps the default list at 30', () => {
    const records: MemoryRecordForModel[] = Array.from({ length: 35 }, (_, index) => ({
      id: `record-${index}`,
      kind: 'task',
      text: `memory ${index}`,
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    }));

    const projected = projectMemoriesForModel(records);

    expect(projected).toHaveLength(30);
    expect(projected[0]).toBe('[task] memory 34');
    expect(projected[29]).toBe('[task] memory 5');
  });

  it('classifies person, task, and experience memories for model context', () => {
    expect(applyPeopleMemoryPolicy({ kind: 'impression', subject: 'agent' })).toEqual({
      kind: 'person',
      about: 'agent',
    });
    expect(applyPeopleMemoryPolicy({ kind: 'work' })).toEqual({ kind: 'task' });
    expect(applyPeopleMemoryPolicy({ kind: 'experience' })).toEqual({ kind: 'experience' });
  });

  it('builds listMemory payloads from notes and records using the shared policy', () => {
    const now = new Date('2026-01-02T03:04:05.000Z');
    const note: AgentNote = {
      id: 'note-1',
      kind: 'impression',
      agentId: 'agent-1',
      userId: 'user-1',
      subject: 'user',
      memory: 'User prefers concise answers.',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    const experience: RecordRef = {
      id: 'experience-1',
      kind: 'experience',
      memory: 'Retry transient APIs with bounded backoff.',
      keywords: [],
      createdAt: new Date('2026-01-02T03:05:05.000Z'),
    };
    const recent: RecordHit = {
      id: 'work-1',
      kind: 'work',
      memory: 'User asked to refactor memory projection.',
      keywords: [],
      messageIds: ['entry-1'],
      workKind: 'process',
      score: 1,
      createdAt: new Date('2026-01-02T03:06:05.000Z'),
    };

    const payload = projectListMemoryPayloadForModel({
      impressions: [note],
      experiences: [experience],
      recentItems: [recent],
    });

    expect(payload.impressions).toEqual([
      expect.objectContaining({ id: 'note-1', modelKind: 'person', about: 'user', memory: note.memory }),
    ]);
    expect(payload.experiences).toEqual([
      expect.objectContaining({ id: 'experience-1', kind: 'experience', modelKind: 'experience', memory: experience.memory }),
    ]);
    expect(payload.recentItems).toEqual([
      expect.objectContaining({
        id: 'work-1',
        kind: 'work',
        modelKind: 'task',
        workKind: 'process',
        evidenceIds: ['entry-1'],
        memory: recent.memory,
      }),
    ]);
  });
});
