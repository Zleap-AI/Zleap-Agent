import { exec } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ToolExecutionResult } from "./tool-registry";

const ignoredDirs = new Set([".git", "node_modules", "dist", "data"]);
const maxSearchResults = 50;
const maxFileBytes = 1024 * 1024;

export async function executeSearchFiles(argumentsJson: string): Promise<ToolExecutionResult> {
  const args = safeJson(argumentsJson) as { query?: unknown };
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    return { ok: false, status: "failed", result: { error: "searchFiles requires query." } };
  }
  const root = process.cwd();
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
      count: results.length,
      results
    }
  };
}

export async function executeRunCommand(argumentsJson: string): Promise<ToolExecutionResult> {
  const args = safeJson(argumentsJson) as { command?: unknown };
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (!command) {
    return { ok: false, status: "failed", result: { error: "runCommand requires command." } };
  }
  const startedAt = new Date().toISOString();
  const result = await runShellCommand(command);
  return {
    ok: result.exitCode === 0,
    status: result.exitCode === 0 ? "completed" : "failed",
    result: {
      command,
      cwd: process.cwd(),
      startedAt,
      completedAt: new Date().toISOString(),
      ...result
    }
  };
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

function runShellCommand(command: string): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    exec(command, {
      cwd: process.cwd(),
      timeout: 30_000,
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

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
