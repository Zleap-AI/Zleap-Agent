const IANA_TIMEZONE_PATTERN = /^[A-Za-z0-9_+\-/]+$/;

export function normalizeCron(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 5) {
    throw new Error('cron_must_have_5_fields');
  }
  return parts.join(' ');
}

export function normalizeTimezone(value: string | undefined, fallback = 'UTC'): string {
  const timezone = value?.trim() || fallback;
  if (!IANA_TIMEZONE_PATTERN.test(timezone)) {
    throw new Error('invalid_timezone');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error('invalid_timezone');
  }
  return timezone;
}

export function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}
