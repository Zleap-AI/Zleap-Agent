import { readFile } from "node:fs/promises";
import path from "node:path";
import { IncomingMessage, ServerResponse } from "node:http";

export async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) as T : {} as T;
}

export function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  response.end(JSON.stringify(value, null, 2));
}

export function sendError(response: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  sendJson(response, 500, { error: message });
}

export async function serveStatic(response: ServerResponse, requestPath: string): Promise<boolean> {
  const root = path.resolve("dist/web");
  const cleanPath = requestPath === "/" ? "/index.html" : requestPath;
  const filePath = path.resolve(root, `.${cleanPath}`);
  if (!filePath.startsWith(root)) return false;
  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath);
    const contentType = ext === ".html" ? "text/html; charset=utf-8"
      : ext === ".js" ? "text/javascript; charset=utf-8"
        : ext === ".css" ? "text/css; charset=utf-8"
          : "application/octet-stream";
    response.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
    response.end(data);
    return true;
  } catch {
    return false;
  }
}
