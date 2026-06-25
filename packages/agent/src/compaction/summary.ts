import type { Message, Model } from '@zleap/ai';

export type WorkspaceSummaryPolicy = {
  triggerRatio: number;
  tailRatio: number;
  fallbackContextWindow: number;
  maxAttempts: number;
};

export type WorkspaceCompactionThresholds = {
  contextWindow: number;
  triggerTokens: number;
  tailTokens: number;
  triggerRatio: number;
  tailRatio: number;
  maxAttempts: number;
};

export type WorkspaceSummaryPromptInput = {
  spaceId: string;
  previousSummaryXml?: string;
  foldedMessages: Message[];
  foldedEntryRefs: Array<{ id: string; role?: string; createdAt?: string }>;
};

export const DEFAULT_WORKSPACE_SUMMARY_POLICY: WorkspaceSummaryPolicy = {
  triggerRatio: 0.5,
  tailRatio: 0.1,
  fallbackContextWindow: 32_000,
  maxAttempts: 3,
};

export function workspaceCompactionThresholds(
  model: Pick<Model, 'contextWindow'>,
  policy: WorkspaceSummaryPolicy = DEFAULT_WORKSPACE_SUMMARY_POLICY,
): WorkspaceCompactionThresholds {
  const contextWindow = model.contextWindow && model.contextWindow > 0 ? model.contextWindow : policy.fallbackContextWindow;
  return {
    contextWindow,
    triggerTokens: Math.ceil(contextWindow * policy.triggerRatio),
    tailTokens: Math.ceil(contextWindow * policy.tailRatio),
    triggerRatio: policy.triggerRatio,
    tailRatio: policy.tailRatio,
    maxAttempts: policy.maxAttempts,
  };
}

export function prependWorkspaceSummaryToUserMessage(content: string, summaryXml: string | undefined, spaceId: string): string {
  const summary = summaryXml?.trim();
  if (!summary) {
    return content;
  }
  validateWorkspaceSummaryXml(summary, spaceId);
  return [summary, '<current_user_message>', content, '</current_user_message>'].join('\n');
}

export function validateWorkspaceSummaryXml(xml: string, spaceId: string): void {
  const expectedStart = `<workspace_summary space="${escapeXmlAttribute(spaceId)}"`;
  if (!xml.startsWith(expectedStart) || !xml.endsWith('</workspace_summary>')) {
    throw new Error(`workspace summary must be wrapped in <workspace_summary space="${spaceId}">`);
  }
}

export function buildWorkspaceSummaryMessages(input: WorkspaceSummaryPromptInput): Message[] {
  const folded = input.foldedMessages.map((message, index) => {
    return [
      `    <message index="${index}" role="${escapeXmlAttribute(message.role)}">`,
      escapeXmlText(messageToSummaryText(message)),
      '    </message>',
    ].join('\n');
  }).join('\n');
  const refs = input.foldedEntryRefs.map((ref) => {
    const fields = [
      `id="${escapeXmlAttribute(ref.id)}"`,
      ref.role ? `role="${escapeXmlAttribute(ref.role)}"` : undefined,
      ref.createdAt ? `createdAt="${escapeXmlAttribute(ref.createdAt)}"` : undefined,
    ].filter(Boolean).join(' ');
    return `    <entry ${fields} />`;
  }).join('\n');
  return [
    {
      role: 'user',
      content: [
        '<summary_task>',
        '  <instruction>Update the previous workspace summary using the folded messages. Return exactly one XML block and no prose.</instruction>',
        '  <rules>',
        '    <rule>Preserve decisions, constraints, user preferences, progress, errors, artifacts, and open work.</rule>',
        '    <rule>Do not invent facts. If something is uncertain, say it is uncertain.</rule>',
        '    <rule>Keep recovery ids under recoverable_history so future turns can call readMessage for exact details.</rule>',
        '    <rule>Do not store secrets, access tokens, or API keys.</rule>',
        '  </rules>',
        `  <required_output><workspace_summary space="${escapeXmlAttribute(input.spaceId)}"><context/><decisions/><progress/><open_items/><artifacts/><recoverable_history/></workspace_summary></required_output>`,
        '  <previous_workspace_summary>',
        input.previousSummaryXml?.trim() || '    <none />',
        '  </previous_workspace_summary>',
        '  <folded_messages>',
        folded,
        '  </folded_messages>',
        '  <recoverable_history>',
        refs,
        '  </recoverable_history>',
        '</summary_task>',
      ].join('\n'),
    },
  ];
}

export function messageToSummaryText(message: Message): string {
  if (typeof message.content === 'string') {
    return message.content;
  }
  return message.content.map((part) => {
    if (part.type === 'text' || part.type === 'thinking') {
      return part.text;
    }
    if (part.type === 'toolCall') {
      return `toolCall:${part.name} ${JSON.stringify(part.arguments)}`;
    }
    return `image:${part.mimeType}`;
  }).join('\n');
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/g, '&quot;');
}
