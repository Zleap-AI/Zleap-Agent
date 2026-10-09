# Parallel Search MCP example

Search the web and fetch page excerpts with Zleap-Agent's existing HTTP MCP
connector. [Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp)
provides free anonymous access for exploration and light use, with no account or
API key. Anonymous search uses Fast mode and is subject to rate limits.

From a source checkout, using Node.js 20+ and pnpm 9.15.0:

```bash
corepack enable
corepack prepare pnpm@9.15.0 --activate
pnpm install --frozen-lockfile
pnpm --filter @zleap/agent... build
node examples/parallel-search/run.mjs search "Find the official Node.js release schedule" "Node.js official release schedule"
node examples/parallel-search/run.mjs fetch https://nodejs.org/en/about/previous-releases
```

The search command accepts one objective and one keyword query. The fetch command
accepts 1–20 HTTP or HTTPS URLs and returns excerpts. Both commands print the MCP
result as JSON and exit with an error if the server reports a tool error.

`server.json` is a Zleap `McpServerRecord` configuration, loaded directly by the
example. It uses Streamable HTTP at `https://search.parallel.ai/mcp`, includes a
project User-Agent header, and has no secret references or authorization header.
It does not read or modify saved servers, workspaces, credentials, or defaults.
Discovery has a 15-second timeout; execution has a 60-second timeout.

The example discovers the current tool schemas and invokes the selected tool
through `createMcpRuntimeTool` and `SdkMcpToolExecutor`. It runs without PostgreSQL
or a model and does not start a conversation or agent loop. To check the connector
locally without making live requests:

```bash
node --test examples/parallel-search/run.test.mjs
```
