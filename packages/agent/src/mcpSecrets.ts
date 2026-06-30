import type { McpServerRecord, SecretRef } from '@zleap/core';

export type McpSecretTarget = 'env' | 'header';
export type McpSecretResolutionStatus = 'resolved' | 'missing' | 'unsupported_provider' | 'forbidden';

export type McpSecretAuditEvent = {
  serverId: string;
  provider: SecretRef['provider'];
  keyHash: string;
  target: McpSecretTarget;
  status: McpSecretResolutionStatus;
  version?: string;
};

export interface McpSecretResolver {
  resolve(ref: SecretRef, context: { server: McpServerRecord; target: McpSecretTarget }): string | undefined;
}

export type ResolveMcpSecretsOptions = {
  resolver?: McpSecretResolver;
  audit?: (event: McpSecretAuditEvent) => void;
};

export type ResolvedMcpSecrets = {
  env: Record<string, string>;
  headers: Record<string, string>;
};

export class EnvMcpSecretResolver implements McpSecretResolver {
  constructor(private readonly env: Record<string, string | undefined> = process.env) {}

  resolve(ref: SecretRef): string | undefined {
    return ref.provider === 'env' ? this.env[ref.key] : undefined;
  }
}

export function resolveMcpSecrets(server: McpServerRecord, options: ResolveMcpSecretsOptions = {}): ResolvedMcpSecrets {
  const resolver = options.resolver ?? new EnvMcpSecretResolver();
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};

  for (const ref of server.secretRefs ?? []) {
    const header = typeof ref.metadata?.header === 'string' ? ref.metadata.header : undefined;
    const target: McpSecretTarget = header ? 'header' : 'env';
    const baseEvent = auditBase(server, ref, target);
    if (!isSecretRefAllowed(server, ref)) {
      options.audit?.({ ...baseEvent, status: 'forbidden' });
      continue;
    }
    if (ref.provider !== 'env') {
      options.audit?.({ ...baseEvent, status: 'unsupported_provider' });
      continue;
    }
    const value = resolver.resolve(ref, { server, target });
    if (!value) {
      options.audit?.({ ...baseEvent, status: 'missing' });
      continue;
    }
    if (target === 'header') {
      const prefix = typeof ref.metadata?.prefix === 'string' ? ref.metadata.prefix : '';
      headers[header!] = `${prefix}${value}`;
    } else {
      const envName = typeof ref.metadata?.env === 'string' ? ref.metadata.env : ref.key;
      env[envName] = value;
    }
    options.audit?.({ ...baseEvent, status: 'resolved' });
  }

  return { env, headers };
}

function isSecretRefAllowed(server: McpServerRecord, ref: SecretRef): boolean {
  const userId = typeof ref.metadata?.userId === 'string' ? ref.metadata.userId : undefined;
  if (userId && server.userId && userId !== server.userId) {
    return false;
  }
  const tenantId = typeof ref.metadata?.tenantId === 'string' ? ref.metadata.tenantId : undefined;
  if (tenantId && server.tenantId && tenantId !== server.tenantId) {
    return false;
  }
  const allowedServerIds = Array.isArray(ref.metadata?.allowedServerIds)
    ? ref.metadata.allowedServerIds.filter((item): item is string => typeof item === 'string')
    : undefined;
  if (allowedServerIds?.length && !allowedServerIds.includes(server.id)) {
    return false;
  }
  return true;
}

function auditBase(server: McpServerRecord, ref: SecretRef, target: McpSecretTarget): Omit<McpSecretAuditEvent, 'status'> {
  const version = typeof ref.metadata?.version === 'string' ? ref.metadata.version : undefined;
  return {
    serverId: server.id,
    provider: ref.provider,
    keyHash: shortHash(ref.key),
    target,
    ...(version ? { version } : {}),
  };
}

function shortHash(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(8, '0').slice(-8);
}
