#!/usr/bin/env node
/* ai-relay 客户端（Mac 侧）
 * 用法：
 *   node relay.mjs --prompt "只回答两个字：收到"
 *   node relay.mjs --prompt "..." --model smart --stream
 *   node relay.mjs --models
 * token 从 ~/.ai-relay-token 读（0600），不写进命令行，可用 RELAY_TOKEN_FILE 覆盖。
 * 端点必须通过 RELAY_URL 指定（例如 http://relay.example.com:8080）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = (process.env.RELAY_URL || '').replace(/\/$/, '');
if (!BASE) {
  console.error('请先设置 RELAY_URL，例如：export RELAY_URL=http://relay.example.com:8080');
  process.exit(2);
}
const tokenFile = process.env.RELAY_TOKEN_FILE || path.join(os.homedir(), '.ai-relay-token');
const TOKEN = fs.readFileSync(tokenFile, 'utf8').trim();

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : def;
}
const prompt = arg('prompt');
const model = arg('model', 'auto');
const stream = args.includes('--stream');

if (args.includes('--models')) {
  const r = await fetch(BASE + '/v1/models', { headers: { authorization: 'Bearer ' + TOKEN } });
  console.log(JSON.stringify(await r.json(), null, 1));
  process.exit(0);
}
if (!prompt) {
  console.error('用法: node relay.mjs --prompt "..." [--model auto] [--stream] [--models]');
  process.exit(2);
}

const t0 = Date.now();
const res = await fetch(BASE + '/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
  body: JSON.stringify({ model, stream, messages: [{ role: 'user', content: prompt }] })
});
if (!res.ok) {
  console.error('HTTP', res.status, (await res.text()).slice(0, 500));
  process.exit(1);
}
if (stream) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 2);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try { const j = JSON.parse(payload); const d = j.choices?.[0]?.delta?.content; if (d) process.stdout.write(d); } catch {}
    }
  }
  process.stdout.write(`\n[${Date.now() - t0}ms]\n`);
} else {
  const j = await res.json();
  console.log(j.choices?.[0]?.message?.content ?? JSON.stringify(j));
  console.error(`[upstream=${j.relay?.upstream} model=${j.relay?.upstream_model} ${Date.now() - t0}ms]`);
}
