import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyTextToClipboard } from '../lib/clipboard';

describe('copyTextToClipboard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back when Clipboard API write permission is denied', async () => {
    const textarea = makeTextarea();
    const appendChild = vi.fn();
    const execCommand = vi.fn(() => true);
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: vi.fn(async () => {
          throw new DOMException('Write permission denied.', 'NotAllowedError');
        }),
      },
    });
    vi.stubGlobal('document', {
      body: { appendChild },
      createElement: vi.fn(() => textarea),
      execCommand,
    });

    await expect(copyTextToClipboard('hello')).resolves.toBe(true);
    expect(appendChild).toHaveBeenCalledWith(textarea);
    expect(textarea.select).toHaveBeenCalled();
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(textarea.remove).toHaveBeenCalled();
  });

  it('returns false instead of throwing when no copy path is available', async () => {
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: vi.fn(async () => {
          throw new DOMException('Write permission denied.', 'NotAllowedError');
        }),
      },
    });
    vi.stubGlobal('document', undefined);

    await expect(copyTextToClipboard('hello')).resolves.toBe(false);
  });
});

function makeTextarea() {
  return {
    value: '',
    style: {},
    setAttribute: vi.fn(),
    focus: vi.fn(),
    select: vi.fn(),
    remove: vi.fn(),
  };
}
