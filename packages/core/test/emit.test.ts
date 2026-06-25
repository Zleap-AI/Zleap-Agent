import { describe, expect, it } from 'vitest';
import { AgentRuntime, type AgentError, type AgentEvent } from '../src/index.js';

describe('workspace streaming + tool scope', () => {
  it('streams workspace_delta events and blocks out-of-scope tools', async () => {
    const runtime = new AgentRuntime();
    const deltas: AgentEvent[] = [];
    runtime.observe((event) => {
      if (event.type === 'workspace_delta') {
        deltas.push(event);
      }
    });

    runtime.registerTool({ id: 'danger', handler: async () => 'ran' });

    let toolError: AgentError | undefined;
    runtime.registerWorkspace({
      id: 'w',
      label: 'W',
      handler: async (context) => {
        context.emit({ kind: 'text', text: 'hi' });
        try {
          // 'danger' exists but is not in this work's toolIds → must be rejected.
          await context.callTool('danger', {});
        } catch (error) {
          toolError = error as AgentError;
        }
        return { title: 'T', summary: 'done' };
      },
    });

    const run = await runtime.run({ spaces: ['w'], goal: 'g', toolIds: [] });

    expect(run.status).toBe('completed');
    expect(toolError?.code).toBe('tool_not_allowed');
    const texts = deltas
      .filter((e) => e.type === 'workspace_delta')
      .map((e) => (e.type === 'workspace_delta' ? e.delta : undefined));
    expect(texts).toContainEqual({ kind: 'text', text: 'hi' });
  });
});
