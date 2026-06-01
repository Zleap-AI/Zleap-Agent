import http from "node:http";
import { pathToFileURL } from "node:url";
import { openDatabase } from "../db/database";
import { Repositories } from "../db/repositories";
import { AgentRuntime } from "../core/agent-runtime";
import { MemoryService } from "../core/memory-service";
import { McpToolExecutor } from "../core/mcp-executor";
import { mcpServerToBindingJson } from "../db/repositories";
import { normalizeProviderBaseUrl } from "../core/llm-client";
import { parseActor, parseActorFromSearchParams } from "./actor";
import { readJson, sendError, sendJson, serveStatic } from "./http";
import type { AgentRunInput, MemoryRow } from "../types";

type RuntimeLike = Pick<AgentRuntime, "run" | "runStream">;

export type ZleapServerDeps = {
  repos: Repositories;
  runtime: RuntimeLike;
  memoryService: MemoryService;
  mcpToolExecutor: McpToolExecutor;
  serveStatic?: typeof serveStatic;
};

function parseUrl(request: http.IncomingMessage): URL {
  return new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
}

export function createZleapServer(deps: ZleapServerDeps): http.Server {
  const { repos, runtime, memoryService, mcpToolExecutor } = deps;
  const staticHandler = deps.serveStatic ?? serveStatic;

  return http.createServer(async (request, response) => {
    if (request.method === "OPTIONS") {
      sendJson(response, 200, {});
      return;
    }

    const url = parseUrl(request);

    try {
      if (request.method === "GET" && url.pathname === "/api/health") {
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/db/tables") {
        const actor = parseActorFromSearchParams(url.searchParams, "Database table list API");
        sendJson(response, 200, { tables: repos.listDatabaseTables(actor.actorRole) });
        return;
      }

      const dbTableMatch = url.pathname.match(/^\/api\/db\/tables\/([^/]+)$/);
      if (dbTableMatch && request.method === "GET") {
        const actor = parseActorFromSearchParams(url.searchParams, "Database table read API");
        sendJson(response, 200, repos.readDatabaseTable(decodeURIComponent(dbTableMatch[1]), {
          actorRole: actor.actorRole,
          limit: Number(url.searchParams.get("limit") ?? 100),
          offset: Number(url.searchParams.get("offset") ?? 0)
        }));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/llm-calls") {
        const limit = Number(url.searchParams.get("limit") ?? 50);
        const actor = parseActorFromSearchParams(url.searchParams, "LLM call log API");
        sendJson(response, 200, {
          llmCalls: repos.listLlmCalls(limit, actor.actorId, actor.actorRole)
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/config") {
        const actor = parseActorFromSearchParams(url.searchParams, "Runtime config list API");
        sendJson(response, 200, { configs: repos.listRuntimeConfigs(actor.actorRole) });
        return;
      }

      const configMatch = url.pathname.match(/^\/api\/config\/([^/]+)$/);
      if (configMatch && request.method === "PUT") {
        const body = await readJson<{ value: unknown; actorId?: string; actorRole?: "user" | "creator" }>(request);
        const actor = parseActor(body, "Runtime config update API");
        sendJson(response, 200, repos.updateRuntimeConfig({
          key: decodeURIComponent(configMatch[1]),
          value: body.value,
          actorId: actor.actorId,
          actorRole: actor.actorRole
        }));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/approvals") {
        const limit = Number(url.searchParams.get("limit") ?? 100);
        const actor = parseActorFromSearchParams(url.searchParams, "Approval list API");
        sendJson(response, 200, {
          approvalRequests: repos.listApprovalRequests({
            conversationId: url.searchParams.get("conversationId") || undefined,
            userId: url.searchParams.get("userId") || undefined,
            status: url.searchParams.get("status") || undefined,
            actorId: actor.actorId,
            actorRole: actor.actorRole,
            limit
          })
        });
        return;
      }

      const approvalMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/resolve$/);
      if (approvalMatch && request.method === "POST") {
        const body = await readJson<{ status: "approved" | "rejected"; actorId?: string; actorRole?: "user" | "creator"; resolutionReason?: string }>(request);
        const actor = parseActor(body, "Approval resolve API");
        if (body.status !== "approved" && body.status !== "rejected") throw new Error("Approval status must be approved or rejected.");
        sendJson(response, 200, repos.resolveApprovalRequest(approvalMatch[1], {
          status: body.status,
          resolvedBy: actor.actorId,
          resolverRole: actor.actorRole,
          resolutionReason: body.resolutionReason
        }));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/agent/run") {
        const body = await readJson<AgentRunInput>(request);
        if (body.llm?.baseUrl) body.llm.baseUrl = normalizeProviderBaseUrl(body.llm.baseUrl);
        const output = await runtime.run(body);
        sendJson(response, 200, output);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/agent/run/stream") {
        const body = await readJson<AgentRunInput>(request);
        if (body.llm?.baseUrl) body.llm.baseUrl = normalizeProviderBaseUrl(body.llm.baseUrl);
        const abortController = new AbortController();
        const stopRun = () => {
          if (!response.writableEnded && !abortController.signal.aborted) abortController.abort();
        };
        request.on("aborted", stopRun);
        response.on("close", stopRun);
        response.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*"
        });
        try {
          for await (const event of runtime.runStream({ ...body, abortSignal: abortController.signal })) {
            if (abortController.signal.aborted || response.writableEnded) break;
            response.write(`data: ${JSON.stringify(event)}\n\n`);
          }
          if (!response.writableEnded) response.end();
        } catch (error) {
          if (abortController.signal.aborted) return;
          const message = error instanceof Error ? error.message : String(error);
          response.write(`data: ${JSON.stringify({ type: "error", error: message })}\n\n`);
          response.end();
        } finally {
          request.off("aborted", stopRun);
          response.off("close", stopRun);
        }
        return;
      }

      if (url.pathname === "/api/agents" && request.method === "GET") {
        sendJson(response, 200, { agents: repos.listAgents() });
        return;
      }
      if (url.pathname === "/api/agents" && request.method === "POST") {
        const body = await readJson<any>(request);
        const actor = parseActor(body, "Agent create API");
        sendJson(response, 200, repos.createAgent({
          id: body.id,
          name: body.name,
          systemPrompt: body.systemPrompt,
          personalityPrompt: body.personalityPrompt,
          defaultModel: body.defaultModel,
          defaultBaseUrl: body.defaultBaseUrl,
          actorId: actor.actorId,
          actorRole: actor.actorRole
        }));
        return;
      }

      const agentMatch = url.pathname.match(/^\/api\/agents\/([^/]+)$/);
      if (agentMatch && request.method === "GET") {
        sendJson(response, 200, repos.getAgent(agentMatch[1]));
        return;
      }
      if (agentMatch && request.method === "PUT") {
        const body = await readJson<any>(request);
        const actor = parseActor(body, "Agent update API");
        sendJson(response, 200, repos.updateAgent({
          ...repos.getAgent(agentMatch[1]),
          ...body,
          id: agentMatch[1],
          actorId: actor.actorId,
          actorRole: actor.actorRole
        }));
        return;
      }

      if (url.pathname === "/api/workspaces" && request.method === "GET") {
        sendJson(response, 200, { workspaces: repos.listWorkspaces(), tools: repos.listTools() });
        return;
      }
      if (url.pathname === "/api/mcp/tools/discover" && request.method === "POST") {
        const body = await readJson<{ bindingJson?: string; actorId?: string; actorRole?: "user" | "creator" }>(request);
        const actor = parseActor(body, "MCP tool discovery API");
        if (actor.actorRole !== "creator") throw new Error("MCP tool discovery requires creator role.");
        sendJson(response, 200, { tools: await mcpToolExecutor.discoverTools(body.bindingJson ?? "{}") });
        return;
      }
      const workspaceMcpCollectionMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/mcp-servers$/);
      if (workspaceMcpCollectionMatch && request.method === "GET") {
        parseActorFromSearchParams(url.searchParams, "MCP server list API");
        sendJson(response, 200, { mcpServers: repos.listMcpServers(workspaceMcpCollectionMatch[1]) });
        return;
      }
      if (workspaceMcpCollectionMatch && request.method === "POST") {
        const body = await readJson<any>(request);
        const actor = parseActor(body, "MCP server create API");
        sendJson(response, 200, repos.upsertMcpServer({
          ...body,
          workspaceId: workspaceMcpCollectionMatch[1],
          actorId: actor.actorId,
          actorRole: actor.actorRole
        }));
        return;
      }
      const workspaceMcpServerMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/mcp-servers\/([^/]+)$/);
      if (workspaceMcpServerMatch && request.method === "PUT") {
        const body = await readJson<any>(request);
        const actor = parseActor(body, "MCP server update API");
        sendJson(response, 200, repos.upsertMcpServer({
          ...body,
          id: workspaceMcpServerMatch[2],
          workspaceId: workspaceMcpServerMatch[1],
          actorId: actor.actorId,
          actorRole: actor.actorRole
        }));
        return;
      }
      if (workspaceMcpServerMatch && request.method === "DELETE") {
        const body = await readJson<{ actorId?: string; actorRole?: "user" | "creator"; deleteReason?: string }>(request);
        const actor = parseActor(body, "MCP server delete API");
        repos.deleteMcpServer(workspaceMcpServerMatch[1], workspaceMcpServerMatch[2], actor.actorId, actor.actorRole, body.deleteReason);
        sendJson(response, 200, { ok: true });
        return;
      }
      const workspaceMcpDiscoverMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/mcp-servers\/([^/]+)\/discover$/);
      if (workspaceMcpDiscoverMatch && request.method === "POST") {
        const body = await readJson<{ actorId?: string; actorRole?: "user" | "creator" }>(request);
        const actor = parseActor(body, "MCP server discovery API");
        if (actor.actorRole !== "creator") throw new Error("MCP server discovery requires creator role.");
        const server = repos.getMcpServer(workspaceMcpDiscoverMatch[2]);
        if (server.workspaceId !== workspaceMcpDiscoverMatch[1]) throw new Error("MCP server belongs to a different workspace.");
        sendJson(response, 200, { tools: await mcpToolExecutor.discoverTools(mcpServerToBindingJson(server)) });
        return;
      }
      const workspaceMcpImportMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/mcp-servers\/([^/]+)\/import-tools$/);
      if (workspaceMcpImportMatch && request.method === "POST") {
        const body = await readJson<{ tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>; actorId?: string; actorRole?: "user" | "creator" }>(request);
        const actor = parseActor(body, "MCP tool import API");
        sendJson(response, 200, {
          tools: repos.importMcpServerTools({
            workspaceId: workspaceMcpImportMatch[1],
            serverId: workspaceMcpImportMatch[2],
            tools: body.tools ?? [],
            actorId: actor.actorId,
            actorRole: actor.actorRole
          })
        });
        return;
      }
      if (url.pathname === "/api/workspaces" && request.method === "POST") {
        const body = await readJson<any>(request);
        const actor = parseActor(body, "Workspace create API");
        sendJson(response, 200, repos.upsertWorkspace({
          ...body,
          actorId: actor.actorId,
          actorRole: actor.actorRole
        }));
        return;
      }
      const workspaceMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)$/);
      if (workspaceMatch && request.method === "PUT") {
        const body = await readJson<any>(request);
        const actor = parseActor(body, "Workspace update API");
        sendJson(response, 200, repos.upsertWorkspace({
          ...body,
          id: workspaceMatch[1],
          actorId: actor.actorId,
          actorRole: actor.actorRole
        }));
        return;
      }
      if (workspaceMatch && request.method === "DELETE") {
        const body = await readJson<{ actorId?: string; actorRole?: "user" | "creator"; deleteReason?: string }>(request);
        const actor = parseActor(body, "Workspace delete API");
        repos.deleteWorkspace(workspaceMatch[1], actor.actorId, actor.actorRole, body.deleteReason);
        sendJson(response, 200, { ok: true });
        return;
      }
      const workspaceToolCollectionMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/tools$/);
      if (workspaceToolCollectionMatch && request.method === "POST") {
        const body = await readJson<any>(request);
        const actor = parseActor(body, "Workspace tool registration API");
        sendJson(response, 200, repos.upsertWorkspaceTool({
          ...body,
          workspaceId: workspaceToolCollectionMatch[1],
          actorId: actor.actorId,
          actorRole: actor.actorRole
        }));
        return;
      }
      const workspaceToolMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/tools\/([^/]+)$/);
      if (workspaceToolMatch && request.method === "PUT") {
        const body = await readJson<any>(request);
        const actor = parseActor(body, "Workspace tool update API");
        sendJson(response, 200, repos.upsertWorkspaceTool({
          ...body,
          id: workspaceToolMatch[2],
          workspaceId: workspaceToolMatch[1],
          actorId: actor.actorId,
          actorRole: actor.actorRole
        }));
        return;
      }
      if (workspaceToolMatch && request.method === "DELETE") {
        const body = await readJson<{ actorId?: string; actorRole?: "user" | "creator"; deleteReason?: string }>(request);
        const actor = parseActor(body, "Workspace tool delete API");
        repos.deleteWorkspaceTool(workspaceToolMatch[1], workspaceToolMatch[2], actor.actorId, actor.actorRole, body.deleteReason);
        sendJson(response, 200, { ok: true });
        return;
      }

      if (url.pathname === "/api/memories" && request.method === "GET") {
        const actor = parseActorFromSearchParams(url.searchParams, "Memory list API");
        sendJson(response, 200, {
          memories: memoryService.listMemoryRecords({
            actorId: actor.actorId,
            actorRole: actor.actorRole,
            filters: {
              query: url.searchParams.get("query") || undefined,
              memoryType: url.searchParams.get("memoryType") || undefined,
              userId: url.searchParams.get("userId") || undefined,
              agentId: url.searchParams.get("agentId") || undefined,
              workspaceId: url.searchParams.get("workspaceId") || undefined
            }
          })
        });
        return;
      }
      if (url.pathname === "/api/memories" && request.method === "POST") {
        const body = await readJson<Partial<MemoryRow> & Pick<MemoryRow, "memoryType" | "title" | "summary" | "detail"> & { actorId?: string; actorRole?: "user" | "creator"; conversationId?: string }>(request);
        const actor = parseActor(body, "Memory create API");
        sendJson(response, 200, memoryService.createMemoryRecord({
          actorId: actor.actorId,
          actorRole: actor.actorRole,
          memory: body,
          conversationId: body.conversationId
        }));
        return;
      }
      const memoryMatch = url.pathname.match(/^\/api\/memories\/([^/]+)$/);
      if (memoryMatch && request.method === "PUT") {
        const body = await readJson<Partial<MemoryRow> & { actorId?: string; actorRole?: "user" | "creator"; conversationId?: string }>(request);
        const actor = parseActor(body, "Memory update API");
        sendJson(response, 200, memoryService.updateMemoryRecord({
          actorId: actor.actorId,
          actorRole: actor.actorRole,
          memoryId: memoryMatch[1],
          patch: body,
          conversationId: body.conversationId
        }));
        return;
      }
      if (memoryMatch && request.method === "DELETE") {
        const body = await readJson<{ actorId?: string; actorRole?: "user" | "creator"; deleteReason?: string; conversationId?: string }>(request);
        const actor = parseActor(body, "Memory delete API");
        memoryService.deleteMemoryRecord({
          actorId: actor.actorId,
          actorRole: actor.actorRole,
          memoryId: memoryMatch[1],
          deleteReason: body.deleteReason,
          conversationId: body.conversationId
        });
        sendJson(response, 200, { ok: true });
        return;
      }

      const traceMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/trace$/);
      if (traceMatch && request.method === "GET") {
        const actor = parseActorFromSearchParams(url.searchParams, "Conversation trace API");
        sendJson(response, 200, repos.getTrace(traceMatch[1], actor.actorId, actor.actorRole));
        return;
      }
      const conversationMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)$/);
      if (conversationMatch && request.method === "DELETE") {
        const body = await readJson<{ actorId?: string; actorRole?: "user" | "creator"; deleteReason?: string }>(request);
        const actor = parseActor(body, "Conversation delete API");
        repos.deleteConversation(conversationMatch[1], actor.actorId, actor.actorRole, body.deleteReason);
        sendJson(response, 200, { ok: true });
        return;
      }

      const served = await staticHandler(response, url.pathname);
      if (served) return;
      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      sendError(response, error);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.ZLEAP_PORT ?? 4173);
  const db = openDatabase();
  const repos = new Repositories(db);
  repos.markPendingLlmCallsInterrupted();
  const runtime = new AgentRuntime(repos);
  const memoryService = new MemoryService(repos);
  const mcpToolExecutor = new McpToolExecutor();
  const server = createZleapServer({ repos, runtime, memoryService, mcpToolExecutor });

  server.listen(port, () => {
    console.log(`Zleap server listening on http://localhost:${port}`);
  });
}
