import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_DEV_ACTOR_HEADERS, shouldAttachLocalDevActorHeaders, webApiFetch, webApiHeaders } from '../lib/api';

describe('web API client actor headers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('attaches local-dev actor headers outside production', () => {
    const headers = webApiHeaders();

    expect(headers.get('x-zleap-user-id')).toBe(LOCAL_DEV_ACTOR_HEADERS['x-zleap-user-id']);
    expect(headers.get('x-zleap-actor-role')).toBe(LOCAL_DEV_ACTOR_HEADERS['x-zleap-actor-role']);
    expect(headers.get('x-zleap-tenant-id')).toBe(LOCAL_DEV_ACTOR_HEADERS['x-zleap-tenant-id']);
  });

  it('keeps caller supplied headers and actor overrides', () => {
    const headers = webApiHeaders({
      'content-type': 'application/json',
      'x-zleap-user-id': 'explicit-user',
    });

    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-zleap-user-id')).toBe('explicit-user');
    expect(headers.get('x-zleap-actor-role')).toBe(LOCAL_DEV_ACTOR_HEADERS['x-zleap-actor-role']);
  });

  it('does not attach local-dev actor headers in production', () => {
    expect(shouldAttachLocalDevActorHeaders('production')).toBe(false);
    expect(shouldAttachLocalDevActorHeaders('development')).toBe(true);
    expect(shouldAttachLocalDevActorHeaders('test')).toBe(true);
  });

  it('routes fetch through the shared header merger', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));

    await webApiFetch('/api/example', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = new Headers(init?.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-zleap-user-id')).toBe(LOCAL_DEV_ACTOR_HEADERS['x-zleap-user-id']);
  });
});
