'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { applyBridgeToolCalls, parseBridgeToolCalls, selectBridgeTools } = require('../router');

const ROOT = path.resolve(__dirname, '..');
const TOKEN = 'test-token';
const API_KEY = 'test-provider-key';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
    server.on('error', reject);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload, headers) {
  const body = JSON.stringify(payload);
  res.writeHead(status, Object.assign({
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body)
  }, headers || {}));
  res.end(body);
}

async function startMockUpstream() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    requests.push({ path: req.url, body, authorization: req.headers.authorization });

    if (req.url === '/fail/chat/completions') {
      return sendJson(res, 500, { error: { message: 'mock failure' } });
    }
    if (req.url === '/fixed/chat/completions') {
      return sendJson(res, 200, {
        id: 'fixed-id',
        object: 'chat.completion',
        model: 'fixed-model',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'fixed-ok' },
          finish_reason: 'stop'
        }]
      });
    }
    if (req.url === '/tools/chat/completions') {
      return sendJson(res, 200, {
        id: 'tools-id',
        object: 'chat.completion',
        model: 'tools-model',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'tools-ok' },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }
      });
    }
    if (req.url === '/bridge/chat/completions') {
      return sendJson(res, 200, {
        id: 'bridge-id',
        object: 'chat.completion',
        model: 'bridge-model',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: '{"tool_calls":[{"name":"functions.lookup","arguments":{"query":"bridge"}}]}'
          },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 }
      });
    }
    if (req.url === '/stream/chat/completions') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({
        id: 'stream-id',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]
      }) + '\n\n');
      res.write('data: ' + JSON.stringify({
        id: 'stream-id',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: 'cloud' }, finish_reason: null }]
      }) + '\n\n');
      res.write('data: ' + JSON.stringify({
        id: 'stream-id',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
      }) + '\n\n');
      res.end('data: [DONE]\n\n');
      return;
    }
    sendJson(res, 404, { error: { message: 'not found' } });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    requests,
    url: 'http://127.0.0.1:' + server.address().port
  };
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseUrl + '/health');
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('router did not become healthy');
}

async function startRouter() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-relay-test-'));
  const tokenFile = path.join(temp, 'token');
  const keyFile = path.join(temp, 'provider.key');
  const configFile = path.join(temp, 'config.json');
  fs.writeFileSync(tokenFile, TOKEN + '\n', { mode: 0o600 });
  fs.writeFileSync(keyFile, API_KEY + '\n', { mode: 0o600 });

  const upstream = await startMockUpstream();
  const port = await freePort();
  const config = {
    port,
    host: '127.0.0.1',
    tokenFile,
    logFile: path.join(temp, 'relay.log'),
    timeouts: { firstEventMs: 3000 },
    circuit: { failThreshold: 3, openMs: 60000, maxOpenMs: 300000 },
    routes: {
      failover: { chain: ['fail', 'fixed'], toolPolicy: 'strict' },
      tools: { chain: ['fixed', 'tools'], toolPolicy: 'strict' },
      bridge: { chain: ['bridge'], toolPolicy: 'strict' },
      stream: { chain: ['fail', 'stream'], toolPolicy: 'strict' },
      auto: { chain: ['fixed'], toolPolicy: 'strict' },
      legacy: { alias: 'auto', hidden: true }
    },
    providers: [
      {
        id: 'fail',
        type: 'openai-compatible',
        endpoint: upstream.url + '/fail/chat/completions',
        apiKeyFile: keyFile,
        capabilities: { tools: true, stream: true, usage: true }
      },
      {
        id: 'fixed',
        type: 'openai-compatible',
        endpoint: upstream.url + '/fixed/chat/completions',
        apiKeyFile: keyFile,
        capabilities: { tools: false, stream: true, usage: false },
        maxTokens: 1024
      },
      {
        id: 'tools',
        type: 'openai-compatible',
        endpoint: upstream.url + '/tools/chat/completions',
        apiKeyFile: keyFile,
        capabilities: { tools: true, stream: true, usage: true }
      },
      {
        id: 'stream',
        type: 'openai-compatible',
        endpoint: upstream.url + '/stream/chat/completions',
        apiKeyFile: keyFile,
        capabilities: { tools: true, stream: true, usage: false }
      },
      {
        id: 'bridge',
        type: 'openai-compatible',
        endpoint: upstream.url + '/bridge/chat/completions',
        apiKeyFile: keyFile,
        capabilities: { tools: false, toolBridge: true, stream: true, usage: true }
      }
    ]
  };
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));

  const child = spawn(process.execPath, [path.join(ROOT, 'router.js')], {
    env: Object.assign({}, process.env, { AI_RELAY_CONFIG: configFile }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => {
    stderr += chunk.toString();
  });
  child.stdout.on('data', () => {});
  const baseUrl = 'http://127.0.0.1:' + port;
  try {
    await waitForHealth(baseUrl);
  } catch (error) {
    child.kill('SIGKILL');
    throw new Error(error.message + ': ' + stderr);
  }

  return {
    baseUrl,
    configFile,
    upstream,
    child,
    async close() {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
      await new Promise(resolve => upstream.server.close(resolve));
      fs.rmSync(temp, { recursive: true, force: true });
    }
  };
}

async function chat(instance, body, route = '/v1/chat/completions') {
  return fetch(instance.baseUrl + route, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + TOKEN,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
}

async function assertStatus(response, expected) {
  if (response.status === expected) return;
  const body = await response.clone().text();
  assert.equal(response.status, expected, body);
}

test('router fails over, preserves usage, and routes tools safely', async t => {
  const instance = await startRouter();
  t.after(() => instance.close());

  const unauthorized = await fetch(instance.baseUrl + '/v1/models');
  assert.equal(unauthorized.status, 401);

  const models = await fetch(instance.baseUrl + '/v1/models', {
    headers: { authorization: 'Bearer ' + TOKEN }
  });
  assert.equal(models.status, 200);
  const modelData = await models.json();
  assert.deepEqual(modelData.data.map(model => model.id).sort(), ['auto', 'bridge', 'failover', 'stream', 'tools']);

  const failover = await chat(instance, {
    model: 'failover',
    messages: [{ role: 'user', content: 'hello' }]
  });
  await assertStatus(failover, 200);
  assert.equal(failover.headers.get('x-relay-upstream'), 'fixed');
  assert.equal(failover.headers.get('x-relay-attempts'), '2');
  const failoverBody = await failover.json();
  assert.equal(failoverBody.choices[0].message.content, 'fixed-ok');
  assert.ok(failoverBody.usage.prompt_tokens > 0);
  assert.equal(failoverBody.usage.estimated, true);

  const tools = await chat(instance, {
    model: 'tools',
    tools: [{
      type: 'function',
      function: {
        name: 'lookup',
        description: 'Lookup',
        parameters: { type: 'object', properties: {} }
      }
    }],
    messages: [{ role: 'user', content: 'use a tool' }]
  });
  await assertStatus(tools, 200);
  assert.equal(tools.headers.get('x-relay-upstream'), 'tools');
  const toolsBody = await tools.json();
  assert.equal(toolsBody.usage.total_tokens, 6);

  const fixedCall = instance.upstream.requests.filter(request => request.path.startsWith('/fixed/'));
  assert.ok(fixedCall.every(request => request.authorization === 'Bearer ' + API_KEY));
  const toolsCall = instance.upstream.requests.find(request => request.path === '/tools/chat/completions');
  assert.ok(Array.isArray(toolsCall.body.tools));

  const bridge = await chat(instance, {
    model: 'bridge',
    stream: true,
    messages: [{ role: 'user', content: 'use the bridge' }],
    tools: [{
      type: 'function',
      function: {
        name: 'lookup',
        description: 'Lookup',
        parameters: { type: 'object', properties: {} }
      }
    }]
  });
  await assertStatus(bridge, 200);
  const bridgeText = await bridge.text();
  assert.match(bridgeText, /"tool_calls"/);
  assert.match(bridgeText, /"name":"lookup"/);
  assert.match(bridgeText, /"finish_reason":"tool_calls"/);
  const bridgeCall = instance.upstream.requests.find(request => request.path === '/bridge/chat/completions');
  assert.equal(bridgeCall.body.tools, undefined);
  assert.match(bridgeCall.body.messages[0].content, /\[Tool bridge protocol\]/);
});

test('streaming waits for a usable upstream and injects usage', async t => {
  const instance = await startRouter();
  t.after(() => instance.close());

  const response = await chat(instance, {
    model: 'stream',
    stream: true,
    messages: [{ role: 'user', content: 'stream please' }]
  });
  await assertStatus(response, 200);
  assert.equal(response.headers.get('x-relay-upstream'), 'stream');
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const text = await response.text();
  assert.match(text, /"content":"cloud"/);
  assert.match(text, /"usage":\{/);
  assert.match(text, /data: \[DONE\]/);
});

test('anthropic requests are translated to the OpenAI provider contract', async t => {
  const instance = await startRouter();
  t.after(() => instance.close());

  const response = await chat(instance, {
    model: 'auto',
    max_tokens: 128,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
  }, '/v1/messages');
  await assertStatus(response, 200);
  const payload = await response.json();
  assert.equal(payload.type, 'message');
  assert.equal(payload.content[0].type, 'text');
  assert.equal(payload.content[0].text, 'fixed-ok');
  assert.equal(payload.relay.upstream, 'fixed');
});

test('text tool bridge validates and normalizes web-model tool calls', () => {
  const tools = [{
    type: 'function',
    function: {
      name: 'lookup',
      parameters: { type: 'object', properties: {} }
    }
  }];

  const calls = parseBridgeToolCalls(
    '```json\n{"tool_calls":[{"name":"lookup","arguments":{"query":"OpenClaw"}}]}\n```',
    tools
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'function');
  assert.equal(calls[0].function.name, 'lookup');
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { query: 'OpenClaw' });

  const rejected = parseBridgeToolCalls(
    '{"tool_calls":[{"name":"not_allowed","arguments":{}}]}',
    tools
  );
  assert.deepEqual(rejected, []);

  const raw = {
    choices: [{
      message: {
        role: 'assistant',
        content: '{"tool_calls":[{"name":"lookup","arguments":{"query":"bridge"}}]}'
      },
      finish_reason: 'stop'
    }]
  };
  applyBridgeToolCalls(raw, tools);
  assert.equal(raw.choices[0].message.content, '');
  assert.equal(raw.choices[0].message.tool_calls[0].function.name, 'lookup');
  assert.equal(raw.choices[0].finish_reason, 'tool_calls');

  const manyTools = Array.from({ length: 30 }, (_, index) => ({
    type: 'function',
    function: {
      name: index === 17 ? 'exec' : 'tool_' + index,
      description: 'Generic tool',
      parameters: { type: 'object', properties: {} }
    }
  }));
  const selected = selectBridgeTools({
    messages: [{ role: 'user', content: '请调用 exec 运行命令' }]
  }, manyTools);
  assert.deepEqual(selected.map(tool => tool.function.name), ['exec']);
});
