import { describe, expect, it } from 'vitest';
import { looksLikeMalformedJsonArguments, recoverToolArgumentShape } from '../src/toolRecovery.js';

describe('tool argument recovery', () => {
  it('canonicalizes schema keys that contain invisible or formatting noise', () => {
    const input = {
      'path\u200B': 'README.md',
      ' Limit ': '5',
      reason: 'inspect file',
    };
    const schema = {
      type: 'object',
      properties: {
        path: { type: 'string' },
        limit: { type: 'number' },
        reason: { type: 'string' },
      },
      required: ['path', 'reason'],
      additionalProperties: false,
    };

    const recovered = recoverToolArgumentShape(input, schema);

    expect(recovered).toEqual({
      path: 'README.md',
      limit: 5,
      reason: 'inspect file',
    });
  });

  it('repairs JSON arguments that only miss final structural closers', () => {
    const input = '{"path":"notes.md","content":"hello","reason":"write note"';
    const schema = {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['path', 'content', 'reason'],
      additionalProperties: false,
    };

    expect(looksLikeMalformedJsonArguments(input)).toBe(false);
    expect(recoverToolArgumentShape(input, schema)).toEqual({
      path: 'notes.md',
      content: 'hello',
      reason: 'write note',
    });
  });

  it('does not treat braces inside string values as JSON argument closers', () => {
    const content = 'FONT_SIZES = {"h1": 20, "body": 10}\nclass RF(RF): pass\n';
    const input = JSON.stringify({ content }).slice(0, -1);
    const schema = {
      type: 'object',
      properties: {
        content: { type: 'string' },
      },
      required: ['content'],
      additionalProperties: false,
    };

    expect(looksLikeMalformedJsonArguments(input)).toBe(false);
    expect(recoverToolArgumentShape(input, schema)).toEqual({ content });
  });

  it('repairs common LLM JSON syntax mistakes before validating tool arguments', () => {
    const input = "```json\n{path: 'notes.md' content: 'hello', reason: 'write note',}\n```";
    const schema = {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['path', 'content', 'reason'],
      additionalProperties: false,
    };

    expect(looksLikeMalformedJsonArguments(input)).toBe(false);
    expect(recoverToolArgumentShape(input, schema)).toEqual({
      path: 'notes.md',
      content: 'hello',
      reason: 'write note',
    });
  });

  it('does not repair JSON arguments with an unfinished string value', () => {
    const input = '{"path":"notes.md","content":"hello';

    expect(looksLikeMalformedJsonArguments(input)).toBe(true);
    expect(recoverToolArgumentShape(input, undefined)).toBe(input);
  });
});
