import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AgentConfig, AgentRunOutput, ApprovalRequest, AuditLog, ContextSegment, LLMCallSnapshot, McpServerDefinition, MemoryRow, ToolCallLog, ToolDefinition, WorkspaceDefinition, WorkspaceSession } from "../types";
import "./styles.css";

type Tab = "chat" | "workspace" | "memory" | "logs";
type ChatMessage = {
  id: string;
  role: string;
  content: string;
  workspaceId?: string;
  eventKind?: string;
  title?: string;
  toolNames?: string[];
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
};

const CACHE_KEY = "zleap.web.state.v2";
const DEFAULT_BASE_URL = "https://api.302ai.com";
const OLD_SYSTEM_PROMPT_MARKER = "你是运行在 Zleap runtime 内的 agent";
const OLD_PERSONALITY_PROMPT_MARKER = "workspace 选择和 context 组织";

type CachedState = {
  userId?: string;
  userRole?: "user" | "creator";
  conversationId?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  messages?: ChatMessage[];
  output?: AgentRunOutput | null;
  retryMessage?: string;
  selectedTurnId?: string;
  agentDraft?: Partial<AgentConfig>;
};

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

function describeWorkspaceView(output: AgentRunOutput | null): { primary: string; detail: string; involved: string[] } {
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

function messageRoleLabel(item: ChatMessage): string {
  if (item.role === "工作空间" && item.workspaceId) return `${item.workspaceId} 工作空间`;
  if (item.role === "运行过程") return "运行过程";
  return item.role;
}

function processMessageSummary(item: ChatMessage): string {
  const workspaceId = item.workspaceId ?? "main";
  const toolCount = item.toolNames?.length ?? 0;
  if (item.eventKind === "entered") return `进入 ${workspaceId} 工作空间`;
  if (item.eventKind === "exit") return `${workspaceId} 工作空间已返回主流程`;
  if (item.eventKind === "tool_call") return `已运行 ${toolCount || 1} 条函数调用`;
  if (item.eventKind === "tool_result") return `已收到 ${toolCount || 1} 条工具结果`;
  return item.title || `${workspaceId} 运行过程`;
}

function processMessageDetail(item: ChatMessage): string {
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

const SYSTEM_TOOL_NAMES = new Set([
  "enterWorkspace",
  "exitWorkspace",
  "askUser",
  "finishTask",
  "searchMemory",
  "writeUserImpression",
  "writeAgentSelfImpression",
  "writeEventMemory",
  "writeSkillMemory",
  "updateMemory",
  "deleteMemory"
]);

const BUILT_IN_WORKSPACE_IDS = new Set(["main", "file", "cli"]);

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
  field: "capabilitiesJson" | "inputKindsJson" | "outputKindsJson",
  value: string
): WorkspaceDefinition {
  return { ...workspace, [field]: JSON.stringify(parseListText(value)) };
}

function loadCache(): CachedState {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) ?? "{}") as CachedState;
  } catch {
    return {};
  }
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

function normalizeCachedMessages(messages: ChatMessage[] | undefined): ChatMessage[] {
  return (messages ?? []).map((item) => ({
    ...item,
    id: item.id ?? createLocalId(item.role === "用户" ? "user-msg" : "assistant-msg")
  }));
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

function App() {
  const [tab, setTab] = useState<Tab>("chat");

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>Zleap Agent</h1>
          <p>工作空间优先的智能体调试控制台</p>
        </div>
        <nav className="tabs" aria-label="主导航">
          {(["chat", "workspace", "memory", "logs"] as Tab[]).map((item) => (
            <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>
              {item === "chat" ? "对话" : item === "workspace" ? "工作空间" : item === "memory" ? "记忆" : "日志"}
            </button>
          ))}
        </nav>
      </header>
      {tab === "chat" && <ChatTab />}
      {tab === "workspace" && <WorkspaceTab />}
      {tab === "memory" && <MemoryTab />}
      {tab === "logs" && <LogsTab />}
    </main>
  );
}

function ChatTab() {
  const cached = loadCache();
  const [agent, setAgent] = useState<AgentConfig | null>(null);
  const [userId, setUserId] = useState(cached.userId ?? "user");
  const [userRole, setUserRole] = useState<"user" | "creator">(cached.userRole ?? "user");
  const [conversationId, setConversationId] = useState(cached.conversationId ?? `conv-${Date.now()}`);
  const [baseUrl, setBaseUrl] = useState(normalizeCachedBaseUrl(cached.baseUrl) ?? DEFAULT_BASE_URL);
  const [model, setModel] = useState(cached.model ?? "gpt-5-mini");
  const [apiKey, setApiKey] = useState(cached.apiKey ?? "");
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>(() => normalizeCachedMessages(cached.messages));
  const [output, setOutput] = useState<AgentRunOutput | null>(cached.output ?? null);
  const [error, setError] = useState("");
  const [retryMessage, setRetryMessage] = useState(cached.retryMessage ?? "");
  const [selectedTurnId, setSelectedTurnId] = useState(cached.selectedTurnId ?? "");
  const [loading, setLoading] = useState(false);
  const selectedUserMessage = selectedTurnId ? messages.find((item) => item.id === selectedTurnId && item.role === "用户") : undefined;
  const visibleOutput = selectedUserMessage ? selectedUserMessage.turnOutput ?? null : output;
  const workspaceView = describeWorkspaceView(visibleOutput);

  useEffect(() => {
    api<AgentConfig>("/api/agents/default-agent")
      .then((loaded) => {
        const draft = sanitizeCachedAgentDraft(cached.agentDraft);
        const merged = { ...loaded, ...draft };
        setAgent(merged);
        setBaseUrl(normalizeCachedBaseUrl(cached.baseUrl) ?? normalizeCachedBaseUrl(merged.defaultBaseUrl) ?? DEFAULT_BASE_URL);
        setModel(cached.model ?? merged.defaultModel);
      })
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    saveCache({ userId, userRole, conversationId, baseUrl, model, apiKey, messages, output, retryMessage, selectedTurnId, agentDraft: agent ?? undefined });
  }, [userId, userRole, conversationId, baseUrl, model, apiKey, messages, output, retryMessage, selectedTurnId, agent]);

  async function saveAgent() {
    if (!agent) return;
    try {
      const saved = await api<AgentConfig>(`/api/agents/${agent.id}`, {
        method: "PUT",
        body: JSON.stringify({ ...agent, actorId: userId, actorRole: userRole })
      });
      setAgent(saved);
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
    if (!cleanMessage.trim() || !agent) return;
    const userMessageId = createLocalId("user-msg");
    const assistantMessageId = createLocalId("assistant-msg");
    setLoading(true);
    setError("");
    setRetryMessage("");
    setSelectedTurnId(userMessageId);
    setMessage("");
    setMessages((items) => [
      ...removeFailedRetryPair(items, cleanMessage),
      { id: userMessageId, role: "用户", content: cleanMessage },
      { id: assistantMessageId, role: "助手", content: "", streaming: true }
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
      }) => {
        const workspaceMessageId = createLocalId(`workspace-${payload.workspaceId}`);
        const baseContent = payload.text.trim()
          ? `**${payload.title}**\n\n${payload.text}`
          : `**${payload.title}**`;
        if (payload.eventKind !== "assistant") {
          setMessages((items) => insertBeforeAssistant(items, {
            id: workspaceMessageId,
            role: "运行过程",
            workspaceId: payload.workspaceId,
            eventKind: payload.eventKind,
            title: payload.title,
            toolNames: payload.toolNames,
            status: payload.status,
            content: baseContent
          }));
          return;
        }
        setMessages((items) => insertBeforeAssistant(items, {
          id: workspaceMessageId,
          role: "工作空间",
          workspaceId: payload.workspaceId,
          eventKind: payload.eventKind,
          content: "",
          streaming: true
        }));
        let streamed = "";
        for (const char of Array.from(baseContent)) {
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
        })
      });
      if (!response.ok || !response.body) throw new Error(`流式请求失败：${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let assistantText = "";

      while (true) {
        const { done, value } = await reader.read();
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
            setOutput(startOutput);
            setMessages((items) => items.map((item) => item.id === userMessageId ? { ...item, turnOutput: startOutput } : item));
          }
          if (payload.type === "delta") {
            for (const char of Array.from(payload.text)) {
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
            setMessages((items) => items.map((item) => item.id === userMessageId ? { ...item, turnOutput: payload.output } : item));
            setMessages((items) => {
              return items.map((item) => item.id === assistantMessageId
                ? { ...item, content: payload.output.assistantMessage, streaming: false }
                : item);
            });
          }
          if (payload.type === "error") {
            throw new Error(payload.error);
          }
        }
      }
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      setError(messageText);
      setRetryMessage(cleanMessage);
      setMessages((items) => {
        return items.map((item) => item.id === assistantMessageId
          ? { ...item, content: `出错：${messageText}`, streaming: false, failed: true, requestText: cleanMessage }
          : item);
      });
    } finally {
      setLoading(false);
    }
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

  function clearLocalCache() {
    localStorage.removeItem(CACHE_KEY);
    setMessages([]);
    setOutput(null);
    setError("");
    setRetryMessage("");
    setSelectedTurnId("");
    setApiKey("");
    setConversationId(`conv-${Date.now()}`);
  }

  async function clearConversation() {
    await api(`/api/conversations/${encodeURIComponent(conversationId)}`, {
      method: "DELETE",
      body: JSON.stringify({ actorId: userId, actorRole: userRole, deleteReason: "用户在 Web UI 清空当前会话" })
    }).catch(() => undefined);
    setConversationId(`conv-${Date.now()}`);
    setMessage("");
    setMessages([]);
    setOutput(null);
    setError("");
    setRetryMessage("");
    setSelectedTurnId("");
  }

  return (
    <section className="chat-grid">
      <aside className="panel config-panel">
        <h2>智能体配置</h2>
        <label>智能体 ID<input value={agent?.id ?? ""} disabled /></label>
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
        <button onClick={clearLocalCache}>清空浏览器缓存</button>
      </aside>

      <section className="panel chat-panel">
        <div className="chat-toolbar">
          <strong>当前会话</strong>
          <button onClick={() => void clearConversation()} disabled={loading || (messages.length === 0 && !output && !error)}>清空当前会话</button>
        </div>
        <div className="message-list">
          {messages.map((item, index) => (
            <article
              key={item.id ?? `${item.role}-${index}`}
              className={`message ${item.role === "用户" ? "user clickable" : item.role === "运行过程" ? "process" : item.role === "工作空间" ? "workspace" : "assistant"} ${item.failed ? "failed" : ""} ${selectedTurnId === item.id ? "selected" : ""}`}
              role={item.role === "用户" ? "button" : undefined}
              tabIndex={item.role === "用户" ? 0 : undefined}
              onClick={() => item.role === "用户" && setSelectedTurnId(item.id)}
              onKeyDown={(event) => {
                if (item.role === "用户" && (event.key === "Enter" || event.key === " ")) setSelectedTurnId(item.id);
              }}
              title={item.role === "用户" ? "查看这轮对话的上下文窗口堆栈" : undefined}
            >
              {item.role === "运行过程" ? (
                <details className="process-details">
                  <summary>
                    <span className="process-icon">▻</span>
                    <span>{processMessageSummary(item)}</span>
                    {item.workspaceId && <small>{item.workspaceId}</small>}
                  </summary>
                  <pre>{processMessageDetail(item)}</pre>
                </details>
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
          ))}
          {messages.length === 0 && <div className="empty">发送一条消息，右侧会展示本轮上下文窗口和工作空间轨迹。</div>}
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
          <button className="primary" disabled={loading} onClick={() => sendMessage()}>{loading ? "生成中" : "发送"}</button>
        </div>
      </section>

      <aside className="panel context-panel">
        <h2>正在查看</h2>
        <div className="turn-badge">
          {selectedUserMessage ? (
            <>
              <strong>用户消息</strong>
              <span>{selectedUserMessage.content}</span>
            </>
          ) : (
            <>
              <strong>最新一轮</strong>
          <span>未选择历史用户消息</span>
            </>
          )}
        </div>
        <h2>当前查看工作空间</h2>
        <div className="workspace-badge">
          <strong>{workspaceView.primary}</strong>
          {workspaceView.detail && <span>{workspaceView.detail}</span>}
          {workspaceView.involved.length > 1 && <small>本轮涉及：{workspaceView.involved.join(" → ")}</small>}
        </div>
        <h2>工作空间轨迹</h2>
        <div className="stack">
          {visibleOutput?.workspaceTrace.map((session) => (
            <details key={session.id} open>
              <summary>{session.workspaceId} · {session.status}</summary>
              <pre>{JSON.stringify(session, null, 2)}</pre>
            </details>
          ))}
        </div>
        <h2>上下文窗口堆栈</h2>
        {selectedUserMessage && !selectedUserMessage.turnOutput
          ? <div className="empty">这条消息还没有保存上下文快照。</div>
          : <ContextStack segments={visibleOutput?.contextSegments ?? []} />}
        <h2>本轮记忆写入</h2>
        <MemoryWriteStack memories={visibleOutput?.memoryWrites ?? []} />
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
            <small>{memory.memoryType}</small>
          </summary>
          <pre>{JSON.stringify(memory, null, 2)}</pre>
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
            <small className={`status-pill ${log.status === "completed" ? "success" : "danger"}`}>{log.status === "completed" ? "已完成" : "失败"}</small>
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

function parseJsonText(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function shortText(value: string, maxLength = 220): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
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
              <pre>{JSON.stringify(messages, null, 2)}</pre>
            </details>
            <details>
              <summary>请求 tools</summary>
              <pre>{JSON.stringify(tools, null, 2)}</pre>
            </details>
            <details>
              <summary>返回 / 诊断</summary>
              <pre>{JSON.stringify(response, null, 2)}</pre>
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
      {segments.map((segment) => (
        <details key={segment.id}>
          <summary>
            <span>{segment.sortOrder}. {contextSegmentLabel(segment)}</span>
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
  if (segment.segmentType === "memory") return "记忆";
  if (segment.segmentType === "history") return "本地对话片段";
  if (segment.segmentType === "user") return "干净用户消息";
  if (segment.segmentType === "tool_result") return "工具结果";
  if (segment.segmentType === "final_messages") return "最终 LLM Messages";
  return segment.title;
}

function contextSubsectionLabel(key: string): string {
  const labels: Record<string, string> = {
    currentWorkspace: "当前工作空间说明",
    availableWorkspaces: "主工作空间可用工作空间清单",
    crossWorkspaceImpressionMemory: "跨工作空间印象记忆",
    currentWorkspaceEventMemory: "当前工作空间事件记忆",
    currentWorkspaceSkillMemory: "当前工作空间经验记忆",
    messages: "本地对话消息",
    currentTask: "当前结构化任务",
    completedWorkspaceResults: "已完成工作空间结果",
    recentToolEvidence: "近期工具证据"
  };
  return labels[key] ?? key;
}

function ContextSegmentContent({ segment }: { segment: ContextSegment }) {
  const parsed = parseJsonText(segment.content);
  if (
    parsed
    && typeof parsed === "object"
    && !Array.isArray(parsed)
    && ["workspace", "memory", "history"].includes(segment.segmentType)
  ) {
    return (
      <div className="context-substack">
        {Object.entries(parsed as Record<string, unknown>)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => (
            <details key={key} open>
              <summary>{contextSubsectionLabel(key)}</summary>
              <pre>{JSON.stringify(value, null, 2)}</pre>
            </details>
          ))}
      </div>
    );
  }
  return <pre>{segment.content}</pre>;
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
      const saved = await api<WorkspaceDefinition>(`/api/workspaces/${encodeURIComponent(selected.id)}`, {
        method: "PUT",
        body: JSON.stringify({
          ...selected,
          toolIds: selected.tools.map((tool) => tool.id),
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
      inputKindsJson: "[]",
      outputKindsJson: "[]",
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
        inputKinds: [],
        outputKinds: [],
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
            <label>描述<textarea value={selected.description} onChange={(event) => setSelected({ ...selected, description: event.target.value })} /></label>
            <label>能力清单<textarea value={stringifyListText(selected.capabilitiesJson)} onChange={(event) => setSelected(updateWorkspaceListField(selected, "capabilitiesJson", event.target.value))} /></label>
            <label>输入类型<textarea value={stringifyListText(selected.inputKindsJson)} onChange={(event) => setSelected(updateWorkspaceListField(selected, "inputKindsJson", event.target.value))} /></label>
            <label>输出类型<textarea value={stringifyListText(selected.outputKindsJson)} onChange={(event) => setSelected(updateWorkspaceListField(selected, "outputKindsJson", event.target.value))} /></label>
            <label className="check-row">
              <input type="checkbox" checked={Boolean(selected.requiresApproval)} onChange={(event) => setSelected({ ...selected, requiresApproval: event.target.checked ? 1 : 0 })} />
              <span>进入或使用该工作空间需要审批</span>
            </label>
            <label>工作空间说明<textarea value={selected.instructions} onChange={(event) => setSelected({ ...selected, instructions: event.target.value })} /></label>
            <label>工具使用说明<textarea value={selected.toolInstructions} onChange={(event) => setSelected({ ...selected, toolInstructions: event.target.value })} /></label>
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
      workspaceId: "main",
      metadataJson: JSON.stringify(skillMetadataTemplate(), null, 2)
    };
  }
  if (memoryType === "impression") {
    return {
      ...base,
      userId: "creator",
      metadataJson: JSON.stringify({ impressionKind: "userImpression", source: "manualMemoryApi" }, null, 2)
    };
  }
  return {
    ...base,
    userId: "creator",
    workspaceId: "main",
    metadataJson: JSON.stringify({ source: "manualMemoryApi", eventKind: "manual", conversationId: "manual-memory-api", outcome: "partial" }, null, 2)
  };
}

function memoryErrorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
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
        setError("metadataJson 必须是合法 JSON。");
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
                <th>用户</th>
                <th>工作空间</th>
                <th>版本</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {memories.map((memory) => (
                <tr key={memory.id}>
                  <td>{memory.memoryType}</td>
                  <td>{memory.title}</td>
                  <td>{memory.userId ?? ""}</td>
                  <td>{memory.workspaceId ?? ""}</td>
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
              <label>工作空间 ID<input value={editing.workspaceId ?? ""} onChange={(event) => setEditing({ ...editing, workspaceId: event.target.value || undefined })} /></label>
              <label>关系 ID<input value={editing.relationId ?? ""} onChange={(event) => setEditing({ ...editing, relationId: event.target.value || undefined })} /></label>
              <label>版本<input type="number" value={editing.version ?? 1} onChange={(event) => setEditing({ ...editing, version: Number(event.target.value) })} /></label>
              <label>元数据 JSON<textarea className="json-editor" value={editing.metadataJson ?? "{}"} onChange={(event) => setEditing({ ...editing, metadataJson: event.target.value })} /></label>
              <button className="primary" onClick={saveMemory} disabled={busy}>保存记忆</button>
            </>
          ) : <div className="empty">请选择或添加一条记忆。</div>}
        </aside>
      </div>
    </section>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
