/**
 * Context assembly types. See docs/memory.md §4. Generic over the surface's
 * message type `M` (the agent layer stays free of any provider/ai message shape)
 * so `assemble` is a pure ordering function.
 */

/** Where a provider may cache the prefix. The ai-layer adapter (Anthropic
 *  `cache_control`, etc.) DECIDES how; the agent only DECLARES the boundaries. */
export type CacheBreakpoint = { after: 'stable' | 'semiStable'; messageIndex: number };

export type AssemblyInput<M> = {
  // ── Block 1: stable (cacheable; byte-stable within a space/session) ──
  /**
   * Pre-ordered system sections. When provided, the stable block is exactly
   * `systemSections.filter(Boolean).join('\n\n')` and the legacy
   * persona/rules/spaceInstructions/impressionsText fields are ignored. This lets
   * a caller (MAIN) control the precise section order without the assembler
   * baking in a fixed layout. Spaces keep using the legacy fields.
   */
  systemSections?: string[];
  persona: string;
  rules: string;
  spaceInstructions?: string;
  /** 人 — rendered impressions. The ONLY memory allowed in the stable block. */
  impressionsText?: string;

  // ── Block 2: semiStable (changes only on compaction) ──
  /** Bounded event window (rendered) + turns kept across compactions. */
  semiStable: M[];

  // ── Block 3: variable (changes every turn) ──
  /** Recent turns since the last compaction + matched recall (老 event ∪ experience). */
  variable: M[];
};

export type AssembledContext<M> = {
  systemPrompt: string;
  messages: M[];
  breakpoints: CacheBreakpoint[];
};
