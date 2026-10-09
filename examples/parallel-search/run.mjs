import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { discoverMcpTools, SdkMcpToolExecutor } from '../../packages/agent/dist/sdkMcpExecutor.js';
import { createMcpRuntimeTool } from '../../packages/agent/dist/mcpRuntime.js';

export async function loadServer() {
  const config = JSON.parse(await readFile(new URL('./server.json', import.meta.url), 'utf8'));
  return { ...config, createdAt: new Date(), updatedAt: new Date() };
}

/** Execute a discovered tool through Zleap's runtime adapter, without a model or database. */
export async function run(command, values, server = undefined) {
  let name;
  let input;
  if (command === 'search' && values.length === 2 && values.every((value) => value.trim())) {
    name = 'web_search';
    input = { objective: values[0], search_queries: [values[1]] };
  } else if (command === 'fetch' && values.length > 0 && values.length <= 20) {
    for (const value of values) {
      if (!['http:', 'https:'].includes(new URL(value).protocol)) {
        throw new Error('Fetch URLs must use HTTP or HTTPS.');
      }
    }
    name = 'web_fetch';
    input = { urls: values };
  } else {
    throw new Error('Usage: node examples/parallel-search/run.mjs search "objective" "keyword query" | fetch <url> [url...]');
  }

  server ??= await loadServer();
  const tools = await discoverMcpTools(server, { timeoutMs: 15_000 });
  const discovered = tools.find((tool) => tool.name === name);
  if (!discovered) throw new Error(`Server did not advertise ${name}.`);
  const tool = {
    ...discovered,
    id: `${server.id}:${name}`,
    serverId: server.id,
    version: 1,
    createdAt: new Date(),
  };
  const runtimeTool = createMcpRuntimeTool(server, tool, new SdkMcpToolExecutor());
  const result = await runtimeTool.handler(input, {
    runId: 'parallel-search-example',
    workId: 'parallel-search-example',
    stepId: name,
    workspaceId: 'parallel-search-example',
  }, AbortSignal.timeout(60_000));
  if (result?.isError) {
    throw new Error(`Parallel returned a tool error: ${JSON.stringify(result.content)}`);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await run(process.argv[2], process.argv.slice(3));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
