import { describe, expect, it } from 'vitest';
import { isAnimated, mascotFace, mascotFrameMs, MASCOT_DISPLAY_WIDTH, resolveMascotMood } from '../src/ui/mascotMood.js';

describe('mascot', () => {
  it('resolves mood by priority: tool > thinking > wizard > palette > idle', () => {
    expect(resolveMascotMood({ running: true, tool: true, wizard: true, paletteOpen: true })).toBe('tool');
    expect(resolveMascotMood({ running: true, tool: false, wizard: true, paletteOpen: true })).toBe('thinking');
    expect(resolveMascotMood({ running: false, tool: false, wizard: true, paletteOpen: true })).toBe('wizard');
    expect(resolveMascotMood({ running: false, tool: false, wizard: false, paletteOpen: true })).toBe('palette');
    expect(resolveMascotMood({ running: false, tool: false, wizard: false, paletteOpen: false })).toBe('idle');
  });

  it('returns compact faces within display width', () => {
    for (const mood of ['idle', 'palette', 'wizard', 'thinking', 'tool', 'done', 'error'] as const) {
      const face = mascotFace(mood);
      expect(face.length).toBeGreaterThan(0);
      expect(face.length).toBeLessThanOrEqual(MASCOT_DISPLAY_WIDTH);
    }
    // Animated moods cycle through richer state-specific frames.
    expect(isAnimated('idle')).toBe(true);
    expect(mascotFace('thinking', 1)).toBe('(-_-)');
    expect(mascotFace('tool', 1)).toBe('(>o<)');
    expect(mascotFace('tool', 2)).toBe('(^o^)');
    expect(mascotFrameMs('tool')).toBeLessThan(mascotFrameMs('idle'));
  });
});
