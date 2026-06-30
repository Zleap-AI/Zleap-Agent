import { describe, expect, it } from 'vitest';
import { ActorContextError, hasActorPermission, parseActorContext, requireActorContext } from '../src/index.js';

function headers(values: Record<string, string | undefined>): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      result.set(key, value);
    }
  }
  return result;
}

describe('ActorContext', () => {
  it('requires an explicit user id header', () => {
    expect(() => parseActorContext(headers({}))).toThrow(ActorContextError);
    try {
      parseActorContext(headers({}));
    } catch (error) {
      expect(error).toMatchObject({ code: 'actor_required', status: 401 });
    }
  });

  it('parses actor role and tenant id', () => {
    expect(
      parseActorContext(
        headers({
          'x-zleap-user-id': ' user-1 ',
          'x-zleap-actor-role': 'admin',
          'x-zleap-tenant-id': 'tenant-1',
        }),
      ),
    ).toEqual({ userId: 'user-1', role: 'admin', tenantId: 'tenant-1' });

    expect(
      parseActorContext(
        headers({
          'x-zleap-user-id': 'creator-1',
          'x-zleap-actor-role': 'creator',
        }),
      ),
    ).toEqual({ userId: 'creator-1', role: 'creator' });
  });

  it('parses explicit actor permissions from a comma or whitespace separated header', () => {
    const actor = parseActorContext(
      headers({
        'x-zleap-user-id': 'admin-1',
        'x-zleap-actor-role': 'admin',
        'x-zleap-actor-permissions': ' debug:trace:raw,ignored debug:trace:raw ',
      }),
    );

    expect(actor).toMatchObject({ userId: 'admin-1', role: 'admin', permissions: ['debug:trace:raw'] });
    expect(hasActorPermission(actor, 'debug:trace:raw')).toBe(true);
  });

  it('defaults role to user and rejects invalid roles', () => {
    expect(parseActorContext(headers({ 'x-zleap-user-id': 'user-1' }))).toMatchObject({ role: 'user' });
    expect(() => parseActorContext(headers({ 'x-zleap-user-id': 'user-1', 'x-zleap-actor-role': 'owner' }))).toThrow(
      ActorContextError,
    );
  });

  it('enforces required roles', () => {
    expect(() => requireActorContext(headers({ 'x-zleap-user-id': 'user-1' }), { roles: ['admin'] })).toThrow(
      ActorContextError,
    );
    expect(requireActorContext(headers({ 'x-zleap-user-id': 'admin-1', 'x-zleap-actor-role': 'admin' }), { roles: ['admin'] }))
      .toMatchObject({ userId: 'admin-1', role: 'admin' });
  });

  it('enforces required permissions', () => {
    expect(() => requireActorContext(headers({ 'x-zleap-user-id': 'admin-1', 'x-zleap-actor-role': 'admin' }), {
      roles: ['admin'],
      permissions: ['debug:trace:raw'],
    })).toThrow(ActorContextError);
    expect(requireActorContext(headers({
      'x-zleap-user-id': 'admin-1',
      'x-zleap-actor-role': 'admin',
      'x-zleap-actor-permissions': 'debug:trace:raw',
    }), {
      roles: ['admin'],
      permissions: ['debug:trace:raw'],
    })).toMatchObject({ userId: 'admin-1', role: 'admin', permissions: ['debug:trace:raw'] });
  });
});
