/** Composer toolbar style tokens + constants. Centralized so the toolbar chips,
 *  dropdown menus, and the main composer body share one definition. All values
 *  reference design tokens (no hardcoded colors/sizes). */
import type { RunMode } from '@/lib/runModes';

export const MAX_ROWS = 8;
export const TOOLBAR_HOVER = 'transition-colors hover:bg-muted/70 hover:text-foreground';
export const TOOLBAR_HIT = 'h-7';
export const TOOLBAR_ICON = 'size-4 shrink-0';
export const TOOLBAR_ICON_BTN = `flex ${TOOLBAR_HIT} w-7 shrink-0 items-center justify-center rounded-pill text-muted-foreground ${TOOLBAR_HOVER}`;
export const TOOLBAR_CHIP_BASE = `flex ${TOOLBAR_HIT} shrink-0 items-center gap-1 rounded-pill text-2xs leading-none text-muted-foreground ${TOOLBAR_HOVER}`;
export const TOOLBAR_DROPDOWN_CHIP = `${TOOLBAR_CHIP_BASE} px-1.5`;
export const TOOLBAR_LABEL_CHIP = `${TOOLBAR_CHIP_BASE} max-w-[min(100%,160px)] px-2`;
export const TOOLBAR_DROPDOWN_CHEVRON = 'size-2.5 shrink-0 opacity-50';
export const TOOLBAR_ICON_SLOT = `flex ${TOOLBAR_ICON} items-center justify-center`;
export const TOOLBAR_STOP_BTN = `${TOOLBAR_ICON_BTN} border border-border bg-card text-muted-foreground shadow-xs hover:border-border hover:bg-muted/70 hover:text-foreground`;
export const RUN_MODE_CYCLE: RunMode[] = ['normal', 'plan', 'goal'];
export const RUN_MODE_SHORTCUT = 'Shift+Tab';
export const TOOLBAR_AVATAR_PROPS = {
  className: 'size-4',
  letterClassName: 'text-2xs',
  emojiClassName: 'text-xs leading-none',
} as const;
