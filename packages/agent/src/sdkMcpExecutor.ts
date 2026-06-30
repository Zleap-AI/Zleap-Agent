import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpServerRecord } from '@zleap/core';
import { resolveMcpSecrets, type McpSecretAuditEvent, type McpSecretResolver } from './mcpSecrets.js';
import type { McpToolCall, McpToolExecutor } from './mcpRuntime.js';

type StdioConfig = {
  command?: unknown;
  args?: unknown;
  cwd?: unknown;
  env?: unknown;
};

type HttpConfig = {
  url?: unknown;
  headers?: unknown;
};

/** A tool as reported by an MCP server's `tools/list` (the discovery shape). */
export type DiscoveredMcpTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
};

export type SdkMcpToolExecutorOptions = {
  secretResolver?: McpSecretResolver;
  auditSecretResolution?: (event: McpSecretAuditEvent) => void;
};

/**
 * Connect once to an MCP server, list its tools (with their JSON Schemas), and
 * disconnect — the auto-discovery primitive. Bounded by a timeout so a hung /
 * misconfigured server can't block the caller (the web's createMcpServer runs
 * this best-effort). Reuses the same transport wiring as tool calls.
 */
export async function discoverMcpTools(
  server: McpServerRecord,
  opts: { timeoutMs?: number; secretResolver?: McpSecretResolver; auditSecretResolution?: (event: McpSecretAuditEvent) => void } = {},
): Promise<DiscoveredMcpTool[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  const client = new Client({ name: 'zleap-agent', version: '0.1.0' });
  const abort = () => {
    void client.close().catch(() => {});
  };
  controller.signal.addEventListener('abort', abort, { once: true });
  try {
    await client.connect(createTransport(server, opts));
    if (controller.signal.aborted) {
      throw new Error(`MCP discovery for "${server.id}" timed out.`);
    }
    const { tools } = await client.listTools();
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
    }));
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', abort);
    await client.close().catch(() => {});
  }
}

export class SdkMcpToolExecutor implements McpToolExecutor {
  constructor(private readonly options: SdkMcpToolExecutorOptions = {}) {}

  async callTool(call: McpToolCall, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) {
      throw new Error('MCP tool call aborted before connecting.');
    }
    const client = new Client({ name: 'zleap-agent', version: '0.1.0' });
    const transport = createTransport(call.server, this.options);
    const abort = () => {
      void client.close().catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      await client.connect(transport);
      if (signal.aborted) {
        throw new Error('MCP tool call aborted.');
      }
      return await client.callTool({ name: call.tool.name, arguments: asRecord(call.input) });
    } finally {
      signal.removeEventListener('abort', abort);
      await client.close().catch(() => {});
    }
  }
}

function createTransport(server: McpServerRecord, options: SdkMcpToolExecutorOptions = {}): Transport {
  const secrets = resolveMcpSecrets(server, {
    resolver: options.secretResolver,
    audit: options.auditSecretResolution,
  });
  if (server.transport === 'stdio') {
    const config = asRecord(server.config) as StdioConfig;
    const command = typeof config.command === 'string' ? config.command : '';
    if (!command) {
      throw new Error(`MCP stdio server "${server.id}" requires config.command.`);
    }
    return new StdioClientTransport({
      command,
      args: stringArray(config.args),
      cwd: typeof config.cwd === 'string' ? config.cwd : undefined,
      env: stdioEnv(config.env, secrets.env),
      stderr: 'pipe',
    });
  }

  const config = asRecord(server.config) as HttpConfig;
  const url = typeof config.url === 'string' ? config.url : '';
  if (!url) {
    throw new Error(`MCP ${server.transport} server "${server.id}" requires config.url.`);
  }
  const requestInit = { headers: httpHeaders(config.headers, secrets.headers) };
  if (server.transport === 'sse') {
    return new SSEClientTransport(new URL(url), { requestInit });
  }
  return new StreamableHTTPClientTransport(new URL(url), { requestInit });
}

function stdioEnv(value: unknown, secrets: Record<string, string>): Record<string, string> {
  return {
    ...getDefaultEnvironment(),
    ...stringRecord(value),
    ...secrets,
  };
}

function httpHeaders(value: unknown, secrets: Record<string, string>): Record<string, string> {
  return { ...stringRecord(value), ...secrets };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringRecord(value: unknown): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, item] of Object.entries(asRecord(value))) {
    if (typeof item === 'string') {
      record[key] = item;
    }
  }
  return record;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((item): item is string => typeof item === 'string');
}
