import { afterEach, describe, expect, it } from 'vitest';
import { createMcpRuntimeTool, mcpRuntimeToolId, notConfiguredMcpExecutor, resetSideEffectStateForTests, type McpToolCall } from '@zleap/agent';

const server = {
  id: 'linear',
  name: 'Linear',
  transport: 'http' as const,
  config: { url: 'https://mcp.example.test/linear' },
  secretRefs: [{ provider: 'env' as const, key: 'LINEAR_MCP_TOKEN' }],
  status: 'active' as const,
  createdAt: new Date('2026-01-02T03:04:05.000Z'),
  updatedAt: new Date('2026-01-02T03:04:05.000Z'),
};

const tool = {
  id: 'linear:list_issues',
  serverId: 'linear',
  name: 'list_issues',
  version: 1,
  label: 'List issues',
  description: 'List Linear issues.',
  inputSchema: { type: 'object', properties: { team: { type: 'string' } } },
  createdAt: new Date('2026-01-02T03:04:05.000Z'),
};

describe('MCP runtime tools', () => {
  afterEach(() => {
    resetSideEffectStateForTests();
  });

  it('projects a persisted MCP tool snapshot into a runtime ToolDefinition', async () => {
    let received: McpToolCall | undefined;
    const runtimeTool = createMcpRuntimeTool(server, tool, {
      callTool: async (call) => {
        received = call;
        return { issues: [{ id: 'LIN-1' }] };
      },
    });

    expect(runtimeTool).toMatchObject({
      id: 'mcp__linear__list_issues__v1',
      description: 'List Linear issues.',
      promptSnippet: 'Use external MCP tool "List issues" from "Linear" when this workspace needs that connected service.',
      promptGuidelines: [
        'MCP tools may touch external services; keep inputs specific and expect approval in request-approval mode.',
        'Do not claim an MCP connection, external action, or external result exists unless this tool actually returns it.',
      ],
      parameters: tool.inputSchema,
    });
    const result = await runtimeTool.handler({ team: 'core' }, {
      runId: 'run_1',
      workId: 'work_1',
      stepId: 'step_1',
      workspaceId: 'terminal',
    }, new AbortController().signal);

    expect(result).toEqual({ issues: [{ id: 'LIN-1' }] });
    expect(received).toEqual({
      server,
      tool,
      input: { team: 'core' },
    });
  });

  it('fails clearly when no MCP connector is configured', async () => {
    const runtimeTool = createMcpRuntimeTool(server, tool, notConfiguredMcpExecutor);

    await expect(runtimeTool.handler({}, {
      runId: 'run_1',
      workId: 'work_1',
      stepId: 'step_1',
      workspaceId: 'terminal',
    }, new AbortController().signal)).rejects.toThrow(/MCP runtime connector is not configured/);
  });

  it('sanitizes runtime tool ids for provider tool schemas', () => {
    expect(mcpRuntimeToolId({ serverId: 'linear/server', name: 'list:issues', version: 12 })).toBe('mcp__linear_server__list_issues__v12');
  });

  it('queues and de-duplicates identical MCP side-effect calls', async () => {
    let calls = 0;
    const runtimeTool = createMcpRuntimeTool(server, tool, {
      callTool: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { ok: true, calls };
      },
    });
    const context = {
      runId: 'run_1',
      workId: 'work_1',
      stepId: 'step_1',
      workspaceId: 'terminal',
    };

    const [first, second] = await Promise.all([
      runtimeTool.handler({ team: 'core' }, context, new AbortController().signal),
      runtimeTool.handler({ team: 'core' }, context, new AbortController().signal),
    ]);

    expect(calls).toBe(1);
    expect(first).toEqual({ ok: true, calls: 1 });
    expect(second).toEqual(first);
  });
});
