export const DEFAULT_MODEL_MEMORY_LIMIT = 30;

export type MemoryKind = 'person' | 'task' | 'experience';

export type PeopleMemoryPolicyInput = {
  kind?: 'impression' | 'work' | 'experience' | 'event' | string;
  about?: 'user' | 'agent';
  subject?: 'user' | 'agent';
};

export type PeopleMemoryPolicy = {
  kind: MemoryKind;
  about?: 'user' | 'agent';
};

export function applyPeopleMemoryPolicy(input: PeopleMemoryPolicyInput): PeopleMemoryPolicy {
  if (input.kind === 'impression') {
    return { kind: 'person', about: input.subject ?? input.about ?? 'user' };
  }
  if (input.kind === 'experience') {
    return { kind: 'experience' };
  }
  return { kind: 'task' };
}
