import { describe, expect, it } from 'vitest';
import { channelsBadge } from '../src/cli/channels.js';
import { stackHealthBadge } from '../src/cli/tuiServe.js';

describe('ambient status badges', () => {
  it('formats stack health labels', () => {
    expect(stackHealthBadge('ok')).toBe('栈✓');
    expect(stackHealthBadge('off')).toBe('栈✗');
    expect(stackHealthBadge('partial')).toBe('栈~');
  });

  it('formats IM connection counts', () => {
    expect(channelsBadge(null)).toBe('IM—');
    expect(channelsBadge({ connected: 0, total: 3 })).toBe('IM0/3');
    expect(channelsBadge({ connected: 2, total: 3 })).toBe('IM2/3✓');
  });
});
