import { describe, expect, it } from 'vitest';
import { normalizeAssistantDisplayText, sanitizeDisplayText } from '../lib/messageText';

describe('message text normalization', () => {
  it('decodes escaped newlines when a markdown report was stored as one JSON-style line', () => {
    const text = 'Report\\n## Summary\\n- One\\n- Two\\n\\nConclusion';

    expect(normalizeAssistantDisplayText(text)).toBe('Report\n## Summary\n- One\n- Two\n\nConclusion');
  });

  it('leaves small inline escape examples untouched', () => {
    expect(normalizeAssistantDisplayText('Use `\\n` in a JavaScript string.')).toBe('Use `\\n` in a JavaScript string.');
  });

  it('drops mojibake lines while preserving readable text', () => {
    const noisy = '\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD \uFFFD\uFFFDKK 1 F\uFFFD\uFFFD\n好的，重新生成脚本。';

    expect(sanitizeDisplayText(noisy)).toBe('好的，重新生成脚本。');
    expect(sanitizeDisplayText('\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD \uFFFD\uFFFDKK 1 F\uFFFD\uFFFD', 'Workspace failed.')).toBe(
      'Workspace failed.',
    );
  });
});
