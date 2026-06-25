import { describe, expect, it } from 'vitest';
import { scheduleKeyForTask } from '../src/queue.js';

describe('scheduleKeyForTask', () => {
  it('keeps pg-boss-safe task ids unchanged', () => {
    expect(scheduleKeyForTask('task-1')).toBe('task-1');
    expect(scheduleKeyForTask('task/foo.bar_1')).toBe('task/foo.bar_1');
  });

  it('encodes ids with characters pg-boss rejects', () => {
    const key = scheduleKeyForTask('memory-dream:zleap-default:user-1');

    expect(key).toMatch(/^task\/[A-Za-z0-9_-]+$/);
    expect(key).not.toContain(':');
  });
});
