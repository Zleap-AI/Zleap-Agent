import type { McpServerRecord, McpToolDefinitionRecord, ToolDefinition } from '@zleap/core';
import { runSideEffect, sideEffectIdempotencyKey } from './sideEffects.js';

export type McpToolCall = {
  server: McpServerRecord;
  tool: McpToolDefinitionRecord;
  input: unknown;
};

export interface McpToolExecutor {
  callTool(call: McpToolCall, signal: AbortSignal): Promise<unknown>;
}

export const notConfiguredMcpExecutor: McpToolExecutor = {
  async callTool(call) {
    throw new Error(`MCP runtime connector is not configured for server "${call.server.id}" and tool "${call.tool.name}".`);
  },
};

export function createMcpRuntimeTool(
  server: McpServerRecord,
  tool: McpToolDefinitionRecord,
  executor: McpToolExecutor = notConfiguredMcpExecutor,
): ToolDefinition {
  const description = tool.description ?? tool.label ?? `MCP tool ${tool.name} from ${server.name}.`;
  const promptLabel = tool.label ?? tool.name;
  return {
    id: mcpRuntimeToolId(tool),
    description,
    promptSnippet: `Use external MCP tool "${promptLabel}" from "${server.name}" when this workspace needs that connected service.`,
    promptGuidelines: [
      'MCP tools may touch external services; keep inputs specific and expect approval in request-approval mode.',
      'Do not claim an MCP connection, external action, or external result exists unless this tool actually returns it.',
    ],
    parameters: tool.inputSchema ?? { type: 'object', additionalProperties: true },
    handler: async (input, _context, signal) => runSideEffect(
      {
        queueKey: `mcp:${server.id}:${tool.name}:v${tool.version}`,
        idempotencyKey: sideEffectIdempotencyKey(['mcp', server.id, tool.name, tool.version, input]),
      },
      () => executor.callTool({ server: publicServerRecord(server), tool, input }, signal),
    ),
  };
}

/** Providers cap a tool name at 64 chars of `[a-zA-Z0-9_-]` (OpenAI/Anthropic). */
const MAX_TOOL_NAME = 64;

export function mcpRuntimeToolId(tool: Pick<McpToolDefinitionRecord, 'serverId' | 'name' | 'version'>): string {
  const full = `mcp__${toolNameSegment(tool.serverId)}__${toolNameSegment(tool.name)}__v${tool.version}`;
  if (full.length <= MAX_TOOL_NAME) {
    return full;
  }
  // Too long for the provider: keep a readable head + a short stable hash of the
  // full id so it stays deterministic and unique. Same input → same id, so the
  // registered tool id and the space's toolIds always match.
  const hash = shortHash(full);
  const head = full.slice(0, MAX_TOOL_NAME - hash.length - 1);
  return `${head}_${hash}`;
}

/** Deterministic 6-char base36 hash (FNV-1a) — only for de-duping clipped ids. */
function shortHash(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(6, '0').slice(-6);
}

function toolNameSegment(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return normalized || 'tool';
}

function publicServerRecord(server: McpServerRecord): McpServerRecord {
  return {
    ...server,
    secretRefs: server.secretRefs?.map((ref) => ({ ...ref })),
  };
}
