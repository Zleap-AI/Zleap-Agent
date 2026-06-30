export const PLAN_EXECUTE_CONFIRM_MARKER = '[[ZLEAP_PLAN_CONFIRM:EXECUTE]]';
export const PLAN_QUESTION_START_MARKER = '[[ZLEAP_PLAN_QUESTION]]';
export const PLAN_QUESTION_END_MARKER = '[[/ZLEAP_PLAN_QUESTION]]';

export function needsExecuteConfirmationReply(text: string): boolean {
  return text.includes(PLAN_EXECUTE_CONFIRM_MARKER);
}

export function stripPlanReplyMarkers(text: string): string {
  return text
    .replace(planQuestionBlockPattern(), '')
    .replaceAll(PLAN_EXECUTE_CONFIRM_MARKER, '')
    .trimEnd();
}

function planQuestionBlockPattern(): RegExp {
  return new RegExp(
    `${escapeRegExp(PLAN_QUESTION_START_MARKER)}\\s*([\\s\\S]*?)\\s*${escapeRegExp(PLAN_QUESTION_END_MARKER)}`,
    'm',
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
