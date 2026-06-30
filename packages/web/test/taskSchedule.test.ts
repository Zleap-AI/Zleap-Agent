import { describe, expect, it } from 'vitest';
import { describeTaskCron, inferTaskSchedule } from '../lib/taskSchedule';

const translations: Record<string, string> = {
  'task.frequencyShort.daily': '每天 {{time}}',
  'task.frequencyShort.weekdays': '工作日 {{time}}',
  'task.frequencyShort.weekly': '每周 {{time}}',
  'task.frequencyShort.monthly': '每月 {{day}} 日 {{time}}',
  'task.frequencyShort.hourly': '每小时',
  'task.frequencyShort.every15': '每 15 分钟',
  'task.frequencyShort.everyMinute': '每分钟',
  'task.frequencyShort.everyMinutes': '每 {{minutes}} 分钟',
};

function t(key: string, options: Record<string, unknown> = {}): string {
  return (translations[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options[name] ?? ''));
}

describe('task schedule helpers', () => {
  it('describes supported minute-step crons without treating them as daily times', () => {
    expect(describeTaskCron('*/3 * * * *', t)).toBe('每 3 分钟');
    expect(describeTaskCron('*/15 * * * *', t)).toBe('每 15 分钟');
  });

  it('keeps non-preset minute-step crons in custom mode for editing', () => {
    expect(inferTaskSchedule('*/3 * * * *')).toMatchObject({
      frequency: 'custom',
      time: '09:00',
    });
  });

  it('still infers fixed daily schedules', () => {
    expect(describeTaskCron('30 9 * * *', t)).toBe('每天 09:30');
    expect(inferTaskSchedule('30 9 * * *')).toMatchObject({
      frequency: 'daily',
      time: '09:30',
    });
  });
});
