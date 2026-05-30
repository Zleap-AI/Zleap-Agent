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

await server.connect(new StdioServerTransport());
