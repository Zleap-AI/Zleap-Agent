import { DEFAULT_AVATAR_ID } from '@zleap/core';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AvatarRunInputError, normalizeAvatarRunInput } from '../src/runAssembly.js';

describe('normalizeAvatarRunInput', () => {
  it('fills deterministic avatar and permission defaults', () => {
    expect(
      normalizeAvatarRunInput({
        channel: 'web',
        actorId: 'user-1',
        spaceId: 'main',
        prompt: 'hello',
      }),
    ).toMatchObject({
      channel: 'web',
      avatarId: DEFAULT_AVATAR_ID,
      actorId: 'user-1',
      spaceId: 'main',
      prompt: 'hello',
      permissionMode: 'default',
    });
  });

  it('preserves explicit caller values after trimming text fields', () => {
    expect(
      normalizeAvatarRunInput({
        channel: 'gateway',
        avatarId: ' avatar-a ',
        actorId: ' user-1 ',
        spaceId: ' main ',
        conversationId: ' c-1 ',
        messageId: ' m-1 ',
        prompt: ' hello ',
        permissionMode: 'trusted',
      }),
    ).toEqual({
      channel: 'gateway',
      avatarId: 'avatar-a',
      actorId: 'user-1',
      spaceId: 'main',
      conversationId: 'c-1',
      messageId: 'm-1',
      prompt: 'hello',
      permissionMode: 'trusted',
    });
  });

  it('fails with a stable code when required run facts are empty', () => {
    expect(() =>
      normalizeAvatarRunInput({
        channel: 'web',
        actorId: ' ',
        spaceId: 'main',
        prompt: 'hello',
      }),
    ).toThrow(new AvatarRunInputError('actor_id_required'));
  });

  it('does not import cli implementation details', async () => {
    const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
    const files = await readdir(srcDir);
    const contents = await Promise.all(files.filter((file) => file.endsWith('.ts')).map((file) => readFile(join(srcDir, file), 'utf8')));

    expect(contents.join('\n')).not.toMatch(/@zleap\/cli/);
  });
});
