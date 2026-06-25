import { describe, expect, it } from 'vitest';
import { buildInboundRunInput } from '../src/inboundRun.js';

describe('buildInboundRunInput', () => {
  it('uses the platform event id as the run message id', () => {
    expect(
      buildInboundRunInput({
        actorId: 'u1',
        eventId: 'evt-1',
        prompt: 'hello',
      }),
    ).toMatchObject({
      channel: 'gateway',
      actorId: 'u1',
      spaceId: 'main',
      messageId: 'evt-1',
      prompt: 'hello',
    });
  });

  it('keeps gateway runs on the default permission mode', () => {
    expect(
      buildInboundRunInput({
        actorId: 'u1',
        eventId: 'evt-1',
        prompt: 'hello',
      }).permissionMode,
    ).toBe('default');
  });
});
