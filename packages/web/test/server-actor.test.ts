import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { requireHttpActor } from '../lib/server/actor';

const previousAuthMode = process.env.ZLEAP_AUTH_MODE;
const previousSecret = process.env.ZLEAP_TRUSTED_ACTOR_HEADER_SECRET;
const previousSkew = process.env.ZLEAP_TRUSTED_ACTOR_MAX_SKEW_MS;
const previousAllowDev = process.env.ZLEAP_ALLOW_DEV_AUTH_IN_PRODUCTION;

afterEach(() => {
  restoreEnv('ZLEAP_AUTH_MODE', previousAuthMode);
  restoreEnv('ZLEAP_TRUSTED_ACTOR_HEADER_SECRET', previousSecret);
  restoreEnv('ZLEAP_TRUSTED_ACTOR_MAX_SKEW_MS', previousSkew);
  restoreEnv('ZLEAP_ALLOW_DEV_AUTH_IN_PRODUCTION', previousAllowDev);
});

describe('requireHttpActor trusted header mode', () => {
  it('keeps unsigned actor headers only in dev-header mode', () => {
    process.env.ZLEAP_AUTH_MODE = 'dev-header';

    const actor = requireHttpActor(actorRequest().request);

    expect(actor).toMatchObject({ userId: 'u1', role: 'user', tenantId: 't1' });
  });

  it('requires a trusted signature when trusted-header mode is enabled', async () => {
    process.env.ZLEAP_AUTH_MODE = 'trusted-header';
    process.env.ZLEAP_TRUSTED_ACTOR_HEADER_SECRET = 'test-secret';

    const response = requireHttpActor(actorRequest().request);

    expect(response).toBeInstanceOf(Response);
    await expect((response as Response).json()).resolves.toMatchObject({ error: 'trusted_actor_signature_required' });
  });

  it('rejects invalid trusted signatures', async () => {
    process.env.ZLEAP_AUTH_MODE = 'trusted-header';
    process.env.ZLEAP_TRUSTED_ACTOR_HEADER_SECRET = 'test-secret';

    const { request, timestamp } = actorRequest();
    request.headers.set('x-zleap-actor-timestamp', timestamp);
    request.headers.set('x-zleap-actor-signature', 'sha256=bad');
    const response = requireHttpActor(request);

    expect(response).toBeInstanceOf(Response);
    await expect((response as Response).json()).resolves.toMatchObject({ error: 'trusted_actor_signature_invalid' });
  });

  it('accepts correctly signed trusted actor headers', () => {
    process.env.ZLEAP_AUTH_MODE = 'trusted-header';
    process.env.ZLEAP_TRUSTED_ACTOR_HEADER_SECRET = 'test-secret';

    const { request, timestamp } = actorRequest();
    request.headers.set('x-zleap-actor-timestamp', timestamp);
    request.headers.set('x-zleap-actor-signature', sign(request.headers, timestamp, 'test-secret'));
    const actor = requireHttpActor(request);

    expect(actor).toMatchObject({ userId: 'u1', role: 'user', tenantId: 't1' });
  });
});

describe('requireHttpActor localhost mode', () => {
  it('accepts localhost requests as admin without client headers', () => {
    process.env.ZLEAP_AUTH_MODE = 'localhost';
    const request = new Request('http://127.0.0.1:3000/api/models');
    const actor = requireHttpActor(request);
    expect(actor).toMatchObject({ role: 'admin' });
  });

  it('rejects non-localhost requests in localhost mode', async () => {
    process.env.ZLEAP_AUTH_MODE = 'localhost';
    const response = requireHttpActor(new Request('http://example.com/api/models'));
    expect(response).toBeInstanceOf(Response);
    await expect((response as Response).json()).resolves.toMatchObject({ error: 'localhost_auth_required' });
  });
});

function actorRequest(): { request: Request; timestamp: string } {
  const timestamp = String(Date.now());
  return {
    timestamp,
    request: new Request('http://localhost/api/test', {
      headers: {
        'x-zleap-user-id': 'u1',
        'x-zleap-actor-role': 'user',
        'x-zleap-tenant-id': 't1',
      },
    }),
  };
}

function sign(headers: Headers, timestamp: string, secret: string): string {
  const payload = [
    timestamp,
    headers.get('x-zleap-user-id')?.trim() ?? '',
    headers.get('x-zleap-actor-role')?.trim() ?? '',
    headers.get('x-zleap-tenant-id')?.trim() ?? '',
    headers.get('x-zleap-actor-permissions')?.trim() ?? '',
  ].join('\n');
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
