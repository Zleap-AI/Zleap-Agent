export const RUN_MODES = ['normal', 'plan', 'goal'] as const;

export type RunMode = (typeof RUN_MODES)[number];

export const RUN_MODE_CYCLE: RunMode[] = ['normal', 'plan', 'goal'];

export const RUN_MODE_SHORTCUT = 'Shift+Tab';

export function normalizeRunMode(value: unknown): RunMode {
  return RUN_MODES.includes(value as RunMode) ? (value as RunMode) : 'normal';
}

export function nextRunMode(mode: RunMode): RunMode {
  const index = RUN_MODE_CYCLE.indexOf(mode);
  return RUN_MODE_CYCLE[(index + 1) % RUN_MODE_CYCLE.length] ?? 'normal';
}

export function runModeLabel(mode: RunMode): string {
  if (mode === 'plan') return '计划';
  if (mode === 'goal') return '目标';
  return '普通';
}

export function runModeHint(mode: RunMode): string {
  if (mode === 'plan') return '只分析计划，不执行工具';
  if (mode === 'goal') return '以目标为导向持续执行';
  return '直接对话与执行';
}

/** User text that means "execute the plan" in plan mode. */
export function isPlanExecuteText(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return normalized === '执行' || normalized === 'execute' || normalized === '/execute';
}
