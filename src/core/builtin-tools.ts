import { exec } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolExecutionResult } from "./tool-registry";

const ignoredDirs = new Set([".git", "node_modules", "dist", "data"]);
const maxSearchResults = 50;
const maxFileBytes = 1024 * 1024;
const maxReadFileBytes = 512 * 1024;
const defaultCommandTimeoutMs = 30_000;
const maxCommandTimeoutMs = 120_000;

type BuiltinToolContext = {
  conversationId: string;
};

export async function executeSearchFiles(argumentsJson: string, context: BuiltinToolContext): Promise<ToolExecutionResult> {
  const args = safeJson(argumentsJson) as { query?: unknown };
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    return { ok: false, status: "failed", result: { error: "searchFiles requires query." } };
  }
  const root = await ensureConversationWorkspaceRoot(context.conversationId);
  const lowerQuery = query.toLowerCase();
  const results: Array<{ path: string; matchType: "name" | "content"; preview?: string }> = [];

  async function visit(dir: string): Promise<void> {
    if (results.length >= maxSearchResults) return;
    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxSearchResults) return;
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(root, fullPath) || entry.name;
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) await visit(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (relativePath.toLowerCase().includes(lowerQuery)) {
        results.push({ path: relativePath, matchType: "name" });
        continue;
      }
      const contentMatch = await findContentMatch(fullPath, lowerQuery);
      if (contentMatch) {
        results.push({ path: relativePath, matchType: "content", preview: contentMatch });
      }
    }
  }

  await visit(root);
  return {
    ok: true,
    status: "completed",
    result: {
      query,
      root,
      conversationId: context.conversationId,
      count: results.length,
      results
    }
  };
}

export async function executeRunCommand(argumentsJson: string, context: BuiltinToolContext): Promise<ToolExecutionResult> {
  const args = safeJson(argumentsJson) as { command?: unknown; cwd?: unknown; timeoutMs?: unknown; reason?: unknown };
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (!command) {
    return { ok: false, status: "failed", result: { error: "runCommand requires command." } };
  }
  const root = await ensureConversationWorkspaceRoot(context.conversationId);
  const cwdResult = resolveWorkspacePath(root, typeof args.cwd === "string" ? args.cwd : ".");
  if (!cwdResult.ok) {
    return { ok: false, status: "failed", result: { error: cwdResult.error } };
  }
  const requestedTimeout = typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs) ? args.timeoutMs : defaultCommandTimeoutMs;
  const timeoutMs = Math.max(1_000, Math.min(maxCommandTimeoutMs, Math.trunc(requestedTimeout)));
  const startedAt = new Date().toISOString();
  const result = await runShellCommand(command, cwdResult.fullPath, timeoutMs);
  return {
    ok: result.exitCode === 0,
    status: result.exitCode === 0 ? "completed" : "failed",
    result: {
      command,
      reason: typeof args.reason === "string" ? args.reason : undefined,
      cwd: cwdResult.relativePath || ".",
      root,
      conversationId: context.conversationId,
      startedAt,
      completedAt: new Date().toISOString(),
      timeoutMs,
      ...result
    }
  };
}

export async function executeReadFile(argumentsJson: string, context: BuiltinToolContext): Promise<ToolExecutionResult> {
  const args = safeJson(argumentsJson) as { path?: unknown; startLine?: unknown; maxLines?: unknown; reason?: unknown };
  const requestedPath = typeof args.path === "string" ? args.path.trim() : "";
  if (!requestedPath) {
    return { ok: false, status: "failed", result: { error: "readFile requires path." } };
  }
  const root = await ensureConversationWorkspaceRoot(context.conversationId);
  const resolved = resolveWorkspacePath(root, requestedPath);
  if (!resolved.ok) {
    return { ok: false, status: "failed", result: { error: resolved.error } };
  }
  try {
    const stat = await fs.stat(resolved.fullPath);
    if (!stat.isFile()) {
      return { ok: false, status: "failed", result: { error: "readFile path is not a file.", path: resolved.relativePath } };
    }
    if (stat.size > maxReadFileBytes) {
      return {
        ok: false,
        status: "failed",
        result: {
          error: "readFile refuses very large files. Use searchFiles or a narrower file operation first.",
          path: resolved.relativePath,
          bytes: stat.size,
          maxBytes: maxReadFileBytes
        }
      };
    }
    const content = await fs.readFile(resolved.fullPath, "utf8");
    const lines = content.split(/\r?\n/);
    const startLine = typeof args.startLine === "number" && Number.isFinite(args.startLine)
      ? Math.max(1, Math.trunc(args.startLine))
      : 1;
    const maxLines = typeof args.maxLines === "number" && Number.isFinite(args.maxLines)
      ? Math.max(1, Math.min(500, Math.trunc(args.maxLines)))
      : 200;
    const selected = lines.slice(startLine - 1, startLine - 1 + maxLines);
    const lineEnd = startLine + selected.length - 1;
    const truncated = lineEnd < lines.length;
    return {
      ok: true,
      status: "completed",
      result: {
        path: resolved.relativePath,
        reason: typeof args.reason === "string" ? args.reason : undefined,
        root,
        conversationId: context.conversationId,
        bytes: stat.size,
        startLine,
        endLine: lineEnd,
        totalLines: lines.length,
        truncated,
        content: selected.join("\n")
      }
    };
  } catch (error) {
    return {
      ok: false,
      status: "failed",
      result: { error: error instanceof Error ? error.message : String(error), path: resolved.relativePath }
    };
  }
}

export async function executeWriteFile(argumentsJson: string, context: BuiltinToolContext): Promise<ToolExecutionResult> {
  const args = safeJson(argumentsJson) as { path?: unknown; content?: unknown; createDirs?: unknown; reason?: unknown };
  const requestedPath = typeof args.path === "string" ? args.path.trim() : "";
  if (!requestedPath) {
    return { ok: false, status: "failed", result: { error: "writeFile requires path." } };
  }
  if (typeof args.content !== "string") {
    return { ok: false, status: "failed", result: { error: "writeFile requires string content.", path: requestedPath } };
  }
  const root = await ensureConversationWorkspaceRoot(context.conversationId);
  const resolved = resolveWorkspacePath(root, requestedPath);
  if (!resolved.ok) {
    return { ok: false, status: "failed", result: { error: resolved.error } };
  }
  try {
    const before = await fs.stat(resolved.fullPath).catch(() => undefined);
    if (before && !before.isFile()) {
      return { ok: false, status: "failed", result: { error: "writeFile path exists but is not a file.", path: resolved.relativePath } };
    }
    if (args.createDirs === true) await fs.mkdir(path.dirname(resolved.fullPath), { recursive: true });
    await fs.writeFile(resolved.fullPath, args.content, "utf8");
    return {
      ok: true,
      status: "completed",
      result: {
        path: resolved.relativePath,
        reason: typeof args.reason === "string" ? args.reason : undefined,
        root,
        conversationId: context.conversationId,
        bytes: Buffer.byteLength(args.content, "utf8"),
        created: !before,
        updated: Boolean(before)
      }
    };
  } catch (error) {
    return {
      ok: false,
      status: "failed",
      result: { error: error instanceof Error ? error.message : String(error), path: resolved.relativePath }
    };
  }
}

export function conversationWorkspaceRoot(conversationId: string): string {
  const base = process.env.ZLEAP_FILE_WORKSPACE_ROOT ?? defaultFileWorkspaceBaseRoot();
  return path.join(path.resolve(process.cwd(), base), safeConversationPathSegment(conversationId));
}

export function defaultFileWorkspaceBaseRoot(): string {
  const homeDir = os.homedir() || process.cwd();
  return path.join(homeDir, "Documents", "Zleap", "conversations");
}

async function ensureConversationWorkspaceRoot(conversationId: string): Promise<string> {
  const root = conversationWorkspaceRoot(conversationId);
  await fs.mkdir(root, { recursive: true });
  return root;
}

function safeConversationPathSegment(conversationId: string): string {
  const hash = crypto.createHash("sha256").update(conversationId).digest("hex").slice(0, 8);
  const cleaned = (conversationId.trim() || "conversation")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^\.+/, "_")
    .slice(0, 80) || "conversation";
  return `${cleaned}-${hash}`;
}

async function findContentMatch(filePath: string, lowerQuery: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > maxFileBytes) return undefined;
    const content = await fs.readFile(filePath, "utf8");
    const lowerContent = content.toLowerCase();
    const index = lowerContent.indexOf(lowerQuery);
    if (index < 0) return undefined;
    const start = Math.max(0, index - 80);
    const end = Math.min(content.length, index + lowerQuery.length + 160);
    return content.slice(start, end).replace(/\s+/g, " ").trim();
  } catch {
    return undefined;
  }
}

function runShellCommand(command: string, cwd: string, timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    exec(command, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      windowsHide: true
    }, (error, stdout, stderr) => {
      const execError = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean } | null;
      const code = typeof execError?.code === "number" ? execError.code : execError ? 1 : 0;
      resolve({
        exitCode: code,
        stdout,
        stderr,
        timedOut: Boolean(execError?.killed)
      });
    });
  });
}

function resolveWorkspacePath(root: string, requestedPath: string): { ok: true; fullPath: string; relativePath: string } | { ok: false; error: string } {
  const fullPath = path.resolve(root, requestedPath);
  const insideRoot = fullPath === root || fullPath.startsWith(root + path.sep);
  if (!insideRoot) {
    return {
      ok: false,
      error: `Path is outside the workspace root: ${requestedPath}`
    };
  }
  return {
    ok: true,
    fullPath,
    relativePath: path.relative(root, fullPath)
  };
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
