import { jsonrepair } from 'jsonrepair';

export type ToolArgumentShapeIssue =
  | { kind: 'missing'; field: string }
  | { kind: 'type'; field: string; expected: string; actual: string };

export function recoverToolArgumentShape(input: unknown, schema: unknown): unknown {
  const parsed = typeof input === 'string' ? parseJsonArgument(input) : undefined;
  const value = canonicalizeSchemaKeys(parsed ?? input, schema);
  return coerceShallowPrimitives(value, schema);
}

export function looksLikeMalformedJsonArguments(input: unknown): boolean {
  if (typeof input !== 'string') {
    return false;
  }
  const candidate = jsonArgumentCandidate(input);
  if (!(candidate.startsWith('{') || candidate.startsWith('['))) {
    return false;
  }
  return parseJsonArgument(input) === undefined;
}

export function validateToolArgumentShape(input: unknown, schema: unknown): ToolArgumentShapeIssue[] {
  const spec = objectSchema(schema);
  if (!spec) {
    return [];
  }
  if (!isRecord(input)) {
    return spec.required.map((field) => ({ kind: 'missing', field }));
  }

  const issues: ToolArgumentShapeIssue[] = [];
  for (const field of spec.required) {
    if (!(field in input) || input[field] === undefined || input[field] === null) {
      issues.push({ kind: 'missing', field });
    }
  }

  for (const [field, propertySchema] of Object.entries(spec.properties)) {
    if (!(field in input) || input[field] === undefined || input[field] === null) {
      continue;
    }
    const expected = primitiveType(propertySchema);
    if (!expected) {
      continue;
    }
    const actual = typeof input[field];
    if (expected === 'integer') {
      if (actual !== 'number' || !Number.isInteger(input[field])) {
        issues.push({ kind: 'type', field, expected, actual: describeValue(input[field]) });
      }
      continue;
    }
    if (actual !== expected) {
      issues.push({ kind: 'type', field, expected, actual: describeValue(input[field]) });
    }
  }
  return issues;
}

export function formatToolArgumentShapeIssues(toolId: string, issues: readonly ToolArgumentShapeIssue[]): string {
  const lines = issues.map((issue) => {
    if (issue.kind === 'missing') {
      return `- ${issue.field}: missing required argument.`;
    }
    return `- ${issue.field}: expected ${issue.expected}, got ${issue.actual}.`;
  });
  return [
    `Tool "${toolId}" arguments are incomplete or invalid.`,
    ...lines,
    `Call ${toolId} again with one complete JSON object matching its schema.`,
  ].join('\n');
}

export function formatMalformedJsonArguments(toolId: string, context: { finishReason?: string } = {}): string {
  const lines = [
    `Tool "${toolId}" was rejected: arguments JSON is incomplete or malformed.`,
    'The runtime received tool arguments that did not parse into one complete JSON object.',
    'Raw provider argument metadata is available in the raw trace for debugging.',
  ];
  if (context.finishReason && ['length', 'max_tokens'].includes(context.finishReason)) {
    lines.push(
      `The provider stopped with finishReason="${context.finishReason}", so these tool arguments were likely truncated by the model output limit.`,
    );
  }
  lines.push(
    `Call ${toolId} again with one complete JSON object matching the tool schema.`,
    'Do not reuse the truncated arguments. Include every required field again, with the full string value.',
  );
  if (toolId === 'write' || toolId === 'bash') {
    lines.push(
      'If the payload is large file content or a large heredoc command, do not retry the same large payload. Use write for a small initial file and append the remaining content in small ordered chunks.',
    );
  }
  return lines.join('\n');
}

function parseJsonArgument(input: string): unknown | undefined {
  const candidate = jsonArgumentCandidate(input);
  for (const raw of jsonParseCandidates(candidate)) {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      /* try the next cheap repair */
    }
  }
  if (endsInsideString(candidate)) {
    return undefined;
  }
  try {
    return JSON.parse(jsonrepair(candidate)) as unknown;
  } catch {
    /* not safely repairable */
  }
  return undefined;
}

function jsonParseCandidates(candidate: string): string[] {
  const candidates = new Set<string>();
  const add = (raw: string | undefined) => {
    if (raw === undefined) {
      return;
    }
    candidates.add(raw);
    candidates.add(raw.replace(/,\s*([}\]])/g, '$1'));
  };
  add(candidate);
  add(appendMissingJsonClosers(candidate));
  return [...candidates];
}

function appendMissingJsonClosers(input: string): string | undefined {
  const trimmed = input.trimEnd();
  if (!trimmed) {
    return undefined;
  }
  const closers: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of trimmed) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      closers.push('}');
      continue;
    }
    if (char === '[') {
      closers.push(']');
      continue;
    }
    if (char === '}' || char === ']') {
      if (closers.pop() !== char) {
        return undefined;
      }
    }
  }
  if (inString || closers.length === 0) {
    return undefined;
  }
  if (/[:,[{\s]$/.test(trimmed)) {
    return undefined;
  }
  return `${trimmed}${closers.reverse().join('')}`;
}

function endsInsideString(input: string): boolean {
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (const char of input.trimEnd()) {
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    }
  }
  return quote !== undefined;
}

function jsonArgumentCandidate(input: string): string {
  const unfenced = input.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const objectStart = unfenced.indexOf('{');
  const arrayStart = unfenced.indexOf('[');
  const starts = [objectStart, arrayStart].filter((index) => index >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  if (start < 0) {
    return unfenced;
  }
  const end = jsonLikeValueEnd(unfenced, start);
  return end === undefined ? unfenced.slice(start) : unfenced.slice(start, end + 1);
}

function jsonLikeValueEnd(input: string, start: number): number | undefined {
  const opener = input[start];
  const firstCloser = opener === '{' ? '}' : opener === '[' ? ']' : undefined;
  if (!firstCloser) {
    return undefined;
  }
  const closers = [firstCloser];
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let index = start + 1; index < input.length; index += 1) {
    const char = input[index]!;
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '{') {
      closers.push('}');
      continue;
    }
    if (char === '[') {
      closers.push(']');
      continue;
    }
    if (char !== '}' && char !== ']') {
      continue;
    }
    if (closers.pop() !== char) {
      return undefined;
    }
    if (closers.length === 0) {
      return index;
    }
  }
  return undefined;
}

function coerceShallowPrimitives(input: unknown, schema: unknown): unknown {
  const spec = objectSchema(schema);
  if (!spec || !isRecord(input)) {
    return input;
  }
  let changed = false;
  const next = { ...input };
  for (const [field, propertySchema] of Object.entries(spec.properties)) {
    if (typeof next[field] !== 'string') {
      continue;
    }
    const expected = primitiveType(propertySchema);
    const coerced = coerceStringPrimitive(next[field], expected);
    if (coerced !== undefined) {
      next[field] = coerced;
      changed = true;
    }
  }
  return changed ? next : input;
}

function canonicalizeSchemaKeys(input: unknown, schema: unknown): unknown {
  const spec = objectSchema(schema);
  if (!spec || !isRecord(input)) {
    return input;
  }

  const canonicalByComparable = new Map<string, string | undefined>();
  for (const field of Object.keys(spec.properties)) {
    const comparable = comparableArgumentKey(field);
    if (!comparable) {
      continue;
    }
    canonicalByComparable.set(comparable, canonicalByComparable.has(comparable) ? undefined : field);
  }

  let changed = false;
  const next = { ...input };
  for (const [key, value] of Object.entries(input)) {
    const comparable = comparableArgumentKey(key);
    const canonical = comparable ? canonicalByComparable.get(comparable) : undefined;
    if (!canonical) {
      continue;
    }
    if (key !== canonical) {
      delete next[key];
      changed = true;
    }
    if (!(canonical in next)) {
      next[canonical] = value;
      changed = true;
    }
  }
  return changed ? next : input;
}

function comparableArgumentKey(key: string): string {
  return key
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
    .replace(/[_-]/g, '')
    .toLowerCase();
}

function coerceStringPrimitive(value: string, expected: string | undefined): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (expected === 'boolean') {
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    return undefined;
  }
  if (expected === 'integer') {
    if (!/^-?\d+$/.test(trimmed)) return undefined;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  if (expected === 'number') {
    if (!/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed)) return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function objectSchema(schema: unknown): { properties: Record<string, unknown>; required: string[] } | undefined {
  if (!isRecord(schema) || schema.type !== 'object') {
    return undefined;
  }
  return {
    properties: isRecord(schema.properties) ? schema.properties : {},
    required: Array.isArray(schema.required) ? schema.required.filter((field): field is string => typeof field === 'string') : [],
  };
}

function primitiveType(schema: unknown): string | undefined {
  if (!isRecord(schema) || 'enum' in schema || 'oneOf' in schema || 'anyOf' in schema || 'allOf' in schema) {
    return undefined;
  }
  return ['string', 'number', 'integer', 'boolean'].includes(String(schema.type)) ? String(schema.type) : undefined;
}

function describeValue(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return value === null ? 'null' : typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
