import type { RuntimeErrorCauseSummary, RuntimeErrorSummary } from '@zleap/core';

const MAX_ERROR_MESSAGE_CHARS = 1_000;
const MAX_ERROR_CAUSE_DEPTH = 4;
const DETAIL_KEYS = ['errno', 'syscall', 'address', 'port', 'status', 'statusCode', 'type'] as const;

export function summarizeError(error: unknown): RuntimeErrorSummary | undefined {
  if (!error) {
    return undefined;
  }
  return summarizeErrorRecord(error, 'Unknown error');
}

function summarizeErrorRecord(error: unknown, fallback: string): RuntimeErrorSummary {
  if (!error || typeof error !== 'object') {
    return { message: truncateErrorText(String(error)) };
  }

  const record = error as { code?: unknown; message?: unknown; error?: unknown; cause?: unknown };
  const providerError = record.error && typeof record.error === 'object'
    ? record.error as { code?: unknown; message?: unknown; cause?: unknown }
    : undefined;
  const source = providerError && typeof providerError.message === 'string' && providerError.message.trim()
    ? providerError
    : record;
  const message = typeof source.message === 'string' && source.message.trim()
    ? source.message
    : fallback;
  const cause = summarizeCause(source.cause, 0);

  return {
    ...(typeof source.code === 'string' ? { code: source.code } : {}),
    message: truncateErrorText(message),
    ...(cause ? { cause } : {}),
  };
}

function summarizeCause(cause: unknown, depth: number): RuntimeErrorCauseSummary | undefined {
  if (!cause || depth >= MAX_ERROR_CAUSE_DEPTH) {
    return undefined;
  }
  if (typeof cause !== 'object') {
    return { message: truncateErrorText(String(cause)) };
  }

  const record = cause as Record<string, unknown>;
  const message = typeof record.message === 'string' && record.message.trim()
    ? record.message
    : cause instanceof Error
      ? cause.message
      : cause.constructor?.name ?? 'Unknown cause';
  const details = causeDetails(record);
  const nested = summarizeCause(record.cause, depth + 1);

  return {
    ...(typeof record.name === 'string' && record.name.trim() ? { name: truncateErrorText(record.name, 120) } : {}),
    ...(typeof record.code === 'string' && record.code.trim() ? { code: truncateErrorText(record.code, 120) } : {}),
    message: truncateErrorText(message),
    ...(Object.keys(details).length > 0 ? { details } : {}),
    ...(nested ? { cause: nested } : {}),
  };
}

function causeDetails(record: Record<string, unknown>): Record<string, string | number | boolean> {
  const details: Record<string, string | number | boolean> = {};
  for (const key of DETAIL_KEYS) {
    const value = record[key];
    if (typeof value === 'string') {
      if (value.trim()) {
        details[key] = truncateErrorText(value, 240);
      }
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      details[key] = value;
    }
  }
  return details;
}

function truncateErrorText(value: string, max = MAX_ERROR_MESSAGE_CHARS): string {
  const cleaned = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '�');
  return cleaned.length > max ? `${cleaned.slice(0, max - 3)}...` : cleaned;
}
