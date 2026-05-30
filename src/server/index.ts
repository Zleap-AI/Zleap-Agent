import http from "node:http";
import { openDatabase } from "../db/database";
import { Repositories } from "../db/repositories";
import { AgentRuntime } from "../core/agent-runtime";
import { MemoryService } from "../core/memory-service";
import { normalizeProviderBaseUrl } from "../core/llm-client";
import { readJson, sendError, sendJson, serveStatic } from "./http";
import type { AgentRunInput, MemoryRow } from "../types";

const port = Number(process.env.ZLEAP_PORT ?? 4173);
const db = openDatabase();
const repos = new Repositories(db);
repos.markPendingLlmCallsInterrupted();
const runtime = new AgentRuntime(repos);
const memoryService = new MemoryService(repos);

function parseUrl(request: http.IncomingMessage): URL {
  return new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
}

const server = http.createServer(async (request, response) => {
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

    if (request.method === "GET" && url.pathname === "/api/llm-calls") {
      const limit = Number(url.searchParams.get("limit") ?? 50);
      sendJson(response, 200, {
        llmCalls: repos.listLlmCalls(
          limit,
          url.searchParams.get("actorId") ?? "user",
          (url.searchParams.get("actorRole") || "user") as "user" | "creator"
        )
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/approvals") {
      const limit = Number(url.searchParams.get("limit") ?? 100);
      sendJson(response, 200, {
        approvalRequests: repos.listApprovalRequests({
          conversationId: url.searchParams.get("conversationId") || undefined,
          userId: url.searchParams.get("userId") || undefined,
          status: url.searchParams.get("status") || undefined,
          actorId: url.searchParams.get("actorId") ?? "user",
          actorRole: (url.searchParams.get("actorRole") || "user") as "user" | "creator",
          limit
        })
      });
      return;
    }

    const approvalMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/resolve$/);
    if (approvalMatch && request.method === "POST") {
      const body = await readJson<{ status: "approved" | "rejected"; actorId?: string; actorRole?: "user" | "creator"; resolvedBy?: string; resolutionReason?: string }>(request);
      if (body.status !== "approved" && body.status !== "rejected") throw new Error("Approval status must be approved or rejected.");
      sendJson(response, 200, repos.resolveApprovalRequest(approvalMatch[1], {
        status: body.status,
        resolvedBy: body.actorId ?? body.resolvedBy ?? "user",
        resolverRole: body.actorRole ?? "user",
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
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*"
      });
      try {
        for await (const event of runtime.runStream(body)) {
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        response.end();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        response.write(`data: ${JSON.stringify({ type: "error", error: message })}\n\n`);
        response.end();
      }
      return;
    }

    const agentMatch = url.pathname.match(/^\/api\/agents\/([^/]+)$/);
    if (agentMatch && request.method === "GET") {
      sendJson(response, 200, repos.getAgent(agentMatch[1]));
      return;
    }
    if (agentMatch && request.method === "PUT") {
      const body = await readJson<any>(request);
      sendJson(response, 200, repos.updateAgent({
        ...repos.getAgent(agentMatch[1]),
        ...body,
        id: agentMatch[1],
        actorId: body.actorId ?? "user",
        actorRole: body.actorRole ?? "user"
      }));
      return;
    }

    if (url.pathname === "/api/workspaces" && request.method === "GET") {
      sendJson(response, 200, { workspaces: repos.listWorkspaces(), tools: repos.listTools() });
      return;
    }
    if (url.pathname === "/api/workspaces" && request.method === "POST") {
      const body = await readJson<any>(request);
      sendJson(response, 200, repos.upsertWorkspace({
        ...body,
        actorId: body.actorId ?? "user",
        actorRole: body.actorRole ?? "user"
      }));
      return;
    }
    const workspaceMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)$/);
    if (workspaceMatch && request.method === "PUT") {
      const body = await readJson<any>(request);
      sendJson(response, 200, repos.upsertWorkspace({
        ...body,
        id: workspaceMatch[1],
        actorId: body.actorId ?? "user",
        actorRole: body.actorRole ?? "user"
      }));
      return;
    }
    if (workspaceMatch && request.method === "DELETE") {
      const body = await readJson<{ actorId?: string; actorRole?: "user" | "creator"; deleteReason?: string }>(request);
      repos.deleteWorkspace(workspaceMatch[1], body.actorId ?? "creator", body.actorRole ?? "creator", body.deleteReason);
      sendJson(response, 200, { ok: true });
      return;
    }

    if (url.pathname === "/api/memories" && request.method === "GET") {
      sendJson(response, 200, {
        memories: memoryService.listMemoryRecords({
          actorId: url.searchParams.get("actorId") || "user",
          actorRole: (url.searchParams.get("actorRole") || "user") as "user" | "creator",
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
      const body = await readJson<Partial<MemoryRow> & Pick<MemoryRow, "memoryType" | "title" | "summary" | "detail"> & { actorId?: string; actorRole?: "user" | "creator" }>(request);
      sendJson(response, 200, memoryService.createMemoryRecord({
        actorId: body.actorId ?? "user",
        actorRole: body.actorRole ?? "user",
        memory: body
      }));
      return;
    }
    const memoryMatch = url.pathname.match(/^\/api\/memories\/([^/]+)$/);
    if (memoryMatch && request.method === "PUT") {
      const body = await readJson<Partial<MemoryRow> & { actorId?: string; actorRole?: "user" | "creator"; conversationId?: string }>(request);
      sendJson(response, 200, memoryService.updateMemoryRecord({
        actorId: body.actorId ?? "user",
        actorRole: body.actorRole ?? "user",
        memoryId: memoryMatch[1],
        patch: body,
        conversationId: body.conversationId
      }));
      return;
    }
    if (memoryMatch && request.method === "DELETE") {
      const body = await readJson<{ actorId?: string; actorRole?: "user" | "creator"; deleteReason?: string; conversationId?: string }>(request);
      memoryService.deleteMemoryRecord({
        actorId: body.actorId ?? "user",
        actorRole: body.actorRole ?? "user",
        memoryId: memoryMatch[1],
        deleteReason: body.deleteReason,
        conversationId: body.conversationId
      });
      sendJson(response, 200, { ok: true });
      return;
    }

    const traceMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/trace$/);
    if (traceMatch && request.method === "GET") {
      sendJson(response, 200, repos.getTrace(
        traceMatch[1],
        url.searchParams.get("actorId") ?? "user",
        (url.searchParams.get("actorRole") || "user") as "user" | "creator"
      ));
      return;
    }
    const conversationMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)$/);
    if (conversationMatch && request.method === "DELETE") {
      const body = await readJson<{ actorId?: string; actorRole?: "user" | "creator"; deleteReason?: string }>(request);
      repos.deleteConversation(conversationMatch[1], body.actorId ?? "user", body.actorRole ?? "user", body.deleteReason);
      sendJson(response, 200, { ok: true });
      return;
    }

    const served = await serveStatic(response, url.pathname);
    if (served) return;
    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    sendError(response, error);
  }
});

server.listen(port, () => {
  console.log(`Zleap server listening on http://localhost:${port}`);
});
