export type RuntimeConfigValueType = "number" | "boolean" | "string";

export type RuntimeConfigDefinition = {
  key: string;
  category: string;
  label: string;
  description: string;
  valueType: RuntimeConfigValueType;
  defaultValue: number | boolean | string;
  minValue?: number;
  maxValue?: number;
  step?: number;
};

export type RuntimeConfigRow = {
  key: string;
  category: string;
  label: string;
  description: string;
  valueType: RuntimeConfigValueType;
  valueJson: string;
  defaultValueJson: string;
  minValue?: number;
  maxValue?: number;
  step?: number;
  updatedAt: string;
};

export const RUNTIME_CONFIG_DEFINITIONS: RuntimeConfigDefinition[] = [
  {
    key: "agent.maxToolRounds",
    category: "agent",
    label: "工具循环最大轮次",
    description: "单次 agent 运行中允许模型连续 function call / tool result follow-up 的最大轮次。",
    valueType: "number",
    defaultValue: 100,
    minValue: 1,
    maxValue: 500,
    step: 1
  },
  {
    key: "memory.impressionRecallLimit",
    category: "memory",
    label: "Impression 召回条数",
    description: "每轮强制注入的用户/Agent impression 上限。Impression 不做 query 选择，按最新有效记录加载。",
    valueType: "number",
    defaultValue: 20,
    minValue: 0,
    maxValue: 100,
    step: 1
  },
  {
    key: "memory.resultEventRecallLimit",
    category: "memory",
    label: "结果事件召回条数",
    description: "当前工作空间旧结果事件时间线的注入上限。",
    valueType: "number",
    defaultValue: 10,
    minValue: 0,
    maxValue: 100,
    step: 1
  },
  {
    key: "memory.processEventRecallLimit",
    category: "memory",
    label: "过程事件召回条数",
    description: "通过 FTS 与当前任务相关的过程事件召回上限。",
    valueType: "number",
    defaultValue: 8,
    minValue: 0,
    maxValue: 50,
    step: 1
  },
  {
    key: "memory.eventWindowSize",
    category: "memory",
    label: "事件提取消息窗口",
    description: "长对话每多少条原始 messages 触发一次过程/结果事件提取。",
    valueType: "number",
    defaultValue: 20,
    minValue: 2,
    maxValue: 200,
    step: 1
  },
  {
    key: "memory.processEventDetailLimit",
    category: "memory",
    label: "过程事件详情长度",
    description: "自动写入过程事件 memory detail 时的最大字符数，避免把原始过程整段塞回记忆。",
    valueType: "number",
    defaultValue: 900,
    minValue: 120,
    maxValue: 5000,
    step: 50
  },
  {
    key: "llm.maxProviderAttempts",
    category: "llm",
    label: "LLM 最大重试次数",
    description: "遇到可重试网络/provider 错误时最多请求次数。非重试型 4xx 仍直接失败。",
    valueType: "number",
    defaultValue: 5,
    minValue: 1,
    maxValue: 10,
    step: 1
  },
  {
    key: "llm.providerFetchTimeoutMs",
    category: "llm",
    label: "LLM 连接超时毫秒",
    description: "provider 初始 fetch / 连接阶段的超时时间。",
    valueType: "number",
    defaultValue: 30000,
    minValue: 1000,
    maxValue: 300000,
    step: 1000
  },
  {
    key: "llm.streamIdleTimeoutMs",
    category: "llm",
    label: "LLM 流式空闲超时毫秒",
    description: "流式响应在两段数据之间允许空闲的最长时间。",
    valueType: "number",
    defaultValue: 45000,
    minValue: 1000,
    maxValue: 300000,
    step: 1000
  },
  {
    key: "context.historyTokenBudget",
    category: "context",
    label: "本地对话 token 预算",
    description: "上下文窗口里本地对话片段的预算。",
    valueType: "number",
    defaultValue: 2200,
    minValue: 200,
    maxValue: 20000,
    step: 100
  },
  {
    key: "context.memoryTokenBudget",
    category: "context",
    label: "记忆 token 预算",
    description: "上下文窗口里 memory 总分区的预算。",
    valueType: "number",
    defaultValue: 3000,
    minValue: 200,
    maxValue: 30000,
    step: 100
  },
  {
    key: "context.toolResultTokenBudget",
    category: "context",
    label: "工具结果 token 预算",
    description: "follow-up LLM call 中工具结果分区的预算。",
    valueType: "number",
    defaultValue: 1400,
    minValue: 200,
    maxValue: 20000,
    step: 100
  },
  {
    key: "tools.devWorkspaceRoot",
    category: "tools",
    label: "Dev 工具文件根目录",
    description: "read/write/edit/bash 的可配置文件根目录。留空时使用默认会话目录；设置后相对和绝对文件路径都必须落在该根目录内。",
    valueType: "string",
    defaultValue: ""
  }
];

export function runtimeConfigDefaults(): Record<string, unknown> {
  return Object.fromEntries(RUNTIME_CONFIG_DEFINITIONS.map((definition) => [definition.key, definition.defaultValue]));
}

export function runtimeConfigNumber(values: Record<string, unknown>, key: string): number {
  const definition = RUNTIME_CONFIG_DEFINITIONS.find((item) => item.key === key);
  const fallback = typeof definition?.defaultValue === "number" ? definition.defaultValue : 0;
  const value = values[key];
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const min = definition?.minValue ?? Number.NEGATIVE_INFINITY;
  const max = definition?.maxValue ?? Number.POSITIVE_INFINITY;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

export function validateRuntimeConfigValue(definition: RuntimeConfigDefinition, value: unknown): number | boolean | string {
  if (definition.valueType === "boolean") return Boolean(value);
  if (definition.valueType === "string") return String(value ?? "");
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${definition.key} must be a number.`);
  const min = definition.minValue ?? Number.NEGATIVE_INFINITY;
  const max = definition.maxValue ?? Number.POSITIVE_INFINITY;
  if (parsed < min || parsed > max) {
    throw new Error(`${definition.key} must be between ${min} and ${max}.`);
  }
  return Math.floor(parsed);
}
