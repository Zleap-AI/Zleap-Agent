import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolDefinition } from "../types";
import type { ToolExecutionResult } from "./tool-registry";

type McpBinding =
  | {
      transport?: "stdio";
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
      timeoutMs?: number;
    }
  | {
      transport: "streamableHttp";
      url?: string;
      headers?: Record<string, string>;
      timeoutMs?: number;
    };

export type DiscoveredMcpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export class McpToolExecutor {
  async execute(tool: ToolDefinition, argumentsJson: string): Promise<ToolExecutionResult> {
    const mcpToolName = tool.mcpToolName || tool.name;
    try {
      const args = JSON.parse(argumentsJson || "{}") as Record<string, unknown>;
      const result = await this.withClient(tool.bindingJson, async (client) => {
        return client.callTool({
          name: mcpToolName,
          arguments: args
        });
      });
      return {
        ok: true,
        status: "completed",
        result: {
          toolName: tool.name,
          mcpToolName,
          mcpServerId: tool.mcpServerId ?? null,
          result
        }
      };
    } catch (error) {
      return {
        ok: false,
        status: "failed",
        result: {
          error: error instanceof Error ? error.message : String(error),
          toolName: tool.name,
          mcpToolName,
          mcpServerId: tool.mcpServerId ?? null
        }
      };
    }
  }

  async discoverTools(bindingJson: string): Promise<DiscoveredMcpTool[]> {
    return this.withClient(bindingJson, async (client) => {
      const discovered: DiscoveredMcpTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        for (const tool of page.tools) {
          discovered.push({
            name: tool.name,
            description: tool.description ?? "",
            inputSchema: tool.inputSchema as Record<string, unknown>
          });
        }
        cursor = page.nextCursor;
      } while (cursor);
      return discovered;
    });
  }

  private async withClient<T>(bindingJson: string, fn: (client: Client) => Promise<T>): Promise<T> {
    const binding = parseBinding(bindingJson);
    const client = new Client({ name: "zleap-mcp-client", version: "0.1.0" }, { capabilities: {} });
    const transport = createTransport(binding);
    const timeoutMs = Math.max(1000, Math.min(10 * 60 * 1000, Number(binding.timeoutMs ?? 30_000)));
    try {
      await withTimeout(client.connect(transport), timeoutMs, "MCP connection timed out.");
      return await withTimeout(fn(client), timeoutMs, "MCP tool request timed out.");
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}

function parseBinding(value: string): McpBinding {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value || "{}");
  } catch {
    throw new Error("MCP bindingJson must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("MCP bindingJson must be a JSON object.");
  return parsed as McpBinding;
}

function createTransport(binding: McpBinding): StdioClientTransport | StreamableHTTPClientTransport {
  if (binding.transport === "streamableHttp") {
    if (!binding.url) throw new Error("MCP Streamable HTTP binding requires url.");
    return new StreamableHTTPClientTransport(new URL(binding.url), {
      requestInit: binding.headers ? { headers: binding.headers } : undefined
    });
  }
  if (!binding.command) throw new Error("MCP stdio binding requires command.");
  return new StdioClientTransport({
    command: binding.command,
    args: Array.isArray(binding.args) ? binding.args : [],
    env: binding.env,
    cwd: binding.cwd,
    stderr: "pipe"
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
