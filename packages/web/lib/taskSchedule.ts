export type TaskFrequency = 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'hourly' | 'every15' | 'custom';

export type TaskScheduleFields = {
  frequency: TaskFrequency;
  time: string;
  weekday: string;
  dayOfMonth: string;
};

export type TaskCronInput = TaskScheduleFields & {
  customCron: string;
};

export const WEEKDAY_VALUES = ['1', '2', '3', '4', '5', '6', '0'];

type Translate = (key: string, options?: Record<string, unknown>) => string;

const MINUTE_STEP_PATTERN = /^(?:\*|0)\/(\d+)$/;

export function buildTaskCron({ frequency, time, weekday, dayOfMonth, customCron }: TaskCronInput): string {
  if (frequency === 'custom') return normalizeCronInput(customCron);
  if (frequency === 'hourly') return '0 * * * *';
  if (frequency === 'every15') return '*/15 * * * *';
  const [hour, minute] = parseTaskTime(time);
  if (frequency === 'daily') return `${minute} ${hour} * * *`;
  if (frequency === 'weekdays') return `${minute} ${hour} * * 1-5`;
  if (frequency === 'weekly') return `${minute} ${hour} * * ${normalizeNumber(weekday, 0, 6, 1)}`;
  return `${minute} ${hour} ${normalizeNumber(dayOfMonth, 1, 31, 1)} * *`;
}

export function inferTaskSchedule(cron: string): TaskScheduleFields {
  const parts = splitCron(cron);
  if (parts.length !== 5) {
    return { frequency: 'custom', time: '09:00', weekday: '1', dayOfMonth: '1' };
  }
  const [minute = '0', hour = '9', day = '*', month = '*', weekday = '*'] = parts;
  const fixedTime = formatFixedTime(minute, hour);
  if (cron === '0 * * * *') return { frequency: 'hourly', time: '09:00', weekday: '1', dayOfMonth: '1' };
  if (cron === '*/15 * * * *') return { frequency: 'every15', time: '09:00', weekday: '1', dayOfMonth: '1' };
  if (fixedTime && day === '*' && month === '*' && weekday === '*') {
    return { frequency: 'daily', time: fixedTime, weekday: '1', dayOfMonth: '1' };
  }
  if (fixedTime && day === '*' && month === '*' && weekday === '1-5') {
    return { frequency: 'weekdays', time: fixedTime, weekday: '1', dayOfMonth: '1' };
  }
  if (fixedTime && day === '*' && month === '*' && WEEKDAY_VALUES.includes(weekday)) {
    return { frequency: 'weekly', time: fixedTime, weekday, dayOfMonth: '1' };
  }
  if (fixedTime && month === '*' && weekday === '*' && isNumberInRange(day, 1, 31)) {
    return { frequency: 'monthly', time: fixedTime, weekday: '1', dayOfMonth: day };
  }
  return { frequency: 'custom', time: fixedTime ?? '09:00', weekday: '1', dayOfMonth: '1' };
}

export function describeTaskCron(cron: string, t: Translate): string {
  if (cron === '0 * * * *') return t('task.frequencyShort.hourly');
  if (cron === '*/15 * * * *') return t('task.frequencyShort.every15');
  const [minute, hour, day, month, weekday] = splitCron(cron);
  if (!minute || !hour || !day || !month || !weekday) return cron;
  if (hour === '*' && day === '*' && month === '*' && weekday === '*') {
    const step = minuteStep(minute);
    if (step) {
      return step === 1
        ? t('task.frequencyShort.everyMinute', { defaultValue: '每分钟' })
        : t('task.frequencyShort.everyMinutes', { minutes: step, defaultValue: `每 ${step} 分钟` });
    }
  }
  const time = formatFixedTime(minute, hour);
  if (!time) return cron;
  if (day === '*' && month === '*' && weekday === '*') return t('task.frequencyShort.daily', { time });
  if (day === '*' && month === '*' && weekday === '1-5') return t('task.frequencyShort.weekdays', { time });
  if (day === '*' && month === '*' && WEEKDAY_VALUES.includes(weekday)) return t('task.frequencyShort.weekly', { time });
  if (month === '*' && weekday === '*' && isNumberInRange(day, 1, 31)) return t('task.frequencyShort.monthly', { day, time });
  return cron;
}

export function normalizeCronInput(value: string): string {
  const parts = splitCron(value);
  return parts.length === 5 ? parts.join(' ') : '';
}

export function parseTaskTime(value: string): [string, string] {
  const [rawHour = '9', rawMinute = '0'] = value.split(':');
  const hour = normalizeNumber(rawHour, 0, 23, 9);
  const minute = normalizeNumber(rawMinute, 0, 59, 0);
  return [hour, minute];
}

export function normalizeNumber(value: string, min: number, max: number, fallback: number): string {
  const next = Number.parseInt(value, 10);
  if (!Number.isFinite(next)) return String(fallback);
  return String(Math.min(max, Math.max(min, next)));
}

function splitCron(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean);
}

function formatFixedTime(minute: string, hour: string): string | undefined {
  if (!isNumberInRange(hour, 0, 23) || !isNumberInRange(minute, 0, 59)) {
    return undefined;
  }
  return `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
}

function minuteStep(value: string): number | undefined {
  const match = MINUTE_STEP_PATTERN.exec(value);
  if (!match) return undefined;
  const step = Number.parseInt(match[1]!, 10);
  return Number.isInteger(step) && step >= 1 && step <= 59 ? step : undefined;
}

function isNumberInRange(value: string, min: number, max: number): boolean {
  if (!/^\d+$/.test(value)) return false;
  const next = Number.parseInt(value, 10);
  return next >= min && next <= max;
}
