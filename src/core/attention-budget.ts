import type { ContextSegment } from "../types";

export type AttentionBudget = Partial<Record<ContextSegment["segmentType"], number>>;

export const DEFAULT_ATTENTION_BUDGET: AttentionBudget = {
  system: 1200,
  personality: 800,
  policy: 900,
  workspace: 1400,
  workspace_registry: 1200,
  task: 800,
  workspace_result: 1200,
  workspace_local_context: 1600,
  tools: 1400,
  impression_memory: 900,
  event_memory: 1400,
  skill_memory: 1400,
  history: 1000,
  user: 4000,
  tool_result: 1400
};

const TRUNCATION_NOTE = "[truncated by attention budget]";

export function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

export class AttentionBudgetManager {
  constructor(private readonly budget: AttentionBudget = DEFAULT_ATTENTION_BUDGET) {}

  apply<T extends Pick<ContextSegment, "segmentType" | "content">>(segments: T[]): T[] {
    return segments.map((segment) => ({
      ...segment,
      content: this.fitSegment(segment.segmentType, segment.content)
    }));
  }

  fitSegment(segmentType: ContextSegment["segmentType"], content: string): string {
    const tokenBudget = this.budget[segmentType];
    if (!tokenBudget || estimateTokens(content) <= tokenBudget) return content;

    const charBudget = Math.max(120, tokenBudget * 4);
    const json = this.tryParseJson(content);
    if (json.parsed) return this.fitJson(json.value, charBudget);
    return this.fitText(content, charBudget);
  }

  private fitJson(value: unknown, charBudget: number): string {
    let stringMax = Math.max(160, Math.min(900, charBudget));
    let arrayMax = 12;

    for (let attempt = 0; attempt < 12; attempt += 1) {
      const compacted = compactJsonValue(value, stringMax, arrayMax);
      const serialized = JSON.stringify(compacted, null, 2);
      if (serialized.length <= charBudget) return serialized;
      if (arrayMax > 3) arrayMax = Math.max(3, Math.floor(arrayMax * 0.7));
      if (stringMax > 120) stringMax = Math.max(120, Math.floor(stringMax * 0.65));
    }

    const preview = this.fitText(JSON.stringify(value), Math.max(60, charBudget - 80));
    return JSON.stringify({ __truncated: TRUNCATION_NOTE, preview }, null, 2);
  }

  private fitText(content: string, charBudget: number): string {
    if (content.length <= charBudget) return content;
    const suffix = `\n${TRUNCATION_NOTE}`;
    return `${content.slice(0, Math.max(0, charBudget - suffix.length))}${suffix}`;
  }

  private tryParseJson(content: string): { parsed: true; value: unknown } | { parsed: false } {
    try {
      return { parsed: true, value: JSON.parse(content) as unknown };
    } catch {
      return { parsed: false };
    }
  }
}

function compactJsonValue(value: unknown, stringMax: number, arrayMax: number): unknown {
  if (typeof value === "string") {
    if (value.length <= stringMax) return value;
    return `${value.slice(0, Math.max(0, stringMax - TRUNCATION_NOTE.length - 1))} ${TRUNCATION_NOTE}`;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, arrayMax).map((item) => compactJsonValue(item, stringMax, arrayMax));
    if (value.length > arrayMax) items.push({ __truncatedItems: value.length - arrayMax });
    return items;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, compactJsonValue(item, stringMax, arrayMax)])
    );
  }
  return value;
}
