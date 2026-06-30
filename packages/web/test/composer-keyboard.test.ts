import { describe, expect, it } from 'vitest';
import { isComposerCompositionKeyEvent } from '../lib/composerKeyboard';

describe('isComposerCompositionKeyEvent', () => {
  it('ignores enter while an IME composition is active', () => {
    expect(isComposerCompositionKeyEvent(keyEvent('Enter'), { composing: true, commitGuard: false })).toBe(true);
  });

  it('ignores browser-native composing key events', () => {
    expect(isComposerCompositionKeyEvent(keyEvent('Enter', { isComposing: true }), { composing: false, commitGuard: false })).toBe(true);
  });

  it('ignores legacy IME keyCode 229 events', () => {
    expect(isComposerCompositionKeyEvent(keyEvent('Enter', { keyCode: 229 }), { composing: false, commitGuard: false })).toBe(true);
  });

  it('only uses the post-composition guard for Enter', () => {
    expect(isComposerCompositionKeyEvent(keyEvent('Enter'), { composing: false, commitGuard: true })).toBe(true);
    expect(isComposerCompositionKeyEvent(keyEvent('a'), { composing: false, commitGuard: true })).toBe(false);
  });

  it('does not block a normal Enter key press', () => {
    expect(isComposerCompositionKeyEvent(keyEvent('Enter'), { composing: false, commitGuard: false })).toBe(false);
  });
});

function keyEvent(
  key: string,
  nativeEvent: { isComposing?: boolean; keyCode?: number } = {},
) {
  return { key, nativeEvent };
}
