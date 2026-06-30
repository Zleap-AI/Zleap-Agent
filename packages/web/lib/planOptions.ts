export type PlanOption = { key: string; text: string };
export type PlanQuestionOption = { id: string; label: string; recommended?: boolean };
export type PlanQuestion = { question: string; options: PlanQuestionOption[] };
export type PlanReplyPrompt = {
  messageId: string;
  questions: PlanQuestion[];
  needsExecuteConfirmation: boolean;
};
export type PlanPromptSourceMessage = { id: string | number; role: string; text?: string };

export const PLAN_EXECUTE_CONFIRM_MARKER = '[[ZLEAP_PLAN_CONFIRM:EXECUTE]]';
export const PLAN_QUESTION_START_MARKER = '[[ZLEAP_PLAN_QUESTION]]';
export const PLAN_QUESTION_END_MARKER = '[[/ZLEAP_PLAN_QUESTION]]';

export function extractPlanOptions(text: string): PlanOption[] {
  if (!/(请选择|选项|可以选择|你可以|方向)/.test(text)) {
    return [];
  }
  const options: PlanOption[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:[-*]\s*)?(?:选项\s*)?([A-Za-z]|\d{1,2})[.:：)、]\s*(.{2,120})\s*$/.exec(line);
    if (!match) continue;
    const key = match[1]!.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    options.push({ key, text: match[2]!.trim() });
    if (options.length >= 4) break;
  }
  return options.length >= 2 ? options : [];
}

export function needsExecuteConfirmationReply(text: string): boolean {
  return text.includes(PLAN_EXECUTE_CONFIRM_MARKER);
}

export function stripPlanReplyMarkers(text: string): string {
  return text
    .replace(planQuestionBlockPattern(), '')
    .replaceAll(PLAN_EXECUTE_CONFIRM_MARKER, '')
    .trimEnd();
}

export function extractPlanQuestion(text: string): PlanQuestion | undefined {
  return extractPlanQuestions(text)[0];
}

export function extractPlanQuestions(text: string): PlanQuestion[] {
  const match = planQuestionBlockPattern().exec(text);
  if (!match?.[1]) {
    return [];
  }
  try {
    const raw = JSON.parse(match[1]) as unknown;
    if (!raw || typeof raw !== 'object') return [];
    const record = raw as Record<string, unknown>;
    const rawQuestions = Array.isArray(record.questions)
      ? record.questions
      : typeof record.question === 'string'
        ? [record]
        : [];
    return rawQuestions
      .map(parsePlanQuestion)
      .filter((question): question is PlanQuestion => Boolean(question))
      .slice(0, 3);
  } catch {
    return [];
  }
}

export function latestPlanReplyPrompt(
  messages: readonly PlanPromptSourceMessage[],
  dismissedMessageIds: ReadonlySet<string> = new Set(),
): PlanReplyPrompt | undefined {
  const latest = messages.at(-1);
  if (!latest || latest.role !== 'assistant') {
    return undefined;
  }
  const messageId = String(latest.id);
  if (dismissedMessageIds.has(messageId)) {
    return undefined;
  }
  const text = latest.text ?? '';
  const questions = extractPlanQuestions(text);
  const needsExecuteConfirmation = needsExecuteConfirmationReply(text);
  if (questions.length === 0 && !needsExecuteConfirmation) {
    return undefined;
  }
  return { messageId, questions, needsExecuteConfirmation };
}

function parsePlanQuestion(raw: unknown): PlanQuestion | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const question = typeof record.question === 'string' ? record.question.trim() : '';
  const optionValues = Array.isArray(record.options) ? record.options : [];
  const options = optionValues
    .map((option, index): PlanQuestionOption | undefined => {
      if (!option || typeof option !== 'object') return undefined;
      const optionRecord = option as Record<string, unknown>;
      const label = typeof optionRecord.label === 'string' ? optionRecord.label.trim() : '';
      if (!label) return undefined;
      const id = typeof optionRecord.id === 'string' && optionRecord.id.trim() ? optionRecord.id.trim() : String(index + 1);
      return {
        id,
        label,
        recommended: optionRecord.recommended === true,
      };
    })
    .filter((option): option is PlanQuestionOption => Boolean(option))
    .slice(0, 3);
  if (!question || options.length < 2) return undefined;
  return { question, options };
}

function planQuestionBlockPattern(): RegExp {
  return new RegExp(`${escapeRegExp(PLAN_QUESTION_START_MARKER)}\\s*([\\s\\S]*?)\\s*${escapeRegExp(PLAN_QUESTION_END_MARKER)}`, 'm');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
