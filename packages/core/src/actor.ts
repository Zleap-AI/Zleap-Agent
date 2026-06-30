export type ActorRole = 'user' | 'creator' | 'admin';
export type ActorPermission = 'debug:trace:raw';

export type ActorContext = {
  userId: string;
  role: ActorRole;
  tenantId?: string;
  permissions?: ActorPermission[];
};

export const LOCAL_DEV_ACTOR_USER_ID = 'local-dev-user';
export const LOCAL_DEV_ACTOR_TENANT_ID = 'local-dev';
export const LOCAL_DEV_ACTOR_ROLE: ActorRole = 'admin';

export function localDevActorContext(): ActorContext {
  return {
    userId: LOCAL_DEV_ACTOR_USER_ID,
    role: LOCAL_DEV_ACTOR_ROLE,
    tenantId: LOCAL_DEV_ACTOR_TENANT_ID,
  };
}

export type HeaderReader = {
  get(name: string): string | null | undefined;
};

export class ActorContextError extends Error {
  constructor(
    readonly code: 'actor_required' | 'actor_role_invalid' | 'actor_forbidden',
    message: string,
    readonly status: 400 | 401 | 403,
  ) {
    super(message);
    this.name = 'ActorContextError';
  }
}

const USER_ID_HEADER = 'x-zleap-user-id';
const ROLE_HEADER = 'x-zleap-actor-role';
const TENANT_ID_HEADER = 'x-zleap-tenant-id';
const PERMISSIONS_HEADER = 'x-zleap-actor-permissions';

export function parseActorContext(headers: HeaderReader): ActorContext {
  const userId = readHeader(headers, USER_ID_HEADER);
  if (!userId) {
    throw new ActorContextError('actor_required', `${USER_ID_HEADER} header is required`, 401);
  }
  const role = readRole(headers);
  const tenantId = readHeader(headers, TENANT_ID_HEADER);
  const permissions = readPermissions(headers);
  return { userId, role, ...(tenantId ? { tenantId } : {}), ...(permissions.length ? { permissions } : {}) };
}

export function requireActorContext(headers: HeaderReader, options: { roles?: ActorRole[]; permissions?: ActorPermission[] } = {}): ActorContext {
  const actor = parseActorContext(headers);
  if (options.roles && !options.roles.includes(actor.role)) {
    throw new ActorContextError('actor_forbidden', `actor role is not allowed: ${actor.role}`, 403);
  }
  if (options.permissions && !options.permissions.every((permission) => hasActorPermission(actor, permission))) {
    throw new ActorContextError('actor_forbidden', 'actor permission is not allowed', 403);
  }
  return actor;
}

export function hasActorPermission(actor: ActorContext, permission: ActorPermission): boolean {
  return actor.permissions?.includes(permission) ?? false;
}

function readHeader(headers: HeaderReader, name: string): string | undefined {
  const value = headers.get(name);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readRole(headers: HeaderReader): ActorRole {
  const value = readHeader(headers, ROLE_HEADER);
  if (!value) {
    return 'user';
  }
  if (value === 'user' || value === 'creator' || value === 'admin') {
    return value;
  }
  throw new ActorContextError('actor_role_invalid', `${ROLE_HEADER} must be "user", "creator", or "admin"`, 400);
}

function readPermissions(headers: HeaderReader): ActorPermission[] {
  const value = readHeader(headers, PERMISSIONS_HEADER);
  if (!value) {
    return [];
  }
  const permissions = value
    .split(/[,\s]+/g)
    .map((item) => item.trim())
    .filter((item): item is ActorPermission => item === 'debug:trace:raw');
  return [...new Set(permissions)];
}
