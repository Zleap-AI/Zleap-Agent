/** Shared types for the composer module, extracted so leaf components don't have
 *  to import from the large Composer.tsx (and create import cycles). */
import type { ReactNode } from 'react';
import type { ComposerCommandSearchInput } from '@/lib/composerCommands';

export type GoalComposerState = { text: string; status: 'active' | 'paused'; startedAt: number };

export type AgentOption = { id: string; name: string; metadata?: Record<string, unknown> };
export type ProjectOption = { id: string; name: string; emoji?: string; accent?: string };
export type CreatedProject = { id: string; name: string };

export type MentionItem = { kind: 'agent'; id: string; name: string; agent: AgentOption };

export type ComposerCommand = ComposerCommandSearchInput & {
  icon: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  trailing?: string;
  run: () => void;
};

export type ChipOption = {
  id: string;
  name: string;
  agent?: AgentOption;
  project?: ProjectOption;
};
