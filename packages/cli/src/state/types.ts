import type { CustomModelConfig } from '@zleap/ai';
import type { SessionListItem } from '../cli/sessions.js';
import type { SelectableModel } from '../cli/models.js';

export type DisplayRole =
  | 'user'
  | 'assistant'
  | 'system'
  | 'error'
  | 'tool'
  | 'space'
  | 'space_result'
  | 'space_message'
  | 'space_status';

export type SystemTone = 'notify' | 'error';

export type ToolStatus = 'running' | 'done' | 'error';

export type ToolCallView = {
  name: string;
  args: string;
  result: string;
  status: ToolStatus;
};

export type SpaceView = {
  id: string;
  label: string;
  goal?: string;
};

export type SpaceResultView = {
  id: string;
  status: 'success' | 'failed';
  summary: string;
};

export type DisplayMessage = {
  id: number;
  role: DisplayRole;
  text?: string;
  tool?: ToolCallView;
  space?: SpaceView;
  result?: SpaceResultView;
  /** Render tool/space lines indented under an active workspace block. */
  nested?: boolean;
  tone?: SystemTone;
};

export type ContextUsage = {
  extractedCount: number;
  itemHistoryActive: boolean;
  triggerMessages: number;
  triggerTokens: number;
  refreshThreshold: number;
  /** Token window fill ratio from the latest context snapshot (0–1). */
  windowRatio?: number;
  usedTokens?: number;
  contextWindow?: number;
  snapshotMessageCount?: number;
};

export type ToolApprovalRequest = {
  approvalId: string;
  name: string;
  args: string;
  preview?: string;
};

export type RunStatus = 'idle' | 'running';

export type ModelWizard =
  | { step: 'protocol'; draft: Partial<CustomModelConfig> }
  | { step: 'baseUrl'; draft: Partial<CustomModelConfig> }
  | { step: 'apiKey'; draft: Partial<CustomModelConfig> }
  | { step: 'model'; draft: Partial<CustomModelConfig> };

export type SessionPicker = {
  items: SessionListItem[];
};

export type ModelPicker = {
  items: SelectableModel[];
};
