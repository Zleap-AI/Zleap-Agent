/**
 * Motion tokens for framer-motion — the JS mirror of the CSS motion tokens in
 * `app/globals.css` (`--ease-*`, `--duration-*`). Tailwind className transitions
 * consume the CSS vars directly (`ease-out`, `duration-[var(--duration-base)]`);
 * framer-motion can't read CSS vars, so it imports these instead. One source for
 * "how motion feels" so durations/easings stay consistent and restrained.
 */

/** cubic-bezier of the `--ease-out` token (calm, decelerating). */
export const EASE_OUT = [0.22, 1, 0.36, 1] as const;
/** cubic-bezier of the `--ease-spring` token (slight overshoot). */
export const EASE_SPRING = [0.34, 1.56, 0.64, 1] as const;

/** Durations in seconds, mirroring `--duration-fast|base|slow` (120/220/360ms). */
export const DURATION = { fast: 0.12, base: 0.22, slow: 0.36 } as const;

/** Sliding panels & drawers (sidebar, inspector, file drawer, page transitions). */
export const SPRING_PANEL = { type: 'spring', stiffness: 300, damping: 32 } as const;
/** Snappy pop for small controls (e.g. the composer send button). */
export const SPRING_SNAPPY = { type: 'spring', stiffness: 500, damping: 30 } as const;
