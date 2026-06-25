import { createHmac, timingSafeEqual } from 'node:crypto';
import { ActorContextError, requireActorContext, type ActorContext, type ActorRole } from '@zleap/core';

const USER_ID_HEADER = 'x-zleap-user-id';
const ROLE_HEADER = 'x-zleap-actor-role';
const TENANT_ID_HEADER = 'x-zleap-tenant-id';
const PERMISSIONS_HEADER = 'x-zleap-actor-permissions';
const SIGNATURE_HEADER = 'x-zleap-actor-signature';
const TIMESTAMP_HEADER = 'x-zleap-actor-timestamp';
const DEFAULT_SIGNATURE_SKEW_MS = 5 * 60 * 1000;

type AuthMode = 'dev-header' | 'trusted-header' | 'localhost';

export function requireHttpActor(req: Request, options: { roles?: ActorRole[] } = {}): ActorContext | Response {
  if (actorAuthMode() === 'localhost' && isLocalhostRequest(req)) {
    try {
      return requireActorContext(localAdminHeaders(), options);
    } catch (error) {
      if (error instanceof ActorContextError) {
        return Response.json({ error: error.code }, { status: error.status });
      }
      throw error;
    }
  }

  const trust = requireTrustedActorHeaders(req.headers);
  if (trust) return trust;
  try {
    return requireActorContext(req.headers, options);
  } catch (error) {
    if (error instanceof ActorContextError) {
      return Response.json({ error: error.code }, { status: error.status });
    }
    throw error;
  }
}

export function isActorResponse(value: ActorContext | Response): value is Response {
  return value instanceof Response;
}

function requireTrustedActorHeaders(headers: Headers): Response | undefined {
  const mode = actorAuthMode();
  if (mode === 'localhost') {
    return Response.json({ error: 'localhost_auth_required' }, { status: 403 });
  }
  if (mode === 'dev-header') {
    if (process.env.NODE_ENV === 'production' && process.env.ZLEAP_ALLOW_DEV_AUTH_IN_PRODUCTION !== 'true') {
      return Response.json({ error: 'dev_actor_headers_disabled' }, { status: 403 });
    }
    return undefined;
  }

  const secret = process.env.ZLEAP_TRUSTED_ACTOR_HEADER_SECRET;
  if (!secret) {
    return Response.json({ error: 'trusted_actor_secret_required' }, { status: 503 });
  }
  const timestamp = headers.get(TIMESTAMP_HEADER)?.trim();
  const signature = headers.get(SIGNATURE_HEADER)?.trim();
  if (!timestamp || !signature) {
    return Response.json({ error: 'trusted_actor_signature_required' }, { status: 401 });
  }
  const timestampMs = Number(timestamp);
  const skewMs = trustedActorMaxSkewMs();
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > skewMs) {
    return Response.json({ error: 'trusted_actor_signature_expired' }, { status: 401 });
  }
  const expected = signActorHeaders(headers, timestamp, secret);
  if (!safeEqualSignature(signature, expected)) {
    return Response.json({ error: 'trusted_actor_signature_invalid' }, { status: 403 });
  }
  return undefined;
}

function actorAuthMode(): AuthMode {
  const configured = process.env.ZLEAP_AUTH_MODE?.trim();
  if (configured === 'dev-header' || configured === 'trusted-header' || configured === 'localhost') {
    return configured;
  }
  return process.env.NODE_ENV === 'production' ? 'trusted-header' : 'dev-header';
}

function isLocalhostRequest(req: Request): boolean {
  const host = (req.headers.get('host') ?? new URL(req.url).host).trim().toLowerCase();
  return /^127\.0\.0\.1(:\d+)?$/.test(host) || /^localhost(:\d+)?$/.test(host) || /^\[::1\](:\d+)?$/.test(host);
}

function localAdminHeaders(): Headers {
  const headers = new Headers();
  headers.set(USER_ID_HEADER, 'local-desktop-user');
  headers.set(ROLE_HEADER, 'admin');
  headers.set(TENANT_ID_HEADER, 'local');
  return headers;
}

function trustedActorMaxSkewMs(): number {
  const configured = Number(process.env.ZLEAP_TRUSTED_ACTOR_MAX_SKEW_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_SIGNATURE_SKEW_MS;
}

function signActorHeaders(headers: Headers, timestamp: string, secret: string): string {
  const payload = [
    timestamp,
    headers.get(USER_ID_HEADER)?.trim() ?? '',
    headers.get(ROLE_HEADER)?.trim() ?? '',
    headers.get(TENANT_ID_HEADER)?.trim() ?? '',
    headers.get(PERMISSIONS_HEADER)?.trim() ?? '',
  ].join('\n');
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

function safeEqualSignature(actual: string, expected: string): boolean {
  const normalized = actual.startsWith('sha256=') ? actual : `sha256=${actual}`;
  const actualBytes = Buffer.from(normalized);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
