import { describe, expect, it } from 'vitest';
import type { SendResult } from '@zleap/core';
import { BasePlatformAdapter } from '../src/platforms/base.js';
import type { OutboundTarget } from '../src/types.js';

class TestAdapter extends BasePlatformAdapter {
  readonly channel = 'test';
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async send(_target: OutboundTarget, _content: string): Promise<SendResult> {
    return { ok: true };
  }
  split(content: string, threshold: number): string[] {
    return this.splitMessage(content, threshold);
  }
}

describe('BasePlatformAdapter.splitMessage', () => {
  const adapter = new TestAdapter();

  it('keeps short content as a single chunk', () => {
    expect(adapter.split('hello world', 100)).toEqual(['hello world']);
  });

  it('splits long content into multiple chunks under threshold', () => {
    const content = 'x'.repeat(50) + '\n' + 'y'.repeat(50);
    const chunks = adapter.split(content, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(40);
    }
  });

  it('defers a code block to the next chunk instead of orphaning a fence', () => {
    // 30 chars of prose, then a self-contained code block (< threshold).
    const content = 'A'.repeat(30) + '```' + 'c'.repeat(30) + '```';
    const chunks = adapter.split(content, 40);
    for (const chunk of chunks) {
      const fences = chunk.match(/```/g)?.length ?? 0;
      expect(fences % 2).toBe(0);
    }
  });
});
