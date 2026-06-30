import type { AssembledContext, AssemblyInput, CacheBreakpoint } from './types.js';

/**
 * The single context-assembly entry (docs/memory.md §4). A PURE ordering
 * function: it orders the three blocks and declares cache breakpoints — it does
 * NOT fetch memory or generate content (the surface prepares the inputs).
 *
 * Block layout:
 *   stable     → systemPrompt = persona + rules + space + impressions(人)
 *   semiStable → bounded event window + kept turns
 *   variable   → recent turns + matched recall(老 event ∪ experience)
 *
 * The stable block has no slot for event/experience text, so the invariant
 * "memory that changes never lands in the cached prefix" is structural.
 */
export function assembleContext<M>(input: AssemblyInput<M>): AssembledContext<M> {
  const systemParts = input.systemSections ?? [input.persona, input.rules, input.spaceInstructions, input.impressionsText];
  const systemPrompt = systemParts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join('\n\n');

  const messages = [...input.semiStable, ...input.variable];
  const breakpoints: CacheBreakpoint[] = [
    { after: 'stable', messageIndex: 0 },
    { after: 'semiStable', messageIndex: input.semiStable.length },
  ];

  return { systemPrompt, messages, breakpoints };
}

/** Class wrapper for DI / mocking parity with the rest of the agent runtime. */
export class ContextAssemblyPipeline {
  assemble<M>(input: AssemblyInput<M>): AssembledContext<M> {
    return assembleContext(input);
  }
}
