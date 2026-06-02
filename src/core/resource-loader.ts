import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { conversationWorkspaceRoot } from "./builtin-tools";

export type LoadedInstructionResource = {
  kind: "zleap_agents" | "workspace_agents" | "root_agents";
  path: string;
  content: string;
};

export type LoadedPromptTemplate = {
  name: string;
  path: string;
  description?: string;
  argumentHint?: string;
  scope: "workspace" | "global";
};

export type LoadedFilesystemSkill = {
  name: string;
  path: string;
  description?: string;
  scope: "workspace" | "global";
};

export type WorkspaceResources = {
  root: string;
  workspaceId: string;
  instructions: LoadedInstructionResource[];
  promptTemplates: LoadedPromptTemplate[];
  filesystemSkills: LoadedFilesystemSkill[];
  skipped: Array<{ path: string; reason: string }>;
  parameterSyntax: string[];
  rules: string[];
};

type ParsedMarkdown = {
  frontmatter: Record<string, string>;
  body: string;
};

export type LoadedPromptTemplateFile = LoadedPromptTemplate & {
  body: string;
};

export type LoadedFilesystemSkillFile = LoadedFilesystemSkill & {
  body: string;
};

export type ResourceCommand = {
  kind: "prompt_template" | "filesystem_skill";
  name: string;
  args: string[];
};

const MAX_INSTRUCTION_CHARS = 12_000;

export function workspaceResourceRoot(conversationId: string): string {
  return path.resolve(process.env.ZLEAP_RESOURCE_ROOT ?? conversationWorkspaceRoot(conversationId));
}

export function loadWorkspaceResources(input: {
  conversationId: string;
  workspaceId: string;
}): WorkspaceResources {
  const root = workspaceResourceRoot(input.conversationId);
  const skipped: WorkspaceResources["skipped"] = [];
  const instructions: LoadedInstructionResource[] = [];

  const addInstruction = (kind: LoadedInstructionResource["kind"], relativePath: string) => {
    const absolutePath = safeJoin(root, relativePath);
    if (!absolutePath) {
      skipped.push({ path: relativePath, reason: "path is outside resource root" });
      return;
    }
    const content = readUtf8IfExists(absolutePath);
    if (content === undefined) return;
    instructions.push({
      kind,
      path: relativePath,
      content: truncate(content, MAX_INSTRUCTION_CHARS)
    });
  };

  addInstruction("zleap_agents", path.join(".zleap", "AGENTS.md"));
  const workspaceResourcePath = workspaceAgentsPath(input.workspaceId);
  if (workspaceResourcePath) {
    addInstruction("workspace_agents", workspaceResourcePath);
  } else {
    skipped.push({ path: `.zleap/workspaces/${input.workspaceId}.md`, reason: "workspaceId is not a safe resource filename" });
  }
  addInstruction("root_agents", "AGENTS.md");

  const promptTemplates = [
    ...loadPromptTemplates(root, path.join(".zleap", "prompts"), "workspace", skipped),
    ...loadGlobalPromptTemplates(skipped)
  ];
  const workspaceSkills = loadFilesystemSkills(root, path.join(".zleap", "skills"), "workspace", skipped);
  const globalSkills = loadGlobalFilesystemSkills(skipped);

  return {
    root,
    workspaceId: input.workspaceId,
    instructions,
    promptTemplates,
    filesystemSkills: [...workspaceSkills, ...globalSkills],
    skipped,
    parameterSyntax: ["$1", "$2", "$@", "$ARGUMENTS", "${@:N}", "${@:N:L}"],
    rules: [
      "Load .zleap/AGENTS.md before workspace-specific resources.",
      "Load .zleap/workspaces/<workspaceId>.md before root AGENTS.md.",
      "Do not load CLAUDE.md by default.",
      "Prompt templates and filesystem skills are injected as indexes; read or expand the referenced file before relying on full content."
    ]
  };
}

export function parseMarkdownWithFrontmatter(content: string): ParsedMarkdown {
  const normalized = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return { frontmatter: {}, body: normalized };
  }
  const bodyStart = match[0].length;
  return {
    frontmatter: parseSimpleFrontmatter(match[1]),
    body: normalized.slice(bodyStart)
  };
}

export function expandPromptTemplate(body: string, args: string[]): string {
  const all = args.join(" ");
  return body
    .replace(/\$\{@:([1-9]\d*):([1-9]\d*)\}/g, (_match, startRaw: string, lengthRaw: string) => {
      const start = Math.max(0, Number(startRaw) - 1);
      const length = Math.max(0, Number(lengthRaw));
      return args.slice(start, start + length).join(" ");
    })
    .replace(/\$\{@:([1-9]\d*)\}/g, (_match, startRaw: string) => {
      const start = Math.max(0, Number(startRaw) - 1);
      return args.slice(start).join(" ");
    })
    .replace(/\$ARGUMENTS/g, all)
    .replace(/\$@/g, all)
    .replace(/\$([1-9]\d*)/g, (_match, indexRaw: string) => args[Number(indexRaw) - 1] ?? "");
}

export function parsePromptTemplateCommand(message: string): { name: string; args: string[] } | undefined {
  const command = parseResourceCommand(message);
  return command?.kind === "prompt_template" ? { name: command.name, args: command.args } : undefined;
}

export function parseResourceCommand(message: string): ResourceCommand | undefined {
  const trimmed = message.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return undefined;
  const match = trimmed.match(/^\/(?:(skill|prompt):)?([A-Za-z0-9_.-]+)(?:\s+([\s\S]*))?$/);
  if (!match) return undefined;
  return {
    kind: match[1] === "skill" ? "filesystem_skill" : "prompt_template",
    name: match[2],
    args: splitTemplateArguments(match[3] ?? "")
  };
}

export function loadPromptTemplateFile(input: {
  conversationId: string;
  name: string;
}): LoadedPromptTemplateFile | undefined {
  if (!isSafeTemplateName(input.name)) return undefined;
  const workspaceRoot = workspaceResourceRoot(input.conversationId);
  const workspaceTemplate = loadPromptTemplateFileFromRoot(workspaceRoot, path.join(".zleap", "prompts", `${input.name}.md`), "workspace");
  if (workspaceTemplate) return workspaceTemplate;
  const globalRoot = process.env.ZLEAP_GLOBAL_RESOURCE_ROOT ?? path.join(os.homedir(), ".zleap");
  return loadPromptTemplateFileFromRoot(globalRoot, path.join("prompts", `${input.name}.md`), "global", true);
}

export function loadFilesystemSkillFile(input: {
  conversationId: string;
  name: string;
}): LoadedFilesystemSkillFile | undefined {
  if (!isSafeTemplateName(input.name)) return undefined;
  const workspaceRoot = workspaceResourceRoot(input.conversationId);
  const workspaceSkill = loadFilesystemSkillFileFromRoot(
    workspaceRoot,
    path.join(".zleap", "skills", input.name, "SKILL.md"),
    input.name,
    "workspace"
  );
  if (workspaceSkill) return workspaceSkill;
  const globalRoot = process.env.ZLEAP_GLOBAL_RESOURCE_ROOT ?? path.join(os.homedir(), ".zleap");
  return loadFilesystemSkillFileFromRoot(globalRoot, path.join("skills", input.name, "SKILL.md"), input.name, "global", true);
}

export function expandFilesystemSkillFile(skill: LoadedFilesystemSkillFile, args: string[]): string {
  const expandedBody = expandPromptTemplate(skill.body, args).trim();
  const argumentText = args.join(" ");
  return [
    `Apply filesystem skill: ${skill.name}`,
    `Skill path: ${skill.path}`,
    skill.description ? `Description: ${skill.description}` : "",
    argumentText ? `Arguments: ${argumentText}` : "",
    "",
    expandedBody
  ].filter((line) => line.length > 0).join("\n");
}

function loadPromptTemplates(
  root: string,
  relativeDir: string,
  scope: LoadedPromptTemplate["scope"],
  skipped: WorkspaceResources["skipped"]
): LoadedPromptTemplate[] {
  const dir = safeJoin(root, relativeDir);
  if (!dir || !directoryExists(dir)) return [];
  return safeListMarkdownFiles(dir, relativeDir, skipped).map(({ absolutePath, relativePath }) => {
    const parsed = parseMarkdownWithFrontmatter(readUtf8IfExists(absolutePath) ?? "");
    return {
      name: path.basename(relativePath, ".md"),
      path: relativePath,
      description: parsed.frontmatter.description,
      argumentHint: parsed.frontmatter["argument-hint"] ?? parsed.frontmatter.argumentHint,
      scope
    };
  });
}

function loadGlobalPromptTemplates(skipped: WorkspaceResources["skipped"]): LoadedPromptTemplate[] {
  const globalRoot = process.env.ZLEAP_GLOBAL_RESOURCE_ROOT ?? path.join(os.homedir(), ".zleap");
  if (!directoryExists(globalRoot)) return [];
  return loadPromptTemplates(globalRoot, "prompts", "global", skipped).map((template) => ({
    ...template,
    path: path.join(globalRoot, template.path)
  }));
}

function loadFilesystemSkills(
  root: string,
  relativeDir: string,
  scope: LoadedFilesystemSkill["scope"],
  skipped: WorkspaceResources["skipped"]
): LoadedFilesystemSkill[] {
  const dir = safeJoin(root, relativeDir);
  if (!dir || !directoryExists(dir)) return [];
  const entries = safeReadDir(dir, relativeDir, skipped)
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
  const skills: LoadedFilesystemSkill[] = [];
  for (const entry of entries) {
    const relativePath = path.join(relativeDir, entry.name, "SKILL.md");
    const absolutePath = safeJoin(root, relativePath);
    if (!absolutePath) {
      skipped.push({ path: relativePath, reason: "path is outside resource root" });
      continue;
    }
    const content = readUtf8IfExists(absolutePath);
    if (content === undefined) continue;
    const parsed = parseMarkdownWithFrontmatter(content);
    skills.push({
      name: parsed.frontmatter.name ?? entry.name,
      path: relativePath,
      description: parsed.frontmatter.description,
      scope
    });
  }
  return skills;
}

function loadGlobalFilesystemSkills(skipped: WorkspaceResources["skipped"]): LoadedFilesystemSkill[] {
  const globalRoot = process.env.ZLEAP_GLOBAL_RESOURCE_ROOT ?? path.join(os.homedir(), ".zleap");
  if (!directoryExists(globalRoot)) return [];
  return loadFilesystemSkills(globalRoot, "skills", "global", skipped).map((skill) => ({
    ...skill,
    path: path.join(globalRoot, skill.path)
  }));
}

function loadPromptTemplateFileFromRoot(
  root: string,
  relativePath: string,
  scope: LoadedPromptTemplate["scope"],
  allowAbsoluteRoot = false
): LoadedPromptTemplateFile | undefined {
  if (!allowAbsoluteRoot && !directoryExists(root)) return undefined;
  const absolutePath = safeJoin(root, relativePath);
  if (!absolutePath) return undefined;
  const content = readUtf8IfExists(absolutePath);
  if (content === undefined) return undefined;
  const parsed = parseMarkdownWithFrontmatter(content);
  return {
    name: path.basename(relativePath, ".md"),
    path: scope === "global" ? absolutePath : relativePath,
    description: parsed.frontmatter.description,
    argumentHint: parsed.frontmatter["argument-hint"] ?? parsed.frontmatter.argumentHint,
    scope,
    body: parsed.body
  };
}

function loadFilesystemSkillFileFromRoot(
  root: string,
  relativePath: string,
  fallbackName: string,
  scope: LoadedFilesystemSkill["scope"],
  allowAbsoluteRoot = false
): LoadedFilesystemSkillFile | undefined {
  if (!allowAbsoluteRoot && !directoryExists(root)) return undefined;
  const absolutePath = safeJoin(root, relativePath);
  if (!absolutePath) return undefined;
  const content = readUtf8IfExists(absolutePath);
  if (content === undefined) return undefined;
  const parsed = parseMarkdownWithFrontmatter(content);
  return {
    name: parsed.frontmatter.name ?? fallbackName,
    path: scope === "global" ? absolutePath : relativePath,
    description: parsed.frontmatter.description,
    scope,
    body: parsed.body
  };
}

function splitTemplateArguments(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let escaping = false;
  for (const char of value.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaping) current += "\\";
  if (current) args.push(current);
  return args;
}

function safeListMarkdownFiles(dir: string, relativeDir: string, skipped: WorkspaceResources["skipped"]): Array<{ absolutePath: string; relativePath: string }> {
  return safeReadDir(dir, relativeDir, skipped)
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => ({
      absolutePath: path.join(dir, entry.name),
      relativePath: path.join(relativeDir, entry.name)
    }));
}

function safeReadDir(dir: string, displayPath: string, skipped: WorkspaceResources["skipped"]): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    skipped.push({ path: displayPath, reason: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

function parseSimpleFrontmatter(header: string): Record<string, string> {
  const record: Record<string, string> = {};
  for (const line of header.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    record[match[1]] = match[2].replace(/^["']|["']$/g, "").trim();
  }
  return record;
}

function workspaceAgentsPath(workspaceId: string): string | undefined {
  if (!/^[A-Za-z0-9_.-]+$/.test(workspaceId)) return undefined;
  return path.join(".zleap", "workspaces", `${workspaceId}.md`);
}

function isSafeTemplateName(name: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(name);
}

function safeJoin(root: string, relativePath: string): string | undefined {
  const absolute = path.resolve(root, relativePath);
  const resolvedRoot = path.resolve(root);
  return absolute === resolvedRoot || absolute.startsWith(`${resolvedRoot}${path.sep}`) ? absolute : undefined;
}

function directoryExists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function readUtf8IfExists(filePath: string): string | undefined {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return undefined;
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}
