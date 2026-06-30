import { BRAND_GOLD, GOLD_DIM, TEXT_ERROR } from './theme.js';

export type MascotMood =
  | 'idle'
  | 'palette'
  | 'wizard'
  | 'thinking'
  | 'tool'
  | 'done'
  | 'error';

/** Zleap brand gold — shared by the launch wordmark, mascot, and prompt frame. */
export { BRAND_GOLD } from './theme.js';

/**
 * Compact kaomoji faces — the parentheses read as the astronaut's helmet, so
 * each face is a little visor expression. Plain ASCII keeps them crisp in any
 * terminal font, and every face is exactly five cells wide so the prompt row
 * never shifts. Multi-frame moods add personality without changing layout.
 */
const FACES: Record<MascotMood, readonly [string, ...string[]]> = {
  idle: ['(^_^)', '(^.^)', '(^_^)'], // warm little idle bounce
  palette: ['(o_o)', '(o_O)', '(O_o)', '(o_o)'], // scanning the slash menu
  wizard: ['(._.)', '(:_.)', '(._:)', '(._.)'], // careful config focus
  thinking: ['(o_o)', '(-_-)', '(o_o)', '(._.)'], // attentive blink loop
  tool: ['(>_<)', '(>o<)', '(^o^)', '(>_<)'], // working burst
  done: ['(^o^)', '(^_^)', '(^v^)'], // celebratory settle
  error: ['(x_x)', '(T_T)', '(x_x)'], // clear but not too noisy
};

const FRAME_MS: Record<MascotMood, number> = {
  idle: 900,
  palette: 360,
  wizard: 520,
  thinking: 420,
  tool: 180,
  done: 260,
  error: 520,
};

const COLORS: Record<MascotMood, string> = {
  idle: BRAND_GOLD,
  palette: BRAND_GOLD,
  wizard: GOLD_DIM,
  thinking: BRAND_GOLD,
  tool: GOLD_DIM,
  done: BRAND_GOLD,
  error: TEXT_ERROR,
};

/** Longest face string — used to reserve horizontal space in the prompt row. */
export const MASCOT_DISPLAY_WIDTH = Math.max(
  ...Object.values(FACES)
    .flatMap((frames) => frames)
    .map((face) => face.length),
);

export function resolveMascotMood(options: {
  running: boolean;
  tool: boolean;
  wizard: boolean;
  paletteOpen: boolean;
}): MascotMood {
  if (options.tool) {
    return 'tool';
  }
  if (options.running) {
    return 'thinking';
  }
  if (options.wizard) {
    return 'wizard';
  }
  if (options.paletteOpen) {
    return 'palette';
  }
  return 'idle';
}

/** Whether a mood cycles frames (and so needs a render timer). */
export function isAnimated(mood: MascotMood): boolean {
  return FACES[mood].length > 1;
}

export function mascotFrameMs(mood: MascotMood): number {
  return FRAME_MS[mood];
}

export function mascotColor(mood: MascotMood): string {
  return COLORS[mood];
}

export function mascotFace(mood: MascotMood, frame = 0): string {
  const frames = FACES[mood];
  return frames[frame % frames.length] ?? frames[0];
}
