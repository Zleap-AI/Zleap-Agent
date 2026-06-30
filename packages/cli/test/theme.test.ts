import { describe, expect, it } from 'vitest';
import { formatContextPercent, renderProgressBar } from '../src/ui/theme.js';

describe('theme progress bar', () => {
  it('renders filled and empty segments', () => {
    expect(renderProgressBar(0.5, 8)).toEqual({ filled: '▓▓▓▓', empty: '░░░░' });
    expect(formatContextPercent(0.328)).toBe('33%');
  });
});
