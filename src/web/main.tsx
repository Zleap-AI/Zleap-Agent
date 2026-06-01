import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AgentConfig, AgentRunOutput, ApprovalRequest, AuditLog, ConversationSummary, ContextSegment, DatabaseTableRows, DatabaseTableSummary, LLMCallSnapshot, McpServerDefinition, MemoryRow, RuntimeConfigItem, StoredMessage, ToolCallLog, ToolDefinition, WorkspaceDefinition, WorkspaceProcessItem, WorkspaceSession } from "../types";
import "./styles.css";

type Tab = "chat" | "workspace" | "memory" | "logs" | "tables" | "config" | "concept";
type ChatMessage = {
  id: string;
  role: string;
  content: string;
  createdAt?: string;
  runId?: string;
  inspectLlmCallId?: string;
  workspaceId?: string;
  eventKind?: string;
  title?: string;
  toolNames?: string[];
  processItems?: WorkspaceProcessItem[];
  status?: string;
  streaming?: boolean;
  failed?: boolean;
  requestText?: string;
  turnOutput?: AgentRunOutput;
};

type ConversationTrace = {
  sessions: WorkspaceSession[];
  llmCalls: LLMCallSnapshot[];
  toolCalls: ToolCallLog[];
  auditLogs: AuditLog[];
  approvalRequests: ApprovalRequest[];
  contextSegments: ContextSegment[];
  memoryWrites: MemoryRow[];
};

const CACHE_KEY = "zleap.web.state.v2";
const USER_UI_CACHE_KEY = "zleap.user.ui.state.v1";
const DEFAULT_BASE_URL = "https://api.302ai.com";
const OLD_SYSTEM_PROMPT_MARKER = "你是运行在 Zleap runtime 内的 agent";
const OLD_PERSONALITY_PROMPT_MARKER = "workspace 选择和 context 组织";
const TAB_LABELS: Record<Tab, string> = {
  chat: "对话",
  workspace: "工作空间",
  memory: "记忆",
  logs: "日志",
  tables: "数据表",
  config: "配置",
  concept: "概念介绍"
};

type CachedState = {
  agentId?: string;
  userId?: string;
  userRole?: "user" | "creator";
  conversationId?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  contextPanelWidth?: number;
  messages?: ChatMessage[];
  output?: AgentRunOutput | null;
  retryMessage?: string;
  selectedTurnId?: string;
  selectedLlmCallId?: string;
  agentDraft?: Partial<AgentConfig>;
};

type UserUiCachedState = {
  selectedAgentId?: string;
  userId?: string;
  userRole?: "user" | "creator";
  conversationId?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  developerMode?: boolean;
  sidebarCollapsed?: boolean;
};

type UserRunProcess = {
  id: string;
  runId: string;
  workspaceId: string;
  eventKind: string;
  title: string;
  text: string;
  status?: string;
  toolNames?: string[];
  items?: WorkspaceProcessItem[];
  createdAt?: string;
};

type SearchResultPreview = {
  title: string;
  url?: string;
  snippet?: string;
  date?: string;
  source?: string;
};

type SearchResultSummary = {
  total?: number;
  error?: string;
  items: SearchResultPreview[];
};

type ProcessReadableDetail = {
  label: string;
  value: string;
  url?: string;
};

type AskUserPrompt = {
  id: string;
  question: string;
  choices: string[];
  reason?: string;
};

type SettingsSection = "basic" | "agents" | "workspaces" | "memory" | "advanced";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createLocalId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function riskLabel(value: string): string {
  if (value === "low") return "低";
  if (value === "medium") return "中";
  if (value === "high") return "高";
  return value;
}

function bindingLabel(value: ToolDefinition["bindingType"]): string {
  if (value === "runtime") return "内置";
  if (value === "mcp") return "MCP";
  return "占位";
}

function workspaceStatusLabel(value: WorkspaceSession["status"]): string {
  if (value === "running") return "运行中";
  if (value === "completed") return "已完成";
  if (value === "failed") return "失败";
  if (value === "blocked") return "已阻塞";
  if (value === "needs_user_input") return "需要用户补充";
  if (value === "needs_approval") return "等待审批";
  return value;
}

function toolCallStatusLabel(value: ToolCallLog["status"]): string {
  if (value === "completed") return "已完成";
  if (value === "failed") return "失败";
  if (value === "blocked") return "已阻塞";
  if (value === "pending") return "等待中";
  return value;
}

function toolCallStatusClass(value: ToolCallLog["status"]): string {
  if (value === "completed") return "success";
  if (value === "pending") return "pending";
  return "danger";
}

type WorkspaceView = { primary: string; detail: string; involved: string[] };

function describeWorkspaceView(output: AgentRunOutput | null): WorkspaceView {
  if (!output) return { primary: "暂无", detail: "", involved: [] };
  const sessions = output.workspaceTrace ?? [];
  const lastCapabilitySession = [...sessions].reverse().find((session) => session.workspaceId !== "main");
  const displaySession = lastCapabilitySession ?? sessions.at(-1);
  const involved = Array.from(new Set(sessions.map((session) => session.workspaceId)));
  if (!displaySession) return { primary: output.activeWorkspaceId, detail: "", involved };
  const statusText = workspaceStatusLabel(displaySession.status);
  const returnedToMain = displaySession.workspaceId !== output.activeWorkspaceId;
  return {
    primary: displaySession.workspaceId,
    detail: returnedToMain
      ? `状态：${statusText}；运行结束后回到 ${output.activeWorkspaceId}`
      : `状态：${statusText}`,
    involved
  };
}

function sessionStatusForWorkspace(output: AgentRunOutput | null, workspaceId: string): string {
  const session = [...(output?.workspaceTrace ?? [])].reverse().find((item) => item.workspaceId === workspaceId);
  return session ? workspaceStatusLabel(session.status) : "";
}

function describeSelectedWorkspaceView(input: {
  output: AgentRunOutput | null;
  message?: ChatMessage;
  llmCallId: string;
  contextSegments: ContextSegment[];
}): WorkspaceView {
  const involved = Array.from(new Set((input.output?.workspaceTrace ?? []).map((session) => session.workspaceId)));
  if (input.message?.workspaceId) {
    const statusText = input.message.status ? workspaceStatusLabel(input.message.status as WorkspaceSession["status"]) : sessionStatusForWorkspace(input.output, input.message.workspaceId);
    return {
      primary: input.message.workspaceId,
      detail: statusText ? `选中消息 · 状态：${statusText}` : "选中消息关联的工作空间",
      involved
    };
  }
  if (input.llmCallId) {
    const segments = segmentsForLlmCall(input.contextSegments, input.llmCallId);
    const workspaceId = workspaceIdForLlmCall(segments);
    if (workspaceId && workspaceId !== "未知") {
      const statusText = sessionStatusForWorkspace(input.output, workspaceId);
      return {
        primary: workspaceId,
        detail: statusText ? `选中 LLM 调用 · 状态：${statusText}` : "选中 LLM 调用关联的工作空间",
        involved
      };
    }
  }
  return describeWorkspaceView(input.output);
}

function messageRoleLabel(item: ChatMessage): string {
  if (item.role === "工作空间" && item.workspaceId) return `${item.workspaceId} 工作空间`;
  if (item.role === "运行过程") return "运行过程";
  return item.role;
}

function trimOneLine(value: string, maxLength = 180): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}...`;
}

function summarizeArgumentsPreview(argumentsJson: string | undefined): string {
  if (!argumentsJson) return "";
  try {
    const parsed = JSON.parse(argumentsJson) as Record<string, unknown>;
    const preferredKeys = ["query", "q", "keyword", "keywords", "command", "url", "path", "workspaceId", "summary", "title"];
    for (const key of preferredKeys) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim()) return trimOneLine(value);
      if (Array.isArray(value) && value.length > 0) return trimOneLine(value.map((item) => String(item)).join(", "));
    }
    return trimOneLine(JSON.stringify(parsed));
  } catch {
    return trimOneLine(argumentsJson);
  }
}

function extractToolReason(argumentsJson: string | undefined): string | undefined {
  if (!argumentsJson) return undefined;
  try {
    const parsed = JSON.parse(argumentsJson) as Record<string, unknown>;
    const reason = parsed.reason;
    return typeof reason === "string" && reason.trim() ? reason.trim() : undefined;
  } catch {
    return undefined;
  }
}

function parseJsonString(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function searchResultFromRecord(record: Record<string, unknown>): SearchResultPreview | null {
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const urlValue = record.link ?? record.url ?? record.href;
  const url = typeof urlValue === "string" ? urlValue.trim() : "";
  const snippetValue = record.snippet ?? record.summary ?? record.description ?? record.content;
  const snippet = typeof snippetValue === "string" ? snippetValue.trim() : "";
  if (!title && !url && !snippet) return null;
  const date = typeof record.date === "string" ? record.date : typeof record.publishedAt === "string" ? record.publishedAt : undefined;
  const source = Array.isArray(record.authors) && record.authors.length > 0
    ? record.authors.map((item) => String(item)).join(", ")
    : typeof record.source === "string"
      ? record.source
      : undefined;
  return {
    title: title || url || trimOneLine(snippet, 80) || "搜索结果",
    url: url || undefined,
    snippet: snippet || undefined,
    date,
    source
  };
}

function collectSearchResults(value: unknown, output: SearchResultSummary, depth = 0): void {
  if (depth > 8 || value === undefined || value === null) return;
  if (typeof value === "string") {
    const parsed = parseJsonString(value);
    if (parsed !== value) collectSearchResults(parsed, output, depth + 1);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSearchResults(item, output, depth + 1);
    return;
  }
  if (typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  if (typeof record.total === "number") output.total = record.total;
  if (typeof record.errMsg === "string") output.error = record.errMsg;
  if (typeof record.error === "string") output.error = record.error;

  const candidate = searchResultFromRecord(record);
  if (candidate && (candidate.url || candidate.snippet)) {
    output.items.push(candidate);
    return;
  }

  const arrayKeys = ["webpages", "webPages", "results", "items", "data", "documents"];
  for (const key of arrayKeys) {
    const item = record[key];
    if (Array.isArray(item)) collectSearchResults(item, output, depth + 1);
  }

  const nestedKeys = ["result", "structuredContent", "content", "text", "body", "payload"];
  for (const key of nestedKeys) {
    const item = record[key];
    if (item !== undefined) collectSearchResults(item, output, depth + 1);
  }
}

function searchResultSummaryFromJson(resultJson: string | undefined): SearchResultSummary {
  const summary: SearchResultSummary = { items: [] };
  if (!resultJson) return summary;
  collectSearchResults(parseJsonString(resultJson), summary);
  const unique = new Map<string, SearchResultPreview>();
  for (const item of summary.items) {
    const key = item.url || item.title;
    if (!unique.has(key)) unique.set(key, item);
  }
  summary.items = [...unique.values()];
  return summary;
}

function formatSearchResultSummary(resultJson: string | undefined): string {
  const summary = searchResultSummaryFromJson(resultJson);
  if (summary.items.length > 0) {
    const titles = summary.items.slice(0, 3).map((item) => item.title).join("；");
    const total = summary.total ?? summary.items.length;
    return `搜索到 ${total} 条结果：${titles}`;
  }
  if (summary.error) return `搜索失败：${summary.error}`;
  return "";
}

function looksLikeSearchPayload(record: Record<string, unknown>): boolean {
  return Boolean(
    Array.isArray(record.webpages)
    || Array.isArray(record.webPages)
    || record.searchParameters
    || (typeof record.toolName === "string" && isSearchLikeTool(record.toolName))
    || (typeof record.mcpToolName === "string" && isSearchLikeTool(record.mcpToolName))
  );
}

function extractResultText(value: unknown): string {
  if (typeof value === "string") {
    const parsed = parseJsonString(value);
    return parsed === value ? value : extractResultText(parsed);
  }
  if (Array.isArray(value)) {
    const first = value[0];
    return value.length === 0 ? "空结果" : `${value.length} 条结果：${extractResultText(first)}`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (looksLikeSearchPayload(record)) {
      const searchSummary: SearchResultSummary = { items: [] };
      collectSearchResults(record, searchSummary);
      if (searchSummary.items.length > 0) {
        const titles = searchSummary.items.slice(0, 3).map((item) => item.title).join("；");
        return `搜索到 ${searchSummary.total ?? searchSummary.items.length} 条结果：${titles}`;
      }
      if (searchSummary.error) return `错误：${searchSummary.error}`;
    }
    if (record.result !== undefined) return extractResultText(record.result);
    if (record.structuredContent !== undefined) return extractResultText(record.structuredContent);
    if (record.content !== undefined) return extractResultText(record.content);
    const preferredKeys = ["error", "stdout", "output", "summary", "answer", "text", "content", "snippet", "description", "title", "url"];
    for (const key of preferredKeys) {
      const item = record[key];
      if (typeof item === "string" && item.trim()) return item;
    }
    for (const [key, item] of Object.entries(record)) {
      if (["toolName", "mcpToolName", "mcpServerId"].includes(key)) continue;
      const extracted = extractResultText(item);
      if (extracted && extracted !== "{}") return extracted;
    }
    return JSON.stringify(record);
  }
  return value === undefined || value === null ? "" : String(value);
}

function summarizeResultPreview(resultJson: string | undefined): string {
  if (!resultJson) return "";
  try {
    return trimOneLine(extractResultText(JSON.parse(resultJson)), 220);
  } catch {
    return trimOneLine(resultJson, 220);
  }
}

function processItemFromToolLog(log: ToolCallLog, eventKind?: string): WorkspaceProcessItem {
  const argumentSummary = summarizeArgumentsPreview(log.argumentsJson);
  const resultSummary = isSearchLikeTool(log.toolName)
    ? formatSearchResultSummary(log.resultJson) || summarizeResultPreview(log.resultJson)
    : summarizeResultPreview(log.resultJson);
  return {
    toolName: log.toolName,
    reason: extractToolReason(log.argumentsJson),
    argumentsJson: log.argumentsJson,
    resultJson: log.resultJson,
    status: log.status,
    summary: eventKind === "tool_result"
      ? `${log.toolName}${resultSummary ? `: ${resultSummary}` : ""}`
      : `${log.toolName}${argumentSummary ? ` ${argumentSummary}` : ""}`
  };
}

function processItemsFromLlmCall(call: LLMCallSnapshot | undefined): WorkspaceProcessItem[] {
  if (!call) return [];
  const parsed = parseJsonText(call.responseJson) as { message?: { tool_calls?: Array<{ function?: { name?: unknown; arguments?: unknown } }> } };
  const toolCalls = parsed?.message?.tool_calls;
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls
    .map((toolCall) => {
      const toolName = typeof toolCall.function?.name === "string" ? toolCall.function.name : "tool";
      const argumentsJson = typeof toolCall.function?.arguments === "string" ? toolCall.function.arguments : "";
      return {
        toolName,
        reason: extractToolReason(argumentsJson),
        argumentsJson,
        summary: `${toolName}${summarizeArgumentsPreview(argumentsJson) ? ` ${summarizeArgumentsPreview(argumentsJson)}` : ""}`
      };
    });
}

function processItemsForMessage(
  item: ChatMessage,
  llmCallId: string,
  llmCalls: LLMCallSnapshot[],
  toolCalls: ToolCallLog[]
): WorkspaceProcessItem[] {
  if (item.processItems?.length) return item.processItems;
  if (item.eventKind !== "tool_call" && item.eventKind !== "tool_result") return [];

  if (item.eventKind === "tool_call") {
    const fromLlm = processItemsFromLlmCall(llmCalls.find((call) => call.id === llmCallId));
    if (fromLlm.length > 0) return fromLlm;
  }

  const names = item.toolNames ?? [];
  const expectedCount = Math.max(1, names.length);
  return toolCalls
    .filter((log) => (!item.workspaceId || log.workspaceId === item.workspaceId)
      && (names.length === 0 || names.includes(log.toolName)))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, expectedCount)
    .map((log) => processItemFromToolLog(log, item.eventKind));
}

function toolProcessMessagesForTurn(input: {
  runId: string;
  firstLlmCallId: string;
  llmCalls: LLMCallSnapshot[];
  toolCalls: ToolCallLog[];
}): ChatMessage[] {
  const turnCalls = llmCallsForTurn(input.firstLlmCallId, input.llmCalls);
  if (turnCalls.length === 0) return [];
  const firstCreatedAt = turnCalls[0]?.createdAt ?? "";
  const lastCompletedAt = turnCalls.at(-1)?.completedAt || turnCalls.at(-1)?.createdAt || "";
  const toolLogs = input.toolCalls
    .filter((log) => log.workspaceId === "main")
    .filter((log) => !firstCreatedAt || log.createdAt >= firstCreatedAt)
    .filter((log) => !lastCompletedAt || log.createdAt <= lastCompletedAt)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (toolLogs.length === 0) return [];

  const callItems = turnCalls
    .flatMap((call) => processItemsFromLlmCall(call));
  const resultItems = toolLogs.map((log) => processItemFromToolLog(log, "tool_result"));
  const firstToolCallLlmCallId = turnCalls.find((call) => processItemsFromLlmCall(call).length > 0)?.id ?? input.firstLlmCallId;
  const followUpLlmCallId = turnCalls.at(-1)?.id ?? firstToolCallLlmCallId;
  const toolNames = [...new Set(toolLogs.map((log) => log.toolName))];
  return [
    {
      id: createLocalId("main-tool-call"),
      runId: input.runId,
      role: "运行过程",
      workspaceId: "main",
      eventKind: "tool_call",
      title: "main 函数调用",
      toolNames,
      processItems: callItems.length ? callItems : toolLogs.map((log) => processItemFromToolLog(log, "tool_call")),
      inspectLlmCallId: firstToolCallLlmCallId,
      content: "**main 函数调用**"
    },
    {
      id: createLocalId("main-tool-result"),
      runId: input.runId,
      role: "运行过程",
      workspaceId: "main",
      eventKind: "tool_result",
      title: "main 工具结果",
      toolNames,
      processItems: resultItems,
      inspectLlmCallId: followUpLlmCallId,
      content: "**main 工具结果**"
    }
  ];
}

function processMessageSummary(item: ChatMessage, processItems: WorkspaceProcessItem[] = []): string {
  const workspaceId = item.workspaceId ?? "main";
  const toolCount = processItems.length || item.toolNames?.length || 0;
  if (item.eventKind === "entered") return `进入 ${workspaceId} 工作空间`;
  if (item.eventKind === "exit") return `${workspaceId} 工作空间已返回主流程`;
  if (item.eventKind === "tool_call") return `已运行 ${toolCount || 1} 条函数调用`;
  if (item.eventKind === "tool_result") return `已收到 ${toolCount || 1} 条工具结果`;
  return item.title || `${workspaceId} 运行过程`;
}

function prettyJsonText(value: string | undefined): string {
  if (!value) return "";
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function processItemLine(item: WorkspaceProcessItem, eventKind?: string): string {
  const reason = item.reason ? `｜理由：${trimOneLine(item.reason, 100)}` : "";
  if (eventKind === "tool_call") return `已运行 ${item.summary}${reason}`;
  if (eventKind === "tool_result") return `结果 ${item.summary}${reason}`;
  return item.summary;
}

function processMessageDetail(item: ChatMessage, processItems: WorkspaceProcessItem[] = []): string {
  if (processItems.length) {
    const header = [
      item.title ? `标题：${item.title}` : "",
      item.workspaceId ? `工作空间：${item.workspaceId}` : "",
      item.eventKind ? `事件：${item.eventKind}` : "",
      item.status ? `状态：${item.status}` : ""
    ].filter(Boolean).join("\n");
    const details = processItems.map((processItem, index) => {
      const content = item.eventKind === "tool_result"
        ? prettyJsonText(processItem.resultJson)
        : prettyJsonText(processItem.argumentsJson);
      const label = item.eventKind === "tool_result" ? "结果" : "参数";
      return [
        `${index + 1}. ${processItem.toolName}`,
        processItem.reason ? `理由：${processItem.reason}` : "",
        `摘要：${processItem.summary}`,
        content ? `${label}：\n${content}` : ""
      ].filter(Boolean).join("\n");
    }).join("\n\n");
    return [header, details].filter(Boolean).join("\n\n");
  }
  const lines = [
    item.title ? `标题：${item.title}` : "",
    item.workspaceId ? `工作空间：${item.workspaceId}` : "",
    item.eventKind ? `事件：${item.eventKind}` : "",
    item.status ? `状态：${item.status}` : "",
    item.toolNames?.length ? `函数：${item.toolNames.join(", ")}` : "",
    item.content
  ].filter(Boolean);
  return lines.join("\n\n");
}

function parseJsonText(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function segmentsForLlmCall(segments: ContextSegment[], llmCallId: string): ContextSegment[] {
  return segments
    .filter((segment) => segment.llmCallId === llmCallId)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

function segmentsWithToolSnapshot(segments: ContextSegment[], call?: LLMCallSnapshot): ContextSegment[] {
  if (!call?.toolsJson || segments.some((segment) => segment.segmentType === "tools")) {
    return segments;
  }
  const toolSegment: ContextSegment = {
    id: `synthetic-tools-${call.id}`,
    llmCallId: call.id,
    conversationId: call.conversationId,
    segmentType: "tools",
    title: "可调用工具",
    content: call.toolsJson,
    tokenEstimate: Math.max(1, Math.ceil(call.toolsJson.length / 4)),
    sortOrder: 25
  };
  return [
    ...segments,
    toolSegment
  ].sort((a, b) => a.sortOrder - b.sortOrder);
}

function workspaceIdForLlmCall(segments: ContextSegment[]): string {
  const workspaceSegment = segments.find((segment) => segment.segmentType === "workspace");
  if (workspaceSegment) {
    const parsed = parseJsonText(workspaceSegment.content) as { currentWorkspace?: { id?: unknown }; activeWorkspaceId?: unknown };
    if (typeof parsed?.currentWorkspace?.id === "string") return parsed.currentWorkspace.id;
    if (typeof parsed?.activeWorkspaceId === "string") return parsed.activeWorkspaceId;
  }
  const toolsSegment = segments.find((segment) => segment.segmentType === "tools");
  if (toolsSegment) {
    const parsed = parseJsonText(toolsSegment.content) as { activeWorkspaceId?: unknown };
    if (typeof parsed?.activeWorkspaceId === "string") return parsed.activeWorkspaceId;
  }
  return "未知";
}

function inferMessageLlmCallId(
  item: ChatMessage,
  index: number,
  messages: ChatMessage[],
  llmCalls: LLMCallSnapshot[],
  contextSegments: ContextSegment[]
): string {
  const fromTurn = item.turnOutput?.contextSegments?.[0]?.llmCallId;
  if (item.role === "用户" && fromTurn) return fromTurn;
  if (item.inspectLlmCallId) return item.inspectLlmCallId;
  if (llmCalls.length === 0) return fromTurn ?? "";

  if (item.role === "助手") {
    const previousUser = messages
      .slice(0, index)
      .reverse()
      .find((candidate) => candidate.role === "用户");
    const previousUserFirstCallId = previousUser?.turnOutput?.contextSegments?.[0]?.llmCallId
      ?? previousUser?.inspectLlmCallId
      ?? "";
    const turnCalls = llmCallsForTurn(previousUserFirstCallId, llmCalls);
    return turnCalls.at(-1)?.id ?? previousUserFirstCallId ?? "";
  }

  if (item.toolNames?.length) {
    const toolName = item.toolNames[0];
    const fromContext = contextSegments.find((segment) => segment.segmentType === "tool_result" && segment.content.includes(toolName));
    if (fromContext) return fromContext.llmCallId;
    const fromResponse = llmCalls.find((call) => call.responseJson.includes(toolName) || call.messagesJson.includes(toolName));
    if (fromResponse) return fromResponse.id;
  }

  if (item.workspaceId) {
    const workspaceCall = llmCalls.find((call) => {
      const segments = segmentsForLlmCall(contextSegments, call.id);
      return workspaceIdForLlmCall(segments) === item.workspaceId;
    });
    if (workspaceCall) return workspaceCall.id;
  }

  return llmCalls[Math.min(index, llmCalls.length - 1)]?.id ?? fromTurn ?? "";
}

function llmCallsForTurn(firstCallId: string, llmCalls: LLMCallSnapshot[]): LLMCallSnapshot[] {
  if (!firstCallId) return [];
  const firstIndex = llmCalls.findIndex((call) => call.id === firstCallId);
  return firstIndex >= 0 ? llmCalls.slice(firstIndex) : [];
}

const SYSTEM_TOOL_NAMES = new Set([
  "enterWorkspace",
  "exitWorkspace",
  "askUser",
  "finishTask",
  "searchMemory",
  "readMemory",
  "readSkill",
  "writeUserImpression",
  "writeAgentSelfImpression",
  "writeSkillMemory"
]);

const BUILT_IN_WORKSPACE_IDS = new Set(["main", "dev"]);
const DEFAULT_WORKSPACE_INPUT_KINDS = ["user_request", "workspace_task"];
const DEFAULT_WORKSPACE_OUTPUT_KINDS = ["workspace_result"];

function isSystemTool(tool: ToolDefinition): boolean {
  return tool.bindingType === "runtime" || SYSTEM_TOOL_NAMES.has(tool.name);
}

function defaultMcpBindingJson(): string {
  return JSON.stringify({
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
    timeoutMs: 30000
  }, null, 2);
}

function createMcpServerDraft(workspaceId: string): McpServerDefinition {
  const now = new Date().toISOString();
  return {
    id: `mcp-${workspaceId}-${Date.now()}`,
    workspaceId,
    name: "",
    transport: "stdio",
    command: "npx",
    argsJson: JSON.stringify(["-y", "@modelcontextprotocol/server-filesystem", "."], null, 2),
    envJson: "{}",
    cwd: ".",
    url: "",
    headersJson: "{}",
    timeoutMs: 30000,
    createdAt: now,
    updatedAt: now
  };
}

function mcpServerSummary(server: McpServerDefinition): string {
  if (server.transport === "streamable-http") return "远程 MCP Server";
  let args = "";
  try {
    const parsed = JSON.parse(server.argsJson || "[]") as unknown;
    if (Array.isArray(parsed)) args = parsed.map(String).join(" ");
  } catch {
    args = server.argsJson;
  }
  return [server.command, args].filter(Boolean).join(" ") || "未填写启动命令";
}

function createToolDraft(workspaceId: string): Partial<ToolDefinition> {
  return {
    id: `tool-${workspaceId}-${Date.now()}`,
    workspaceId,
    name: "",
    description: "",
    parametersJson: JSON.stringify({ type: "object", properties: {}, additionalProperties: false }, null, 2),
    riskLevel: "low",
    bindingType: "mcp",
    bindingJson: defaultMcpBindingJson(),
    mcpServerId: "",
    mcpToolName: ""
  };
}

function parseListText(value: string): string[] {
  return value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
}

function stringifyListText(value: string): string {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return parsed.join("\n");
  } catch {
    return value;
  }
  return value;
}

function updateWorkspaceListField(
  workspace: WorkspaceDefinition,
  field: "capabilitiesJson",
  value: string
): WorkspaceDefinition {
  return { ...workspace, [field]: JSON.stringify(parseListText(value)) };
}

function normalizeWorkspaceForSave(workspace: WorkspaceDefinition): WorkspaceDefinition {
  const description = workspace.description.trim();
  return {
    ...workspace,
    description,
    instructions: description,
    toolInstructions: "",
    inputKindsJson: JSON.stringify(DEFAULT_WORKSPACE_INPUT_KINDS),
    outputKindsJson: JSON.stringify(DEFAULT_WORKSPACE_OUTPUT_KINDS),
    manifest: {
      ...workspace.manifest,
      description,
      inputKinds: DEFAULT_WORKSPACE_INPUT_KINDS,
      outputKinds: DEFAULT_WORKSPACE_OUTPUT_KINDS
    }
  };
}

function loadCache(): CachedState {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) ?? "{}") as CachedState;
  } catch {
    return {};
  }
}

function loadUserUiCache(): UserUiCachedState {
  try {
    return JSON.parse(localStorage.getItem(USER_UI_CACHE_KEY) ?? "{}") as UserUiCachedState;
  } catch {
    return {};
  }
}

function isWideUserViewport(): boolean {
  return window.matchMedia("(min-width: 900px)").matches;
}

function initialSidebarCollapsed(cached: UserUiCachedState): boolean {
  if (isWideUserViewport()) return false;
  return Boolean(cached.sidebarCollapsed);
}

function normalizeCachedBaseUrl(value: string | undefined): string | undefined {
  if (!value) return value;
  const trimmed = value
    .trim()
    .replace(/^http:\/\/api\.302\.ai(?=[:/]|$)/i, "https://api.302ai.com")
    .replace(/^https:\/\/api\.302\.ai(?=[:/]|$)/i, "https://api.302ai.com")
    .replace(/^api\.302\.ai(?=[:/]|$)/i, "https://api.302ai.com")
    .replace(/\/+$/, "");
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withProtocol);
    if (url.hostname.toLowerCase() === "api.302.ai") {
      url.protocol = "https:";
      url.hostname = "api.302ai.com";
      return url.toString().replace(/\/+$/, "");
    }
    if (trimmed !== withProtocol) return url.toString().replace(/\/+$/, "");
  } catch {
    return trimmed;
  }
  return trimmed;
}

function chatCompletionsEndpoint(value: string | undefined): string {
  const normalized = normalizeCachedBaseUrl(value) ?? DEFAULT_BASE_URL;
  if (normalized.endsWith("/chat/completions")) return normalized;
  if (normalized.endsWith("/v1")) return `${normalized}/chat/completions`;
  return `${normalized}/v1/chat/completions`;
}

function saveCache(patch: CachedState): void {
  const next = { ...loadCache(), ...patch };
  next.baseUrl = normalizeCachedBaseUrl(next.baseUrl);
  localStorage.setItem(CACHE_KEY, JSON.stringify(next));
}

function saveUserUiCache(patch: UserUiCachedState): void {
  const next = { ...loadUserUiCache(), ...patch };
  next.baseUrl = normalizeCachedBaseUrl(next.baseUrl);
  localStorage.setItem(USER_UI_CACHE_KEY, JSON.stringify(next));
}

function clampContextPanelWidth(value: number): number {
  return Math.min(720, Math.max(320, Math.round(value)));
}

function normalizeCachedMessages(messages: ChatMessage[] | undefined): ChatMessage[] {
  const normalized = (messages ?? []).map((item) => ({
    ...item,
    id: item.id ?? createLocalId(item.role === "用户" ? "user-msg" : "assistant-msg")
  }));
  const failedRunIds = new Set(normalized.filter((item) => item.failed && item.runId).map((item) => item.runId as string));
  return normalized.filter((item, index) => {
    if (item.failed) return false;
    if (item.runId && failedRunIds.has(item.runId)) return false;
    const next = normalized[index + 1];
    if (item.role === "用户" && next?.failed && next.requestText === item.content) return false;
    return true;
  });
}

function sanitizeCachedAgentDraft(draft: Partial<AgentConfig> | undefined): Partial<AgentConfig> {
  const next = { ...(draft ?? {}) };
  if (next.systemPrompt?.includes(OLD_SYSTEM_PROMPT_MARKER) && !next.systemPrompt.includes("不要在面向用户")) {
    delete next.systemPrompt;
  }
  if (next.personalityPrompt?.includes(OLD_PERSONALITY_PROMPT_MARKER)) {
    delete next.personalityPrompt;
  }
  return next;
}

function renderInlineMarkdown(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const tokenPattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g;
  let lastIndex = 0;
  let index = 0;
  for (const match of text.matchAll(tokenPattern)) {
    const value = match[0];
    const start = match.index ?? 0;
    if (start > lastIndex) nodes.push(text.slice(lastIndex, start));

    if (value.startsWith("`")) {
      nodes.push(<code key={`${keyPrefix}-inline-${index}`}>{value.slice(1, -1)}</code>);
    } else if (value.startsWith("**")) {
      nodes.push(<strong key={`${keyPrefix}-bold-${index}`}>{renderInlineMarkdown(value.slice(2, -2), `${keyPrefix}-bold-${index}`)}</strong>);
    } else if (value.startsWith("*")) {
      nodes.push(<em key={`${keyPrefix}-em-${index}`}>{renderInlineMarkdown(value.slice(1, -1), `${keyPrefix}-em-${index}`)}</em>);
    } else {
      const link = value.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
      nodes.push(link
        ? <a key={`${keyPrefix}-link-${index}`} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>
        : value);
    }

    lastIndex = start + value.length;
    index += 1;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function renderParagraph(text: string, key: string): React.ReactNode {
  const lines = text.split("\n");
  return (
    <p key={key}>
      {lines.map((line, index) => (
        <React.Fragment key={`${key}-line-${index}`}>
          {index > 0 && <br />}
          {renderInlineMarkdown(line, `${key}-line-${index}`)}
        </React.Fragment>
      ))}
    </p>
  );
}

function renderMarkdownBlocks(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const lines = text.split(/\r?\n/);
  let paragraph: string[] = [];
  let list: string[] = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    nodes.push(renderParagraph(paragraph.join("\n"), `${keyPrefix}-p-${nodes.length}`));
    paragraph = [];
  };
  const flushList = () => {
    if (!list.length) return;
    nodes.push(
      <ul key={`${keyPrefix}-ul-${nodes.length}`}>
        {list.map((item, index) => <li key={`${keyPrefix}-li-${index}`}>{renderInlineMarkdown(item, `${keyPrefix}-li-${index}`)}</li>)}
      </ul>
    );
    list = [];
  };

  for (const line of lines) {
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    const item = line.match(/^\s*[-*]\s+(.+)$/);
    const quote = line.match(/^\s*>\s?(.+)$/);

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      const content = renderInlineMarkdown(heading[2], `${keyPrefix}-h-${nodes.length}`);
      nodes.push(level === 1
        ? <h1 key={`${keyPrefix}-h-${nodes.length}`}>{content}</h1>
        : level === 2
          ? <h2 key={`${keyPrefix}-h-${nodes.length}`}>{content}</h2>
          : <h3 key={`${keyPrefix}-h-${nodes.length}`}>{content}</h3>);
      continue;
    }
    if (item) {
      flushParagraph();
      list.push(item[1]);
      continue;
    }
    if (quote) {
      flushParagraph();
      flushList();
      nodes.push(<blockquote key={`${keyPrefix}-quote-${nodes.length}`}>{renderInlineMarkdown(quote[1], `${keyPrefix}-quote-${nodes.length}`)}</blockquote>);
      continue;
    }
    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  return nodes;
}

function MarkdownMessage({ content }: { content: string }) {
  const nodes: React.ReactNode[] = [];
  const fencePattern = /```([a-zA-Z0-9_-]+)?\r?\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let index = 0;
  for (const match of content.matchAll(fencePattern)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      nodes.push(...renderMarkdownBlocks(content.slice(lastIndex, start), `md-${index}`));
    }
    nodes.push(
      <pre key={`md-code-${index}`} className="code-block">
        {match[1] && <span className="code-language">{match[1]}</span>}
        <code>{match[2].replace(/\n$/, "")}</code>
      </pre>
    );
    lastIndex = start + match[0].length;
    index += 1;
  }
  if (lastIndex < content.length) nodes.push(...renderMarkdownBlocks(content.slice(lastIndex), `md-${index}`));
  return <div className="markdown-body">{nodes.length ? nodes : <p />}</div>;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error ?? response.statusText);
  return data as T;
}

function storedMessageToChatMessage(message: StoredMessage): ChatMessage {
  return {
    id: message.id,
    role: message.role === "user" ? "用户" : message.role === "assistant" ? "助手" : message.role,
    content: message.content,
    createdAt: message.createdAt
  };
}

function isSearchLikeTool(name: string): boolean {
  return /search|web|google|metaso|bing|查找|搜索/i.test(name);
}

function userProcessActivityLabel(item: UserRunProcess): string {
  const processItem = item.items?.[0];
  const toolName = processItem?.toolName ?? item.toolNames?.[0] ?? "";
  const argumentPreview = summarizeArgumentsPreview(processItem?.argumentsJson);
  const searchSummary = processItem && isSearchLikeTool(toolName) ? formatSearchResultSummary(processItem.resultJson) : "";
  const resultPreview = searchSummary || summarizeResultPreview(processItem?.resultJson);
  if (item.eventKind === "entered") return `进入 ${item.workspaceId} 工作空间`;
  if (item.eventKind === "exit") return `${item.workspaceId} 工作空间完成`;
  if (item.eventKind === "tool_call") {
    if (toolName && isSearchLikeTool(toolName)) return argumentPreview ? `正在搜索：${argumentPreview}` : "正在搜索";
    if (toolName) return argumentPreview ? `正在使用 ${toolName}：${argumentPreview}` : `正在使用 ${toolName}`;
    return item.title || "正在调用工具";
  }
  if (item.eventKind === "tool_result") {
    if (toolName && isSearchLikeTool(toolName)) return resultPreview ? `搜索到结果：${resultPreview}` : "已收到搜索结果";
    if (toolName) return resultPreview ? `${toolName} 返回：${resultPreview}` : `${toolName} 已返回结果`;
    return item.title || "已收到工具结果";
  }
  return item.text.trim() || item.title || `${item.workspaceId} 正在处理`;
}

function readableProcessDetails(item: UserRunProcess): ProcessReadableDetail[] {
  const details: ProcessReadableDetail[] = [];
  if (item.status) details.push({ label: "状态", value: workspaceStatusLabel(item.status as WorkspaceSession["status"]) });
  if (item.text.trim()) details.push({ label: "说明", value: trimOneLine(item.text, 260) });
  for (const processItem of item.items ?? []) {
    const argumentPreview = summarizeArgumentsPreview(processItem.argumentsJson);
    const action = processItem.status ? `${processItem.toolName} · ${toolCallStatusLabel(processItem.status as ToolCallLog["status"])}` : processItem.toolName;
    const searchSummary = isSearchLikeTool(processItem.toolName) ? searchResultSummaryFromJson(processItem.resultJson) : { items: [] };
    if (searchSummary.items.length > 0) {
      details.push({ label: action, value: `搜索到 ${searchSummary.total ?? searchSummary.items.length} 条结果` });
      for (const result of searchSummary.items.slice(0, 5)) {
        const meta = [result.source, result.date].filter(Boolean).join(" · ");
        details.push({
          label: result.title,
          value: [meta, result.snippet ? trimOneLine(result.snippet, 260) : ""].filter(Boolean).join("\n"),
          url: result.url
        });
      }
      continue;
    }
    const resultPreview = searchSummary.error ? `搜索失败：${searchSummary.error}` : summarizeResultPreview(processItem.resultJson);
    const summary = [
      processItem.reason ? `理由：${trimOneLine(processItem.reason, 140)}` : "",
      argumentPreview ? `正在处理：${argumentPreview}` : "",
      resultPreview ? `结果：${resultPreview}` : "",
      processItem.summary && processItem.summary !== argumentPreview && processItem.summary !== resultPreview ? processItem.summary : ""
    ].filter(Boolean).join("；");
    details.push({ label: action, value: summary || "已执行" });
  }
  if (details.length === 0) details.push({ label: "进展", value: userProcessActivityLabel(item) });
  return details;
}

function developerProcessDetails(item: UserRunProcess): ProcessReadableDetail[] {
  return readableProcessDetails(item);
}

function userProcessesFromTrace(trace: ConversationTrace, runId: string): UserRunProcess[] {
  return (trace.toolCalls ?? [])
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((log) => ({
      id: `trace-${log.id}`,
      runId,
      workspaceId: log.workspaceId,
      eventKind: "tool_result",
      title: `${log.toolName} 工具结果`,
      text: "",
      status: log.status,
      toolNames: [log.toolName],
      items: [processItemFromToolLog(log, "tool_result")],
      createdAt: log.createdAt
    }));
}

function userProcessGroupsFromTrace(trace: ConversationTrace, messages: ChatMessage[], runId: string): Record<string, UserRunProcess[]> {
  const assistantMessages = messages.filter((item) => item.role === "助手");
  if (assistantMessages.length === 0) return {};
  const groups: Record<string, UserRunProcess[]> = {};
  for (const processItem of userProcessesFromTrace(trace, runId)) {
    const anchorId = messageIdForProcessTime(processItem.createdAt, messages) ?? assistantMessages.at(-1)?.id;
    if (!anchorId) continue;
    groups[anchorId] = [...(groups[anchorId] ?? []), processItem];
  }
  for (const messageId of Object.keys(groups)) {
    groups[messageId] = groups[messageId].slice().sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  }
  return groups;
}

function messageIdForProcessTime(createdAt: string | undefined, messages: ChatMessage[]): string | undefined {
  const processTime = createdAt ? Date.parse(createdAt) : Number.NaN;
  if (Number.isNaN(processTime)) return undefined;
  let previousUserTime: number | undefined;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const currentTime = message.createdAt ? Date.parse(message.createdAt) : Number.NaN;
    if (message.role === "用户" && !Number.isNaN(currentTime)) {
      previousUserTime = currentTime;
      continue;
    }
    if (message.role !== "助手") continue;
    const nextUser = messages.slice(index + 1).find((candidate) => candidate.role === "用户" && candidate.createdAt);
    const nextUserTime = nextUser?.createdAt ? Date.parse(nextUser.createdAt) : Number.NaN;
    const turnStart = previousUserTime ?? Number.NEGATIVE_INFINITY;
    const turnEnd = Number.isNaN(nextUserTime) ? Number.POSITIVE_INFINITY : nextUserTime;
    if (processTime >= turnStart - 1000 && processTime < turnEnd + 1000) return message.id;
  }
  return messages.filter((item) => item.role === "助手").at(-1)?.id;
}

function askUserPayloadFromValue(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    const parsed = parseJsonString(value);
    return parsed === value ? undefined : askUserPayloadFromValue(parsed);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = askUserPayloadFromValue(item);
      if (found) return found;
    }
    return undefined;
  }
  if (!isJsonRecord(value)) return undefined;
  if (typeof value.question === "string" && Array.isArray(value.choices)) return value;
  for (const key of ["result", "structuredContent", "payload", "content", "text"]) {
    const found = askUserPayloadFromValue(value[key]);
    if (found) return found;
  }
  return undefined;
}

function askUserPromptFromProcess(item: UserRunProcess): AskUserPrompt | null {
  const processItem = item.items?.find((entry) => entry.toolName === "askUser");
  if (!processItem) return null;
  const payload = askUserPayloadFromValue(processItem.resultJson) ?? askUserPayloadFromValue(processItem.argumentsJson);
  if (!payload) return null;
  const question = typeof payload.question === "string" ? payload.question.trim() : "";
  const choices = Array.isArray(payload.choices)
    ? payload.choices.map((choice) => typeof choice === "string" ? choice.trim() : trimOneLine(JSON.stringify(choice), 180)).filter(Boolean)
    : [];
  if (!question || choices.length === 0) return null;
  return {
    id: item.id,
    question,
    choices,
    reason: typeof payload.reason === "string" ? payload.reason.trim() : undefined
  };
}

function latestAskUserPrompt(items: UserRunProcess[], messages: ChatMessage[], loading: boolean): AskUserPrompt | null {
  if (loading || messages.at(-1)?.role === "用户") return null;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const prompt = askUserPromptFromProcess(items[index]);
    if (prompt) return prompt;
  }
  return null;
}

function askQuestionAlreadyVisible(messages: ChatMessage[], prompt: AskUserPrompt | null): boolean {
  if (!prompt) return false;
  const last = messages.at(-1);
  if (last?.role !== "助手") return false;
  const visible = last.content.replace(/\s+/g, "");
  const question = prompt.question.replace(/\s+/g, "");
  return question.length > 0 && visible.includes(question.slice(0, Math.min(24, question.length)));
}

function isProcessTerminalStatus(status: string | undefined): boolean {
  return status === "completed" || status === "failed" || status === "blocked" || status === "needs_user_input" || status === "needs_approval";
}

function isProcessActive(item: UserRunProcess, allItems: UserRunProcess[], loading: boolean): boolean {
  if (!loading) return false;
  if (isProcessTerminalStatus(item.status)) return false;
  if (item.eventKind === "tool_result" || item.eventKind === "exit") return false;
  if (item.eventKind === "tool_call") {
    const toolNames = new Set(item.toolNames ?? item.items?.map((processItem) => processItem.toolName) ?? []);
    return !allItems.some((candidate) => candidate !== item
      && candidate.runId === item.runId
      && candidate.eventKind === "tool_result"
      && (candidate.toolNames ?? candidate.items?.map((processItem) => processItem.toolName) ?? []).some((toolName) => toolNames.has(toolName)));
  }
  if (item.eventKind === "entered") {
    return !allItems.some((candidate) => candidate !== item
      && candidate.runId === item.runId
      && candidate.workspaceId === item.workspaceId
      && candidate.eventKind === "exit");
  }
  return true;
}

function processPanelSummary(items: UserRunProcess[], loading: boolean): string {
  if (items.length === 0) return "运行过程";
  const active = items.find((item) => isProcessActive(item, items, loading));
  if (active) return userProcessActivityLabel(active);
  const searchCount = items.filter((item) => (item.toolNames ?? []).some(isSearchLikeTool)).length;
  if (searchCount > 0) return `运行过程 · ${searchCount} 次搜索 / ${items.length} 个步骤`;
  return `运行过程 · ${items.length} 个步骤`;
}

function memoryTypeLabel(value: string | undefined): string {
  if (value === "impression") return "关于我";
  if (value === "event") return "项目 / 事件";
  if (value === "skill") return "可复用经验";
  return value || "记忆";
}

function workspaceRiskText(value: WorkspaceDefinition["riskLevel"]): string {
  if (value === "low") return "普通";
  if (value === "medium") return "谨慎";
  return "高风险";
}

function newWorkspaceDraftForUser(userId: string): WorkspaceDefinition {
  const now = new Date().toISOString();
  return {
    id: `workspace-${Date.now()}`,
    name: "新的工作空间",
    description: "",
    capabilitiesJson: "[]",
    inputKindsJson: JSON.stringify(DEFAULT_WORKSPACE_INPUT_KINDS),
    outputKindsJson: JSON.stringify(DEFAULT_WORKSPACE_OUTPUT_KINDS),
    requiresApproval: 0,
    instructions: "",
    toolInstructions: "",
    memoryPolicyJson: JSON.stringify({
      eventRecallEnabled: true,
      skillRecallEnabled: true,
      eventWriteEnabled: true,
      skillWriteEnabled: true,
      maxEventMemories: 4,
      maxSkillMemories: 4
    }),
    riskLevel: "low",
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
    manifest: {
      id: "",
      name: "新的工作空间",
      description: "",
      capabilities: [],
      inputKinds: DEFAULT_WORKSPACE_INPUT_KINDS,
      outputKinds: DEFAULT_WORKSPACE_OUTPUT_KINDS,
      riskLevel: "low",
      requiresApproval: false
    },
    memoryPolicy: {
      eventRecallEnabled: true,
      skillRecallEnabled: true,
      eventWriteEnabled: true,
      skillWriteEnabled: true,
      maxEventMemories: 4,
      maxSkillMemories: 4
    },
    tools: []
  };
}

function newUserMemoryDraft(type: MemoryRow["memoryType"], userId: string, agentId: string, workspaceId = ""): Partial<MemoryRow> {
  return {
    memoryType: type,
    title: "",
    summary: "",
    detail: "",
    userId: type === "skill" ? undefined : userId,
    agentId,
    workspaceId: type === "skill" ? workspaceId || undefined : undefined,
    version: 1,
    metadataJson: "{}"
  };
}

function UserChatApp() {
  const cached = loadUserUiCache();
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState(cached.selectedAgentId ?? "default-agent");
  const [agent, setAgent] = useState<AgentConfig | null>(null);
  const [userId, setUserId] = useState(cached.userId ?? "user");
  const [userRole, setUserRole] = useState<"user" | "creator">(cached.userRole ?? "user");
  const [conversationId, setConversationId] = useState(cached.conversationId ?? `conv-${Date.now()}`);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationFilter, setConversationFilter] = useState("");
  const [baseUrl, setBaseUrl] = useState(normalizeCachedBaseUrl(cached.baseUrl) ?? DEFAULT_BASE_URL);
  const [model, setModel] = useState(cached.model ?? "gpt-5-mini");
  const [apiKey, setApiKey] = useState(cached.apiKey ?? "");
  const [developerMode, setDeveloperMode] = useState(Boolean(cached.developerMode));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(initialSidebarCollapsed(cached));
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("basic");
  const [settingsNotice, setSettingsNotice] = useState("");
  const [composerToolsOpen, setComposerToolsOpen] = useState(false);
  const [powerBusy, setPowerBusy] = useState(false);
  const [agentDraft, setAgentDraft] = useState<Partial<AgentConfig>>({});
  const [workspaces, setWorkspaces] = useState<WorkspaceDefinition[]>([]);
  const [workspaceDraft, setWorkspaceDraft] = useState<WorkspaceDefinition | null>(null);
  const [workspaceMcpServers, setWorkspaceMcpServers] = useState<McpServerDefinition[]>([]);
  const [workspaceMcpDraft, setWorkspaceMcpDraft] = useState<McpServerDefinition | null>(null);
  const [workspaceDiscoveredTools, setWorkspaceDiscoveredTools] = useState<Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>>([]);
  const [selectedWorkspaceDiscoveredTools, setSelectedWorkspaceDiscoveredTools] = useState<Set<string>>(new Set());
  const [memories, setMemories] = useState<MemoryRow[]>([]);
  const [memoryQuery, setMemoryQuery] = useState("");
  const [memoryTypeFilter, setMemoryTypeFilter] = useState("");
  const [memoryEditing, setMemoryEditing] = useState<Partial<MemoryRow> | null>(null);
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [processItemsByMessageId, setProcessItemsByMessageId] = useState<Record<string, UserRunProcess[]>>({});
  const [processPanelOpenByMessageId, setProcessPanelOpenByMessageId] = useState<Record<string, boolean>>({});
  const [processDetailOpenByItemId, setProcessDetailOpenByItemId] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [error, setError] = useState("");
  const [retryMessage, setRetryMessage] = useState("");
  const [menuConversationId, setMenuConversationId] = useState("");
  const [renamingConversationId, setRenamingConversationId] = useState("");
  const [renameDraft, setRenameDraft] = useState("");
  const currentRunControllerRef = useRef<AbortController | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);

  const currentConversation = conversations.find((item) => item.id === conversationId);
  const chatHeaderSubtitle = messages.length > 0 ? currentConversation?.title ?? "新对话" : "新对话";
  const allProcessItems = Object.values(processItemsByMessageId)
    .flat()
    .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  const processItemCount = allProcessItems.length;
  const filteredConversations = conversations.filter((item) => {
    const query = conversationFilter.trim().toLowerCase();
    if (!query) return true;
    return item.title.toLowerCase().includes(query);
  });

  useEffect(() => {
    const wideViewportQuery = window.matchMedia("(min-width: 900px)");
    const expandOnWideViewport = () => {
      if (!wideViewportQuery.matches) return;
      setSidebarCollapsed(false);
      setMobileSidebarOpen(false);
    };
    expandOnWideViewport();
    wideViewportQuery.addEventListener("change", expandOnWideViewport);
    return () => wideViewportQuery.removeEventListener("change", expandOnWideViewport);
  }, []);

  useEffect(() => {
    api<{ agents: AgentConfig[] }>("/api/agents")
      .then(({ agents: loadedAgents }) => {
        setAgents(loadedAgents);
        const loaded = loadedAgents.find((item) => item.id === selectedAgentId)
          ?? loadedAgents.find((item) => item.id === "default-agent")
          ?? loadedAgents[0];
        if (!loaded) throw new Error("没有可用智能体。");
        setSelectedAgentId(loaded.id);
        setAgent(loaded);
        setBaseUrl((current) => normalizeCachedBaseUrl(cached.baseUrl) ?? normalizeCachedBaseUrl(loaded.defaultBaseUrl) ?? current);
        setModel(cached.model ?? loaded.defaultModel);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    saveUserUiCache({
      selectedAgentId,
      userId,
      userRole,
      conversationId,
      baseUrl,
      model,
      apiKey,
      developerMode,
      sidebarCollapsed
    });
  }, [selectedAgentId, userId, userRole, conversationId, baseUrl, model, apiKey, developerMode, sidebarCollapsed]);

  useEffect(() => {
    if (!selectedAgentId) return;
    void refreshConversations(conversationId, true);
  }, [selectedAgentId, userId, userRole]);

  useEffect(() => {
    if (agent) setAgentDraft(agent);
  }, [agent?.id]);

  useEffect(() => {
    if (!settingsOpen) return;
    setSettingsNotice("");
    if (settingsSection === "workspaces") void loadUserWorkspaces();
    if (settingsSection === "memory") void loadUserMemories();
  }, [settingsOpen, settingsSection]);

  useEffect(() => {
    if (!settingsOpen || settingsSection !== "workspaces" || !workspaceDraft?.id) return;
    if (!workspaces.some((workspace) => workspace.id === workspaceDraft.id)) {
      setWorkspaceMcpServers([]);
      setWorkspaceMcpDraft(null);
      setWorkspaceDiscoveredTools([]);
      setSelectedWorkspaceDiscoveredTools(new Set());
      return;
    }
    void loadUserMcpServers(workspaceDraft.id);
    setWorkspaceDiscoveredTools([]);
    setSelectedWorkspaceDiscoveredTools(new Set());
  }, [settingsOpen, settingsSection, workspaceDraft?.id]);

  useEffect(() => {
    messageListRef.current?.scrollTo({ top: messageListRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, messages.at(-1)?.content, developerMode, processItemCount]);

  async function refreshConversations(preferredId = conversationId, shouldLoadMessages = true): Promise<ConversationSummary[]> {
    const params = new URLSearchParams({
      actorId: userId,
      actorRole: userRole,
      limit: "80"
    });
    if (selectedAgentId) params.set("agentId", selectedAgentId);
    const data = await api<{ conversations: ConversationSummary[] }>(`/api/conversations?${params.toString()}`);
    setConversations(data.conversations);
    const preferred = data.conversations.find((item) => item.id === preferredId);
    const nextId = preferred?.id ?? data.conversations[0]?.id ?? preferredId ?? `conv-${Date.now()}`;
    if (nextId && nextId !== conversationId) setConversationId(nextId);
    if (shouldLoadMessages && data.conversations.some((item) => item.id === nextId)) {
      await loadConversationMessages(nextId);
    } else if (!data.conversations.length && !messages.length) {
      setMessages([]);
      setProcessItemsByMessageId({});
      setProcessPanelOpenByMessageId({});
      setProcessDetailOpenByItemId({});
    }
    return data.conversations;
  }

  async function loadConversationMessages(targetId: string): Promise<void> {
    if (!targetId) return;
    setLoadingMessages(true);
    setError("");
    try {
      const params = new URLSearchParams({ actorId: userId, actorRole: userRole, limit: "240" });
      const data = await api<{ messages: StoredMessage[] }>(`/api/conversations/${encodeURIComponent(targetId)}/messages?${params.toString()}`);
      setConversationId(targetId);
      const loadedMessages = data.messages.map(storedMessageToChatMessage);
      setMessages(loadedMessages);
      await loadConversationProcesses(targetId, loadedMessages, false);
      setRetryMessage("");
      setMobileSidebarOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingMessages(false);
    }
  }

  async function loadConversationProcesses(targetId: string, messageItems: ChatMessage[], keepOpen: boolean): Promise<void> {
    if (!targetId) return;
    try {
      const params = new URLSearchParams({ actorId: userId, actorRole: userRole });
      const trace = await api<ConversationTrace>(`/api/conversations/${encodeURIComponent(targetId)}/trace?${params.toString()}`);
      const groups = userProcessGroupsFromTrace(trace, messageItems, `trace-${targetId}`);
      setProcessItemsByMessageId(groups);
      setProcessPanelOpenByMessageId(Object.fromEntries(Object.keys(groups).map((messageId) => [messageId, keepOpen])));
      setProcessDetailOpenByItemId({});
    } catch {
      setProcessItemsByMessageId({});
      setProcessPanelOpenByMessageId({});
      setProcessDetailOpenByItemId({});
    }
  }

  function createConversation() {
    currentRunControllerRef.current?.abort();
    const nextId = `conv-${Date.now()}`;
    setConversationId(nextId);
    setMessages([]);
    setProcessItemsByMessageId({});
    setProcessPanelOpenByMessageId({});
    setProcessDetailOpenByItemId({});
    setComposerToolsOpen(false);
    setMessage("");
    setError("");
    setRetryMessage("");
    setMobileSidebarOpen(false);
  }

  async function deleteConversation(targetId: string) {
    await api(`/api/conversations/${encodeURIComponent(targetId)}`, {
      method: "DELETE",
      body: JSON.stringify({ actorId: userId, actorRole: userRole, deleteReason: "用户在新 UI 删除会话" })
    });
    const nextItems = await refreshConversations("", false);
    const next = nextItems.find((item) => item.id !== targetId) ?? nextItems[0];
    if (next) {
      await loadConversationMessages(next.id);
    } else {
      createConversation();
    }
  }

  async function renameConversation(targetId: string) {
    const title = renameDraft.trim();
    if (!title) return;
    const saved = await api<ConversationSummary>(`/api/conversations/${encodeURIComponent(targetId)}`, {
      method: "PATCH",
      body: JSON.stringify({ title, actorId: userId, actorRole: userRole })
    });
    setConversations((items) => items.map((item) => item.id === saved.id ? saved : item));
    setRenamingConversationId("");
    setRenameDraft("");
    setMenuConversationId("");
  }

  async function copyConversationId(targetId: string) {
    await navigator.clipboard?.writeText(targetId).catch(() => undefined);
    setMenuConversationId("");
  }

  function openDev(targetId = conversationId) {
    window.location.href = `/dev?conversationId=${encodeURIComponent(targetId)}`;
  }

  function openSettingsSection(section: SettingsSection) {
    setSettingsSection(section);
    setSettingsOpen(true);
    setComposerToolsOpen(false);
  }

  function selectAgent(agentId: string) {
    const next = agents.find((item) => item.id === agentId);
    if (!next) return;
    setSelectedAgentId(next.id);
    setAgent(next);
    setBaseUrl(normalizeCachedBaseUrl(next.defaultBaseUrl) ?? DEFAULT_BASE_URL);
    setModel(next.defaultModel);
    createConversation();
  }

  async function createUserAgent() {
    const source = agent ?? agents[0];
    if (!source) return;
    setPowerBusy(true);
    setSettingsNotice("");
    try {
      const created = await api<AgentConfig>("/api/agents", {
        method: "POST",
        body: JSON.stringify({
          id: `agent-${Date.now()}`,
          name: `我的 Agent ${agents.length + 1}`,
          systemPrompt: agentDraft.systemPrompt || source.systemPrompt,
          personalityPrompt: agentDraft.personalityPrompt || source.personalityPrompt,
          defaultModel: model || source.defaultModel,
          defaultBaseUrl: normalizeCachedBaseUrl(baseUrl) ?? source.defaultBaseUrl,
          actorId: userId,
          actorRole: userRole
        })
      });
      setAgents((items) => [...items, created]);
      setSelectedAgentId(created.id);
      setAgent(created);
      setAgentDraft(created);
      setSettingsNotice("已创建新的 Agent。");
    } catch (err) {
      setSettingsNotice(`创建失败：${memoryErrorText(err)}。如果你不是创建者身份，请在高级设置中切换后再试。`);
    } finally {
      setPowerBusy(false);
    }
  }

  async function saveUserAgent() {
    if (!agent || !agentDraft.name || !agentDraft.defaultModel || !agentDraft.defaultBaseUrl) return;
    setPowerBusy(true);
    setSettingsNotice("");
    try {
      const saved = await api<AgentConfig>(`/api/agents/${encodeURIComponent(agent.id)}`, {
        method: "PUT",
        body: JSON.stringify({
          ...agent,
          ...agentDraft,
          id: agent.id,
          actorId: userId,
          actorRole: userRole
        })
      });
      setAgent(saved);
      setAgentDraft(saved);
      setAgents((items) => items.map((item) => item.id === saved.id ? saved : item));
      setBaseUrl(normalizeCachedBaseUrl(saved.defaultBaseUrl) ?? DEFAULT_BASE_URL);
      setModel(saved.defaultModel);
      setSettingsNotice("Agent 已保存。");
    } catch (err) {
      setSettingsNotice(`保存失败：${memoryErrorText(err)}。`);
    } finally {
      setPowerBusy(false);
    }
  }

  async function loadUserWorkspaces() {
    setPowerBusy(true);
    setSettingsNotice("");
    try {
      const data = await api<{ workspaces: WorkspaceDefinition[]; tools: ToolDefinition[] }>("/api/workspaces");
      setWorkspaces(data.workspaces);
      if (data.workspaces.length === 0) {
        setWorkspaceMcpServers([]);
        setWorkspaceMcpDraft(null);
        setWorkspaceDiscoveredTools([]);
        setSelectedWorkspaceDiscoveredTools(new Set());
      }
      setWorkspaceDraft((current) => {
        if (current && data.workspaces.some((item) => item.id === current.id)) {
          return data.workspaces.find((item) => item.id === current.id) ?? current;
        }
        return data.workspaces[0] ?? null;
      });
    } catch (err) {
      setSettingsNotice(`工作空间加载失败：${memoryErrorText(err)}。`);
    } finally {
      setPowerBusy(false);
    }
  }

  async function saveUserWorkspace() {
    if (!workspaceDraft?.id || !workspaceDraft.name.trim()) return;
    setPowerBusy(true);
    setSettingsNotice("");
    try {
      const exists = workspaces.some((workspace) => workspace.id === workspaceDraft.id);
      const normalized = normalizeWorkspaceForSave(workspaceDraft);
      const saved = await api<WorkspaceDefinition>(
        exists ? `/api/workspaces/${encodeURIComponent(workspaceDraft.id)}` : "/api/workspaces",
        {
          method: exists ? "PUT" : "POST",
          body: JSON.stringify({
            ...normalized,
            toolIds: normalized.tools.map((tool) => tool.id),
            actorId: userId,
            actorRole: userRole
          })
        }
      );
      setWorkspaceDraft(saved);
      await loadUserWorkspaces();
      setSettingsNotice("工作空间已保存。");
    } catch (err) {
      setSettingsNotice(`保存失败：${memoryErrorText(err)}。`);
    } finally {
      setPowerBusy(false);
    }
  }

  async function loadUserMcpServers(workspaceId: string) {
    const params = new URLSearchParams({ actorId: userId, actorRole: userRole });
    try {
      const data = await api<{ mcpServers: McpServerDefinition[] }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/mcp-servers?${params.toString()}`);
      setWorkspaceMcpServers(data.mcpServers);
      setWorkspaceMcpDraft((current) => {
        if (current && current.workspaceId === workspaceId) {
          return data.mcpServers.find((server) => server.id === current.id) ?? current;
        }
        return null;
      });
    } catch (err) {
      setSettingsNotice(`MCP Server 加载失败：${mcpUserErrorText(err)}。`);
    }
  }

  async function saveUserMcpServer(): Promise<McpServerDefinition | null> {
    if (!workspaceDraft || !workspaceMcpDraft) return null;
    setPowerBusy(true);
    setSettingsNotice("");
    try {
      JSON.parse(workspaceMcpDraft.argsJson || "[]");
      JSON.parse(workspaceMcpDraft.envJson || "{}");
      JSON.parse(workspaceMcpDraft.headersJson || "{}");
      const exists = workspaceMcpServers.some((server) => server.id === workspaceMcpDraft.id);
      const saved = await api<McpServerDefinition>(
        exists
          ? `/api/workspaces/${encodeURIComponent(workspaceDraft.id)}/mcp-servers/${encodeURIComponent(workspaceMcpDraft.id)}`
          : `/api/workspaces/${encodeURIComponent(workspaceDraft.id)}/mcp-servers`,
        {
          method: exists ? "PUT" : "POST",
          body: JSON.stringify({
            ...workspaceMcpDraft,
            workspaceId: workspaceDraft.id,
            actorId: userId,
            actorRole: userRole
          })
        }
      );
      setWorkspaceMcpDraft(saved);
      await loadUserMcpServers(workspaceDraft.id);
      setSettingsNotice("MCP Server 已保存。");
      return saved;
    } catch (err) {
      setSettingsNotice(`MCP Server 保存失败：${mcpUserErrorText(err)}。`);
      return null;
    } finally {
      setPowerBusy(false);
    }
  }

  async function deleteUserMcpServer(server: McpServerDefinition) {
    if (!workspaceDraft) return;
    setPowerBusy(true);
    setSettingsNotice("");
    try {
      await api(`/api/workspaces/${encodeURIComponent(workspaceDraft.id)}/mcp-servers/${encodeURIComponent(server.id)}`, {
        method: "DELETE",
        body: JSON.stringify({
          actorId: userId,
          actorRole: userRole,
          deleteReason: "用户在新 UI 删除 MCP Server"
        })
      });
      setWorkspaceDiscoveredTools([]);
      setSelectedWorkspaceDiscoveredTools(new Set());
      await loadUserWorkspaces();
      await loadUserMcpServers(workspaceDraft.id);
      setSettingsNotice("MCP Server 已删除，相关工具也已移除。");
    } catch (err) {
      setSettingsNotice(`MCP Server 删除失败：${mcpUserErrorText(err)}。`);
    } finally {
      setPowerBusy(false);
    }
  }

  async function discoverUserMcpTools() {
    if (!workspaceDraft || !workspaceMcpDraft) return;
    setPowerBusy(true);
    setSettingsNotice("");
    setWorkspaceDiscoveredTools([]);
    setSelectedWorkspaceDiscoveredTools(new Set());
    try {
      const server = await saveUserMcpServer();
      if (!server) return;
      const data = await api<{ tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> }>(
        `/api/workspaces/${encodeURIComponent(workspaceDraft.id)}/mcp-servers/${encodeURIComponent(server.id)}/discover`,
        {
          method: "POST",
          body: JSON.stringify({ actorId: userId, actorRole: userRole })
        }
      );
      setWorkspaceDiscoveredTools(data.tools);
      setSelectedWorkspaceDiscoveredTools(new Set(data.tools.map((tool) => tool.name)));
      setSettingsNotice(data.tools.length > 0 ? `检测到 ${data.tools.length} 个工具。` : "没有检测到可挂载工具。");
    } catch (err) {
      setSettingsNotice(`工具检测失败：${mcpUserErrorText(err)}。`);
    } finally {
      setPowerBusy(false);
    }
  }

  async function importUserMcpTools() {
    if (!workspaceDraft || !workspaceMcpDraft) return;
    const tools = workspaceDiscoveredTools.filter((tool) => selectedWorkspaceDiscoveredTools.has(tool.name));
    if (tools.length === 0) return;
    setPowerBusy(true);
    setSettingsNotice("");
    try {
      await api<{ tools: ToolDefinition[] }>(
        `/api/workspaces/${encodeURIComponent(workspaceDraft.id)}/mcp-servers/${encodeURIComponent(workspaceMcpDraft.id)}/import-tools`,
        {
          method: "POST",
          body: JSON.stringify({
            tools,
            actorId: userId,
            actorRole: userRole
          })
        }
      );
      setWorkspaceDiscoveredTools([]);
      setSelectedWorkspaceDiscoveredTools(new Set());
      await loadUserWorkspaces();
      setSettingsNotice(`已挂载 ${tools.length} 个工具。`);
    } catch (err) {
      setSettingsNotice(`工具挂载失败：${mcpUserErrorText(err)}。`);
    } finally {
      setPowerBusy(false);
    }
  }

  async function deleteUserWorkspaceTool(tool: ToolDefinition) {
    if (!workspaceDraft || isSystemTool(tool)) return;
    setPowerBusy(true);
    setSettingsNotice("");
    try {
      await api(`/api/workspaces/${encodeURIComponent(workspaceDraft.id)}/tools/${encodeURIComponent(tool.id)}`, {
        method: "DELETE",
        body: JSON.stringify({
          actorId: userId,
          actorRole: userRole,
          deleteReason: "用户在新 UI 删除工作空间工具"
        })
      });
      await loadUserWorkspaces();
      setSettingsNotice("工具已移除。");
    } catch (err) {
      setSettingsNotice(`工具删除失败：${mcpUserErrorText(err)}。`);
    } finally {
      setPowerBusy(false);
    }
  }

  async function loadUserMemories() {
    setPowerBusy(true);
    setSettingsNotice("");
    try {
      const params = new URLSearchParams({ actorId: userId, actorRole: userRole });
      if (memoryQuery.trim()) params.set("query", memoryQuery.trim());
      if (memoryTypeFilter) params.set("memoryType", memoryTypeFilter);
      if (selectedAgentId) params.set("agentId", selectedAgentId);
      const data = await api<{ memories: MemoryRow[] }>(`/api/memories?${params.toString()}`);
      setMemories(data.memories);
    } catch (err) {
      setSettingsNotice(`记忆加载失败：${memoryErrorText(err)}。`);
    } finally {
      setPowerBusy(false);
    }
  }

  async function saveUserMemory() {
    if (!memoryEditing?.memoryType || !memoryEditing.title || !memoryEditing.summary || !memoryEditing.detail) return;
    setPowerBusy(true);
    setSettingsNotice("");
    try {
      const body = {
        memoryType: memoryEditing.memoryType,
        title: memoryEditing.title,
        summary: memoryEditing.summary,
        detail: memoryEditing.detail,
        userId: memoryEditing.memoryType === "skill" ? undefined : (memoryEditing.userId || userId),
        agentId: memoryEditing.agentId || selectedAgentId,
        workspaceId: memoryEditing.workspaceId || undefined,
        actorId: userId,
        actorRole: userRole
      };
      if (memoryEditing.id) {
        await api(`/api/memories/${encodeURIComponent(memoryEditing.id)}`, {
          method: "PUT",
          body: JSON.stringify(body)
        });
      } else {
        await api("/api/memories", {
          method: "POST",
          body: JSON.stringify(body)
        });
      }
      setMemoryEditing(null);
      await loadUserMemories();
      setSettingsNotice("记忆已保存。");
    } catch (err) {
      setSettingsNotice(`保存失败：${memoryErrorText(err)}。`);
    } finally {
      setPowerBusy(false);
    }
  }

  async function deleteUserMemory(id: string) {
    setPowerBusy(true);
    setSettingsNotice("");
    try {
      await api(`/api/memories/${encodeURIComponent(id)}`, {
        method: "DELETE",
        body: JSON.stringify({ actorId: userId, actorRole: userRole, deleteReason: "用户在新 UI 删除记忆" })
      });
      if (memoryEditing?.id === id) setMemoryEditing(null);
      await loadUserMemories();
      setSettingsNotice("记忆已删除。");
    } catch (err) {
      setSettingsNotice(`删除失败：${memoryErrorText(err)}。`);
    } finally {
      setPowerBusy(false);
    }
  }

  function removeFailedRetryPair(items: ChatMessage[], requestText: string): ChatMessage[] {
    const last = items.at(-1);
    if (!last?.failed || last.requestText !== requestText) return items;
    const withoutError = items.slice(0, -1);
    const previous = withoutError.at(-1);
    if (previous?.role === "用户" && previous.content === requestText) return withoutError.slice(0, -1);
    return withoutError;
  }

  async function sendMessage(retryText?: string) {
    const cleanMessage = typeof retryText === "string" ? retryText : message;
    if (loading || !cleanMessage.trim() || !agent) return;
    const runId = createLocalId("run");
    const userMessageId = createLocalId("user-msg");
    const assistantMessageId = createLocalId("assistant-msg");
    const controller = new AbortController();
    currentRunControllerRef.current = controller;
    setLoading(true);
    setError("");
    setRetryMessage("");
    setProcessItemsByMessageId((groups) => ({ ...groups, [assistantMessageId]: [] }));
    setProcessPanelOpenByMessageId((groups) => ({ ...groups, [assistantMessageId]: false }));
    setComposerToolsOpen(false);
    setMessage("");
    setMessages((items) => [
      ...removeFailedRetryPair(items, cleanMessage),
      { id: userMessageId, runId, role: "用户", content: cleanMessage },
      { id: assistantMessageId, runId, role: "助手", content: "", streaming: true }
    ]);

    const effectiveBaseUrl = normalizeCachedBaseUrl(baseUrl) ?? DEFAULT_BASE_URL;
    if (effectiveBaseUrl !== baseUrl) setBaseUrl(effectiveBaseUrl);

    try {
      const response = await fetch("/api/agent/run/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: agent.id,
          userId,
          userRole,
          conversationId,
          message: cleanMessage,
          llm: { baseUrl: effectiveBaseUrl, model, apiKey: apiKey || undefined }
        }),
        signal: controller.signal
      });
      if (!response.ok || !response.body) throw new Error(`请求失败：${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let assistantText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (controller.signal.aborted) throw new Error("运行已停止。");
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";

        for (const event of events) {
          const line = event.split("\n").find((item) => item.startsWith("data:"));
          if (!line) continue;
          const payload = JSON.parse(line.slice(5).trim()) as any;
          if (payload.type === "delta") {
            assistantText += payload.text;
            setMessages((items) => items.map((item) => item.id === assistantMessageId ? { ...item, content: assistantText, streaming: true } : item));
          }
          if (payload.type === "workspace") {
            setProcessItemsByMessageId((groups) => ({
              ...groups,
              [assistantMessageId]: [
                ...(groups[assistantMessageId] ?? []),
                {
                  id: createLocalId("process"),
                  runId,
                  workspaceId: payload.workspaceId,
                  eventKind: payload.eventKind,
                  title: payload.title,
                  text: payload.text,
                  status: payload.status,
                  toolNames: payload.toolNames,
                  items: payload.items,
                  createdAt: new Date().toISOString()
                }
              ]
            }));
          }
          if (payload.type === "done") {
            setMessages((items) => items.map((item) => item.id === assistantMessageId ? { ...item, content: payload.output.assistantMessage, streaming: false } : item));
            setProcessPanelOpenByMessageId((groups) => ({ ...groups, [assistantMessageId]: false }));
            await refreshConversations(payload.output.conversationId, false);
          }
          if (payload.type === "error") throw new Error(payload.error);
        }
      }
    } catch (err) {
      if (controller.signal.aborted) {
        setMessages((items) => items.map((item) => item.id === assistantMessageId
          ? { ...item, content: item.content || "已停止运行。", streaming: false }
          : item.streaming ? { ...item, streaming: false } : item));
        setProcessPanelOpenByMessageId((groups) => ({ ...groups, [assistantMessageId]: false }));
        setError("");
        return;
      }
      const messageText = err instanceof Error ? err.message : String(err);
      setError(messageText);
      setRetryMessage(cleanMessage);
      setProcessPanelOpenByMessageId((groups) => {
        const next = { ...groups };
        delete next[assistantMessageId];
        return next;
      });
      setProcessItemsByMessageId((groups) => {
        const next = { ...groups };
        delete next[assistantMessageId];
        return next;
      });
      setMessages((items) => items.filter((item) => item.runId !== runId));
    } finally {
      if (currentRunControllerRef.current === controller) currentRunControllerRef.current = null;
      setLoading(false);
    }
  }

  function stopCurrentRun() {
    currentRunControllerRef.current?.abort();
  }

  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    if (event.shiftKey || event.ctrlKey) return;
    event.preventDefault();
    void sendMessage();
  }

  const workspaceCustomTools = workspaceDraft?.tools.filter((tool) => !isSystemTool(tool)) ?? [];
  const workspaceHasUnsavedDraft = Boolean(workspaceDraft && !workspaces.some((workspace) => workspace.id === workspaceDraft.id));
  const latestProcessMessageId = messages.slice().reverse().find((item) => (processItemsByMessageId[item.id]?.length ?? 0) > 0)?.id ?? "";
  const latestMessageProcessItems = latestProcessMessageId ? processItemsByMessageId[latestProcessMessageId] ?? [] : [];
  const pendingAskUser = latestAskUserPrompt(latestMessageProcessItems.length ? latestMessageProcessItems : allProcessItems, messages, loading);
  const pendingAskQuestionVisible = askQuestionAlreadyVisible(messages, pendingAskUser);

  function renderProcessPanel(messageId: string, processItems: UserRunProcess[]) {
    if (processItems.length === 0) return null;
    const active = processItems.some((item) => isProcessActive(item, processItems, loading));
    const open = Boolean(processPanelOpenByMessageId[messageId]);
    return (
      <section className="tool-process-row" aria-label="Agent 运行进展">
        <div className="assistant-avatar process-avatar">Z</div>
        <section className={`tool-process-panel ${open ? "open" : ""}`}>
          <button
            className="tool-process-summary"
            type="button"
            aria-expanded={open}
            onClick={() => {
              const itemIds = new Set(processItems.map((item) => item.id));
              setProcessDetailOpenByItemId((details) => Object.fromEntries(Object.entries(details).filter(([itemId]) => !itemIds.has(itemId))));
              setProcessPanelOpenByMessageId((groups) => ({ ...groups, [messageId]: !open }));
            }}
          >
            <span className={`tool-activity-dot ${active ? "active" : "done"}`} />
            <span>{processPanelSummary(processItems, active)}</span>
            <small>{open ? "收起详情" : active ? "运行中" : "点击查看详情"}</small>
          </button>
          {open && <div className="tool-activity-list">
            {processItems.map((item) => {
              const itemActive = isProcessActive(item, processItems, active);
              const detailOpen = Boolean(processDetailOpenByItemId[item.id]);
              return (
                <section key={item.id} className={`tool-activity ${itemActive ? "active" : "done"} ${detailOpen ? "open" : ""}`}>
                  <button
                    className="tool-activity-summary"
                    type="button"
                    aria-expanded={detailOpen}
                    onClick={() => setProcessDetailOpenByItemId((details) => ({ ...details, [item.id]: !detailOpen }))}
                  >
                    <span className="tool-activity-dot" />
                    <span>{userProcessActivityLabel(item)}</span>
                    <small>{detailOpen ? "收起详情" : "查看详情"}</small>
                  </button>
                  {detailOpen && <div className="tool-activity-detail">
                    {readableProcessDetails(item).map((detail, index) => (
                      <div key={`${item.id}-${index}`}>
                        <strong>{detail.url ? <a href={detail.url} target="_blank" rel="noreferrer">{detail.label}</a> : detail.label}</strong>
                        <span>{detail.value}</span>
                      </div>
                    ))}
                  </div>}
                </section>
              );
            })}
          </div>}
        </section>
      </section>
    );
  }

  return (
    <main className={`user-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <button className="mobile-sidebar-button" type="button" aria-label="打开会话栏" onClick={() => setMobileSidebarOpen(true)}>☰</button>
      {mobileSidebarOpen && <button className="sidebar-scrim" aria-label="关闭会话栏" onClick={() => setMobileSidebarOpen(false)} />}
      <aside className={`user-sidebar ${mobileSidebarOpen ? "open" : ""}`}>
        <div className="sidebar-head">
          <button className="new-chat-button" type="button" onClick={createConversation}>+ 新对话</button>
          <button className="icon-button" type="button" aria-label="折叠侧边栏" onClick={() => setSidebarCollapsed((value) => !value)}>‹</button>
        </div>
        <label className="conversation-search">
          <input value={conversationFilter} onChange={(event) => setConversationFilter(event.target.value)} placeholder="搜索会话" />
        </label>
        <div className="conversation-list">
          {filteredConversations.map((conversation) => (
            <article
              key={conversation.id}
              className={`conversation-item ${conversation.id === conversationId ? "active" : ""} ${menuConversationId === conversation.id ? "menu-open" : ""}`}
              onClick={() => void loadConversationMessages(conversation.id)}
            >
              {renamingConversationId === conversation.id ? (
                <form className="rename-form" onSubmit={(event) => {
                  event.preventDefault();
                  void renameConversation(conversation.id);
                }}>
                  <input value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)} autoFocus />
                  <button type="submit">保存</button>
                </form>
              ) : (
                <>
                  <div className="conversation-copy">
                    <strong>{conversation.title}</strong>
                  </div>
                  <button className="conversation-menu-button" type="button" aria-label="会话菜单" onClick={(event) => {
                    event.stopPropagation();
                    setMenuConversationId((current) => current === conversation.id ? "" : conversation.id);
                  }}>...</button>
                  {menuConversationId === conversation.id && (
                    <div className="conversation-menu" onClick={(event) => event.stopPropagation()}>
                      <button onClick={() => {
                        setRenamingConversationId(conversation.id);
                        setRenameDraft(conversation.title);
                        setMenuConversationId("");
                      }}>重命名</button>
                      <button onClick={() => void copyConversationId(conversation.id)}>复制 ID</button>
                      <button onClick={() => openDev(conversation.id)}>开发者打开</button>
                      <button className="danger-text" onClick={() => void deleteConversation(conversation.id)}>删除</button>
                    </div>
                  )}
                </>
              )}
            </article>
          ))}
          {filteredConversations.length === 0 && <div className="sidebar-empty">开始一个新对话</div>}
        </div>
        <div className="sidebar-foot">
          <button onClick={() => setSettingsOpen(true)}>设置</button>
          <label className="developer-toggle">
            <input type="checkbox" checked={developerMode} onChange={(event) => setDeveloperMode(event.target.checked)} />
            <span>开发者模式</span>
          </label>
          {developerMode && <button onClick={() => openDev()}>打开调试台</button>}
        </div>
      </aside>

      <section className="user-chat">
        <header className="user-chat-header">
          <div>
            <strong>{agent?.name ?? "Zleap Agent"}</strong>
            <span>{chatHeaderSubtitle}</span>
          </div>
          <div className="chat-header-actions">
            <select value={model} onChange={(event) => setModel(event.target.value)} aria-label="模型">
              <option value={model}>{model}</option>
              <option value="gpt-5-mini">gpt-5-mini</option>
              <option value="gpt-5">gpt-5</option>
              <option value="gpt-4.1">gpt-4.1</option>
            </select>
            <button onClick={() => setSettingsOpen(true)}>设置</button>
            {developerMode && <button onClick={() => openDev()}>/dev</button>}
          </div>
        </header>

        <div className="user-message-list" ref={messageListRef}>
          {loadingMessages && <div className="user-empty-state">正在载入会话...</div>}
          {!loadingMessages && messages.length === 0 && (
            <div className="user-empty-state">
              <div className="empty-mark">Z</div>
              <h1>今天想完成什么？</h1>
              <p>直接描述目标，Zleap 会在背后选择合适的工作空间和工具。</p>
            </div>
          )}
          {messages.map((item) => {
            const messageProcessItems = processItemsByMessageId[item.id] ?? [];
            return (
            <React.Fragment key={item.id}>
              {item.role !== "用户" && renderProcessPanel(item.id, messageProcessItems)}
              <article className={`user-message ${item.role === "用户" ? "from-user" : "from-assistant"} ${item.streaming ? "streaming" : ""}`}>
                {item.role !== "用户" && <div className="assistant-avatar">Z</div>}
                <div className="user-message-bubble">
                  {item.content ? <MarkdownMessage content={item.content} /> : <span className="typing-dots"><i /><i /><i /></span>}
                </div>
              </article>
            </React.Fragment>
            );
          })}
          {pendingAskUser && (
            <section className="ask-user-panel" aria-label="需要你选择">
              <div className="assistant-avatar">Z</div>
              <div className="ask-user-card">
                {!pendingAskQuestionVisible && <strong>{pendingAskUser.question}</strong>}
                <div className="ask-user-options">
                  {pendingAskUser.choices.map((choice, index) => (
                    <button
                      key={`${pendingAskUser.id}-${index}`}
                      type="button"
                      onClick={() => void sendMessage(choice)}
                      disabled={loading || !agent}
                    >
                      {choice}
                    </button>
                  ))}
                </div>
              </div>
            </section>
          )}
          {developerMode && allProcessItems.length > 0 && (
            <section className="developer-process-list">
              <h2>运行过程</h2>
              {allProcessItems.map((item) => (
                <details key={item.id}>
                  <summary>{userProcessActivityLabel(item)}<span>{item.workspaceId}</span></summary>
                  <div className="developer-process-readable">
                    {developerProcessDetails(item).map((detail, index) => (
                      <div key={`${item.id}-${index}`}>
                        <strong>{detail.url ? <a href={detail.url} target="_blank" rel="noreferrer">{detail.label}</a> : detail.label}</strong>
                        <span>{detail.value}</span>
                      </div>
                    ))}
                  </div>
                </details>
              ))}
            </section>
          )}
        </div>

        <footer className="user-composer-wrap">
          {error && (
            <div className="user-error">
              <span>{error}</span>
              {retryMessage && <button onClick={() => void sendMessage(retryMessage)} disabled={loading}>重试</button>}
            </div>
          )}
          <div className="user-composer">
            <div className="composer-tool-menu-wrap">
              <button
                className={`tool-menu-button ${composerToolsOpen ? "active" : ""}`}
                type="button"
                title="工具菜单"
                aria-label="工具菜单"
                aria-expanded={composerToolsOpen}
                onClick={() => setComposerToolsOpen((value) => !value)}
              >+</button>
              {composerToolsOpen && (
                <div className="composer-tool-menu" role="menu">
                  <button type="button" role="menuitem" onClick={() => openSettingsSection("workspaces")}>
                    <strong>工作空间与工具</strong>
                    <span>MCP Server、专属工具和场景能力</span>
                  </button>
                  <button type="button" role="menuitem" onClick={() => openSettingsSection("memory")}>
                    <strong>记忆</strong>
                    <span>查看、搜索和修正 Agent 记住的内容</span>
                  </button>
                  <button type="button" role="menuitem" onClick={() => openSettingsSection("agents")}>
                    <strong>Agent</strong>
                    <span>切换或编辑当前 Agent</span>
                  </button>
                  <button type="button" role="menuitem" onClick={() => {
                    setComposerToolsOpen(false);
                    openDev();
                  }}>
                    <strong>打开调试台</strong>
                    <span>查看当前会话的完整开发者视图</span>
                  </button>
                </div>
              )}
            </div>
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder="向 Zleap 发送消息"
              rows={1}
            />
            {loading
              ? <button className="send-button stop" onClick={stopCurrentRun}>停止</button>
              : <button className="send-button" disabled={!message.trim() || !agent} onClick={() => void sendMessage()}>发送</button>}
          </div>
          <p className="composer-note">Enter 发送，Shift+Enter 换行。API Key 只保存在当前浏览器。</p>
        </footer>
      </section>

      {settingsOpen && (
        <div className="settings-layer" role="dialog" aria-modal="true" aria-label="设置">
          <button className="settings-backdrop" aria-label="关闭设置" onClick={() => setSettingsOpen(false)} />
          <section className="settings-modal">
            <div className="settings-title">
              <h2>设置</h2>
              <button className="icon-button" onClick={() => setSettingsOpen(false)}>×</button>
            </div>
            <nav className="settings-tabs" aria-label="设置分区">
              {([
                ["basic", "基础"],
                ["agents", "Agent"],
                ["workspaces", "工作空间"],
                ["memory", "记忆"],
                ["advanced", "高级"]
              ] as Array<[SettingsSection, string]>).map(([section, label]) => (
                <button key={section} className={settingsSection === section ? "active" : ""} onClick={() => setSettingsSection(section)}>{label}</button>
              ))}
            </nav>
            {settingsNotice && <div className="settings-notice">{settingsNotice}</div>}
            {settingsSection === "basic" && (
              <section className="settings-section">
                <p>这里是日常对话需要的最小配置。更深入的 Agent、工作空间和记忆管理可以在上方切换。</p>
                <label>Agent
                  <select value={selectedAgentId} onChange={(event) => selectAgent(event.target.value)}>
                    {agents.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select>
                </label>
                <label>Model<input value={model} onChange={(event) => setModel(event.target.value)} /></label>
                <label>Base URL<input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} onBlur={() => setBaseUrl(normalizeCachedBaseUrl(baseUrl) ?? DEFAULT_BASE_URL)} /></label>
                <label>API Key<input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="只保存在当前浏览器" /></label>
              </section>
            )}
            {settingsSection === "agents" && (
              <section className="settings-section">
                <p>创建不同 Agent 来适配不同工作方式。这里用自然语言描述，不需要理解底层 prompt。</p>
                <div className="power-toolbar">
                  <select value={selectedAgentId} onChange={(event) => selectAgent(event.target.value)}>
                    {agents.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select>
                  <button onClick={() => void createUserAgent()} disabled={powerBusy}>新建 Agent</button>
                </div>
                <label>名称<input value={agentDraft.name ?? ""} onChange={(event) => setAgentDraft({ ...agentDraft, name: event.target.value })} /></label>
                <label>默认模型<input value={agentDraft.defaultModel ?? model} onChange={(event) => setAgentDraft({ ...agentDraft, defaultModel: event.target.value })} /></label>
                <label>服务地址<input value={agentDraft.defaultBaseUrl ?? baseUrl} onChange={(event) => setAgentDraft({ ...agentDraft, defaultBaseUrl: event.target.value })} /></label>
                <label>核心指令<textarea value={agentDraft.systemPrompt ?? ""} onChange={(event) => setAgentDraft({ ...agentDraft, systemPrompt: event.target.value })} placeholder="它负责什么、应该如何行动" /></label>
                <label>表达风格<textarea value={agentDraft.personalityPrompt ?? ""} onChange={(event) => setAgentDraft({ ...agentDraft, personalityPrompt: event.target.value })} placeholder="语气、偏好、回答方式" /></label>
                <div className="settings-actions inline">
                  <button className="primary" onClick={() => void saveUserAgent()} disabled={powerBusy || !agent}>保存 Agent</button>
                </div>
              </section>
            )}
            {settingsSection === "workspaces" && (
              <section className="settings-section">
                <p>工作空间是 Agent 的专业场景。这里可以描述用途，也可以用 MCP Server 接入这个场景专用的外部工具；内置系统工具不会显示在列表里。</p>
                <div className="power-split">
                  <div className="power-list">
                    <button className="power-list-item create" onClick={() => {
                      setWorkspaceDraft(newWorkspaceDraftForUser(userId));
                      setWorkspaceMcpServers([]);
                      setWorkspaceMcpDraft(null);
                      setWorkspaceDiscoveredTools([]);
                      setSelectedWorkspaceDiscoveredTools(new Set());
                    }}>+ 新工作空间</button>
                    {workspaces.map((workspace) => (
                      <button key={workspace.id} className={`power-list-item ${workspaceDraft?.id === workspace.id ? "active" : ""}`} onClick={() => {
                        setWorkspaceDraft(workspace);
                        setWorkspaceDiscoveredTools([]);
                        setSelectedWorkspaceDiscoveredTools(new Set());
                      }}>
                        <strong>{workspace.name}</strong>
                        <span>{workspace.description || workspace.id}</span>
                      </button>
                    ))}
                  </div>
                  <div className="power-editor">
                    {workspaceDraft ? (
                      <>
                        <label>ID<input value={workspaceDraft.id} disabled={workspaces.some((item) => item.id === workspaceDraft.id)} onChange={(event) => setWorkspaceDraft({ ...workspaceDraft, id: event.target.value })} /></label>
                        <label>名称<input value={workspaceDraft.name} onChange={(event) => setWorkspaceDraft({ ...workspaceDraft, name: event.target.value })} /></label>
                        <label>用途说明<textarea value={workspaceDraft.description} onChange={(event) => setWorkspaceDraft({ ...workspaceDraft, description: event.target.value })} placeholder="这个工作空间适合处理什么任务" /></label>
                        <label>能力清单<textarea value={stringifyListText(workspaceDraft.capabilitiesJson)} onChange={(event) => setWorkspaceDraft(updateWorkspaceListField(workspaceDraft, "capabilitiesJson", event.target.value))} placeholder="每行一条，例如：联网搜索资料" /></label>
                        <label>风险等级
                          <select value={workspaceDraft.riskLevel} onChange={(event) => setWorkspaceDraft({ ...workspaceDraft, riskLevel: event.target.value as WorkspaceDefinition["riskLevel"] })}>
                            <option value="low">{workspaceRiskText("low")}</option>
                            <option value="medium">{workspaceRiskText("medium")}</option>
                            <option value="high">{workspaceRiskText("high")}</option>
                          </select>
                        </label>
                        <label className="developer-toggle compact">
                          <input type="checkbox" checked={Boolean(workspaceDraft.requiresApproval)} onChange={(event) => setWorkspaceDraft({ ...workspaceDraft, requiresApproval: event.target.checked ? 1 : 0 })} />
                          <span>使用前需要我确认</span>
                        </label>
                        <div className="settings-actions inline">
                          <button className="primary" onClick={() => void saveUserWorkspace()} disabled={powerBusy}>保存工作空间</button>
                        </div>
                        <section className="workspace-user-tools">
                          <div className="user-section-heading">
                            <div>
                              <h3>MCP Server</h3>
                              <p>给当前工作空间增加外部工具来源。保存工作空间后才能配置 Server。</p>
                            </div>
                            <button
                              type="button"
                              onClick={() => setWorkspaceMcpDraft(createMcpServerDraft(workspaceDraft.id))}
                              disabled={workspaceHasUnsavedDraft || powerBusy}
                            >添加 Server</button>
                          </div>
                          {workspaceHasUnsavedDraft ? (
                            <div className="soft-empty">先保存工作空间，再配置 MCP Server。</div>
                          ) : (
                            <>
                              <div className="workspace-tool-list compact">
                                {workspaceMcpServers.map((server) => (
                                  <article key={server.id} className="tool-card user-tool-card">
                                    <div>
                                      <strong>{server.name || server.id}</strong>
                                      <span>{mcpServerSummary(server)}</span>
                                    </div>
                                    <small>{server.transport === "stdio" ? "本地命令" : "远程 Server"}</small>
                                    <div className="tool-card-actions">
                                      <button type="button" onClick={() => {
                                        setWorkspaceMcpDraft(server);
                                        setWorkspaceDiscoveredTools([]);
                                        setSelectedWorkspaceDiscoveredTools(new Set());
                                      }}>编辑</button>
                                      <button type="button" onClick={() => void deleteUserMcpServer(server)} disabled={powerBusy}>删除</button>
                                    </div>
                                  </article>
                                ))}
                                {workspaceMcpServers.length === 0 && <div className="soft-empty">还没有 MCP Server。</div>}
                              </div>
                              {workspaceMcpDraft && (
                                <div className="mcp-user-editor">
                                  <div className="user-section-heading tight">
                                    <h3>{workspaceMcpServers.some((server) => server.id === workspaceMcpDraft.id) ? "编辑 Server" : "添加 Server"}</h3>
                                    <button type="button" onClick={() => setWorkspaceMcpDraft(null)}>收起</button>
                                  </div>
                                  <label>名称<input value={workspaceMcpDraft.name} onChange={(event) => setWorkspaceMcpDraft({ ...workspaceMcpDraft, name: event.target.value })} placeholder="例如：公司知识库" /></label>
                                  <label>Server ID<input value={workspaceMcpDraft.id} disabled={workspaceMcpServers.some((server) => server.id === workspaceMcpDraft.id)} onChange={(event) => setWorkspaceMcpDraft({ ...workspaceMcpDraft, id: event.target.value })} /></label>
                                  <label>连接方式
                                    <select value={workspaceMcpDraft.transport} onChange={(event) => setWorkspaceMcpDraft({ ...workspaceMcpDraft, transport: event.target.value as McpServerDefinition["transport"] })}>
                                      <option value="stdio">本地命令</option>
                                      <option value="streamable-http">远程地址</option>
                                    </select>
                                  </label>
                                  {workspaceMcpDraft.transport === "stdio" ? (
                                    <>
                                      <label>启动命令<input value={workspaceMcpDraft.command ?? ""} onChange={(event) => setWorkspaceMcpDraft({ ...workspaceMcpDraft, command: event.target.value })} placeholder="npx" /></label>
                                      <label>参数<textarea value={workspaceMcpDraft.argsJson} onChange={(event) => setWorkspaceMcpDraft({ ...workspaceMcpDraft, argsJson: event.target.value })} placeholder='["-y", "server-name"]' /></label>
                                      <label>工作目录<input value={workspaceMcpDraft.cwd ?? ""} onChange={(event) => setWorkspaceMcpDraft({ ...workspaceMcpDraft, cwd: event.target.value })} placeholder="." /></label>
                                      <label>环境变量<textarea value={workspaceMcpDraft.envJson} onChange={(event) => setWorkspaceMcpDraft({ ...workspaceMcpDraft, envJson: event.target.value })} placeholder='{"TOKEN":"..."}' /></label>
                                    </>
                                  ) : (
                                    <>
                                      <label>远程地址<input value={workspaceMcpDraft.url ?? ""} onChange={(event) => setWorkspaceMcpDraft({ ...workspaceMcpDraft, url: event.target.value })} placeholder="https://example.com/mcp" /></label>
                                      <label>请求头<textarea value={workspaceMcpDraft.headersJson} onChange={(event) => setWorkspaceMcpDraft({ ...workspaceMcpDraft, headersJson: event.target.value })} placeholder='{"Authorization":"Bearer ..."}' /></label>
                                    </>
                                  )}
                                  <label>超时毫秒<input type="number" value={workspaceMcpDraft.timeoutMs} onChange={(event) => setWorkspaceMcpDraft({ ...workspaceMcpDraft, timeoutMs: Number(event.target.value) })} /></label>
                                  <div className="settings-actions inline">
                                    <button className="primary" type="button" onClick={() => void saveUserMcpServer()} disabled={powerBusy}>保存 Server</button>
                                    <button type="button" onClick={() => void discoverUserMcpTools()} disabled={powerBusy}>检测工具</button>
                                    <button type="button" onClick={() => void importUserMcpTools()} disabled={powerBusy || selectedWorkspaceDiscoveredTools.size === 0}>挂载选中工具</button>
                                  </div>
                                  {workspaceDiscoveredTools.length > 0 && (
                                    <div className="discovered-tools user-discovered-tools">
                                      {workspaceDiscoveredTools.map((tool) => (
                                        <label key={tool.name} className="check-row discovered-tool-row">
                                          <input
                                            type="checkbox"
                                            checked={selectedWorkspaceDiscoveredTools.has(tool.name)}
                                            onChange={(event) => {
                                              const next = new Set(selectedWorkspaceDiscoveredTools);
                                              if (event.target.checked) next.add(tool.name);
                                              else next.delete(tool.name);
                                              setSelectedWorkspaceDiscoveredTools(next);
                                            }}
                                          />
                                          <span><strong>{tool.name}</strong><br />{tool.description || "没有说明"}</span>
                                          <small>MCP</small>
                                        </label>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )}
                            </>
                          )}
                        </section>
                        <section className="workspace-user-tools">
                          <div className="user-section-heading">
                            <div>
                              <h3>专属工具</h3>
                              <p>只显示这个工作空间额外挂载的工具，系统内置工具已隐藏。</p>
                            </div>
                          </div>
                          <div className="workspace-tool-list compact">
                            {workspaceCustomTools.map((tool) => (
                              <article key={tool.id} className="tool-card user-tool-card">
                                <div>
                                  <strong>{tool.name}</strong>
                                  <span>{tool.description || "没有说明"}</span>
                                </div>
                                <small>{riskLabel(tool.riskLevel)} · {bindingLabel(tool.bindingType)}</small>
                                <div className="tool-card-actions">
                                  <button type="button" onClick={() => void deleteUserWorkspaceTool(tool)} disabled={powerBusy}>删除</button>
                                </div>
                              </article>
                            ))}
                            {workspaceCustomTools.length === 0 && <div className="soft-empty">还没有专属工具。可以先添加 MCP Server，然后检测并挂载工具。</div>}
                          </div>
                        </section>
                      </>
                    ) : <div className="soft-empty">请选择或新建一个工作空间。</div>}
                  </div>
                </div>
              </section>
            )}
            {settingsSection === "memory" && (
              <section className="settings-section">
                <p>这里展示 Agent 记住的内容。你可以补充事实、修正误解，或删除过期记忆。</p>
                <div className="power-toolbar">
                  <input placeholder="搜索记忆" value={memoryQuery} onChange={(event) => setMemoryQuery(event.target.value)} />
                  <select value={memoryTypeFilter} onChange={(event) => setMemoryTypeFilter(event.target.value)}>
                    <option value="">全部</option>
                    <option value="impression">关于我</option>
                    <option value="event">项目 / 事件</option>
                    <option value="skill">可复用经验</option>
                  </select>
                  <button onClick={() => void loadUserMemories()} disabled={powerBusy}>筛选</button>
                </div>
                <div className="memory-actions">
                  <button onClick={() => setMemoryEditing(newUserMemoryDraft("impression", userId, selectedAgentId))}>添加关于我</button>
                  <button onClick={() => setMemoryEditing(newUserMemoryDraft("event", userId, selectedAgentId))}>添加项目 / 事件</button>
                  <button onClick={() => setMemoryEditing(newUserMemoryDraft("skill", userId, selectedAgentId, workspaceDraft?.id))}>添加经验</button>
                </div>
                <div className="memory-manager">
                  <div className="memory-card-list">
                    {memories.map((memory) => (
                      <article key={memory.id} className={`memory-card ${memoryEditing?.id === memory.id ? "active" : ""}`}>
                        <button onClick={() => setMemoryEditing(memory)}>
                          <small>{memoryTypeLabel(memory.memoryType)}</small>
                          <strong>{memory.title}</strong>
                          <span>{memory.summary}</span>
                        </button>
                        <button className="danger-text" onClick={() => void deleteUserMemory(memory.id)} disabled={powerBusy}>删除</button>
                      </article>
                    ))}
                    {memories.length === 0 && <div className="soft-empty">还没有匹配的记忆。</div>}
                  </div>
                  <div className="power-editor">
                    {memoryEditing ? (
                      <>
                        <label>类型
                          <select value={memoryEditing.memoryType ?? "impression"} onChange={(event) => setMemoryEditing({ ...memoryEditing, memoryType: event.target.value as MemoryRow["memoryType"] })}>
                            <option value="impression">关于我</option>
                            <option value="event">项目 / 事件</option>
                            <option value="skill">可复用经验</option>
                          </select>
                        </label>
                        <label>标题<input value={memoryEditing.title ?? ""} onChange={(event) => setMemoryEditing({ ...memoryEditing, title: event.target.value })} /></label>
                        <label>摘要<textarea value={memoryEditing.summary ?? ""} onChange={(event) => setMemoryEditing({ ...memoryEditing, summary: event.target.value })} /></label>
                        <label>详情<textarea value={memoryEditing.detail ?? ""} onChange={(event) => setMemoryEditing({ ...memoryEditing, detail: event.target.value })} /></label>
                        {memoryEditing.memoryType === "skill" && (
                          <label>适用工作空间<input value={memoryEditing.workspaceId ?? ""} onChange={(event) => setMemoryEditing({ ...memoryEditing, workspaceId: event.target.value || undefined })} placeholder="例如 search 或 dev" /></label>
                        )}
                        <div className="settings-actions inline">
                          <button className="primary" onClick={() => void saveUserMemory()} disabled={powerBusy}>保存记忆</button>
                          <button onClick={() => setMemoryEditing(null)}>取消</button>
                        </div>
                      </>
                    ) : <div className="soft-empty">选择一条记忆查看详情，或添加新的记忆。</div>}
                  </div>
                </div>
              </section>
            )}
            {settingsSection === "advanced" && (
              <section className="settings-section">
                <p>这些设置用于本地调试或多身份测试。普通使用不需要修改。</p>
                <label>userId<input value={userId} onChange={(event) => setUserId(event.target.value)} /></label>
                <label>userRole
                  <select value={userRole} onChange={(event) => setUserRole(event.target.value as "user" | "creator")}>
                    <option value="user">user</option>
                    <option value="creator">creator</option>
                  </select>
                </label>
                <label>conversationId<input value={conversationId} readOnly /></label>
              </section>
            )}
            <div className="settings-actions">
              <button className="primary" onClick={() => setSettingsOpen(false)}>完成</button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

function LegacyDevApp() {
  const [tab, setTab] = useState<Tab>("chat");
  const renderTabPanel = (item: Tab, node: React.ReactNode) => (
    <div className={`tab-panel ${tab === item ? "active" : ""}`} aria-hidden={tab !== item}>
      {node}
    </div>
  );

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>Zleap Agent</h1>
          <p>工作空间优先的智能体调试控制台</p>
        </div>
        <nav className="tabs" aria-label="主导航">
          {(["chat", "workspace", "memory", "logs", "tables", "config", "concept"] as Tab[]).map((item) => (
            <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>
              {TAB_LABELS[item]}
            </button>
          ))}
        </nav>
      </header>
      {renderTabPanel("chat", <ChatTab />)}
      {renderTabPanel("workspace", <WorkspaceTab />)}
      {renderTabPanel("memory", <MemoryTab />)}
      {renderTabPanel("logs", <LogsTab />)}
      {renderTabPanel("tables", <DatabaseTablesTab />)}
      {renderTabPanel("config", <ConfigTab />)}
      {renderTabPanel("concept", <ConceptIntroTab />)}
    </main>
  );
}

function configCategoryLabel(category: string): string {
  if (category === "agent") return "Agent 调度";
  if (category === "memory") return "记忆策略";
  if (category === "llm") return "LLM 请求";
  if (category === "context") return "上下文预算";
  return category;
}

function configDraftValue(item: RuntimeConfigItem): string {
  return item.valueType === "boolean" ? String(Boolean(item.value)) : String(item.value);
}

function parseConfigDraft(item: RuntimeConfigItem, value: string): unknown {
  if (item.valueType === "boolean") return value === "true";
  if (item.valueType === "number") return Number(value);
  return value;
}

function ConfigTab() {
  const [configs, setConfigs] = useState<RuntimeConfigItem[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [savingKey, setSavingKey] = useState("");

  async function load() {
    setError("");
    try {
      const params = new URLSearchParams({ actorId: "creator", actorRole: "creator" });
      const data = await api<{ configs: RuntimeConfigItem[] }>(`/api/config?${params.toString()}`);
      setConfigs(data.configs);
      setDrafts(Object.fromEntries(data.configs.map((item) => [item.key, configDraftValue(item)])));
    } catch (err) {
      setError(`加载配置失败：${memoryErrorText(err)}`);
    }
  }

  async function saveConfig(item: RuntimeConfigItem, nextValue = drafts[item.key] ?? configDraftValue(item)) {
    setSavingKey(item.key);
    setError("");
    try {
      const saved = await api<RuntimeConfigItem>(`/api/config/${encodeURIComponent(item.key)}`, {
        method: "PUT",
        body: JSON.stringify({
          actorId: "creator",
          actorRole: "creator",
          value: parseConfigDraft(item, nextValue)
        })
      });
      setConfigs((current) => current.map((candidate) => candidate.key === saved.key ? saved : candidate));
      setDrafts((current) => ({ ...current, [saved.key]: configDraftValue(saved) }));
    } catch (err) {
      setError(`保存配置失败：${memoryErrorText(err)}`);
    } finally {
      setSavingKey("");
    }
  }

  useEffect(() => {
    load().catch(console.error);
  }, []);

  const grouped = configs.reduce<Record<string, RuntimeConfigItem[]>>((acc, item) => {
    acc[item.category] = [...(acc[item.category] ?? []), item];
    return acc;
  }, {});

  return (
    <section className="config-page">
      <div className="config-header">
        <div>
          <h2>运行配置</h2>
          <p>这些参数保存在 SQLite 的 `runtime_config` 表里，保存后下一次 runtime/LLM 调用会读取最新值。</p>
        </div>
        <button onClick={() => void load()}>刷新</button>
      </div>
      {error && <div className="error memory-error"><span>{error}</span></div>}
      {Object.entries(grouped).map(([category, items]) => (
        <section className="config-section panel" key={category}>
          <h3>{configCategoryLabel(category)}</h3>
          <div className="config-list">
            {items.map((item) => {
              const draft = drafts[item.key] ?? configDraftValue(item);
              const changed = draft !== configDraftValue(item);
              return (
                <article className="config-row" key={item.key}>
                  <div className="config-copy">
                    <strong>{item.label}</strong>
                    <code>{item.key}</code>
                    <p>{item.description}</p>
                    <small>默认值：{String(item.defaultValue)}{item.minValue !== undefined || item.maxValue !== undefined ? ` · 范围：${item.minValue ?? "-"} - ${item.maxValue ?? "-"}` : ""}</small>
                  </div>
                  <div className="config-control">
                    {item.valueType === "boolean" ? (
                      <select value={draft} onChange={(event) => setDrafts((current) => ({ ...current, [item.key]: event.target.value }))}>
                        <option value="true">开启</option>
                        <option value="false">关闭</option>
                      </select>
                    ) : (
                      <input
                        type={item.valueType === "number" ? "number" : "text"}
                        min={item.minValue}
                        max={item.maxValue}
                        step={item.step}
                        value={draft}
                        onChange={(event) => setDrafts((current) => ({ ...current, [item.key]: event.target.value }))}
                      />
                    )}
                    <div className="config-actions">
                      <button className="primary" disabled={!changed || savingKey === item.key} onClick={() => void saveConfig(item)}>保存</button>
                      <button disabled={savingKey === item.key} onClick={() => void saveConfig(item, String(item.defaultValue))}>恢复默认</button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ))}
    </section>
  );
}

function ConceptIntroTab() {
  return (
    <section className="concept-page">
      <section className="concept-hero">
        <div className="concept-hero-copy">
          <span className="concept-kicker">Zleap Agent Framework</span>
          <h2>稳定身份 + 动态工作空间状态</h2>
          <p>
            Zleap 的核心不是让模型看到更多内容，而是让模型在正确的工作空间里看到正确内容。
            Runtime 负责边界、隔离和生命周期，模型负责判断、行动和自然表达。
          </p>
        </div>
        <div className="identity-diagram" aria-label="Agent 结构图">
          <div className="identity-node stable">
            <strong>Stable Identity</strong>
            <span>LLM / 系统提示词 / 人格提示词 / 自我印象</span>
          </div>
          <div className="identity-plus">+</div>
          <div className="identity-node dynamic">
            <strong>Dynamic Workspace State</strong>
            <span>工具 / 局部记忆 / 持续本地记录 / 工具证据</span>
          </div>
        </div>
      </section>

      <section className="concept-section">
        <div className="section-heading">
          <span>问题与答案</span>
          <h2>为什么不是一个装满所有能力的大 Agent</h2>
        </div>
        <div className="compare-grid">
          <article className="compare-card problem">
            <h3>传统 Agent</h3>
            <code>LLM + 所有 tools + 所有 memory + 所有 context</code>
            <ul>
              <li>工具、记忆、历史全部混在同一个窗口里。</li>
              <li>模型既要编排任务，又要执行底层操作。</li>
              <li>用户信息、过程事件、共享经验容易互相污染。</li>
              <li>上下文越堆越大，注意力越来越稀薄。</li>
            </ul>
          </article>
          <article className="compare-card solution">
            <h3>Zleap Agent</h3>
            <code>Stable Identity + Dynamic Workspace State</code>
            <ul>
              <li>按 workspace 暴露当前真正需要的工具。</li>
              <li>Main 负责编排，子 workspace 负责专业执行。</li>
              <li>Workspace manifest 是共享能力地图，不是共享工具权限。</li>
              <li>Impression、Event、Skill 分层存储和召回。</li>
              <li>每次 LLM 调用都能检查真实 context stack。</li>
            </ul>
          </article>
        </div>
      </section>

      <section className="concept-section">
        <div className="section-heading">
          <span>工作空间模型</span>
          <h2>Workspace 是能力边界，不是子 Agent</h2>
        </div>
        <div className="workspace-map">
          <div className="map-main">
            <strong>Main Workspace</strong>
            <span>理解目标、选择 workspace、整合结果</span>
            <small>持有调度权；整合子空间 handoff 建议</small>
          </div>
          <div className="map-branches">
            {[
              ["Dev", "统一处理文件搜索、代码检查和命令执行", "searchFiles / runCommand"],
              ["MCP", "外部或用户提供能力，可建议 main handoff", "stdio / Streamable HTTP"]
            ].map(([name, desc, tools]) => (
              <div className="map-workspace" key={name}>
                <strong>{name} Workspace</strong>
                <span>{desc}</span>
                <small>{tools}</small>
              </div>
            ))}
          </div>
        </div>
        <div className="flow-lane">
          {["用户请求", "Main 编排", "enterWorkspace", "子空间执行", "exitWorkspace", "Main 整合", "最终答复"].map((item) => (
            <div className="flow-step" key={item}>{item}</div>
          ))}
        </div>
      </section>

      <section className="concept-section">
        <div className="section-heading">
          <span>记忆系统</span>
          <h2>Impression / Event / Skill 三层分工</h2>
        </div>
        <div className="memory-triad">
          <article>
            <strong>Impression</strong>
            <span>记人和 Agent 自我</span>
            <p>Agent 主动写入稳定偏好、背景和长期约束；afterAgentTurn hook 做保守防漏，没有明确稳定信息就跳过。</p>
          </article>
          <article>
            <strong>Event</strong>
            <span>记事情过程和结果</span>
            <p>由 runtime hook 自动提取；结果事件保留旧结果时间线，过程事件只按当前任务相关性少量召回，完整详情按需用 readMemory 读取。</p>
          </article>
          <article>
            <strong>Skill</strong>
            <span>记可复用方法</span>
            <p>上下文默认只显示近 N 条名称和简介；高度相关时由 Agent 调用 readSkill 读取完整步骤，避免把所有经验细节一次性塞进窗口。</p>
          </article>
        </div>
        <table className="concept-table">
          <thead>
            <tr>
              <th>记忆类型</th>
              <th>跨 Workspace</th>
              <th>User 隔离</th>
              <th>共享</th>
              <th>用途</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>User Impression</td><td>是</td><td>是</td><td>否</td><td>长期偏好、背景、约束</td></tr>
            <tr><td>Agent Self Impression</td><td>是</td><td>否</td><td>creator 控制</td><td>Agent 自我认知</td></tr>
            <tr><td>Event</td><td>否</td><td>是</td><td>否</td><td>某用户在某 workspace 做过什么</td></tr>
            <tr><td>Skill</td><td>否</td><td>否</td><td>是</td><td>某 workspace 可复用经验</td></tr>
          </tbody>
        </table>
      </section>

      <section className="concept-section">
        <div className="section-heading">
          <span>记忆召回</span>
          <h2>长对话靠投影延续，不靠原文回灌</h2>
        </div>
        <div className="memory-triad">
          <article>
            <strong>原始近邻</strong>
            <span>最近 20 条本地记录</span>
            <p>保留当前任务最需要的细节；更早的长对话不直接回灌原文，避免把上下文窗口重新撑满。</p>
          </article>
          <article>
            <strong>事件投影</strong>
            <span>10 条结果 + 相关过程索引</span>
            <p>结果事件提供旧任务时间线；过程事件只按当前任务相关性召回少量索引和摘要投影，完整细节按 id 用 readMemory 读取。</p>
          </article>
          <article>
            <strong>稳定印象</strong>
            <span>固定最新 20 条 + readMemory</span>
            <p>Impression 不按 query 筛选；默认只注入紧凑投影并标出详情未注入。用户追问“详细说说”或摘要不足时，必须按 id 调用 readMemory 再展开。</p>
          </article>
          <article>
            <strong>经验披露</strong>
            <span>Skill 名称简介 + readSkill</span>
            <p>Skill 先作为索引出现；只有当简介能明显降低失败率或指导工具流程时，才读取 detail、procedure、适用和避免条件。</p>
          </article>
        </div>
      </section>

      <section className="concept-section">
        <div className="section-heading">
          <span>上下文窗口堆栈</span>
          <h2>一级分区少而稳定，二级内容在分区里展开</h2>
        </div>
        <div className="context-stack-blueprint">
          {[
            {
              code: "system",
              title: "系统提示词",
              summary: "唯一 system message：基础系统提示词、人格提示词、内部运行策略、workspace 决策契约。",
              items: ["不放 tools JSON", "不放 memory 原文", "要求最终回复隐藏 runtime/workspace 机制"]
            },
            {
              code: "workspace",
              title: "工作空间信息",
              summary: "当前 workspace 的说明、manifest、instructions、memory policy，以及可用 workspace 能力地图。",
              items: ["main 有调度权", "子 workspace 只有当前工具", "子 workspace 可知道其他 workspace 存在但不能直接切换"]
            },
            {
              code: "tools",
              title: "可调用工具",
              summary: "OpenAI-compatible 顶层 tools 数组的可检查快照，不是写进 system prompt 的文本。",
              items: ["function 名称与说明", "参数 schema", "runtime / MCP / risk / active workspace metadata"]
            },
            {
              code: "memory",
              title: "记忆投影",
              summary: "runtime_context.memory 的分区投影视图，默认只注入 compact projection，不回灌原始 detail。",
              items: ["跨工作空间印象记忆", "当前工作空间结果事件", "当前工作空间相关过程事件", "当前工作空间经验记忆"],
              memoryDetails: [
                ["crossWorkspaceImpressionMemory", "跨工作空间印象记忆", "最新有效 20 条投影", "用户印象与 Agent 自我印象；默认不做 query 筛选，详情未注入，必要时用 readMemory。"],
                ["currentWorkspaceResultEvents", "当前工作空间结果事件", "约 10 条旧结果时间线", "记录过去完成了什么、失败了什么、产出在哪里；不复制原始对话。"],
                ["currentWorkspaceRelevantProcessEvents", "当前工作空间相关过程事件", "少量 FTS 相关过程索引", "只给 id/title/summary/readMemory 提示；过程 detail 不直接进入上下文。"],
                ["currentWorkspaceSkillMemory", "当前工作空间经验记忆", "近 N 条名称和简介", "先看简介判断相关性；高度相关时调用 readSkill 读取 procedure/appliesWhen/avoidWhen。"]
              ]
            },
            {
              key: "local_conversation",
              code: "runtime_context.local_conversation",
              title: "本地对话片段",
              summary: "UI 叫本地对话片段，内部 segmentType 是 history；它不是全局聊天记录。",
              items: ["同 workspace 最近本地消息", "当前 WorkspaceTask", "同 workspace 已完成结果", "crossWorkspaceHandoffContext", "近期本地工具证据"]
            },
            {
              code: "user",
              title: "干净用户消息",
              summary: "当前用户原文保持干净，只表达用户这一轮说了什么。",
              items: ["不拼接系统策略", "不拼接记忆", "不拼接工具说明"]
            },
            {
              code: "tool_result",
              title: "工具结果",
              summary: "只有工具执行后的 follow-up LLM call 才出现，包含 assistant tool_calls 与真实 tool messages。",
              items: ["点击工具结果块时查看这一层", "结果长文本应摘要展示", "原始结果留在 tool_calls / 日志"]
            }
          ].map((layer, index) => (
            <article className={`context-layer-card ${layer.key ?? layer.code}`} key={layer.key ?? layer.code}>
              <b>{index + 1}</b>
              <div>
                <strong>{layer.title}</strong>
                <code>{layer.code}</code>
                <p>{layer.summary}</p>
                <ul>
                  {layer.items.map((item) => <li key={item}>{item}</li>)}
                </ul>
                {"memoryDetails" in layer && Array.isArray(layer.memoryDetails) && (
                  <div className="memory-detail-in-stack">
                    <div className="memory-detail-heading">
                      <strong>memory 分区展开</strong>
                      <span>自动注入的是索引和摘要；详情靠 readMemory / readSkill 渐进读取</span>
                    </div>
                    <div className="memory-detail-grid">
                      {layer.memoryDetails.map(([code, title, badge, desc]) => (
                        <article key={code}>
                          <div>
                            <strong>{title}</strong>
                            <small>{badge}</small>
                          </div>
                          <code>{code}</code>
                          <p>{desc}</p>
                        </article>
                      ))}
                    </div>
                    <div className="progressive-disclosure">
                      <span>summary_only</span>
                      <span>detailInjected=false</span>
                      <span>detailAvailable=true</span>
                      <span>readMemory(memoryId)</span>
                      <span>readSkill(skillId)</span>
                    </div>
                  </div>
                )}
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="concept-section">
        <div className="section-heading">
          <span>生命周期</span>
          <h2>Runtime 负责边界，模型负责判断和行动</h2>
        </div>
        <div className="lifecycle-grid">
          {[
            ["beforeAgentTurn", "校验会话归属、加载配置、准备 context"],
            ["beforeWorkspaceEnter", "权限检查、构造 WorkspaceTask、召回记忆"],
            ["beforeToolCall / afterToolCall", "校验工具边界、保存结果、更新局部证据"],
            ["beforeWorkspaceExit", "校验结构化 WorkspaceResult"],
            ["afterWorkspaceExit", "保存结果、提取 event、生成 skill candidate"],
            ["afterAgentTurn", "基于已保存对话窗口沉淀长期记忆"]
          ].map(([hook, desc]) => (
            <article key={hook}>
              <strong>{hook}</strong>
              <span>{desc}</span>
            </article>
          ))}
        </div>
      </section>

      <section className="concept-section principle-section">
        <div className="section-heading">
          <span>七大原则</span>
          <h2>让框架可以长期成长，而不是只跑一次任务</h2>
        </div>
        <div className="principle-grid">
          {[
            "注意力分区",
            "稳定人格",
            "Workspace 即能力边界",
            "记忆分层",
            "多租户优先",
            "可成长",
            "可运行"
          ].map((item, index) => (
            <div className="principle" key={item}>
              <b>{index + 1}</b>
              <span>{item}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="concept-section">
        <div className="section-heading">
          <span>实现路线</span>
          <h2>从理念到 TypeScript Agent Framework</h2>
        </div>
        <div className="module-grid">
          {[
            ["core", "AgentRuntime、ContextBuilder、LLM、tool loop、memory lifecycle"],
            ["db", "SQLite schema、Raw SQL repositories、migrations、seed"],
            ["server", "HTTP API、streaming endpoint、static web serving"],
            ["web", "对话、工作空间、记忆、日志、上下文堆栈、概念介绍"],
            ["tests", "runtime、memory、policy、context、MCP、UI contract"]
          ].map(([name, desc]) => (
            <article key={name}>
              <strong>src/{name}</strong>
              <span>{desc}</span>
            </article>
          ))}
        </div>
      </section>
    </section>
  );
}

function ChatTab() {
  const cached = loadCache();
  const queryConversationId = new URLSearchParams(window.location.search).get("conversationId") ?? "";
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState(cached.agentId ?? "default-agent");
  const [agent, setAgent] = useState<AgentConfig | null>(null);
  const [userId, setUserId] = useState(cached.userId ?? "user");
  const [userRole, setUserRole] = useState<"user" | "creator">(cached.userRole ?? "user");
  const [conversationId, setConversationId] = useState(queryConversationId || cached.conversationId || `conv-${Date.now()}`);
  const [baseUrl, setBaseUrl] = useState(normalizeCachedBaseUrl(cached.baseUrl) ?? DEFAULT_BASE_URL);
  const [model, setModel] = useState(cached.model ?? "gpt-5-mini");
  const [apiKey, setApiKey] = useState(cached.apiKey ?? "");
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>(() => normalizeCachedMessages(cached.messages));
  const [output, setOutput] = useState<AgentRunOutput | null>(cached.output ?? null);
  const [trace, setTrace] = useState<ConversationTrace | null>(null);
  const [error, setError] = useState("");
  const [retryMessage, setRetryMessage] = useState(cached.retryMessage ?? "");
  const [selectedTurnId, setSelectedTurnId] = useState(cached.selectedTurnId ?? "");
  const [selectedLlmCallId, setSelectedLlmCallId] = useState(cached.selectedLlmCallId ?? "");
  const [showRawContextLogs, setShowRawContextLogs] = useState(false);
  const [contextPanelWidth, setContextPanelWidth] = useState(clampContextPanelWidth(cached.contextPanelWidth ?? 420));
  const [loading, setLoading] = useState(false);
  const currentRunControllerRef = useRef<AbortController | null>(null);
  const selectedUserMessage = selectedTurnId ? messages.find((item) => item.id === selectedTurnId && item.role === "用户") : undefined;
  const visibleOutput = selectedUserMessage ? selectedUserMessage.turnOutput ?? null : output;
  const traceSegments = trace?.contextSegments ?? [];
  const llmCalls = (trace?.llmCalls ?? []).slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const inspectedMessage = selectedTurnId ? messages.find((item) => item.id === selectedTurnId) : undefined;
  const inspectedOutput = inspectedMessage?.role === "用户" ? inspectedMessage.turnOutput ?? output : output;
  const inspectedLlmCallId = selectedLlmCallId || inspectedMessage?.inspectLlmCallId || inspectedOutput?.contextSegments?.[0]?.llmCallId || llmCalls.at(-1)?.id || "";
  const inspectedLlmCall = llmCalls.find((call) => call.id === inspectedLlmCallId);
  const inspectedLlmSegments = inspectedLlmCallId ? segmentsForLlmCall(traceSegments, inspectedLlmCallId) : [];
  const inspectedRawContextSegments = inspectedLlmSegments.length > 0 ? inspectedLlmSegments : (inspectedOutput?.contextSegments ?? []);
  const inspectedContextSegments = segmentsWithToolSnapshot(inspectedRawContextSegments, inspectedLlmCall);
  const workspaceView = describeSelectedWorkspaceView({
    output: visibleOutput,
    message: inspectedMessage,
    llmCallId: inspectedLlmCallId,
    contextSegments: traceSegments
  });
  const displayedContextSegments = inspectedContextSegments.filter((segment) => segment.segmentType !== "final_messages");
  const rawContextLogSegment = inspectedContextSegments.find((segment) => segment.segmentType === "final_messages");
  const hasRawContextLogs = Boolean(inspectedLlmCall || rawContextLogSegment);
  const visibleMemoryWrites = memoryWritesForVisibleTurn(visibleOutput, trace?.memoryWrites ?? []);

  function resetConversationState() {
    setConversationId(`conv-${Date.now()}`);
    setMessage("");
    setMessages([]);
    setOutput(null);
    setTrace(null);
    setError("");
    setRetryMessage("");
    setSelectedTurnId("");
    setSelectedLlmCallId("");
  }

  function applySelectedAgent(nextAgent: AgentConfig, resetConversation = true) {
    setSelectedAgentId(nextAgent.id);
    setAgent(nextAgent);
    setBaseUrl(normalizeCachedBaseUrl(nextAgent.defaultBaseUrl) ?? DEFAULT_BASE_URL);
    setModel(nextAgent.defaultModel);
    if (resetConversation) resetConversationState();
  }

  async function loadConversationTrace(targetConversationId = conversationId): Promise<ConversationTrace | null> {
    if (!targetConversationId.trim()) return null;
    try {
      const params = new URLSearchParams({ actorId: userId, actorRole: userRole });
      const loaded = await api<ConversationTrace>(`/api/conversations/${encodeURIComponent(targetConversationId)}/trace?${params.toString()}`);
      setTrace(loaded);
      return loaded;
    } catch {
      return null;
    }
  }

  useEffect(() => {
    api<{ agents: AgentConfig[] }>("/api/agents")
      .then(({ agents: loadedAgents }) => {
        const allAgents = loadedAgents.length > 0 ? loadedAgents : [];
        setAgents(allAgents);
        const loaded = allAgents.find((item) => item.id === selectedAgentId)
          ?? allAgents.find((item) => item.id === "default-agent")
          ?? allAgents[0];
        if (!loaded) throw new Error("没有可用智能体。");
        const draft = sanitizeCachedAgentDraft(cached.agentDraft);
        const merged = { ...loaded, ...draft };
        setSelectedAgentId(merged.id);
        setAgent(merged);
        setBaseUrl(normalizeCachedBaseUrl(cached.baseUrl) ?? normalizeCachedBaseUrl(merged.defaultBaseUrl) ?? DEFAULT_BASE_URL);
        setModel(cached.model ?? merged.defaultModel);
      })
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    if (!conversationId || (!output && messages.length === 0)) return;
    void loadConversationTrace(conversationId);
  }, [conversationId, userId, userRole]);

  useEffect(() => {
    saveCache({ agentId: selectedAgentId, userId, userRole, conversationId, baseUrl, model, apiKey, contextPanelWidth, messages, output, retryMessage, selectedTurnId, selectedLlmCallId, agentDraft: agent ?? undefined });
  }, [selectedAgentId, userId, userRole, conversationId, baseUrl, model, apiKey, contextPanelWidth, messages, output, retryMessage, selectedTurnId, selectedLlmCallId, agent]);

  function selectAgent(agentId: string) {
    const nextAgent = agents.find((item) => item.id === agentId);
    if (!nextAgent) return;
    applySelectedAgent(nextAgent);
  }

  async function createAgent() {
    const sourceAgent = agent ?? agents[0];
    if (!sourceAgent) return;
    const effectiveBaseUrl = normalizeCachedBaseUrl(baseUrl) ?? DEFAULT_BASE_URL;
    try {
      const created = await api<AgentConfig>("/api/agents", {
        method: "POST",
        body: JSON.stringify({
          id: `agent-${Date.now()}`,
          name: `新智能体 ${agents.length + 1}`,
          systemPrompt: sourceAgent.systemPrompt,
          personalityPrompt: sourceAgent.personalityPrompt,
          defaultModel: model || sourceAgent.defaultModel,
          defaultBaseUrl: effectiveBaseUrl,
          actorId: userId,
          actorRole: userRole
        })
      });
      setAgents((items) => [...items, created]);
      applySelectedAgent(created);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function saveAgent() {
    if (!agent) return;
    try {
      const saved = await api<AgentConfig>(`/api/agents/${agent.id}`, {
        method: "PUT",
        body: JSON.stringify({ ...agent, actorId: userId, actorRole: userRole })
      });
      setAgent(saved);
      setAgents((items) => items.map((item) => item.id === saved.id ? saved : item));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function removeFailedRetryPair(items: ChatMessage[], requestText: string): ChatMessage[] {
    const last = items.at(-1);
    if (!last?.failed || last.requestText !== requestText) return items;
    const withoutError = items.slice(0, -1);
    const previous = withoutError.at(-1);
    if (previous?.role === "用户" && previous.content === requestText) return withoutError.slice(0, -1);
    return withoutError;
  }

  async function sendMessage(retryText?: string) {
    const cleanMessage = typeof retryText === "string" ? retryText : message;
    if (loading || !cleanMessage.trim() || !agent) return;
    const runId = createLocalId("run");
    const userMessageId = createLocalId("user-msg");
    const assistantMessageId = createLocalId("assistant-msg");
    const controller = new AbortController();
    currentRunControllerRef.current = controller;
    setLoading(true);
    setError("");
    setRetryMessage("");
    setSelectedTurnId(userMessageId);
    setSelectedLlmCallId("");
    setMessage("");
    setMessages((items) => [
      ...removeFailedRetryPair(items, cleanMessage),
      { id: userMessageId, runId, role: "用户", content: cleanMessage },
      { id: assistantMessageId, runId, role: "助手", content: "", streaming: true }
    ]);

    const effectiveBaseUrl = normalizeCachedBaseUrl(baseUrl) ?? DEFAULT_BASE_URL;
    if (effectiveBaseUrl !== baseUrl) setBaseUrl(effectiveBaseUrl);

    try {
      const insertBeforeAssistant = (items: ChatMessage[], item: ChatMessage): ChatMessage[] => {
        const index = items.findIndex((candidate) => candidate.id === assistantMessageId);
        if (index < 0) return [...items, item];
        const next = [...items];
        next.splice(index, 0, item);
        return next;
      };

      const appendWorkspaceMessage = async (payload: {
        workspaceId: string;
        eventKind: string;
        title: string;
        text: string;
        status?: string;
        toolNames?: string[];
        llmCallId?: string;
        items?: WorkspaceProcessItem[];
      }) => {
        if (controller.signal.aborted) throw new Error("运行已停止。");
        const workspaceMessageId = createLocalId(`workspace-${payload.workspaceId}`);
        const baseContent = payload.text.trim()
          ? `**${payload.title}**\n\n${payload.text}`
          : `**${payload.title}**`;
        if (payload.eventKind !== "assistant") {
          setMessages((items) => insertBeforeAssistant(items, {
            id: workspaceMessageId,
            runId,
            role: "运行过程",
            workspaceId: payload.workspaceId,
            eventKind: payload.eventKind,
            title: payload.title,
            toolNames: payload.toolNames,
            processItems: payload.items,
            status: payload.status,
            inspectLlmCallId: payload.llmCallId,
            content: baseContent
          }));
          return;
        }
        setMessages((items) => insertBeforeAssistant(items, {
          id: workspaceMessageId,
          runId,
          role: "工作空间",
          workspaceId: payload.workspaceId,
          eventKind: payload.eventKind,
          inspectLlmCallId: payload.llmCallId,
          content: "",
          streaming: true
        }));
        let streamed = "";
        for (const char of Array.from(baseContent)) {
          if (controller.signal.aborted) throw new Error("运行已停止。");
          streamed += char;
          setMessages((items) => items.map((item) => item.id === workspaceMessageId ? { ...item, content: streamed, streaming: true } : item));
          await sleep(8);
        }
        setMessages((items) => items.map((item) => item.id === workspaceMessageId ? { ...item, content: baseContent, streaming: false } : item));
      };

      const response = await fetch("/api/agent/run/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: agent.id,
          userId,
          userRole,
          conversationId,
          message: cleanMessage,
          llm: { baseUrl: effectiveBaseUrl, model, apiKey: apiKey || undefined }
        }),
        signal: controller.signal
      });
      if (!response.ok || !response.body) throw new Error(`流式请求失败：${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let assistantText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (controller.signal.aborted) throw new Error("运行已停止。");
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";

        for (const event of events) {
          const line = event.split("\n").find((item) => item.startsWith("data:"));
          if (!line) continue;
          const payload = JSON.parse(line.slice(5).trim()) as any;
          if (payload.type === "start") {
            const startOutput = { ...payload.output, assistantMessage: "" } as AgentRunOutput;
            const startLlmCallId = startOutput.contextSegments[0]?.llmCallId ?? "";
            setOutput(startOutput);
            setSelectedLlmCallId(startLlmCallId);
            setMessages((items) => items.map((item) => item.id === userMessageId
              ? { ...item, turnOutput: startOutput, inspectLlmCallId: startLlmCallId }
              : item.id === assistantMessageId
                ? { ...item, inspectLlmCallId: startLlmCallId }
                : item));
          }
          if (payload.type === "delta") {
            for (const char of Array.from(payload.text)) {
              if (controller.signal.aborted) throw new Error("运行已停止。");
              assistantText += char;
              setMessages((items) => {
                return items.map((item) => item.id === assistantMessageId ? { ...item, content: assistantText, streaming: true } : item);
              });
              await sleep(16);
            }
          }
          if (payload.type === "workspace") {
            await appendWorkspaceMessage(payload);
          }
          if (payload.type === "done") {
            setRetryMessage("");
            setOutput(payload.output);
            const loadedTrace = await loadConversationTrace(payload.output.conversationId);
            const calls = (loadedTrace?.llmCalls ?? []).slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
            const firstCallId = payload.output.contextSegments[0]?.llmCallId ?? "";
            const turnCalls = llmCallsForTurn(firstCallId, calls);
            const finalCallId = turnCalls.at(-1)?.id ?? firstCallId;
            const mainToolProcessMessages = toolProcessMessagesForTurn({
              runId,
              firstLlmCallId: firstCallId,
              llmCalls: calls,
              toolCalls: loadedTrace?.toolCalls ?? []
            });
            setSelectedLlmCallId(firstCallId);
            setMessages((items) => items.map((item) => item.id === userMessageId ? { ...item, turnOutput: payload.output, inspectLlmCallId: firstCallId } : item));
            setMessages((items) => {
              const hasMainToolProcess = items.some((item) => item.runId === runId && item.role === "运行过程" && item.workspaceId === "main" && (item.eventKind === "tool_call" || item.eventKind === "tool_result"));
              const withAssistant = items.map((item) => item.id === assistantMessageId
                ? { ...item, content: payload.output.assistantMessage, streaming: false, inspectLlmCallId: finalCallId }
                : item);
              if (hasMainToolProcess || mainToolProcessMessages.length === 0) return withAssistant;
              const assistantIndex = withAssistant.findIndex((item) => item.id === assistantMessageId);
              if (assistantIndex < 0) return [...withAssistant, ...mainToolProcessMessages];
              return [
                ...withAssistant.slice(0, assistantIndex),
                ...mainToolProcessMessages,
                ...withAssistant.slice(assistantIndex)
              ];
            });
          }
          if (payload.type === "error") {
            throw new Error(payload.error);
          }
        }
      }
    } catch (err) {
      if (controller.signal.aborted) {
        setError("");
        setRetryMessage("");
        setMessages((items) => items.map((item) => item.id === assistantMessageId
          ? { ...item, content: item.content || "已停止运行。", streaming: false, failed: false, requestText: undefined }
          : item.streaming
            ? { ...item, streaming: false }
            : item));
        void loadConversationTrace(conversationId);
        return;
      }
      const messageText = err instanceof Error ? err.message : String(err);
      setError(messageText);
      setRetryMessage(cleanMessage);
      setMessages((items) => items.filter((item) => item.runId !== runId && item.id !== userMessageId && item.id !== assistantMessageId));
      setSelectedTurnId((current) => current === userMessageId ? "" : current);
      setSelectedLlmCallId("");
      void loadConversationTrace(conversationId);
    } finally {
      if (currentRunControllerRef.current === controller) currentRunControllerRef.current = null;
      setLoading(false);
    }
  }

  function stopCurrentRun() {
    currentRunControllerRef.current?.abort();
  }

  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    if (event.ctrlKey) {
      event.preventDefault();
      const target = event.currentTarget;
      const start = target.selectionStart;
      const end = target.selectionEnd;
      setMessage((current) => `${current.slice(0, start)}\n${current.slice(end)}`);
      requestAnimationFrame(() => {
        target.selectionStart = start + 1;
        target.selectionEnd = start + 1;
      });
      return;
    }
    event.preventDefault();
    void sendMessage();
  }

  function handleContextResizePointerDown(event: React.PointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = contextPanelWidth;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const handlePointerMove = (moveEvent: PointerEvent) => {
      setContextPanelWidth(clampContextPanelWidth(startWidth + startX - moveEvent.clientX));
    };
    const handlePointerUp = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  }

  function clearLocalCache() {
    localStorage.removeItem(CACHE_KEY);
    setMessages([]);
    setOutput(null);
    setTrace(null);
    setError("");
    setRetryMessage("");
    setSelectedTurnId("");
    setSelectedLlmCallId("");
    setApiKey("");
    resetConversationState();
  }

  async function clearConversation() {
    await api(`/api/conversations/${encodeURIComponent(conversationId)}`, {
      method: "DELETE",
      body: JSON.stringify({ actorId: userId, actorRole: userRole, deleteReason: "用户在 Web UI 清空当前会话" })
    }).catch(() => undefined);
    resetConversationState();
  }

  return (
    <section className="chat-grid" style={{ "--context-panel-width": `${contextPanelWidth}px` } as React.CSSProperties}>
      <aside className="panel config-panel">
        <h2>智能体配置</h2>
        <label>
          当前智能体
          <select value={selectedAgentId} onChange={(event) => selectAgent(event.target.value)} disabled={loading}>
            {agents.map((item) => <option value={item.id} key={item.id}>{item.name} · {item.id}</option>)}
          </select>
        </label>
        <label>智能体 ID<input value={agent?.id ?? ""} disabled /></label>
        <label>智能体名称<input value={agent?.name ?? ""} onChange={(event) => agent && setAgent({ ...agent, name: event.target.value })} /></label>
        <label>用户 ID<input value={userId} onChange={(event) => setUserId(event.target.value)} /></label>
        <label>
          角色
          <select value={userRole} onChange={(event) => setUserRole(event.target.value as "user" | "creator")}>
            <option value="user">普通用户</option>
            <option value="creator">创建者</option>
          </select>
        </label>
        <label>会话 ID<input value={conversationId} onChange={(event) => setConversationId(event.target.value)} /></label>
        <h2>模型参数</h2>
        <label>接口地址<input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} onBlur={() => setBaseUrl(normalizeCachedBaseUrl(baseUrl) ?? DEFAULT_BASE_URL)} /></label>
        <div className="endpoint-preview">
          <span>实际请求</span>
          <code>{chatCompletionsEndpoint(baseUrl)}</code>
        </div>
        <label>模型<input value={model} onChange={(event) => setModel(event.target.value)} /></label>
        <label>接口密钥（浏览器本机缓存）<input value={apiKey} type="password" onChange={(event) => setApiKey(event.target.value)} placeholder="只存浏览器缓存，不入库" /></label>
        <h2>提示词</h2>
        <label>系统提示词<textarea value={agent?.systemPrompt ?? ""} onChange={(event) => agent && setAgent({ ...agent, systemPrompt: event.target.value })} /></label>
        <label>人格提示词<textarea value={agent?.personalityPrompt ?? ""} onChange={(event) => agent && setAgent({ ...agent, personalityPrompt: event.target.value })} /></label>
        <button className="primary" onClick={saveAgent}>保存智能体</button>
        <button onClick={() => void createAgent()} disabled={loading || !agent}>新建智能体</button>
        <button onClick={clearLocalCache}>清空浏览器缓存</button>
      </aside>

      <section className="panel chat-panel">
        <div className="chat-toolbar">
          <strong>当前会话</strong>
          <button onClick={() => void clearConversation()} disabled={loading || (messages.length === 0 && !output && !error)}>清空当前会话</button>
        </div>
        <div className="message-list">
          {messages.map((item, index) => {
            const inferredLlmCallId = inferMessageLlmCallId(item, index, messages, llmCalls, traceSegments);
            const processItems = processItemsForMessage(item, inferredLlmCallId, llmCalls, trace?.toolCalls ?? []);
            const clickable = Boolean(inferredLlmCallId || item.turnOutput);
            return (
            <article
              key={item.id ?? `${item.role}-${index}`}
              className={`message ${item.role === "用户" ? "user" : item.role === "运行过程" ? "process" : item.role === "工作空间" ? "workspace" : "assistant"} ${clickable ? "clickable" : ""} ${item.failed ? "failed" : ""} ${selectedTurnId === item.id ? "selected" : ""}`}
              role={clickable ? "button" : undefined}
              tabIndex={clickable ? 0 : undefined}
              onClick={() => {
                if (!clickable) return;
                setSelectedTurnId(item.id);
                setSelectedLlmCallId(inferredLlmCallId);
              }}
              onKeyDown={(event) => {
                if (!clickable || (event.key !== "Enter" && event.key !== " ")) return;
                setSelectedTurnId(item.id);
                setSelectedLlmCallId(inferredLlmCallId);
              }}
              title={clickable ? "查看这条消息关联的 LLM 上下文窗口堆栈" : undefined}
            >
              {item.role === "运行过程" ? (
                <div className="process-card">
                  <details className="process-details">
                    <summary>
                      <span className="process-icon">▻</span>
                      <span>{processMessageSummary(item, processItems)}</span>
                      {item.workspaceId && <small>{item.workspaceId}</small>}
                    </summary>
                    <pre>{processMessageDetail(item, processItems)}</pre>
                  </details>
                  {processItems.length ? (
                    <div className="process-preview">
                      {processItems.map((processItem, processIndex) => (
                        <div className="process-preview-row" key={`${processItem.toolName}-${processIndex}`}>
                          {processItemLine(processItem, item.eventKind)}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : (
                <>
                  <span>{messageRoleLabel(item)}{item.streaming ? " · 正在生成" : ""}</span>
                  <MarkdownMessage content={item.content} />
                </>
              )}
              {item.failed && item.requestText && (
                <button className="inline-action" disabled={loading} onClick={() => sendMessage(item.requestText)}>重试</button>
              )}
            </article>
            );
          })}
          {messages.length === 0 && <div className="empty">发送一条消息，右侧会展示当前工作空间、上下文窗口堆栈和记忆写入。</div>}
        </div>
        {error && (
          <div className="error">
            <span>{error}</span>
            {retryMessage && <button disabled={loading} onClick={() => sendMessage(retryMessage)}>重试</button>}
          </div>
        )}
        <div className="composer">
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={handleComposerKeyDown}
            placeholder="输入干净的用户消息..."
          />
          {loading && <button className="danger" onClick={stopCurrentRun}>停止</button>}
          <button className="primary" disabled={loading} onClick={() => sendMessage()}>{loading ? "生成中" : "发送"}</button>
        </div>
      </section>

      <aside className="panel context-panel">
        <button
          className="context-resizer"
          type="button"
          aria-label="调整右侧栏宽度"
          title="拖拽调整右侧栏宽度"
          onPointerDown={handleContextResizePointerDown}
        />
        <h2>当前工作空间</h2>
        <div className="workspace-badge">
          <strong>{workspaceView.primary}</strong>
          {workspaceView.detail && <span>{workspaceView.detail}</span>}
        </div>
        <div className="context-stack-heading">
          <h2>上下文窗口堆栈</h2>
          {hasRawContextLogs && (
            <button className="subtle-button" onClick={() => setShowRawContextLogs((value) => !value)}>
              {showRawContextLogs ? "显示结构化视图" : "显示原始日志"}
            </button>
          )}
        </div>
        {inspectedMessage && !displayedContextSegments.length
          ? <div className="empty">这条消息还没有匹配到已保存的 LLM 上下文快照。</div>
          : showRawContextLogs
            ? <RawContextLog call={inspectedLlmCall} segment={rawContextLogSegment} />
            : <ContextStack segments={displayedContextSegments} />}
        <h2>本轮记忆写入</h2>
        <MemoryWriteStack memories={visibleMemoryWrites} />
      </aside>
    </section>
  );
}

function LogsTab() {
  const cached = loadCache();
  const [userId, setUserId] = useState(cached.userId ?? "user");
  const [userRole, setUserRole] = useState<"user" | "creator">(cached.userRole ?? "user");
  const [conversationId, setConversationId] = useState(cached.conversationId ?? "");
  const [llmLogs, setLlmLogs] = useState<LLMCallSnapshot[]>([]);
  const [globalLlmLogs, setGlobalLlmLogs] = useState<LLMCallSnapshot[]>([]);
  const [toolLogs, setToolLogs] = useState<ToolCallLog[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [approvalRequests, setApprovalRequests] = useState<ApprovalRequest[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function loadLogs() {
    setLoading(true);
    setError("");
    try {
      if (conversationId.trim()) {
        const traceParams = new URLSearchParams({ actorId: userId, actorRole: userRole });
        const trace = await api<ConversationTrace>(`/api/conversations/${encodeURIComponent(conversationId.trim())}/trace?${traceParams.toString()}`);
        setLlmLogs(trace.llmCalls);
        setToolLogs(trace.toolCalls ?? []);
        setAuditLogs(trace.auditLogs ?? []);
        setApprovalRequests(trace.approvalRequests ?? []);
      } else {
        setLlmLogs([]);
        setToolLogs([]);
        setAuditLogs([]);
        setApprovalRequests([]);
      }
      const globalParams = new URLSearchParams({ limit: "100", actorId: userId, actorRole: userRole });
      const global = await api<{ llmCalls: LLMCallSnapshot[] }>(`/api/llm-calls?${globalParams.toString()}`);
      setGlobalLlmLogs(global.llmCalls);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function clearLogView() {
    setLlmLogs([]);
    setGlobalLlmLogs([]);
    setToolLogs([]);
    setAuditLogs([]);
    setApprovalRequests([]);
    setError("");
  }

  useEffect(() => {
    void loadLogs();
  }, []);

  return (
    <section className="logs-page">
      <aside className="panel logs-control-panel">
        <h2>日志范围</h2>
        <label>用户 ID<input value={userId} onChange={(event) => setUserId(event.target.value)} /></label>
        <label>
          角色
          <select value={userRole} onChange={(event) => setUserRole(event.target.value as "user" | "creator")}>
            <option value="user">普通用户</option>
            <option value="creator">创建者</option>
          </select>
        </label>
        <label>会话 ID<input value={conversationId} onChange={(event) => setConversationId(event.target.value)} placeholder="留空时只看全局 LLM 请求" /></label>
        <button className="primary" onClick={() => void loadLogs()} disabled={loading}>{loading ? "加载中" : "刷新日志"}</button>
        <button onClick={clearLogView} disabled={loading}>清空当前日志视图</button>
        {error && <div className="error inline-error"><span>{error}</span></div>}
      </aside>

      <section className="logs-main">
        <LlmDebugSummary
          conversationLogs={llmLogs}
          globalLogs={globalLlmLogs}
          onRefresh={() => void loadLogs()}
        />
        <section className="panel logs-panel">
          <div className="section-heading">
            <h2>生命周期护持日志</h2>
            <button onClick={() => setAuditLogs([])}>清空</button>
          </div>
          <AuditLogPanel logs={auditLogs} />
        </section>
        <section className="panel logs-panel">
          <div className="section-heading">
            <h2>工具调用日志</h2>
            <button onClick={() => setToolLogs([])}>清空</button>
          </div>
          <ToolLogPanel logs={toolLogs} />
        </section>
        <section className="panel logs-panel">
          <div className="section-heading">
            <h2>工具审批请求</h2>
            <button onClick={() => setApprovalRequests([])}>清空</button>
          </div>
          <ApprovalPanel
            requests={approvalRequests}
            canResolve={userRole === "creator"}
            onResolve={async (approvalId, status) => {
              await api(`/api/approvals/${approvalId}/resolve`, {
                method: "POST",
                body: JSON.stringify({ status, actorId: userId, actorRole: userRole })
              });
              await loadLogs();
            }}
          />
        </section>
        <section className="panel logs-panel">
          <div className="section-heading">
            <h2>当前会话 LLM 请求日志</h2>
            <button onClick={() => setLlmLogs([])}>清空</button>
          </div>
          <LlmLogPanel logs={llmLogs} />
        </section>
        <section className="panel logs-panel">
          <div className="section-heading">
            <h2>全局最近 LLM 请求日志</h2>
            <button onClick={() => setGlobalLlmLogs([])}>清空</button>
          </div>
          <LlmLogPanel logs={globalLlmLogs} />
        </section>
      </section>
    </section>
  );
}

function MemoryWriteStack({ memories }: { memories: MemoryRow[] }) {
  if (memories.length === 0) return <div className="empty">本轮没有写入长期记忆。</div>;
  return (
    <div className="stack memory-write-stack">
      {memories.map((memory) => (
        <details key={memory.id}>
          <summary>
            <span>{memory.title}</span>
            <small>{memoryScopeLabel(memory)}</small>
          </summary>
          <div className="memory-write-card">
            <div><span>类型</span><strong>{memory.memoryType}</strong></div>
            <div><span>Scope</span><strong>{memoryScopeLabel(memory)}</strong></div>
            <div><span>用户 ID</span><code>{memory.userId ?? "-"}</code></div>
            <div><span>Agent ID</span><code>{memory.agentId ?? "-"}</code></div>
            <div><span>工作空间 ID</span><code>{memory.workspaceId ?? "-"}</code></div>
            <div><span>关系 ID</span><code>{memory.relationId ?? "-"}</code></div>
            <div className="wide"><span>摘要</span><p>{memory.summary}</p></div>
          </div>
          <details>
            <summary>完整记录</summary>
            <JsonValueView value={memory} />
          </details>
        </details>
      ))}
    </div>
  );
}

function ToolLogPanel({ logs }: { logs: ToolCallLog[] }) {
  if (logs.length === 0) return <div className="empty">还没有工具调用日志。</div>;
  return (
    <div className="stack tool-log-stack">
      {logs.map((log) => (
        <details key={log.id}>
          <summary>
            <span>{log.toolName}</span>
            <small className={`status-pill ${toolCallStatusClass(log.status)}`}>{toolCallStatusLabel(log.status)}</small>
          </summary>
          <div className="llm-log-meta">
            <span>工作空间：{log.workspaceId}</span>
            <span>时间：{log.createdAt}</span>
            <span>调用 ID：{log.id}</span>
          </div>
          <details>
            <summary>参数</summary>
            <pre>{JSON.stringify(parseJsonText(log.argumentsJson), null, 2)}</pre>
          </details>
          <details>
            <summary>结果</summary>
            <pre>{JSON.stringify(parseJsonText(log.resultJson), null, 2)}</pre>
          </details>
        </details>
      ))}
    </div>
  );
}

function approvalStatusLabel(status: ApprovalRequest["status"]): string {
  if (status === "approved") return "已批准";
  if (status === "rejected") return "已拒绝";
  return "等待批准";
}

function ApprovalPanel({ requests, canResolve, onResolve }: {
  requests: ApprovalRequest[];
  canResolve: boolean;
  onResolve: (approvalId: string, status: "approved" | "rejected") => Promise<void>;
}) {
  if (requests.length === 0) return <div className="empty">还没有工具审批请求。</div>;
  return (
    <div className="stack approval-stack">
      {requests.map((request) => (
        <details key={request.id}>
          <summary>
            <span>{request.toolName}</span>
            <small className={`status-pill ${request.status === "pending" ? "pending" : request.status === "approved" ? "success" : "danger"}`}>
              {approvalStatusLabel(request.status)}
            </small>
          </summary>
          <div className="llm-log-meta">
            <span>工作空间：{request.workspaceId}</span>
            <span>原因：{request.reason}</span>
            <span>时间：{request.createdAt}</span>
            <span>审批 ID：{request.id}</span>
            {request.resolvedAt && <span>处理时间：{request.resolvedAt}</span>}
            {request.resolvedBy && <span>处理人：{request.resolvedBy}</span>}
          </div>
          <details>
            <summary>请求参数</summary>
            <pre>{JSON.stringify(parseJsonText(request.argumentsJson), null, 2)}</pre>
          </details>
          <details>
            <summary>元数据</summary>
            <pre>{JSON.stringify(parseJsonText(request.metadataJson), null, 2)}</pre>
          </details>
          {request.status === "pending" && canResolve && (
            <div className="approval-actions">
              <button className="primary" onClick={() => void onResolve(request.id, "approved")}>批准</button>
              <button onClick={() => void onResolve(request.id, "rejected")}>拒绝</button>
            </div>
          )}
          {request.status === "pending" && !canResolve && (
            <div className="empty">只有创建者可以批准或拒绝高风险工具请求。</div>
          )}
        </details>
      ))}
    </div>
  );
}

function hookLabel(action: string): string {
  return action.startsWith("hook.") ? action.slice("hook.".length) : action;
}

function AuditLogPanel({ logs }: { logs: AuditLog[] }) {
  if (logs.length === 0) return <div className="empty">还没有生命周期 hook 日志。</div>;
  return (
    <div className="stack audit-log-stack">
      {logs.map((log) => {
        const metadata = parseJsonText(log.metadataJson);
        return (
          <details key={log.id}>
            <summary>
              <span>{hookLabel(log.action)}</span>
              <small>{log.actorRole}</small>
            </summary>
            <div className="llm-log-meta">
              <span>资源：{log.resourceKind}</span>
              {log.workspaceId && <span>工作空间：{log.workspaceId}</span>}
              {log.conversationId && <span>会话：{log.conversationId}</span>}
              <span>时间：{log.createdAt}</span>
              <span>审计 ID：{log.id}</span>
            </div>
            <pre>{JSON.stringify(metadata, null, 2)}</pre>
          </details>
        );
      })}
    </div>
  );
}

function statusLabel(status: LLMCallSnapshot["status"]): string {
  if (status === "completed") return "已返回";
  if (status === "failed") return "失败";
  return "等待中";
}

function statusClass(status: LLMCallSnapshot["status"]): string {
  if (status === "completed") return "success";
  if (status === "failed") return "danger";
  return "pending";
}

function shortText(value: string, maxLength = 220): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function memoryMetadataFromValue(metadataJson?: string): Record<string, unknown> {
  const parsed = parseJsonText(metadataJson || "{}");
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function memoryMetadata(memory: MemoryRow): Record<string, unknown> {
  return memoryMetadataFromValue(memory.metadataJson);
}

function memorySourceRefIds(metadata: Record<string, unknown>, table: string): string[] {
  const refs = metadata.sourceRefs;
  if (!Array.isArray(refs)) return [];
  const ref = refs.find((item) => isJsonRecord(item) && item.table === table) as Record<string, unknown> | undefined;
  return Array.isArray(ref?.ids) ? ref.ids.map(String) : [];
}

function memoryScopeLabel(memory: MemoryRow): string {
  if (memory.memoryType === "impression" && memory.agentId && !memory.userId && !memory.workspaceId) return `Agent 自我 · ${memory.agentId}`;
  if (memory.memoryType === "impression" && memory.userId && !memory.agentId && !memory.workspaceId) return `用户印象 · ${memory.userId}`;
  if (memory.memoryType === "event" && memory.userId && memory.workspaceId) return `事件 · ${memory.userId} / ${memory.workspaceId}`;
  if (memory.memoryType === "skill" && memory.workspaceId && !memory.userId) return `工作空间经验 · ${memory.workspaceId}`;
  return "未识别 scope";
}

function memoryWritesForVisibleTurn(output: AgentRunOutput | null, traceWrites: MemoryRow[]): MemoryRow[] {
  const directWrites = output?.memoryWrites ?? [];
  if (directWrites.length > 0) return directWrites;
  if (!output || traceWrites.length === 0) return [];
  const taskIds = new Set(output.workspaceTrace.map((session) => session.taskId));
  const sessionIds = new Set(output.workspaceTrace.map((session) => session.id));
  return traceWrites.filter((memory) => {
    const metadata = memoryMetadata(memory);
    if (metadata.conversationId !== output.conversationId) return false;
    const metadataTaskIds = Array.isArray(metadata.taskIds) ? metadata.taskIds.map(String) : [];
    const metadataSessionIds = [
      ...(Array.isArray(metadata.workspaceSessionIds) ? metadata.workspaceSessionIds.map(String) : []),
      ...memorySourceRefIds(metadata, "workspace_sessions")
    ];
    if (typeof metadata.taskId === "string" && taskIds.has(metadata.taskId)) return true;
    if (typeof metadata.workspaceSessionId === "string" && sessionIds.has(metadata.workspaceSessionId)) return true;
    if (metadataTaskIds.some((id) => taskIds.has(id))) return true;
    if (metadataSessionIds.some((id) => sessionIds.has(id))) return true;
    return false;
  });
}

function logResultText(log: LLMCallSnapshot | undefined): string {
  if (!log) return "还没有请求";
  if (log.status === "failed") return log.errorText ? shortText(log.errorText) : "请求失败";
  if (log.status === "pending") return "请求仍在等待返回";
  const response = parseJsonText(log.responseJson);
  if (response && typeof response === "object") {
    const record = response as Record<string, unknown>;
    if (typeof record.assistantMessage === "string" && record.assistantMessage.trim()) {
      return shortText(record.assistantMessage);
    }
    if (typeof record.returnedTextLength === "number") {
      return `已返回，文本长度 ${record.returnedTextLength}`;
    }
    if (record.choices) return "已返回 OpenAI-compatible choices";
  }
  return "已返回";
}

function logDiagnostic(log: LLMCallSnapshot): string {
  if (log.status === "failed") return log.errorText ? shortText(log.errorText, 160) : "请求失败，没有错误详情";
  if (log.status === "pending") return "请求已发出，尚未完成";
  return logResultText(log);
}

function LlmDebugSummary({ conversationLogs, globalLogs, onRefresh }: {
  conversationLogs: LLMCallSnapshot[];
  globalLogs: LLMCallSnapshot[];
  onRefresh: () => void;
}) {
  const latest = conversationLogs[0] ?? globalLogs[0];
  const allLogs = latest ? conversationLogs : globalLogs;
  const completed = allLogs.filter((log) => log.status === "completed").length;
  const failed = allLogs.filter((log) => log.status === "failed").length;
  const pending = allLogs.filter((log) => log.status === "pending").length;

  return (
    <section className="llm-debug-card">
      <div className="section-heading compact">
        <h2>LLM 调试</h2>
        <button onClick={onRefresh}>刷新</button>
      </div>
      {latest ? (
        <>
          <div className="llm-debug-row">
            <span>最近状态</span>
            <small className={`status-pill ${statusClass(latest.status)}`}>{statusLabel(latest.status)}</small>
          </div>
          <div className="llm-debug-row">
            <span>接口</span>
            <code>{latest.normalizedEndpoint}</code>
          </div>
          <div className="llm-debug-row">
            <span>来源地址</span>
            <code>{latest.providerBaseUrl}</code>
          </div>
          <div className="llm-debug-row">
            <span>模型</span>
            <code>{latest.model}</code>
          </div>
          <div className="llm-debug-result">{logResultText(latest)}</div>
          <div className="llm-debug-row">
            <span>时间</span>
            <code>{latest.completedAt ?? latest.createdAt}</code>
          </div>
          <div className="llm-debug-counts">
            <span>已返回 {completed}</span>
            <span>失败 {failed}</span>
            <span>等待 {pending}</span>
          </div>
        </>
      ) : (
        <div className="empty">还没有任何 LLM 请求。</div>
      )}
    </section>
  );
}

function LlmLogPanel({ logs }: { logs: LLMCallSnapshot[] }) {
  if (logs.length === 0) return <div className="empty">还没有 LLM 请求日志。</div>;
  return (
    <div className="stack llm-log-stack">
      {logs.map((log) => {
        const messages = parseJsonText(log.messagesJson);
        const tools = parseJsonText(log.toolsJson);
        const response = parseJsonText(log.responseJson);
        return (
          <details key={log.id}>
            <summary>
              <span>{log.model}</span>
              <small className={`status-pill ${statusClass(log.status)}`}>{statusLabel(log.status)}</small>
            </summary>
            <div className="llm-log-meta">
              <span>来源地址：{log.providerBaseUrl}</span>
              <span>接口：{log.normalizedEndpoint}</span>
              <span>创建：{log.createdAt}</span>
              {log.completedAt && <span>完成：{log.completedAt}</span>}
              <span>请求 ID：{log.id}</span>
              {log.errorText && <span className="log-error">错误：{log.errorText}</span>}
            </div>
            <div className={`llm-log-diagnostic ${statusClass(log.status)}`}>{logDiagnostic(log)}</div>
            <details>
              <summary>请求 messages</summary>
              <JsonValueView value={messages} />
            </details>
            <details>
              <summary>请求 tools</summary>
              <JsonValueView value={tools} />
            </details>
            <details>
              <summary>返回 / 诊断</summary>
              <JsonValueView value={response} />
            </details>
          </details>
        );
      })}
    </div>
  );
}

function ContextStack({ segments }: { segments: ContextSegment[] }) {
  if (segments.length === 0) return <div className="empty">还没有上下文快照。</div>;
  return (
    <div className="stack">
      {segments.map((segment, index) => (
        <details key={segment.id}>
          <summary>
            <span>{index + 1}. {contextSegmentLabel(segment)}</span>
            <small>{segment.segmentType} · 约 {segment.tokenEstimate} tokens</small>
          </summary>
          <ContextSegmentContent segment={segment} />
        </details>
      ))}
    </div>
  );
}

function contextSegmentLabel(segment: ContextSegment): string {
  if (segment.segmentType === "system") return "系统提示词";
  if (segment.segmentType === "workspace") return "工作空间信息";
  if (segment.segmentType === "tools") return "可调用工具";
  if (segment.segmentType === "memory") return "记忆";
  if (segment.segmentType === "history") return "本地对话片段";
  if (segment.segmentType === "user") return "干净用户消息";
  if (segment.segmentType === "tool_result") return "工具结果";
  if (segment.segmentType === "final_messages") return "原始 LLM Messages 日志";
  return segment.title;
}

function contextSubsectionLabel(key: string): string {
  const labels: Record<string, string> = {
    currentWorkspace: "当前工作空间说明",
    availableWorkspaces: "共享工作空间能力地图",
    activeWorkspaceId: "当前工作空间",
    toolCount: "工具数量",
    tools: "本次可调用工具",
    crossWorkspaceImpressionMemory: "跨工作空间印象记忆",
    currentWorkspaceResultEvents: "当前工作空间结果事件记忆",
    currentWorkspaceRelevantProcessEvents: "当前工作空间相关过程事件记忆",
    currentWorkspaceSkillMemory: "当前工作空间经验记忆",
    messages: "当前工作空间本地对话",
    currentTask: "当前结构化任务",
    completedWorkspaceResults: "当前工作空间历史结果",
    crossWorkspaceHandoffContext: "交接上下文（非本地对话）",
    recentToolEvidence: "当前工作空间近期工具证据"
  };
  return labels[key] ?? key;
}

function ContextSegmentContent({ segment }: { segment: ContextSegment }) {
  const parsed = parseJsonText(segment.content);
  if (
    parsed
    && typeof parsed === "object"
  ) {
    if (segment.segmentType === "memory" && isJsonRecord(parsed)) {
      return <MemoryContextView memory={parsed} />;
    }
    if (!Array.isArray(parsed) && ["workspace", "tools", "memory", "history"].includes(segment.segmentType)) {
      return (
        <div className="context-substack">
          {Object.entries(parsed as Record<string, unknown>)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => (
              <details key={key} open>
                <summary>{contextSubsectionLabel(key)}</summary>
                <JsonValueView value={value} />
              </details>
            ))}
        </div>
      );
    }
    return <JsonValueView value={parsed} />;
  }
  return <pre>{segment.content}</pre>;
}

function MemoryContextView({ memory }: { memory: Record<string, unknown> }) {
  const sections = [
    {
      key: "crossWorkspaceImpressionMemory",
      title: "跨工作空间印象记忆",
      note: "每轮强制载入最近有效印象，不做选择性召回。",
      empty: "本次没有注入用户/Agent 印象记忆。"
    },
    {
      key: "currentWorkspaceResultEvents",
      title: "当前工作空间结果事件记忆",
      note: "用于长对话的结果连续性，只注入压缩后的旧结果。",
      empty: "本次没有注入旧结果事件。"
    },
    {
      key: "currentWorkspaceRelevantProcessEvents",
      title: "当前工作空间相关过程事件记忆",
      note: "只召回与当前任务相关的过程事件索引和摘要；完整过程细节需要通过 readMemory 按 id 读取。",
      empty: "本次没有召回相关过程事件。"
    },
    {
      key: "currentWorkspaceSkillMemory",
      title: "当前工作空间经验记忆",
      note: "渐进式披露：这里只注入 Skill 名称和简介；高度相关时由 Agent 调用 readSkill 读取完整步骤。",
      empty: "当前 LLM 调用没有注入 Skill 简介。通常表示当前工作空间没有 Skill、策略关闭、上限为 0，或你正在查看 main 调用而 Skill 属于子工作空间。"
    }
  ];

  return (
    <div className="memory-context-view">
      {sections.map((section) => {
        const value = memory[section.key];
        const rows = sanitizeMemoryContextRows(section.key, Array.isArray(value) ? value : []);
        const isSkillSection = section.key === "currentWorkspaceSkillMemory";
        return (
          <details className="memory-context-section" key={section.key} open>
            <summary>
              <span>{section.title}</span>
              <small>{rows.length} 条</small>
            </summary>
            <p className="memory-context-note">{section.note}</p>
            {rows.length === 0
              ? <div className="memory-context-empty">{section.empty}</div>
              : isSkillSection
                ? <SkillDisclosureList skills={rows} />
                : <JsonValueView value={rows} />}
          </details>
        );
      })}
    </div>
  );
}

function sanitizeMemoryContextRows(sectionKey: string, rows: unknown[]): unknown[] {
  if (sectionKey !== "currentWorkspaceRelevantProcessEvents") return rows;
  return rows.map((row) => {
    if (!isJsonRecord(row)) return row;
    const { detail, detailSnippet, metadataJson, ...projection } = row;
    void detail;
    void detailSnippet;
    void metadataJson;
    return projection;
  });
}

function SkillDisclosureList({ skills }: { skills: unknown[] }) {
  return (
    <div className="skill-disclosure-list">
      {skills.map((skill, index) => {
        const record = isJsonRecord(skill) ? skill : {};
        return (
          <div className="skill-disclosure-card" key={`${String(record.id ?? index)}-${index}`}>
            <div className="skill-disclosure-head">
              <strong>{String(record.title ?? `Skill ${index + 1}`)}</strong>
              <span>{String(record.disclosure ?? "summary_only") === "summary_only" ? "只注入简介" : String(record.disclosure ?? "已注入")}</span>
            </div>
            <p>{String(record.summary ?? "没有简介。")}</p>
            <div className="skill-disclosure-meta">
              <span>读取详情工具：<code>{String(record.readTool ?? "readSkill")}</code></span>
              {record.workspaceId !== undefined && <span>工作空间：<code>{String(record.workspaceId)}</code></span>}
              {record.relationId !== undefined && <span>关系 ID：<code>{String(record.relationId)}</code></span>}
              {record.confidence !== undefined && <span>置信度：<code>{String(record.confidence)}</code></span>}
              {record.id !== undefined && <span>ID：<code>{String(record.id)}</code></span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function rawLlmCallLog(call: LLMCallSnapshot, segment?: ContextSegment): string {
  return JSON.stringify({
    llmCallId: call.id,
    conversationId: call.conversationId,
    status: call.status,
    providerBaseUrl: call.providerBaseUrl,
    normalizedEndpoint: call.normalizedEndpoint,
    model: call.model,
    createdAt: call.createdAt,
    completedAt: call.completedAt,
    errorText: call.errorText,
    messages: parseJsonText(call.messagesJson || segment?.content || "[]"),
    tools: parseJsonText(call.toolsJson || "[]"),
    response: parseJsonText(call.responseJson || "{}")
  }, null, 2);
}

function RawContextLog({ call, segment }: { call?: LLMCallSnapshot; segment?: ContextSegment }) {
  const [rawLogQuery, setRawLogQuery] = useState("");
  if (!call && !segment) return <div className="empty">这次 LLM 调用还没有保存原始日志。</div>;
  const content = call ? rawLlmCallLog(call, segment) : segment?.content ?? "";
  const matchCount = rawLogMatchCount(content, rawLogQuery);
  return (
    <div className="raw-context-view">
      <div className="raw-log-search">
        <input
          value={rawLogQuery}
          onChange={(event) => setRawLogQuery(event.target.value)}
          placeholder="搜索原始日志关键词"
        />
        <span>{rawLogQuery.trim() ? `${matchCount} 处命中` : "输入关键词定位内容"}</span>
      </div>
      <pre className="raw-json">{renderRawLogSearchHighlights(content, rawLogQuery)}</pre>
    </div>
  );
}

function rawLogMatchCount(content: string, query: string): number {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  const haystack = content.toLowerCase();
  while (index < haystack.length) {
    const found = haystack.indexOf(needle, index);
    if (found < 0) break;
    count += 1;
    index = found + needle.length;
  }
  return count;
}

function renderRawLogSearchHighlights(content: string, query: string): React.ReactNode[] | string {
  const needle = query.trim();
  if (!needle) return content;
  const haystack = content.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  let index = 0;
  while (cursor < content.length) {
    const found = haystack.indexOf(lowerNeedle, cursor);
    if (found < 0) break;
    if (found > cursor) nodes.push(content.slice(cursor, found));
    nodes.push(<mark className="raw-log-match" key={`raw-log-match-${index}`}>{content.slice(found, found + needle.length)}</mark>);
    cursor = found + needle.length;
    index += 1;
  }
  if (cursor < content.length) nodes.push(content.slice(cursor));
  return nodes;
}

function JsonValueView({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (Array.isArray(value)) {
    if (value.length === 0) return <div className="json-empty">空数组</div>;
    if (value.every(isJsonRecord)) {
      const columns = collectJsonColumns(value, depth > 0 ? 6 : 9);
      if (columns.length > 0) {
        return (
          <div className="json-table-wrap">
            <table className="json-table">
              <thead>
                <tr>
                  <th>#</th>
                  {columns.map((column) => <th key={column}>{jsonFieldLabel(column)}</th>)}
                </tr>
              </thead>
              <tbody>
                {value.map((row, index) => (
                  <tr key={index}>
                    <td>{index + 1}</td>
                    {columns.map((column) => (
                      <td key={column}>
                        <JsonTableCell value={row[column]} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }
    }
    return (
      <div className="json-list">
        {value.map((item, index) => (
          <div className="json-list-row" key={index}>
            <span className="json-index">{index + 1}</span>
            <JsonValueView value={item} depth={depth + 1} />
          </div>
        ))}
      </div>
    );
  }

  if (isJsonRecord(value)) {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (entries.length === 0) return <div className="json-empty">空对象</div>;
    return (
      <div className={`json-object ${depth > 0 ? "nested" : ""}`}>
        {entries.map(([key, item]) => (
          <div className={`json-field ${isJsonScalar(item) ? "" : "wide"}`} key={key}>
            <span className="json-label">{jsonFieldLabel(key)}</span>
            <JsonCell value={item} depth={depth + 1} />
          </div>
        ))}
      </div>
    );
  }

  return <span className={`json-scalar ${jsonScalarClass(value)}`}>{formatJsonScalar(value)}</span>;
}

function JsonCell({ value, depth }: { value: unknown; depth: number }) {
  if (value === undefined) return <span className="json-muted">-</span>;
  if (isJsonScalar(value)) return <span className={`json-scalar ${jsonScalarClass(value)}`}>{formatJsonScalar(value)}</span>;
  if (depth > 3) return <code className="json-compact">{compactJson(value)}</code>;
  return <JsonValueView value={value} depth={depth} />;
}

function JsonTableCell({ value }: { value: unknown }) {
  const [open, setOpen] = useState(false);
  if (value === undefined) return <span className="json-muted">-</span>;
  const preview = tableCellPreview(value);
  return (
    <>
      <button
        className="json-table-cell-preview-button"
        type="button"
        title="点击查看完整内容"
        aria-label={`查看完整内容：${preview}`}
        onClick={() => setOpen(true)}
      >
        <span className={`json-table-cell-preview ${isJsonScalar(value) ? jsonScalarClass(value) : ""}`}>{preview}</span>
      </button>
      {open && (
        <div className="json-cell-modal-backdrop" role="presentation" onClick={() => setOpen(false)}>
          <section className="json-cell-modal" role="dialog" aria-modal="true" aria-label="完整内容" onClick={(event) => event.stopPropagation()}>
            <header>
              <strong>完整内容</strong>
              <button type="button" onClick={() => setOpen(false)}>关闭</button>
            </header>
            <pre>{fullJsonText(value)}</pre>
          </section>
        </div>
      )}
    </>
  );
}

function tableCellPreview(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "空数组";
    if (value.every(isJsonScalar)) return value.map((item) => formatJsonScalar(item)).join("，");
    return `${value.length} 条：${value.slice(0, 3).map((item) => tableCellPreview(item)).join("；")}`;
  }
  if (isJsonRecord(value)) {
    const preferredKeys = ["name", "id", "title", "summary", "description", "status", "type", "workspaceId"];
    const parts: string[] = [];
    for (const key of preferredKeys) {
      const item = value[key];
      if (item !== undefined) parts.push(`${jsonFieldLabel(key)}=${tableCellPreview(item)}`);
      if (parts.length >= 3) break;
    }
    if (parts.length > 0) return parts.join("，");
    return compactJson(value);
  }
  return formatJsonScalar(value);
}

function fullJsonText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  if (isJsonScalar(value)) return formatJsonScalar(value);
  return JSON.stringify(value, null, 2);
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isJsonScalar(value: unknown): boolean {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function collectJsonColumns(rows: Record<string, unknown>[], limit: number): string[] {
  const priority = [
    "name",
    "id",
    "title",
    "description",
    "summary",
    "type",
    "status",
    "workspaceId",
    "riskLevel",
    "bindingType",
    "mcpServerId",
    "mcpToolName",
    "toolCount"
  ];
  const keys = new Set<string>();
  rows.forEach((row) => {
    Object.keys(row).forEach((key) => {
      if (row[key] !== undefined) keys.add(key);
    });
  });
  return [...keys].sort((left, right) => {
    const leftRank = priority.indexOf(left);
    const rightRank = priority.indexOf(right);
    const normalizedLeft = leftRank === -1 ? Number.MAX_SAFE_INTEGER : leftRank;
    const normalizedRight = rightRank === -1 ? Number.MAX_SAFE_INTEGER : rightRank;
    if (normalizedLeft !== normalizedRight) return normalizedLeft - normalizedRight;
    return left.localeCompare(right);
  }).slice(0, limit);
}

function jsonFieldLabel(key: string): string {
  const labels: Record<string, string> = {
    id: "ID",
    name: "名称",
    title: "标题",
    description: "说明",
    summary: "摘要",
    type: "类型",
    status: "状态",
    role: "角色",
    content: "内容",
    workspaceId: "工作空间",
    toolCount: "工具数",
    tools: "工具",
    parameters: "参数",
    parametersJson: "参数",
    crossWorkspaceHandoffContext: "交接上下文（非本地对话）",
    fromWorkspaceId: "来源工作空间",
    toWorkspaceId: "目标工作空间",
    direction: "方向",
    reason: "原因",
    inputSchema: "输入结构",
    function: "函数",
    binding: "绑定",
    bindingJson: "绑定",
    bindingType: "绑定类型",
    riskLevel: "风险",
    mcpServerId: "MCP Server",
    mcpToolName: "MCP 工具名",
    createdAt: "创建时间",
    updatedAt: "更新时间",
    metadata: "元数据",
    metadataJson: "元数据",
    relationId: "关系 ID",
    version: "版本"
  };
  return labels[key] ?? key;
}

function formatJsonScalar(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function jsonScalarClass(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  return "string";
}

function compactJson(value: unknown): string {
  const text = JSON.stringify(value);
  if (!text) return "";
  return text.length > 220 ? `${text.slice(0, 220)}...` : text;
}

function WorkspaceTab() {
  const [workspaces, setWorkspaces] = useState<WorkspaceDefinition[]>([]);
  const [selected, setSelected] = useState<WorkspaceDefinition | null>(null);
  const [toolDraft, setToolDraft] = useState<Partial<ToolDefinition> | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServerDefinition[]>([]);
  const [mcpDraft, setMcpDraft] = useState<McpServerDefinition | null>(null);
  const [toolError, setToolError] = useState("");
  const [discoveredTools, setDiscoveredTools] = useState<Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>>([]);
  const [selectedDiscoveredTools, setSelectedDiscoveredTools] = useState<Set<string>>(new Set());

  async function load() {
    const data = await api<{ workspaces: WorkspaceDefinition[]; tools: ToolDefinition[] }>("/api/workspaces");
    setWorkspaces(data.workspaces);
    setSelected((current) => {
      const next = current ? data.workspaces.find((item) => item.id === current.id) ?? current : data.workspaces[0] ?? null;
      if (next && toolDraft && toolDraft.workspaceId !== next.id) setToolDraft(createToolDraft(next.id));
      return next;
    });
  }

  async function loadMcpServers(workspaceId: string) {
    const cached = loadCache();
    const params = new URLSearchParams({
      actorId: cached.userId ?? "creator",
      actorRole: cached.userRole ?? "creator"
    });
    const data = await api<{ mcpServers: McpServerDefinition[] }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/mcp-servers?${params.toString()}`);
    setMcpServers(data.mcpServers);
    setMcpDraft((current) => {
      if (current && current.workspaceId === workspaceId) {
        return data.mcpServers.find((server) => server.id === current.id) ?? current;
      }
      return data.mcpServers[0] ?? null;
    });
  }

  useEffect(() => {
    load().catch(console.error);
  }, []);

  useEffect(() => {
    if (!selected?.id) return;
    loadMcpServers(selected.id).catch((err) => setToolError(err instanceof Error ? err.message : String(err)));
    setDiscoveredTools([]);
    setSelectedDiscoveredTools(new Set());
  }, [selected?.id]);

  async function save() {
    if (!selected) return;
    setToolError("");
    try {
      const cached = loadCache();
      const normalized = normalizeWorkspaceForSave(selected);
      const saved = await api<WorkspaceDefinition>(`/api/workspaces/${encodeURIComponent(selected.id)}`, {
        method: "PUT",
        body: JSON.stringify({
          ...normalized,
          toolIds: normalized.tools.map((tool) => tool.id),
          actorId: cached.userId ?? "user",
          actorRole: cached.userRole ?? "user"
        })
      });
      setSelected(saved);
      await load();
    } catch (err) {
      setToolError(err instanceof Error ? err.message : String(err));
    }
  }

  async function saveTool() {
    if (!selected || !toolDraft?.name || !toolDraft.description || !toolDraft.parametersJson || !toolDraft.bindingType) return;
    setToolError("");
    try {
      JSON.parse(toolDraft.parametersJson);
      JSON.parse(toolDraft.bindingJson || "{}");
      const cached = loadCache();
      const body = {
        ...toolDraft,
        actorId: cached.userId ?? "creator",
        actorRole: cached.userRole ?? "creator"
      };
      const path = toolDraft.id && selected.tools.some((tool) => tool.id === toolDraft.id)
        ? `/api/workspaces/${encodeURIComponent(selected.id)}/tools/${encodeURIComponent(toolDraft.id)}`
        : `/api/workspaces/${encodeURIComponent(selected.id)}/tools`;
      await api<ToolDefinition>(path, {
        method: toolDraft.id && selected.tools.some((tool) => tool.id === toolDraft.id) ? "PUT" : "POST",
        body: JSON.stringify(body)
      });
      setToolDraft(createToolDraft(selected.id));
      setDiscoveredTools([]);
      await load();
    } catch (err) {
      setToolError(err instanceof Error ? err.message : String(err));
    }
  }

  async function deleteTool(tool: ToolDefinition) {
    if (!selected || isSystemTool(tool)) return;
    setToolError("");
    try {
      const cached = loadCache();
      await api(`/api/workspaces/${encodeURIComponent(selected.id)}/tools/${encodeURIComponent(tool.id)}`, {
        method: "DELETE",
        body: JSON.stringify({
          actorId: cached.userId ?? "creator",
          actorRole: cached.userRole ?? "creator",
          deleteReason: "用户在工作空间工具 UI 删除"
        })
      });
      if (toolDraft?.id === tool.id) setToolDraft(createToolDraft(selected.id));
      await load();
    } catch (err) {
      setToolError(err instanceof Error ? err.message : String(err));
    }
  }

  async function saveMcpServer(): Promise<McpServerDefinition | null> {
    if (!selected || !mcpDraft) return null;
    setToolError("");
    try {
      JSON.parse(mcpDraft.argsJson || "[]");
      JSON.parse(mcpDraft.envJson || "{}");
      JSON.parse(mcpDraft.headersJson || "{}");
      const cached = loadCache();
      const exists = mcpServers.some((server) => server.id === mcpDraft.id);
      const saved = await api<McpServerDefinition>(
        exists
          ? `/api/workspaces/${encodeURIComponent(selected.id)}/mcp-servers/${encodeURIComponent(mcpDraft.id)}`
          : `/api/workspaces/${encodeURIComponent(selected.id)}/mcp-servers`,
        {
          method: exists ? "PUT" : "POST",
          body: JSON.stringify({
            ...mcpDraft,
            actorId: cached.userId ?? "creator",
            actorRole: cached.userRole ?? "creator"
          })
        }
      );
      setMcpDraft(saved);
      await loadMcpServers(selected.id);
      return saved;
    } catch (err) {
      setToolError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  async function deleteMcpServer(server: McpServerDefinition) {
    if (!selected) return;
    setToolError("");
    try {
      const cached = loadCache();
      await api(`/api/workspaces/${encodeURIComponent(selected.id)}/mcp-servers/${encodeURIComponent(server.id)}`, {
        method: "DELETE",
        body: JSON.stringify({
          actorId: cached.userId ?? "creator",
          actorRole: cached.userRole ?? "creator",
          deleteReason: "用户在工作空间 MCP Server UI 删除"
        })
      });
      setDiscoveredTools([]);
      setSelectedDiscoveredTools(new Set());
      await load();
      await loadMcpServers(selected.id);
    } catch (err) {
      setToolError(err instanceof Error ? err.message : String(err));
    }
  }

  async function discoverMcpTools() {
    if (!selected || !mcpDraft?.id) return;
    setToolError("");
    setDiscoveredTools([]);
    setSelectedDiscoveredTools(new Set());
    try {
      const cached = loadCache();
      const server = mcpServers.some((item) => item.id === mcpDraft.id) ? mcpDraft : await saveMcpServer();
      if (!server) return;
      const data = await api<{ tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> }>(
        `/api/workspaces/${encodeURIComponent(selected.id)}/mcp-servers/${encodeURIComponent(server.id)}/discover`,
        {
          method: "POST",
          body: JSON.stringify({
            actorId: cached.userId ?? "creator",
            actorRole: cached.userRole ?? "creator"
          })
        }
      );
      setDiscoveredTools(data.tools);
      setSelectedDiscoveredTools(new Set(data.tools.map((tool) => tool.name)));
    } catch (err) {
      setToolError(err instanceof Error ? err.message : String(err));
    }
  }

  async function importDiscoveredTools() {
    if (!selected || !mcpDraft?.id) return;
    const tools = discoveredTools.filter((tool) => selectedDiscoveredTools.has(tool.name));
    if (tools.length === 0) return;
    setToolError("");
    try {
      const cached = loadCache();
      await api<{ tools: ToolDefinition[] }>(
        `/api/workspaces/${encodeURIComponent(selected.id)}/mcp-servers/${encodeURIComponent(mcpDraft.id)}/import-tools`,
        {
          method: "POST",
          body: JSON.stringify({
            tools,
            actorId: cached.userId ?? "creator",
            actorRole: cached.userRole ?? "creator"
          })
        }
      );
      setDiscoveredTools([]);
      setSelectedDiscoveredTools(new Set());
      await load();
    } catch (err) {
      setToolError(err instanceof Error ? err.message : String(err));
    }
  }

  function createWorkspace() {
    setSelected({
      id: `workspace-${Date.now()}`,
      name: "新工作空间",
      description: "",
      capabilitiesJson: "[]",
      inputKindsJson: JSON.stringify(DEFAULT_WORKSPACE_INPUT_KINDS),
      outputKindsJson: JSON.stringify(DEFAULT_WORKSPACE_OUTPUT_KINDS),
      requiresApproval: 0,
      instructions: "",
      toolInstructions: "",
      memoryPolicyJson: JSON.stringify({
        eventRecallEnabled: true,
        skillRecallEnabled: true,
        eventWriteEnabled: true,
        skillWriteEnabled: true,
        maxEventMemories: 4,
        maxSkillMemories: 4
      }),
      riskLevel: "low",
      createdBy: loadCache().userId ?? "user",
      createdAt: "",
      updatedAt: "",
      manifest: {
        id: "",
        name: "",
        description: "",
        capabilities: [],
        inputKinds: DEFAULT_WORKSPACE_INPUT_KINDS,
        outputKinds: DEFAULT_WORKSPACE_OUTPUT_KINDS,
        riskLevel: "low",
        requiresApproval: false
      },
      memoryPolicy: {
        eventRecallEnabled: true,
        skillRecallEnabled: true,
        eventWriteEnabled: true,
        skillWriteEnabled: true,
        maxEventMemories: 4,
        maxSkillMemories: 4
      },
      tools: []
    });
    setToolDraft(null);
    setMcpDraft(null);
    setMcpServers([]);
    setDiscoveredTools([]);
    setSelectedDiscoveredTools(new Set());
  }

  async function deleteWorkspace() {
    if (!selected) return;
    const isExisting = workspaces.some((workspace) => workspace.id === selected.id);
    if (!isExisting) {
      setSelected(workspaces[0] ?? null);
      setToolDraft(null);
      setMcpDraft(null);
      setMcpServers([]);
      setDiscoveredTools([]);
      setSelectedDiscoveredTools(new Set());
      setToolError("");
      return;
    }
    if (BUILT_IN_WORKSPACE_IDS.has(selected.id)) {
      setToolError("内置工作空间不能删除。");
      return;
    }
    if (!window.confirm(`删除工作空间 ${selected.id}？相关专属工具和 MCP Server 也会被移除。`)) return;
    setToolError("");
    try {
      const cached = loadCache();
      await api(`/api/workspaces/${encodeURIComponent(selected.id)}`, {
        method: "DELETE",
        body: JSON.stringify({
          actorId: cached.userId ?? "creator",
          actorRole: cached.userRole ?? "creator",
          deleteReason: "用户在工作空间 UI 删除"
        })
      });
      setSelected(null);
      setToolDraft(null);
      setMcpDraft(null);
      setMcpServers([]);
      setDiscoveredTools([]);
      setSelectedDiscoveredTools(new Set());
      await load();
    } catch (err) {
      setToolError(err instanceof Error ? err.message : String(err));
    }
  }

  const workspaceTools = selected?.tools.filter((tool) => !isSystemTool(tool)) ?? [];
  const systemTools = selected?.tools.filter(isSystemTool) ?? [];
  const isExistingWorkspace = selected ? workspaces.some((workspace) => workspace.id === selected.id) : false;
  const isBuiltInWorkspace = selected ? BUILT_IN_WORKSPACE_IDS.has(selected.id) : false;

  return (
    <section className="workspace-grid">
      <aside className="panel list-panel">
        <div className="panel-header">
          <h2>工作空间</h2>
          <button onClick={createWorkspace}>新建</button>
        </div>
        {workspaces.map((workspace) => (
          <button key={workspace.id} className={selected?.id === workspace.id ? "row active" : "row"} onClick={() => {
            setSelected(workspace);
            setToolError("");
          }}>
            <strong>{workspace.name}</strong>
            <span>{workspace.id}</span>
          </button>
        ))}
      </aside>
      <section className="panel editor-panel">
        {selected ? (
          <>
            {toolError && <div className="error inline-error"><span>{toolError}</span></div>}
            <label>
              ID
              <input
                value={selected.id}
                disabled={isExistingWorkspace}
                onChange={(event) => setSelected({ ...selected, id: event.target.value })}
              />
              {isExistingWorkspace && <small>已保存工作空间的 ID 是稳定主键，不能在编辑时修改。</small>}
            </label>
            <label>名称<input value={selected.name} onChange={(event) => setSelected({ ...selected, name: event.target.value })} /></label>
            <label>工作空间说明<textarea value={selected.description} onChange={(event) => setSelected({ ...selected, description: event.target.value })} /></label>
            <label>能力清单<textarea value={stringifyListText(selected.capabilitiesJson)} onChange={(event) => setSelected(updateWorkspaceListField(selected, "capabilitiesJson", event.target.value))} /></label>
            <label className="check-row">
              <input type="checkbox" checked={Boolean(selected.requiresApproval)} onChange={(event) => setSelected({ ...selected, requiresApproval: event.target.checked ? 1 : 0 })} />
              <span>进入或使用该工作空间需要审批</span>
            </label>
            <label>记忆策略 JSON<textarea value={selected.memoryPolicyJson} onChange={(event) => setSelected({ ...selected, memoryPolicyJson: event.target.value })} /></label>
            <label>
              风险等级
              <select value={selected.riskLevel} onChange={(event) => setSelected({ ...selected, riskLevel: event.target.value as WorkspaceDefinition["riskLevel"] })}>
                <option value="low">低</option>
                <option value="medium">中</option>
                <option value="high">高</option>
              </select>
            </label>
            <div className="section-heading">
              <h2>MCP Server</h2>
              <button onClick={() => setMcpDraft(createMcpServerDraft(selected.id))}>新增 Server</button>
            </div>
            <div className="workspace-tool-list">
              {mcpServers.map((server) => (
                <article key={server.id} className="tool-card">
                  <div>
                    <strong>{server.name}</strong>
                    <span>{server.transport === "stdio" ? `${server.command ?? ""} ${server.argsJson}` : server.url}</span>
                  </div>
                  <small>{server.transport === "stdio" ? "本地 stdio" : "远程 Streamable HTTP"}</small>
                  <div className="tool-card-actions">
                    <button onClick={() => {
                      setMcpDraft(server);
                      setDiscoveredTools([]);
                      setSelectedDiscoveredTools(new Set());
                    }}>编辑</button>
                    <button onClick={() => void deleteMcpServer(server)}>删除</button>
                  </div>
                </article>
              ))}
              {mcpServers.length === 0 && <div className="empty">这个工作空间还没有绑定 MCP Server。</div>}
            </div>
            {mcpDraft && (
              <section className="tool-editor">
                <div className="section-heading">
                  <h2>{mcpServers.some((server) => server.id === mcpDraft.id) ? "编辑 MCP Server" : "注册 MCP Server"}</h2>
                  <button onClick={() => setMcpDraft(null)}>收起</button>
                </div>
                {toolError && <div className="error inline-error"><span>{toolError}</span></div>}
                <label>Server ID<input value={mcpDraft.id} onChange={(event) => setMcpDraft({ ...mcpDraft, id: event.target.value })} /></label>
                <label>名称<input value={mcpDraft.name} onChange={(event) => setMcpDraft({ ...mcpDraft, name: event.target.value })} /></label>
                <label>
                  类型
                  <select value={mcpDraft.transport} onChange={(event) => setMcpDraft({ ...mcpDraft, transport: event.target.value as McpServerDefinition["transport"] })}>
                    <option value="stdio">本地 stdio</option>
                    <option value="streamable-http">远程 Streamable HTTP</option>
                  </select>
                </label>
                {mcpDraft.transport === "stdio" ? (
                  <>
                    <label>启动命令<input value={mcpDraft.command ?? ""} onChange={(event) => setMcpDraft({ ...mcpDraft, command: event.target.value })} /></label>
                    <label>参数 JSON 数组<textarea className="json-editor" value={mcpDraft.argsJson} onChange={(event) => setMcpDraft({ ...mcpDraft, argsJson: event.target.value })} /></label>
                    <label>环境变量 JSON<textarea className="json-editor" value={mcpDraft.envJson} onChange={(event) => setMcpDraft({ ...mcpDraft, envJson: event.target.value })} /></label>
                    <label>工作目录<input value={mcpDraft.cwd ?? ""} onChange={(event) => setMcpDraft({ ...mcpDraft, cwd: event.target.value })} /></label>
                  </>
                ) : (
                  <>
                    <label>远程地址<input value={mcpDraft.url ?? ""} onChange={(event) => setMcpDraft({ ...mcpDraft, url: event.target.value })} /></label>
                    <label>请求头 JSON<textarea className="json-editor" value={mcpDraft.headersJson} onChange={(event) => setMcpDraft({ ...mcpDraft, headersJson: event.target.value })} /></label>
                  </>
                )}
                <label>超时毫秒<input type="number" value={mcpDraft.timeoutMs} onChange={(event) => setMcpDraft({ ...mcpDraft, timeoutMs: Number(event.target.value) })} /></label>
                <div className="tool-editor-actions">
                  <button className="primary" onClick={() => void saveMcpServer()}>保存 Server</button>
                  <button onClick={() => void discoverMcpTools()}>检测工具</button>
                  <button onClick={() => void importDiscoveredTools()} disabled={selectedDiscoveredTools.size === 0}>挂载选中工具</button>
                </div>
                {discoveredTools.length > 0 && (
                  <div className="discovered-tools">
                    {discoveredTools.map((tool) => (
                      <label key={tool.name} className="check-row discovered-tool-row">
                        <input
                          type="checkbox"
                          checked={selectedDiscoveredTools.has(tool.name)}
                          onChange={(event) => {
                            const next = new Set(selectedDiscoveredTools);
                            if (event.target.checked) next.add(tool.name);
                            else next.delete(tool.name);
                            setSelectedDiscoveredTools(next);
                          }}
                        />
                        <span><strong>{tool.name}</strong><br />{tool.description || "没有说明"}</span>
                        <small>MCP</small>
                      </label>
                    ))}
                  </div>
                )}
              </section>
            )}
            <div className="section-heading">
              <h2>工作空间已挂载工具</h2>
              <button onClick={() => setToolDraft(createToolDraft(selected.id))}>高级手动添加</button>
            </div>
            <div className="workspace-tool-list">
              {workspaceTools.map((tool) => (
                <article key={tool.id} className="tool-card">
                  <div>
                    <strong>{tool.name}</strong>
                    <span>{tool.description}</span>
                  </div>
                  <small title={tool.bindingType === "mcp" ? `${tool.mcpServerId ?? ""}/${tool.mcpToolName ?? ""}` : tool.bindingJson}>
                    {riskLabel(tool.riskLevel)} · {bindingLabel(tool.bindingType)}
                  </small>
                  <div className="tool-card-actions">
                    <button onClick={() => setToolDraft({ ...tool })}>编辑</button>
                    <button onClick={() => void deleteTool(tool)}>删除</button>
                  </div>
                </article>
              ))}
              {workspaceTools.length === 0 && <div className="empty">这个工作空间还没有注册专属工具。</div>}
            </div>
            {toolDraft && (
              <section className="tool-editor">
                <div className="section-heading">
                  <h2>{selected.tools.some((tool) => tool.id === toolDraft.id) ? "编辑工具" : "注册工具"}</h2>
                  <button onClick={() => setToolDraft(null)}>收起</button>
                </div>
                {toolError && <div className="error inline-error"><span>{toolError}</span></div>}
                <label>工具 ID<input value={toolDraft.id ?? ""} onChange={(event) => setToolDraft({ ...toolDraft, id: event.target.value })} /></label>
                <label>Function 名称<input value={toolDraft.name ?? ""} onChange={(event) => setToolDraft({ ...toolDraft, name: event.target.value })} /></label>
                <label>说明<textarea value={toolDraft.description ?? ""} onChange={(event) => setToolDraft({ ...toolDraft, description: event.target.value })} /></label>
                <label>
                  类型
                  <select value={toolDraft.bindingType ?? "mcp"} onChange={(event) => setToolDraft({ ...toolDraft, bindingType: event.target.value as ToolDefinition["bindingType"] })}>
                    <option value="mcp">MCP</option>
                    <option value="placeholder">占位</option>
                  </select>
                </label>
                <label>
                  风险等级
                  <select value={toolDraft.riskLevel ?? "low"} onChange={(event) => setToolDraft({ ...toolDraft, riskLevel: event.target.value as ToolDefinition["riskLevel"] })}>
                    <option value="low">低</option>
                    <option value="medium">中</option>
                    <option value="high">高</option>
                  </select>
                </label>
                <label>参数 JSON Schema<textarea className="json-editor" value={toolDraft.parametersJson ?? ""} onChange={(event) => setToolDraft({ ...toolDraft, parametersJson: event.target.value })} /></label>
                <label>MCP Server ID<input value={toolDraft.mcpServerId ?? ""} onChange={(event) => setToolDraft({ ...toolDraft, mcpServerId: event.target.value })} /></label>
                <label>MCP Tool 名称<input value={toolDraft.mcpToolName ?? ""} onChange={(event) => setToolDraft({ ...toolDraft, mcpToolName: event.target.value })} /></label>
                <label>绑定配置 JSON<textarea className="json-editor" value={toolDraft.bindingJson ?? "{}"} onChange={(event) => setToolDraft({ ...toolDraft, bindingJson: event.target.value })} /></label>
                <div className="tool-editor-actions">
                  <button className="primary" onClick={() => void saveTool()}>保存到当前工作空间</button>
                </div>
              </section>
            )}
            <h2>系统自动挂载工具</h2>
            <div className="tool-grid">
              {systemTools.map((tool) => (
                <div key={tool.id} className="check-row locked-tool">
                  <span>{tool.name}</span>
                  <small>{riskLabel(tool.riskLevel)} · {bindingLabel(tool.bindingType)}</small>
                </div>
              ))}
            </div>
            <div className="workspace-actions">
              <button className="primary" onClick={save}>保存工作空间</button>
              <button className="danger" onClick={() => void deleteWorkspace()} disabled={isExistingWorkspace && isBuiltInWorkspace}>
                {isExistingWorkspace ? "删除工作空间" : "放弃新建"}
              </button>
            </div>
          </>
        ) : <div className="empty">请选择一个工作空间。</div>}
      </section>
    </section>
  );
}

function databaseCellPreview(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") {
    const parsed = parseJsonText(value);
    if (parsed !== value) return trimOneLine(compactJson(parsed), 180);
    return trimOneLine(value, 180);
  }
  if (typeof value === "object") return trimOneLine(compactJson(value), 180);
  return String(value);
}

function DatabaseTablesTab() {
  const [tables, setTables] = useState<DatabaseTableSummary[]>([]);
  const [selectedTable, setSelectedTable] = useState("");
  const [tableRows, setTableRows] = useState<DatabaseTableRows | null>(null);
  const [selectedRow, setSelectedRow] = useState<Record<string, unknown> | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const limit = 100;

  async function loadTables(preferredTable = selectedTable) {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ actorId: "creator", actorRole: "creator" });
      const data = await api<{ tables: DatabaseTableSummary[] }>(`/api/db/tables?${params.toString()}`);
      setTables(data.tables);
      const nextTable = preferredTable && data.tables.some((table) => table.name === preferredTable)
        ? preferredTable
        : data.tables[0]?.name ?? "";
      setSelectedTable(nextTable);
      if (nextTable) await loadTableRows(nextTable, 0);
    } catch (err) {
      setError(`加载数据表失败：${memoryErrorText(err)}`);
    } finally {
      setLoading(false);
    }
  }

  async function loadTableRows(tableName = selectedTable, nextOffset = offset) {
    if (!tableName) return;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({
        actorId: "creator",
        actorRole: "creator",
        limit: String(limit),
        offset: String(nextOffset)
      });
      const data = await api<DatabaseTableRows>(`/api/db/tables/${encodeURIComponent(tableName)}?${params.toString()}`);
      setTableRows(data);
      setSelectedRow(data.rows[0] ?? null);
      setOffset(data.offset);
    } catch (err) {
      setError(`读取数据表失败：${memoryErrorText(err)}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadTables().catch(console.error);
  }, []);

  const canPrev = Boolean(tableRows && tableRows.offset > 0);
  const canNext = Boolean(tableRows && tableRows.offset + tableRows.limit < tableRows.total);

  return (
    <section className="database-page">
      <aside className="panel database-sidebar">
        <div className="section-heading compact">
          <h2>数据库表</h2>
          <button onClick={() => void loadTables()} disabled={loading}>刷新</button>
        </div>
        <div className="database-table-list">
          {tables.map((table) => (
            <button
              key={table.name}
              className={selectedTable === table.name ? "active" : ""}
              onClick={() => {
                setSelectedTable(table.name);
                void loadTableRows(table.name, 0);
              }}
            >
              <span>{table.name}</span>
              <small>{table.rowCount} 行</small>
            </button>
          ))}
          {tables.length === 0 && <div className="empty">暂无可查看的数据表。</div>}
        </div>
      </aside>
      <section className="panel database-browser">
        <div className="database-toolbar">
          <div>
            <strong>{tableRows?.table ?? (selectedTable || "未选择表")}</strong>
            <span>
              {tableRows ? `共 ${tableRows.total} 行，当前 ${tableRows.offset + 1}-${Math.min(tableRows.offset + tableRows.rows.length, tableRows.total)}` : "选择左侧表后查看原始记录"}
            </span>
          </div>
          <div className="database-toolbar-actions">
            <button onClick={() => void loadTableRows(selectedTable, Math.max(0, offset - limit))} disabled={loading || !canPrev}>上一页</button>
            <button onClick={() => void loadTableRows(selectedTable, offset + limit)} disabled={loading || !canNext}>下一页</button>
          </div>
        </div>
        {error && <div className="error memory-error"><span>{error}</span></div>}
        <div className="database-content">
          <div className="database-table-wrap">
            {tableRows ? (
              <table className="database-table">
                <thead>
                  <tr>
                    {tableRows.columns.map((column) => <th key={column}>{jsonFieldLabel(column)}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {tableRows.rows.map((row, rowIndex) => (
                    <tr
                      key={rowIndex}
                      className={selectedRow === row ? "selected" : ""}
                      onClick={() => setSelectedRow(row)}
                    >
                      {tableRows.columns.map((column) => (
                        <td key={column}>{databaseCellPreview(row[column])}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <div className="empty">选择一个表查看完整数据库记录。</div>}
          </div>
          <aside className="database-row-detail">
            <h2>当前行详情</h2>
            {selectedRow ? <JsonValueView value={selectedRow} /> : <div className="empty">点击一行查看字段详情。</div>}
          </aside>
        </div>
      </section>
    </section>
  );
}

function skillMetadataTemplate() {
  return {
    desensitized: true,
    confidence: 0.7,
    qualityGate: {
      reusable: true,
      userPrivateDetailRemoved: true,
      workspaceScoped: true,
      evidenceCount: 0
    },
    procedure: ["写下可复用的步骤，而不是一次性项目细节。"],
    appliesWhen: ["写下这条经验适用的场景。"],
    avoidWhen: ["写下不应该套用这条经验的场景。"]
  };
}

function memoryDraft(memoryType: MemoryRow["memoryType"]): Partial<MemoryRow> {
  const base = {
    memoryType,
    title: "",
    summary: "",
    detail: "",
    version: 1
  };
  if (memoryType === "skill") {
    return {
      ...base,
      agentId: "default-agent",
      workspaceId: "main",
      metadataJson: JSON.stringify(skillMetadataTemplate(), null, 2)
    };
  }
  if (memoryType === "impression") {
    return {
      ...base,
      userId: "creator",
      agentId: "default-agent",
      metadataJson: JSON.stringify({ impressionKind: "userImpression", source: "manualMemoryApi" }, null, 2)
    };
  }
  return {
    ...base,
    userId: "creator",
    agentId: "default-agent",
    workspaceId: "main",
    metadataJson: JSON.stringify({ source: "manualMemoryApi", eventKind: "manual", conversationId: "manual-memory-api", outcome: "partial" }, null, 2)
  };
}

function memoryErrorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function mcpUserErrorText(error: unknown) {
  const message = memoryErrorText(error);
  if (message.includes("requires creator role")) return "需要创建者身份才能调整工作空间工具，请在高级设置中切换身份后重试";
  if (message.includes("argsJson")) return "参数必须是 JSON 数组，例如 [\"-y\", \"server-name\"]";
  if (message.includes("envJson")) return "环境变量必须是 JSON 对象，例如 {\"TOKEN\":\"...\"}";
  if (message.includes("headersJson")) return "请求头必须是 JSON 对象，例如 {\"Authorization\":\"Bearer ...\"}";
  if (message.includes("Local stdio MCP server requires command")) return "本地 MCP Server 需要填写启动命令";
  if (message.includes("Remote MCP server requires url")) return "远程 MCP Server 需要填写远程地址";
  if (message.includes("Tool name already exists")) return "检测到同名工具已被其他工作空间使用，请调整 MCP Server 或先删除旧工具";
  return message;
}

function MemoryEvidencePanel({ memory }: { memory: Partial<MemoryRow> }) {
  const metadata = memoryMetadataFromValue(memory.metadataJson);
  const sourceRefs = Array.isArray(metadata.sourceRefs) ? metadata.sourceRefs.filter(isJsonRecord) as Record<string, unknown>[] : [];
  const evidenceEventIds = Array.isArray(metadata.evidenceEventIds) ? metadata.evidenceEventIds.map(String) : [];
  const compactMetadata = Object.fromEntries(Object.entries(metadata).filter(([key]) => !["sourceRefs", "evidenceEventIds"].includes(key)));
  return (
    <section className="memory-evidence-panel">
      <h3>证据引用</h3>
      <p>记忆只保存语义投影；原始消息、工具结果和 LLM 日志保存在数据表中，这里只保留可追溯 ID。</p>
      {sourceRefs.length > 0 ? (
        <div className="evidence-ref-list">
          {sourceRefs.map((ref, index) => {
            const ids = Array.isArray(ref.ids) ? ref.ids.map(String) : [];
            return (
              <div className="evidence-ref-row" key={`${String(ref.table)}-${index}`}>
                <span>{String(ref.table ?? "-")}</span>
                <small>{ids.length} 条</small>
                <code title={ids.join(", ")}>{ids.slice(0, 4).join(", ") || "-"}</code>
              </div>
            );
          })}
        </div>
      ) : <div className="empty">这条记忆没有关联原始表引用。</div>}
      {evidenceEventIds.length > 0 && (
        <div className="evidence-ref-row">
          <span>event memory</span>
          <small>{evidenceEventIds.length} 条</small>
          <code title={evidenceEventIds.join(", ")}>{evidenceEventIds.slice(0, 4).join(", ")}</code>
        </div>
      )}
      {Object.keys(compactMetadata).length > 0 && (
        <details>
          <summary>结构字段</summary>
          <JsonValueView value={compactMetadata} />
        </details>
      )}
    </section>
  );
}

function MemoryTab() {
  const [memories, setMemories] = useState<MemoryRow[]>([]);
  const [query, setQuery] = useState("");
  const [memoryType, setMemoryType] = useState("");
  const [editing, setEditing] = useState<Partial<MemoryRow> | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      setError("");
      const params = new URLSearchParams();
      if (query) params.set("query", query);
      if (memoryType) params.set("memoryType", memoryType);
      params.set("actorId", "creator");
      params.set("actorRole", "creator");
      const data = await api<{ memories: MemoryRow[] }>(`/api/memories?${params.toString()}`);
      setMemories(data.memories);
    } catch (err) {
      setError(`加载记忆失败：${memoryErrorText(err)}`);
    }
  }

  useEffect(() => {
    load().catch(console.error);
  }, []);

  async function saveMemory() {
    if (!editing?.title || !editing.summary || !editing.detail || !editing.memoryType) return;
    if (editing.metadataJson) {
      try {
        JSON.parse(editing.metadataJson);
      } catch {
        setError("记忆证据字段必须是合法 JSON。");
        return;
      }
    }
    setBusy(true);
    setError("");
    try {
      if (editing.id) {
        await api(`/api/memories/${editing.id}`, {
          method: "PUT",
          body: JSON.stringify({ ...editing, actorId: "creator", actorRole: "creator" })
        });
      } else {
        await api("/api/memories", {
          method: "POST",
          body: JSON.stringify({ ...editing, actorId: "creator", actorRole: "creator" })
        });
      }
      setEditing(null);
      await load();
    } catch (err) {
      setError(`保存记忆失败：${memoryErrorText(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function deleteMemory(id: string) {
    setBusy(true);
    setError("");
    try {
      await api(`/api/memories/${id}`, {
        method: "DELETE",
        body: JSON.stringify({ actorId: "creator", actorRole: "creator" })
      });
      await load();
    } catch (err) {
      setError(`删除记忆失败：${memoryErrorText(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="memory-page">
      <div className="panel memory-toolbar">
        <input placeholder="全文搜索" value={query} onChange={(event) => setQuery(event.target.value)} />
        <select value={memoryType} onChange={(event) => setMemoryType(event.target.value)}>
          <option value="">全部类型</option>
          <option value="impression">impression</option>
          <option value="event">event</option>
          <option value="skill">skill</option>
        </select>
        <button onClick={load} disabled={busy}>筛选</button>
        <button className="primary" onClick={() => setEditing(memoryDraft("event"))} disabled={busy}>添加事件</button>
        <button onClick={() => setEditing(memoryDraft("impression"))} disabled={busy}>添加印象</button>
        <button onClick={() => setEditing(memoryDraft("skill"))} disabled={busy}>添加技能</button>
      </div>
      {error && <div className="error memory-error"><span>{error}</span></div>}
      <div className="memory-layout">
        <section className="panel table-panel">
          <table>
            <thead>
              <tr>
                <th>类型</th>
                <th>标题</th>
                <th>Scope</th>
                <th>用户</th>
                <th>Agent</th>
                <th>工作空间</th>
                <th>关系 ID</th>
                <th>版本</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {memories.map((memory) => (
                <tr key={memory.id}>
                  <td>{memory.memoryType}</td>
                  <td>{memory.title}</td>
                  <td>{memoryScopeLabel(memory)}</td>
                  <td>{memory.userId ?? ""}</td>
                  <td>{memory.agentId ?? ""}</td>
                  <td>{memory.workspaceId ?? ""}</td>
                  <td><code>{memory.relationId ?? ""}</code></td>
                  <td>{memory.version}</td>
                  <td>
                    <button onClick={() => setEditing(memory)} disabled={busy}>编辑</button>
                    <button onClick={() => deleteMemory(memory.id)} disabled={busy}>删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <aside className="panel memory-editor">
          {editing ? (
            <>
              <label>
                类型
                <select
                  value={editing.memoryType}
                  onChange={(event) => {
                    const nextType = event.target.value as MemoryRow["memoryType"];
                    setEditing(editing.id ? { ...editing, memoryType: nextType } : { ...memoryDraft(nextType), title: editing.title, summary: editing.summary, detail: editing.detail });
                  }}
                >
                  <option value="impression">impression</option>
                  <option value="event">event</option>
                  <option value="skill">skill</option>
                </select>
              </label>
              <label>标题<input value={editing.title ?? ""} onChange={(event) => setEditing({ ...editing, title: event.target.value })} /></label>
              <label>摘要<textarea value={editing.summary ?? ""} onChange={(event) => setEditing({ ...editing, summary: event.target.value })} /></label>
              <label>详情<textarea value={editing.detail ?? ""} onChange={(event) => setEditing({ ...editing, detail: event.target.value })} /></label>
              <label>用户 ID<input value={editing.userId ?? ""} onChange={(event) => setEditing({ ...editing, userId: event.target.value || undefined })} /></label>
              <label>Agent ID<input value={editing.agentId ?? ""} onChange={(event) => setEditing({ ...editing, agentId: event.target.value || undefined })} /></label>
              <label>工作空间 ID<input value={editing.workspaceId ?? ""} onChange={(event) => setEditing({ ...editing, workspaceId: event.target.value || undefined })} /></label>
              <label>关系 ID<input value={editing.relationId ?? ""} onChange={(event) => setEditing({ ...editing, relationId: event.target.value || undefined })} /></label>
              <label>版本<input type="number" value={editing.version ?? 1} onChange={(event) => setEditing({ ...editing, version: Number(event.target.value) })} /></label>
              <MemoryEvidencePanel memory={editing} />
              <button className="primary" onClick={saveMemory} disabled={busy}>保存记忆</button>
            </>
          ) : <div className="empty">请选择或添加一条记忆。</div>}
        </aside>
      </div>
    </section>
  );
}

const RootApp = window.location.pathname.startsWith("/dev") ? LegacyDevApp : UserChatApp;

createRoot(document.getElementById("root")!).render(<RootApp />);
