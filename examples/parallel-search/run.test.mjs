import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { loadServer, run } from './run.mjs';

test('anonymous configuration reaches discovery, search and fetch through the runtime', async (t) => {
  const requests = [];
  const fixture = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const message = body ? JSON.parse(body) : undefined;
    requests.push({ url: req.url, headers: req.headers, message });
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    if (message.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    let result;
    if (message.method === 'initialize') {
      result = {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'parallel-fixture', version: '1.0.0' },
      };
    } else if (message.method === 'tools/list') {
      result = { tools: [
        { name: 'web_search', description: 'Search', inputSchema: {
          type: 'object', properties: { objective: { type: 'string' }, search_queries: { type: 'array', items: { type: 'string' } } },
          required: ['objective', 'search_queries'],
        } },
        { name: 'web_fetch', description: 'Fetch', inputSchema: {
          type: 'object', properties: { urls: { type: 'array', items: { type: 'string' } } }, required: ['urls'],
        } },
      ] };
    } else if (message.method === 'tools/call') {
      result = message.params.arguments.objective === 'fixture error'
        ? { isError: true, content: [{ type: 'text', text: 'Rate limit exceeded' }] }
        : { content: [{ type: 'text', text: message.params.name === 'web_search'
          ? 'Node.js releases: https://nodejs.org/en/about/previous-releases'
          : 'Node.js releases follow a predictable schedule.' }] };
    } else {
      res.writeHead(400).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => fixture.close(resolve)));
  const server = await loadServer();
  assert.equal(server.config.url, 'https://search.parallel.ai/mcp');
  assert.equal(server.transport, 'http');
  assert.deepEqual(server.secretRefs, []);
  server.config.url = `http://127.0.0.1:${fixture.address().port}/mcp`;

  const search = await run('search', ['Find Node.js releases', 'Node.js official release schedule'], server);
  assert.match(search.content[0].text, /https:\/\/nodejs.org/);
  const fetch = await run('fetch', ['https://nodejs.org/en/about/previous-releases'], server);
  assert.match(fetch.content[0].text, /predictable schedule/);
  await assert.rejects(run('search', ['fixture error', 'fixture error query'], server), /Rate limit exceeded/);

  for (const request of requests) {
    assert.equal(request.url, '/mcp');
    assert.equal(request.headers['user-agent'], 'Zleap-Agent/parallel-search-example');
    assert.equal(request.headers.authorization, undefined);
  }
  assert.equal(requests.filter((request) => request.message?.method === 'tools/list').length, 3);
  const calls = requests.filter((request) => request.message?.method === 'tools/call');
  assert.deepEqual(calls[0].message.params, {
    name: 'web_search', arguments: { objective: 'Find Node.js releases', search_queries: ['Node.js official release schedule'] },
  });
  assert.deepEqual(calls[1].message.params, {
    name: 'web_fetch', arguments: { urls: ['https://nodejs.org/en/about/previous-releases'] },
  });
});

test('invalid arguments fail before connecting', async () => {
  await assert.rejects(run('search', ['missing query']), /Usage:/);
  await assert.rejects(run('fetch', ['file:///etc/hosts']), /HTTP or HTTPS/);
  await assert.rejects(run('fetch', Array(21).fill('https://example.com')), /Usage:/);
});
