import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "zleap-test-mcp", version: "1.0.0" });

server.registerTool(
  "echo",
  {
    description: "Echo test input.",
    inputSchema: {
      text: z.string()
    }
  },
  async ({ text }) => ({
    content: [{ type: "text", text: `echo:${text}` }],
    structuredContent: { echo: text }
  })
);

server.registerTool(
  "sleepEcho",
  {
    description: "Echo test input after a short delay.",
    inputSchema: {
      text: z.string(),
      delayMs: z.number().optional()
    }
  },
  async ({ text, delayMs = 0 }) => {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(2000, delayMs))));
    return {
      content: [{ type: "text", text: `sleepEcho:${text}` }],
      structuredContent: { echo: text, delayMs }
    };
  }
);

await server.connect(new StdioServerTransport());
