export const LOCAL_DEV_ACTOR_HEADERS = {
  'x-zleap-user-id': 'local-dev-user',
  'x-zleap-actor-role': 'admin',
  'x-zleap-tenant-id': 'local-dev',
} as const;

export function shouldAttachLocalDevActorHeaders(nodeEnv = process.env.NODE_ENV): boolean {
  return nodeEnv !== 'production';
}

export function webApiHeaders(headers?: HeadersInit): Headers {
  const next = new Headers(headers);
  if (shouldAttachLocalDevActorHeaders()) {
    for (const [key, value] of Object.entries(LOCAL_DEV_ACTOR_HEADERS)) {
      if (!next.has(key)) {
        next.set(key, value);
      }
    }
  }
  return next;
}

export async function webApiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  return fetch(input, {
    ...init,
    headers: webApiHeaders(init.headers),
  });
}

/** Thin JSON fetch helpers for the management surface. Throw on non-2xx with the
 *  server's `error` field when present, so callers can surface it in a toast. */
async function send(method: string, url: string, body?: unknown): Promise<unknown> {
  const response = await webApiFetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(typeof data.error === 'string' ? data.error : `${url}: HTTP ${response.status}`);
  }
  return data;
}

export const postJson = (url: string, body: unknown) => send('POST', url, body);
export const patchJson = (url: string, body: unknown) => send('PATCH', url, body);
export const deleteJson = (url: string, body?: unknown) => send('DELETE', url, body);

/** GET + parse JSON, throwing the server `error` on non-2xx (mirrors `send`). */
export async function getJson<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const response = await webApiFetch(url, init);
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(typeof data.error === 'string' ? data.error : `${url}: HTTP ${response.status}`);
  }
  return data as T;
}
