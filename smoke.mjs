#!/usr/bin/env node
'use strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const baseUrl = (process.env.RELAY_URL || '').replace(/\/+$/, '');
if (!baseUrl) {
  console.error('请先设置 RELAY_URL，例如：RELAY_URL=http://relay.example.com:8080 ./smoke.mjs');
  process.exit(2);
}
const tokenFile = process.env.RELAY_TOKEN_FILE || path.join(os.homedir(), '.ai-relay-token');
const token = fs.readFileSync(tokenFile, 'utf8').trim();
const model = process.env.RELAY_TEST_MODEL || 'auto';
const prompt = process.env.RELAY_TEST_PROMPT || 'Reply with exactly: relay-ok';
const toolTest = process.argv.includes('--tools');
const nonStream = process.argv.includes('--non-stream');

if (!token) throw new Error('relay token is empty');

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    throw new Error(response.status + ' ' + JSON.stringify(payload).slice(0, 1000));
  }
  return { response, payload };
}

const headers = {
  authorization: 'Bearer ' + token,
  'content-type': 'application/json'
};

const health = await requestJson(baseUrl + '/health');
const models = await requestJson(baseUrl + '/v1/models', { headers });
const modelIds = Array.isArray(models.payload.data)
  ? models.payload.data.map(modelInfo => modelInfo.id)
  : [];
if (!modelIds.includes(model)) {
  throw new Error('configured test model is not advertised: ' + model);
}

const request = {
  model,
  messages: [{ role: 'user', content: prompt }],
  stream: !nonStream,
  max_tokens: 512
};
if (toolTest) {
  delete request.max_tokens;
  request.tools = [{
    type: 'function',
    function: {
      name: 'relay_probe',
      description: 'Return a probe value.',
      parameters: {
        type: 'object',
        properties: {
          value: { type: 'string' }
        },
        required: ['value']
      }
    }
  }];
}

const started = Date.now();
let upstream = null;
let attempts = null;
let text = '';
let usage = null;
let toolCalls = [];

if (nonStream) {
  const result = await requestJson(baseUrl + '/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify(request)
  });
  upstream = result.response.headers.get('x-relay-upstream');
  attempts = result.response.headers.get('x-relay-attempts');
  text = String(result.payload.choices?.[0]?.message?.content || '');
  toolCalls = result.payload.choices?.[0]?.message?.tool_calls || [];
  usage = result.payload.usage || null;
} else {
  const response = await fetch(baseUrl + '/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify(request)
  });
  if (!response.ok) {
    throw new Error(response.status + ' ' + (await response.text()).slice(0, 1000));
  }
  upstream = response.headers.get('x-relay-upstream');
  attempts = response.headers.get('x-relay-attempts');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of event.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let chunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk.error) throw new Error(JSON.stringify(chunk.error));
        if (chunk.usage) usage = chunk.usage;
        const delta = chunk.choices?.[0]?.delta;
        if (delta?.content) text += delta.content;
        if (delta?.tool_calls) toolCalls.push(...delta.tool_calls);
      }
    }
  }
}

if (!text.trim() && !toolCalls.length) throw new Error('upstream returned neither text nor a tool call');
if (!usage || !Number.isFinite(Number(usage.prompt_tokens))) {
  throw new Error('upstream answer did not include normalized usage');
}

process.stdout.write(JSON.stringify({
  ok: true,
  base_url: baseUrl,
  model,
  upstream,
  attempts,
  elapsed_ms: Date.now() - started,
  usage,
  preview: text.slice(0, 160),
  tool_calls: toolCalls.map(call => call.function && call.function.name || call.name || 'unknown')
}, null, 2) + '\n');
