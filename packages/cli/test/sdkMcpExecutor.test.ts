import { describe, expect, it } from 'vitest';
import type { McpToolCall } from '@zleap/agent';
import { SdkMcpToolExecutor } from '@zleap/agent/sdkMcpExecutor';

const tool = {
  id: 'server:list_items',
  serverId: 'server',
  name: 'list_items',
  version: 1,
  createdAt: new Date('2026-01-02T03:04:05.000Z'),
};

describe('SdkMcpToolExecutor', () => {
  it('requires command for stdio servers before connecting', async () => {
    const executor = new SdkMcpToolExecutor();
    const call: McpToolCall = {
      server: {
        id: 'local',
        name: 'Local',
        transport: 'stdio',
        config: {},
        status: 'active',
        createdAt: new Date('2026-01-02T03:04:05.000Z'),
        updatedAt: new Date('2026-01-02T03:04:05.000Z'),
      },
      tool,
      input: {},
    };

    await expect(executor.callTool(call, new AbortController().signal)).rejects.toThrow(/requires config.command/);
  });

  it('requires url for HTTP servers before connecting', async () => {
    const executor = new SdkMcpToolExecutor();
    const call: McpToolCall = {
      server: {
        id: 'remote',
        name: 'Remote',
        transport: 'http',
        config: {},
        status: 'active',
        createdAt: new Date('2026-01-02T03:04:05.000Z'),
        updatedAt: new Date('2026-01-02T03:04:05.000Z'),
      },
      tool,
      input: {},
    };

    await expect(executor.callTool(call, new AbortController().signal)).rejects.toThrow(/requires config.url/);
  });

  it('fails fast when aborted before connecting', async () => {
    const executor = new SdkMcpToolExecutor();
    const controller = new AbortController();
    controller.abort();

    await expect(executor.callTool({
      server: {
        id: 'remote',
        name: 'Remote',
        transport: 'http',
        config: { url: 'https://mcp.example.test' },
        status: 'active',
        createdAt: new Date('2026-01-02T03:04:05.000Z'),
        updatedAt: new Date('2026-01-02T03:04:05.000Z'),
      },
      tool,
      input: {},
    }, controller.signal)).rejects.toThrow(/aborted/);
  });
});
