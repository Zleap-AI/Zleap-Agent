import { describe, expect, it } from 'vitest';
import type { DisplayMessage } from '../src/state/types.js';
import {
  buildReplyRuntimeOptions,
  buildProviderHistory,
  restoredContextMessagesToProviderHistory,
  type RestoredContextMessage,
} from '../src/hooks/useChat.js';
import type { ToolConfirm } from '../src/engine.js';

describe('useChat provider history helpers', () => {
  it('uses durable resume context as hidden provider history without replaying visible transcript twice', () => {
    const restoredTranscript: DisplayMessage[] = [
      { id: 1, role: 'user', text: 'old visible user' },
      { id: 2, role: 'assistant', text: 'old visible assistant' },
    ];
    const restoredContext: RestoredContextMessage[] = [
      { role: 'system', text: '[Summary of earlier conversation]\nolder durable context' },
      {
        role: 'system',
        text: '<Pending-Workspaces>\n- space="terminal" status="suspended" workspaceStatus="needs_user_input"\n</Pending-Workspaces>',
      },
      { role: 'user', text: 'recent durable user' },
      { role: 'assistant', text: 'recent durable assistant' },
    ];
    const base = {
      messages: restoredContextMessagesToProviderHistory(restoredContext),
      baselineUserAssistantCount: 2,
    };

    const history = buildProviderHistory([
      ...restoredTranscript,
      { id: 3, role: 'system', text: 'Restored 2 message(s) from the durable store.' },
      { id: 4, role: 'user', text: 'new user turn' },
      { id: 5, role: 'assistant', text: 'new assistant turn' },
    ], base);

    expect(history).toEqual([
      { role: 'user', content: 'recent durable user' },
      { role: 'assistant', content: [{ type: 'text', text: 'recent durable assistant' }] },
      { role: 'user', content: 'new user turn' },
      { role: 'assistant', content: [{ type: 'text', text: 'new assistant turn' }] },
    ]);
    expect(JSON.stringify(history)).not.toContain('old visible user');
    expect(JSON.stringify(history)).not.toContain('Restored 2 message');
    expect(JSON.stringify(history)).not.toContain('Pending-Workspaces');
    expect(JSON.stringify(history)).not.toContain('[Durable session context]');
  });

  it('threads a restored workspaceRoot into reply runtime options', () => {
    const confirm: ToolConfirm = async () => true;

    expect(buildReplyRuntimeOptions(confirm, { workspaceRoot: ' /tmp/zleap-workspaces/conversation-1 ' })).toEqual({
      confirm,
      workspaceRoot: '/tmp/zleap-workspaces/conversation-1',
    });
    expect(buildReplyRuntimeOptions(confirm, { workspaceRoot: '   ' })).toEqual({ confirm });
    expect(buildReplyRuntimeOptions(confirm)).toEqual({ confirm });
  });
});
