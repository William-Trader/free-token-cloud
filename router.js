'use strict';

/*
 * ai-relay router
 *
 * A zero-dependency, OpenAI-compatible relay with:
 * - ordered multi-provider failover
 * - tool-capability aware routing
 * - retry/cooldown circuit breakers
 * - key rotation
 * - stream preflight before the client receives bytes
 * - normalized usage for OpenClaw
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tls = require('tls');
const { StringDecoder } = require('string_decoder');

const DASHBOARD_FILE = path.join(__dirname, 'dashboard.html');
const PROVIDER_SETUP_FILE = path.join(__dirname, 'provider-setup.html');
let dashboardHtml = null;
let providerSetupHtml = null;

function dashboardPage() {
  if (dashboardHtml == null) {
    try {
      dashboardHtml = fs.readFileSync(DASHBOARD_FILE, 'utf8');
    } catch {
      dashboardHtml = '<!doctype html><meta charset="utf-8"><title>Relay Console</title><h1>Relay Console</h1><p>dashboard.html 未上传。</p>';
    }
  }
  return dashboardHtml;
}

function providerSetupPage() {
  if (providerSetupHtml == null) {
    try {
      providerSetupHtml = fs.readFileSync(PROVIDER_SETUP_FILE, 'utf8');
    } catch {
      providerSetupHtml = '<!doctype html><meta charset="utf-8"><title>Provider Setup</title><h1>Provider Setup</h1><p>provider-setup.html 未上传。</p>';
    }
  }
  return providerSetupHtml;
}

const ROOT = __dirname;
const DEFAULT_CONFIG = process.env.AI_RELAY_CONFIG || path.join(ROOT, 'config.json');
const STARTED_AT = Date.now();
const MAX_LOGS = 500;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_STREAM_PREFIX = 4 * 1024 * 1024;
const logs = [];
const metrics = {
  requests: 0,
  successes: 0,
  failures: 0,
  streams: 0,
  estimatedUsage: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  cachedTokens: 0,
  reasoningTokens: 0,
  cacheHits: 0,
  usageEvents: 0
};
let usageHistory = {};
let usageHourly = {};

const usagePersistence = {
  timer: null,
  updatedAt: null,
  loadedAt: null,
  startedAt: new Date(STARTED_AT).toISOString()
};

let CFG = null;
let TOKEN = '';
let providers = [];
let providerById = new Map();
let routes = {};
let stateById = new Map();
let groupStates = new Map();
let credentialValues = new Map();
let providerCatalog = [];
let providerSettings = new Map();

let modelsCache = { at: 0, data: null };

const CHAT_FIELDS = [
  'temperature',
  'top_p',
  'max_tokens',
  'max_completion_tokens',
  'stop',
  'seed',
  'presence_penalty',
  'frequency_penalty',
  'logit_bias',
  'response_format',
  'n',
  'user',
  'service_tier'
];

function nowIso() {
  return new Date().toISOString();
}

function log(event) {
  const record = Object.assign({ ts: nowIso() }, event);
  try {
    if (record.model && (record.ev === 'ok' || record.ev === 'fail' || record.ev === 'relay_error')) {
      const now = new Date();
      const day = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
      const hour = now.toLocaleTimeString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' });
      const key = day + 'T' + hour;
      const bucket = usageHourly[key] || (usageHourly[key] = { tools: 0, chat: 0, fail: 0, tokens: 0 });
      if (record.ev !== 'ok') bucket.fail += 1;
      else if (record.model === 'tools') bucket.tools += 1;
      else bucket.chat += 1;
      bucket.tokens += Number(record.tokens || 0);
      const keys = Object.keys(usageHourly).sort();
      while (keys.length > 72) { delete usageHourly[keys.shift()]; }
    }
  } catch {}
  logs.push(record);
  if (logs.length > MAX_LOGS) logs.shift();
  try {
    if (CFG && CFG.logFile) fs.appendFileSync(CFG.logFile, JSON.stringify(record) + '\n');
  } catch {}
  console.log(JSON.stringify(record));
}

function readTextFile(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonIfExists(file, fallback) {
  try {
    return readJsonFile(file);
  } catch {
    return fallback;
  }
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

let providerScores = null;
let scoreLastRun = null;
let scoreSaveTimer = null;

function scoresFile() {
  return CFG && CFG.scoresFile ? CFG.scoresFile : null;
}

function ensureScores() {
  if (providerScores) return providerScores;
  providerScores = {};
  const file = scoresFile();
  if (file) {
    const saved = readJsonIfExists(file, null);
    if (saved && typeof saved === 'object') {
      providerScores = saved.scores || {};
      scoreLastRun = saved.lastRun || null;
    }
  }
  return providerScores;
}

function saveScores() {
  const file = scoresFile();
  if (!file) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temp, JSON.stringify({ version: 1, lastRun: scoreLastRun, scores: ensureScores() }, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temp, file);
    return true;
  } catch (error) {
    log({ ev: 'score_persist_failed', error: String(error.message || error) });
    return false;
  }
}

function scheduleScoreSave() {
  if (scoreSaveTimer) return;
  scoreSaveTimer = setTimeout(() => { scoreSaveTimer = null; saveScores(); }, 5000);
  scoreSaveTimer.unref();
}

function scoreInstant(ok, latencyMs) {
  if (!ok) return 5;
  return Math.max(20, Math.min(100, 100 - Number(latencyMs || 0) / 50));
}

function bumpScore(id, ok, latencyMs) {
  const scores = ensureScores();
  const previous = scores[id] && Number(scores[id].score);
  const instant = scoreInstant(ok, latencyMs);
  const score = previous == null ? Math.round(instant) : Math.round(previous * 0.6 + instant * 0.4);
  scores[id] = {
    score,
    latencyMs: Number(latencyMs || 0),
    ok: Boolean(ok),
    checkedAt: nowIso()
  };
  scheduleScoreSave();
}

function scoreFor(id) {
  const item = ensureScores()[id];
  return item && Number.isFinite(item.score) ? item.score : 50;
}

function loadUsageState() {
  if (!CFG || !CFG.usageStateFile) return null;
  const saved = readJsonIfExists(CFG.usageStateFile, null);
  if (!saved || typeof saved !== 'object') return null;

  for (const key of Object.keys(metrics)) {
    if (saved.metrics && saved.metrics[key] !== undefined) {
      metrics[key] = finiteNumber(saved.metrics[key]);
    }
  }

  for (const [id, providerState] of Object.entries(saved.providers || {})) {
    if (!providerState || typeof providerState !== 'object') continue;
    const state = stateFor(id);
    state.successes = finiteNumber(providerState.successes);
    state.failures = finiteNumber(providerState.failures);
    state.attempts = finiteNumber(providerState.attempts);
    state.avgLatencyMs = providerState.avgLatencyMs == null
      ? null
      : finiteNumber(providerState.avgLatencyMs);
    state.lastOkAt = providerState.lastOkAt || null;
    state.tokens = {
      prompt: finiteNumber(providerState.tokens && providerState.tokens.prompt),
      completion: finiteNumber(providerState.tokens && providerState.tokens.completion),
      total: finiteNumber(providerState.tokens && providerState.tokens.total)
    };
  }

  usageHistory = saved.history && typeof saved.history === 'object' ? saved.history : {};
  usageHourly = saved.hourly && typeof saved.hourly === 'object' ? saved.hourly : {};
  usagePersistence.updatedAt = saved.updatedAt || null;
  usagePersistence.loadedAt = nowIso();
  usagePersistence.startedAt = saved.startedAt || usagePersistence.startedAt;
  return saved;
}

function usageSnapshot() {
  const providers = {};
  for (const [id, state] of stateById.entries()) {
    providers[id] = {
      successes: state.successes,
      failures: state.failures,
      attempts: state.attempts,
      avgLatencyMs: state.avgLatencyMs,
      lastOkAt: state.lastOkAt,
      tokens: Object.assign({}, state.tokens)
    };
  }
  return {
    version: 1,
    startedAt: usagePersistence.startedAt,
    updatedAt: nowIso(),
    metrics: Object.assign({}, metrics),
    history: usageHistory,
    hourly: usageHourly,
    providers
  };
}

function saveUsageState() {
  if (!CFG || !CFG.usageStateFile) return false;
  if (usagePersistence.timer) {
    clearTimeout(usagePersistence.timer);
    usagePersistence.timer = null;
  }
  try {
    const file = CFG.usageStateFile;
    const temp = file + '.' + process.pid + '.tmp';
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const snapshot = usageSnapshot();
    fs.writeFileSync(temp, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temp, file);
    usagePersistence.updatedAt = snapshot.updatedAt;
    return true;
  } catch (error) {
    log({ ev: 'usage_persist_failed', error: String(error.message || error) });
    return false;
  }
}

function scheduleUsageSave() {
  if (!CFG || !CFG.usageStateFile || usagePersistence.timer) return;
  usagePersistence.timer = setTimeout(() => {
    usagePersistence.timer = null;
    saveUsageState();
  }, 250);
  usagePersistence.timer.unref();
}

function bumpMetric(name, delta = 1) {
  if (!Object.prototype.hasOwnProperty.call(metrics, name)) return;
  metrics[name] += delta;
  scheduleUsageSave();
}

function readCredentialKey(keyFile) {
  fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  let value = readTextFile(keyFile);
  if (!value) {
    value = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(keyFile, value + '\n', { mode: 0o600 });
  }
  const key = Buffer.from(value, 'hex');
  if (key.length !== 32) {
    throw new Error('credential key must be 32 bytes of hex');
  }
  return key;
}

function decryptCredentialStore(storeFile, keyFile) {
  const key = readCredentialKey(keyFile);
  const store = readJsonIfExists(storeFile, { version: 1, entries: {} });
  const values = new Map();
  for (const [id, entry] of Object.entries(store.entries || {})) {
    try {
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(entry.iv, 'base64')
      );
      decipher.setAAD(Buffer.from(id));
      decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(entry.data, 'base64')),
        decipher.final()
      ]).toString('utf8');
      if (plaintext) values.set(id, plaintext);
    } catch {}
  }
  return values;
}

function writeCredentialValue(storeFile, keyFile, id, secret) {
  const key = readCredentialKey(keyFile);
  const store = readJsonIfExists(storeFile, { version: 1, entries: {} });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(id));
  const data = Buffer.concat([cipher.update(String(secret), 'utf8'), cipher.final()]);
  store.version = 1;
  store.entries = store.entries || {};
  store.entries[id] = {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
    updatedAt: nowIso()
  };
  fs.mkdirSync(path.dirname(storeFile), { recursive: true, mode: 0o700 });
  const temp = storeFile + '.tmp-' + process.pid;
  fs.writeFileSync(temp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, storeFile);
  fs.chmodSync(storeFile, 0o600);
}

function deleteCredentialValue(storeFile, id) {
  const store = readJsonIfExists(storeFile, { version: 1, entries: {} });
  if (!store.entries || !store.entries[id]) return false;
  delete store.entries[id];
  fs.writeFileSync(storeFile, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(storeFile, 0o600);
  return true;
}

function readProviderSettings(file) {
  if (!file) return new Map();
  const saved = readJsonIfExists(file, { version: 1, providers: {} });
  return new Map(Object.entries(saved && saved.providers || {}));
}

function writeProviderSetting(file, id, enabled) {
  const saved = readJsonIfExists(file, { version: 1, providers: {} });
  saved.version = 1;
  saved.providers = saved.providers || {};
  saved.providers[id] = {
    enabled: Boolean(enabled),
    updatedAt: nowIso()
  };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.tmp-' + process.pid;
  fs.writeFileSync(temp, JSON.stringify(saved, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
  fs.chmodSync(file, 0o600);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, override) {
  const output = Object.assign({}, base);
  for (const [key, value] of Object.entries(override || {})) {
    if (isPlainObject(value) && isPlainObject(output[key])) {
      output[key] = deepMerge(output[key], value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function readConfigWithExtends(file, seen = new Set()) {
  const absolute = path.resolve(file);
  if (seen.has(absolute)) throw new Error('config extends cycle: ' + absolute);
  seen.add(absolute);
  const raw = readJsonFile(absolute);
  if (!raw.extends) return raw;
  const parentPath = path.isAbsolute(raw.extends)
    ? raw.extends
    : path.resolve(path.dirname(absolute), raw.extends);
  const parent = readConfigWithExtends(parentPath, seen);
  const override = Object.assign({}, raw);
  delete override.extends;
  return deepMerge(parent, override);
}

function tokenFromRequest(req) {
  const auth = String(req.headers.authorization || '');
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  return String(req.headers['x-api-key'] || '').trim();
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (!left.length || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function isAuthorized(req) {
  return Boolean(TOKEN) && safeEqual(tokenFromRequest(req), TOKEN);
}

function writeJson(res, status, payload, extraHeaders) {
  const body = JSON.stringify(payload);
  const headers = Object.assign({
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  }, extraHeaders || {});
  res.writeHead(status, headers);
  res.end(body);
}

function readRequestBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (error) {
        reject(Object.assign(new Error('invalid JSON: ' + error.message), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function readAll(stream, limit = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    stream.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        stream.destroy();
        reject(new Error('upstream response too large'));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

function makeAbortError(message) {
  const error = new Error(message);
  error.code = 'ETIMEDOUT';
  return error;
}

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 15000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 15000 });


function proxiedRequest(target, options, proxyUrl, timeoutMs) {
  const proxy = new URL(proxyUrl);
  const method = options.method || 'POST';
  const body = options.body;
  return new Promise((resolve, reject) => {
    if (target.protocol === 'http:') {
      const req = http.request({
        host: proxy.hostname,
        port: proxy.port || 80,
        method,
        path: target.href,
        headers: Object.assign({}, options.headers || {}, { host: target.host })
      }, response => resolve({ status: response.statusCode, headers: response.headers, stream: response }));
      req.setTimeout(timeoutMs, () => req.destroy(makeAbortError('upstream timeout ' + timeoutMs + 'ms')));
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
      return;
    }
    const connect = http.request({
      host: proxy.hostname,
      port: proxy.port || 80,
      method: 'CONNECT',
      path: target.hostname + ':' + (target.port || 443),
      headers: { host: target.hostname + ':' + (target.port || 443) }
    });
    connect.setTimeout(timeoutMs, () => connect.destroy(makeAbortError('proxy timeout')));
    connect.on('error', reject);
    connect.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error('proxy CONNECT failed ' + res.statusCode));
        return;
      }
      const secure = tls.connect({ socket, servername: target.hostname, ALPNProtocols: ['http/1.1'] }, () => {
        const req = https.request({
          host: target.hostname,
          port: target.port || 443,
          path: target.pathname + target.search,
          method,
          headers: options.headers || {},
          createConnection: () => secure
        }, response => resolve({ status: response.statusCode, headers: response.headers, stream: response }));
        req.setTimeout(timeoutMs, () => req.destroy(makeAbortError('upstream timeout ' + timeoutMs + 'ms')));
        req.on('error', reject);
        if (body !== undefined) req.write(body);
        req.end();
      });
      secure.on('error', reject);
    });
    connect.end();
  });
}

function request(urlString, options = {}) {
  const target = new URL(urlString);
  const transport = target.protocol === 'https:' ? https : http;
  const timeoutMs = Number(options.timeoutMs || 90000);
  if (options.proxy) return proxiedRequest(target, options, options.proxy, timeoutMs);

  return new Promise((resolve, reject) => {
    const req = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      method: options.method || 'POST',
      headers: options.headers || {},
      agent: target.protocol === 'https:' ? httpsAgent : httpAgent,
      family: options.family || 4
    }, response => resolve({
      status: response.statusCode,
      headers: response.headers,
      stream: response
    }));

    req.setTimeout(timeoutMs, () => req.destroy(makeAbortError('upstream timeout ' + timeoutMs + 'ms')));
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function cleanUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}

function providerEndpoint(raw) {
  if (raw.endpoint) return raw.endpoint;
  const base = cleanUrl(raw.baseUrl);
  if (!base) return '';
  if (raw.type === 'pi-agent') return base;
  if (raw.type === 'ollama-chat') return base + '/api/chat';
  if (raw.type === 'anthropic-compatible') return base + '/v1/messages';
  return base + '/chat/completions';
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function piAgentJson(provider, pathname, options = {}) {
  const base = cleanUrl(provider.baseUrl);
  if (!base) throw new Error('Pi Agent baseUrl is missing');
  const response = await request(base + pathname, {
    method: options.method || 'GET',
    headers: options.body === undefined
      ? { accept: 'application/json' }
      : {
          accept: 'application/json',
          'content-type': 'application/json'
        },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    timeoutMs: Math.min(options.timeoutMs || 30000, provider.timeoutMs),
    family: provider.family || 4
  });
  const text = await readAll(response.stream, 4 * 1024 * 1024);
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (response.status < 200 || response.status >= 300) {
    const message = payload.error || payload.raw || ('HTTP ' + response.status);
    const error = new Error(String(message).slice(0, 500));
    error.status = response.status;
    throw error;
  }
  return payload;
}

function piAgentPrompt(body) {
  const lines = [];
  for (const message of body.messages || []) {
    const role = String(message.role || 'user').toUpperCase();
    const text = contentText(message.content);
    if (text) lines.push(role + ':\n' + text);
  }
  return lines.join('\n\n').trim();
}

async function piAgentCompletion(provider, body) {
  const prompt = piAgentPrompt(body);
  if (!prompt) throw new Error('Pi Agent prompt is empty');
  const created = await piAgentJson(provider, '/api/agent/new', {
    method: 'POST',
    timeoutMs: 45000,
    body: {
      cwd: provider.piAgentCwd,
      type: 'prompt',
      message: prompt,
      ...(provider.piAgentProvider ? { provider: provider.piAgentProvider } : {}),
      ...(provider.piAgentModel ? { modelId: provider.piAgentModel } : {}),
      thinkingLevel: provider.piAgentThinkingLevel || 'off'
    }
  });
  const sessionId = created.sessionId;
  if (!sessionId) throw new Error('Pi Agent did not return a session id');

  const deadline = Date.now() + provider.timeoutMs;
  let state = null;
  while (Date.now() < deadline) {
    await delay(750);
    const current = await piAgentJson(
      provider,
      '/api/sessions/' + encodeURIComponent(sessionId) + '/state',
      { timeoutMs: 8000 }
    );
    state = current.state || null;
    if (!current.running || !state) break;
    if (!state.isPromptRunning && !state.isStreaming && Number(state.messageCount || 0) > 0) break;
  }
  if (state && (state.isPromptRunning || state.isStreaming)) {
    throw Object.assign(new Error('Pi Agent prompt timed out'), {
      status: 504,
      classification: { code: 'network', status: 504, cooldownMs: 5000 }
    });
  }

  const session = await piAgentJson(
    provider,
    '/api/sessions/' + encodeURIComponent(sessionId),
    { timeoutMs: 15000 }
  );
  const messages = session.context && Array.isArray(session.context.messages)
    ? session.context.messages
    : [];
  const assistant = [...messages].reverse().find(message => message.role === 'assistant');
  const text = assistant ? contentText(assistant.content).trim() : '';
  if (!text) throw new Error('Pi Agent returned no assistant text');
  const stats = session.stats && session.stats.tokens || {};
  const promptTokens = Number(stats.input || 0);
  const completionTokens = Number(stats.output || 0);
  const totalTokens = Number(stats.total || promptTokens + completionTokens);
  return {
    id: 'piagent-' + sessionId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.model || 'piagent',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text },
      finish_reason: 'stop'
    }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens
    },
    piagent: {
      session_id: sessionId,
      model: session.context && session.context.model || null
    }
  };
}

function normalizeProviderType(type) {
  const value = String(type || 'openai-compatible');
  if (value === 'openai-compat') return 'openai-compatible';
  if (value === 'anthropic' || value === 'anthropic-messages') return 'anthropic-compatible';
  if (value === 'ollama') return 'ollama-chat';
  return value;
}

function normalizeProvider(raw) {
  const provider = Object.assign({}, raw);
  provider.type = normalizeProviderType(raw.type);
  provider.endpoint = providerEndpoint(provider);
  provider.capabilities = Object.assign({
    tools: false,
    toolBridge: false,
    stream: false,
    usage: false,
    vision: false
  }, raw.capabilities || {});
  provider.modelMap = Object.assign({}, raw.modelMap || {});
  provider.headers = Object.assign({}, raw.headers || {});
  provider.timeoutMs = Number(raw.timeoutMs || 120000);
  provider.healthUrl = raw.healthUrl || '';
  provider.validationMode = raw.validationMode === 'chat' ? 'chat' : 'health';
  provider.validationMaxTokens = Math.max(1, Number(raw.validationMaxTokens || 8));
  provider.priority = Number.isFinite(raw.priority) ? raw.priority : 100;
  provider.toolPriority = Number.isFinite(raw.toolPriority) ? raw.toolPriority : provider.priority;
  provider.maxConcurrency = Math.max(1, Number(raw.maxConcurrency || 4));
  provider.rpm = Math.max(0, Number(raw.rpm || 0));
  provider.group = raw.group ? String(raw.group) : '';
  provider.maxKeyAttempts = Math.max(1, Number(raw.maxKeyAttempts || 3));
  provider.optionalAuth = raw.optionalAuth === true;
  const setting = providerSettings.get(raw.id);
  const hasEnabledSetting = setting && typeof setting.enabled === 'boolean';
  provider.enabled = hasEnabledSetting ? setting.enabled : raw.enabled !== false;
  provider.hasUserEnabledSetting = Boolean(hasEnabledSetting);
  provider.pools = Array.isArray(raw.pools)
    ? [...new Set(raw.pools.filter(pool => pool === 'tools' || pool === 'chat'))]
    : [provider.capabilities.tools || provider.capabilities.toolBridge ? 'tools' : 'chat', 'chat'];
  provider.keys = loadProviderKeys(raw);
  provider.authConfigured = raw.authConfigured !== undefined
    ? Boolean(raw.authConfigured)
    : hasConfiguredAuth(raw);

  if (!provider.enabled) {
    provider.disabledReason = hasEnabledSetting ? 'disabled_by_user' : 'disabled_in_config';
  }
  else if (!provider.endpoint) provider.disabledReason = 'missing_endpoint';
  else if (provider.authConfigured && !provider.keys.length && !provider.optionalAuth) {
    provider.disabledReason = 'missing_api_key';
  }
  if (provider.disabledReason) provider.enabled = false;
  return provider;
}

function hasConfiguredAuth(raw) {
  return Boolean(
    raw.credentialId ||
    raw.apiKey ||
    raw.apiKeys ||
    raw.apiKeyFile ||
    raw.apiKeyFiles ||
    raw.apiKeyEnv
  );
}

function envValues(name) {
  if (!name) return [];
  return String(process.env[name] || '')
    .split(/[\n,]+/)
    .map(value => value.trim())
    .filter(Boolean);
}

function loadProviderKeys(raw) {
  const keys = [];
  const stored = credentialValues.get(raw.credentialId || raw.id);
  if (stored) keys.push(stored);
  if (raw.apiKey) keys.push(String(raw.apiKey));
  for (const key of raw.apiKeys || []) keys.push(String(key));
  for (const value of envValues(raw.apiKeyEnv)) keys.push(value);
  const files = [];
  if (raw.apiKeyFile) files.push(raw.apiKeyFile);
  for (const file of raw.apiKeyFiles || []) files.push(file);
  for (const file of files) {
    const value = readTextFile(file);
    if (value) keys.push(value);
  }
  // 多 key 扩容：同目录下 <id>*.key 全部纳入轮换（合法多账号/多 key）
  try {
    const base = raw.apiKeyFile;
    if (base) {
      const dir = path.dirname(base);
      const prefix = path.basename(base).replace(/\.key$/, '');
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.key')) continue;
        if (name === path.basename(base)) continue;
        if (!name.startsWith(prefix)) continue;
        const value = readTextFile(path.join(dir, name));
        if (value) keys.push(value);
      }
    }
  } catch {}
  return [...new Set(keys.map(value => value.trim()).filter(Boolean))];
}

function newProviderState(id) {
  return {
    id,
    state: 'closed',
    failures: 0,
    successes: 0,
    attempts: 0,
    lastError: null,
    lastErrorCode: null,
    lastStatus: null,
    lastAttemptAt: null,
    lastOkAt: null,
    lastLatencyMs: null,
    avgLatencyMs: null,
    lastProbeAt: null,
    lastProbeOkAt: null,
    lastProbeError: null,
    probeFailures: 0,
    tokens: { prompt: 0, completion: 0, total: 0, cached: 0, reasoning: 0 },
    toolAttempts: 0,
    toolSuccesses: 0,
    openUntil: 0,
    probing: false,
    inFlight: 0,
    requestTimes: [],
    keyCursor: 0
  };
}

function stateFor(id) {
  if (!stateById.has(id)) stateById.set(id, newProviderState(id));
  return stateById.get(id);
}

function groupStateFor(name) {
  if (!name) return null;
  if (!groupStates.has(name)) {
    groupStates.set(name, {
      name,
      inFlight: 0,
      requestTimes: []
    });
  }
  return groupStates.get(name);
}

function pruneRequestTimes(state) {
  const cutoff = Date.now() - 60000;
  state.requestTimes = state.requestTimes.filter(value => value >= cutoff);
}

function providerLimited(provider) {
  const state = stateFor(provider.id);
  pruneRequestTimes(state);
  if (state.inFlight >= provider.maxConcurrency) return 'concurrency_limit';
  if (provider.rpm > 0 && state.requestTimes.length >= provider.rpm) return 'rpm_limit';
  const group = groupStateFor(provider.group);
  const groupConfig = provider.group && CFG.providerGroups && CFG.providerGroups[provider.group];
  if (group && groupConfig) {
    group.requestTimes = group.requestTimes.filter(value => value >= Date.now() - 60000);
    if (group.inFlight >= Number(groupConfig.maxConcurrency || 64)) return 'group_concurrency_limit';
    if (Number(groupConfig.rpm) > 0 && group.requestTimes.length >= Number(groupConfig.rpm)) {
      return 'group_rpm_limit';
    }
  }
  return '';
}

function circuitAllows(provider) {
  const state = stateFor(provider.id);
  const now = Date.now();
  if (state.openUntil <= now) {
    if (state.state === 'open') {
      state.state = 'half-open';
      state.probing = false;
    }
    if (state.state === 'half-open' && state.probing) return false;
    return true;
  }
  return false;
}

function routeDefinition(logical) {
  const definition = routes[logical] || routes.auto;
  if (!routes[logical] && providerById.has(logical)) {
    return {
      chain: [logical],
      toolPolicy: 'strict',
      strategy: 'ordered',
      allowLastResort: true
    };
  }
  if (!definition) return null;
  if (Array.isArray(definition)) {
    return { chain: definition, toolPolicy: 'strict', strategy: 'ordered' };
  }
  if (definition.alias) {
    return Object.assign(
      {},
      routeDefinition(definition.alias),
      definition,
      { alias: undefined }
    );
  }
  return Object.assign({
    chain: definition.chain || [],
    toolPolicy: definition.toolPolicy || 'strict',
    strategy: definition.strategy || 'ordered',
    allowLastResort: definition.allowLastResort !== false
  }, definition);
}

function bodyWantsTools(body) {
  return Array.isArray(body.tools) && body.tools.length > 0;
}

function buildCandidates(logical, body, options = {}) {
  const definition = routeDefinition(logical);
  if (!definition) return { definition: null, candidates: [], skipped: [] };
  const stripTools = definition.toolPolicy === 'strip';
  const wantsTools = bodyWantsTools(body) && !stripTools;
  const skipped = [];
  const candidates = [];

  for (const id of definition.chain || []) {
    const provider = providerById.get(id);
    if (!provider) {
      skipped.push({ provider: id, reason: 'unknown_provider' });
      continue;
    }
    if (!provider.enabled) {
      skipped.push({ provider: id, reason: provider.disabledReason || 'disabled' });
      continue;
    }
    if (wantsTools && !provider.pools.includes('tools')) {
      skipped.push({ provider: id, reason: 'chat_only' });
      continue;
    }
    const limited = providerLimited(provider);
    if (limited) {
      skipped.push({ provider: id, reason: limited });
      continue;
    }
    if (!options.ignoreCircuit && !circuitAllows(provider)) {
      skipped.push({ provider: id, reason: 'circuit_open' });
      continue;
    }
    const state = stateFor(provider.id);
    candidates.push({
      provider,
      score: state.avgLatencyMs == null ? Number.MAX_SAFE_INTEGER : state.avgLatencyMs
    });
  }

  if (definition.strategy === 'adaptive') {
    const rank = candidate => {
      const state = stateFor(candidate.provider.id);
      const attempts = wantsTools ? (state.toolAttempts || 0) : ((state.successes || 0) + (state.failures || 0));
      const wins = wantsTools ? (state.toolSuccesses || 0) : (state.successes || 0);
      const reliability = (wins + 1) / (attempts + 2);
      const latency = state.avgLatencyMs == null ? 4000 : state.avgLatencyMs;
      const speed = 1 / (1 + latency / 2000);
      const slowPenalty = latency > 8000 ? 0.15 : 0;
      const idle = state.inFlight > 0 ? 0 : 0.12;
      const priorityBonus = Math.max(0, (200 - (candidate.provider.toolPriority || candidate.provider.priority)) / 2000);
      const scoreBonus = (scoreFor(candidate.provider.id) / 100) * 0.1;
      return reliability * 0.55 + speed * 0.3 + idle + priorityBonus + scoreBonus - slowPenalty + Math.random() * 0.03;
    };
    candidates.sort((left, right) => rank(right) - rank(left));
  } else {
    candidates.sort((left, right) => {
      if (wantsTools && left.provider.toolPriority !== right.provider.toolPriority) {
        return left.provider.toolPriority - right.provider.toolPriority;
      }
      if (left.provider.priority !== right.provider.priority) {
        return left.provider.priority - right.provider.priority;
      }
      if (definition.strategy === 'latency') return left.score - right.score;
      return 0;
    });
  }

  return { definition, candidates, skipped, wantsTools, stripTools };
}

function classifyFailure(error) {
  const status = Number(error && error.status) || null;
  const message = String(error && error.message || error || '');
  const lower = message.toLowerCase();
  const retryAfter = Number(error && error.retryAfterMs);

  if (status === 401 || status === 403 || /invalid.*api.?key|unauthorized|forbidden/.test(lower)) {
    return { code: 'auth', status, cooldownMs: retryAfter || 10 * 60 * 1000 };
  }
  if (status === 402 || status === 429 || /rate.?limit|too many requests|free.?limit|quota|insufficient_quota|credits?|balance|billing/.test(lower)) {
    return { code: 'rate_limit', status, cooldownMs: retryAfter || 30 * 1000 };
  }
  if (/model.*(not found|not available|unsupported|unknown)|invalid model/.test(lower)) {
    return { code: 'model_unavailable', status, cooldownMs: retryAfter || 10 * 60 * 1000 };
  }
  if (status && status >= 500) {
    return { code: 'upstream_5xx', status, cooldownMs: retryAfter || 0 };
  }
  if (
    /econnreset|econnrefused|etimedout|enotfound|enetunreach|socket hang up|connection error|network|fetch failed|timeout/.test(lower)
  ) {
    return { code: 'network', status, cooldownMs: retryAfter || 0 };
  }
  if (status && status >= 400) return { code: 'request', status, cooldownMs: retryAfter || 0 };
  return { code: 'unknown', status, cooldownMs: retryAfter || 0 };
}

function openCircuit(state, provider, cooldownMs) {
  const circuit = CFG.circuit || {};
  state.state = 'open';
  state.openUntil = Date.now() + Math.max(1000, cooldownMs || circuit.openMs || 60000);
}

function markFailure(provider, error, elapsedMs) {
  const state = stateFor(provider.id);
  bumpScore(provider.id, false, elapsedMs);
  const failure = error.classification || classifyFailure(error);
  const circuit = CFG.circuit || {};
  state.failures += 1;
  state.attempts += 1;
  state.lastError = String(error && error.message || error || 'unknown').slice(0, 500);
  state.lastErrorCode = failure.code;
  state.lastStatus = failure.status || null;
  state.lastLatencyMs = elapsedMs;
  state.lastAttemptAt = nowIso();

  if (failure.code === 'request') {
    state.failures = Math.max(0, state.failures - 1);
    scheduleUsageSave();
    return failure;
  }
  const immediate = failure.code === 'auth' || failure.code === 'rate_limit' || failure.code === 'model_unavailable';
  if (immediate) {
    openCircuit(state, provider, failure.cooldownMs);
  } else if (state.failures >= Number(circuit.failThreshold || 3)) {
    const base = Number(circuit.openMs || 60000);
    openCircuit(state, provider, Math.min(Number(circuit.maxOpenMs || 300000), base * 2 ** Math.max(0, state.failures - 1)));
  }
  scheduleUsageSave();
  return failure;
}

function addUsage(providerId, usage) {
  if (!usage) return;
  const prompt = Number(usage.prompt_tokens || usage.input_tokens || 0);
  const completion = Number(usage.completion_tokens || usage.output_tokens || 0);
  const total = Number(usage.total_tokens || (prompt + completion));
  if (!prompt && !completion && !total) return;
  const cached = Number(
    usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens ||
    usage.input_tokens_details && usage.input_tokens_details.cached_tokens || 0
  );
  const reasoning = Number(
    usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens ||
    usage.output_tokens_details && usage.output_tokens_details.reasoning_tokens || 0
  );
  const dayKey = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const bucket = usageHistory[dayKey] || (usageHistory[dayKey] = {
    prompt: 0, completion: 0, cached: 0, reasoning: 0, total: 0, requests: 0
  });
  bucket.prompt += prompt;
  bucket.completion += completion;
  bucket.cached += cached;
  bucket.reasoning += reasoning;
  bucket.total += total;
  bucket.requests += 1;
  metrics.promptTokens += prompt;
  metrics.completionTokens += completion;
  metrics.totalTokens += total;
  metrics.cachedTokens += cached;
  metrics.reasoningTokens += reasoning;
  if (cached > 0) metrics.cacheHits += 1;
  metrics.usageEvents += 1;
  scheduleUsageSave();
  if (providerId) {
    const state = stateFor(providerId);
    const tokens = state.tokens || (state.tokens = { prompt: 0, completion: 0, total: 0, cached: 0, reasoning: 0 });
    tokens.prompt = Number(tokens.prompt || 0) + prompt;
    tokens.completion = Number(tokens.completion || 0) + completion;
    tokens.total = Number(tokens.total || 0) + total;
    tokens.cached = Number(tokens.cached || 0) + cached;
    tokens.reasoning = Number(tokens.reasoning || 0) + reasoning;
  }
}

function markSuccess(provider, elapsedMs, usage) {
  const state = stateFor(provider.id);
  bumpScore(provider.id, true, elapsedMs);
  addUsage(provider.id, usage);
  state.successes += 1;
  state.attempts += 1;
  state.failures = 0;
  state.state = 'closed';
  state.openUntil = 0;
  state.probing = false;
  state.lastError = null;
  state.lastErrorCode = null;
  state.lastStatus = null;
  state.lastLatencyMs = elapsedMs;
  state.lastOkAt = nowIso();
  state.lastAttemptAt = state.lastOkAt;
  state.avgLatencyMs = state.avgLatencyMs == null
    ? elapsedMs
    : Math.round(state.avgLatencyMs * 0.7 + elapsedMs * 0.3);
  scheduleUsageSave();
}

function beginProviderAttempt(provider) {
  const state = stateFor(provider.id);
  state.inFlight += 1;
  state.lastAttemptAt = nowIso();
  pruneRequestTimes(state);
  state.requestTimes.push(Date.now());
  const group = groupStateFor(provider.group);
  if (group) {
    group.inFlight += 1;
    group.requestTimes = group.requestTimes.filter(value => value >= Date.now() - 60000);
    group.requestTimes.push(Date.now());
  }
  if (state.state === 'half-open') state.probing = true;
}

function endProviderAttempt(provider) {
  const state = stateFor(provider.id);
  state.inFlight = Math.max(0, state.inFlight - 1);
  const group = groupStateFor(provider.group);
  if (group) group.inFlight = Math.max(0, group.inFlight - 1);
  if (state.state === 'half-open') state.probing = false;
}

function orderedKeys(provider) {
  if (!provider.keys.length) return [null];
  const state = stateFor(provider.id);
  const count = Math.min(provider.maxKeyAttempts, provider.keys.length);
  const result = [];
  for (let index = 0; index < count; index += 1) {
    result.push(provider.keys[(state.keyCursor + index) % provider.keys.length]);
  }
  state.keyCursor = (state.keyCursor + count) % provider.keys.length;
  return result;
}

function mappedModel(provider, logical, original) {
  return provider.modelMap[logical] ||
    (logical === 'tools' ? provider.modelMap.auto || provider.modelMap.fast || provider.modelMap.smart : null) ||
    provider.defaultModel ||
    original ||
    logical;
}

function authHeaders(provider, apiKey) {
  const headers = Object.assign({
    'accept-encoding': 'identity'
  }, provider.headers);
  if (provider.type === 'anthropic-compatible') {
    if (apiKey) headers['x-api-key'] = apiKey;
    if (!headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01';
  } else if (provider.type === 'ollama-chat') {
    // Ollama cloud uses a bearer token; local Ollama ignores it.
    if (apiKey) headers.authorization = 'Bearer ' + apiKey;
  } else if (apiKey) {
    headers.authorization = 'Bearer ' + apiKey;
  }
  return headers;
}

function headersWithContentType(headers) {
  return Object.assign({ 'content-type': 'application/json' }, headers);
}

function buildOpenAIBody(provider, logical, body, stream, stripTools) {
  const output = {
    model: mappedModel(provider, logical, body.model),
    messages: body.messages || []
  };
  for (const field of CHAT_FIELDS) {
    if (body[field] !== undefined) output[field] = body[field];
  }
  if (Array.isArray(body.tools) && body.tools.length && !stripTools && provider.capabilities.tools) {
    output.tools = body.tools;
    if (body.tool_choice !== undefined) output.tool_choice = body.tool_choice;
    if (body.parallel_tool_calls !== undefined) output.parallel_tool_calls = body.parallel_tool_calls;
  }
  if (provider.maxTokens && output.max_tokens === undefined && output.max_completion_tokens === undefined) {
    output.max_tokens = provider.maxTokens;
  }
  if (stream) {
    output.stream = true;
    if (provider.capabilities.usage && provider.includeUsageInStream !== false) {
      output.stream_options = Object.assign({}, body.stream_options || {}, { include_usage: true });
    }
  }
  return output;
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (!part) return '';
      if (typeof part === 'string') return part;
      if (typeof part.text === 'string') return part.text;
      return '';
    }).join('');
  }
  if (content == null) return '';
  return JSON.stringify(content);
}

function reasoningEffort(body) {
  const direct = String(
    body.reasoning_effort ||
    body.reasoning && body.reasoning.effort ||
    ''
  ).toLowerCase();
  if (direct && direct !== 'none') return direct;
  const thinking = body.thinking;
  if (!thinking || thinking.type === 'disabled') return '';
  const budget = Number(thinking.budget_tokens || 0);
  if (budget >= 32000) return 'max';
  if (budget >= 16000) return 'high';
  if (budget >= 8000) return 'medium';
  return thinking.type === 'enabled' ? 'low' : '';
}

function withReasoningInstruction(body, logical) {
  const effort = reasoningEffort(body);
  if (!effort || logical === 'chat' || !Array.isArray(body.messages)) return body;
  const marked = body.messages.some(message =>
    message && String(message.content || '').includes('[Relay reasoning mode]')
  );
  if (marked) return body;
  body.messages = [{
    role: 'system',
    content:
      '[Relay reasoning mode]\n' +
      'Before answering, reason internally, decompose the task, verify assumptions, and self-check the result. ' +
      'For tool tasks, choose tools deliberately and validate their outputs. ' +
      'Reasoning effort: ' + effort + '.'
  }, ...body.messages];
  return body;
}

function toolBridgeProtocol(tools, strict, hint) {
  const definitions = tools.map(tool => {
    const fn = tool.function || tool;
    return {
      name: fn.name,
      description: fn.description || '',
      parameters: fn.parameters || fn.input_schema || {
        type: 'object',
        properties: {}
      }
    };
  });
  const requiredLines = definitions.map(def => {
    const required = (def.parameters && def.parameters.required) || [];
    return required.length ? def.name + ' 必填: ' + required.join(', ') : def.name + ' 必填: 无';
  });
  return [
    '[Tool bridge protocol]',
    strict
      ? 'IMPORTANT: your previous reply contained no tool call. You MUST reply with exactly one JSON object and nothing else.'
      : 'You may call the tools listed below.',
    'When a tool is needed, reply with ONLY one JSON object and no markdown, no prose, no explanation:',
    '{"tool_calls":[{"name":"tool_name","arguments":{"key":"value"}}]}',
    'If the user explicitly requires a tool, you must call it — do not answer in natural language.',
    'Do not invent a tool result. If no tool is needed, answer normally.',
    hint ? '上一次调用的参数不合法：' + hint + '。必须按 schema 补齐后重发。' : '',
    'Required fields:',
    requiredLines.join('\n'),
    'Available tools:',
    JSON.stringify(definitions)
  ].filter(Boolean).join('\n');
}

function balancedJsonObjects(text) {
  const objects = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return objects;
}

function toolRequiredMap(tools) {
  const map = {};
  for (const tool of tools || []) {
    const fn = tool.function || tool;
    if (!fn || !fn.name) continue;
    const params = fn.parameters || fn.input_schema || {};
    map[fn.name] = Array.isArray(params.required) ? params.required : [];
  }
  return map;
}

function parseBridgeToolCalls(answer, tools) {
  const text = String(answer || '').trim();
  if (!text) return [];
  const allowed = new Set((tools || []).map(tool => {
    const fn = tool.function || tool;
    return fn && fn.name;
  }).filter(Boolean));
  const candidates = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.unshift(fenced[1].trim());
  candidates.push(...balancedJsonObjects(text));

  for (const candidate of candidates) {
    let value;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    let calls = value && value.tool_calls;
    if (calls && !Array.isArray(calls)) calls = [calls];
    if (!calls && value && (value.name || value.tool || value.function_name)) calls = [value];
    if (!Array.isArray(calls) || !calls.length) continue;
    const normalized = [];
    for (const call of calls) {
      const fn = call.function || call;
      const rawName = String(
        fn && (fn.name || fn.tool || fn.function_name) ||
        call.name ||
        call.tool ||
        call.function_name ||
        ''
      ).trim();
      if (!rawName) continue;
      let name = rawName;
      if (allowed.size && !allowed.has(name)) {
        const prefixes = ['functions.', 'function.', 'tools.', 'tool.'];
        const prefix = prefixes.find(item => rawName.startsWith(item));
        if (prefix && allowed.has(rawName.slice(prefix.length))) {
          name = rawName.slice(prefix.length);
        } else {
          const suffixMatch = [...allowed].find(item => (
            rawName.endsWith('.' + item) ||
            rawName.endsWith('/' + item) ||
            rawName.endsWith(':' + item)
          ));
          if (suffixMatch) name = suffixMatch;
        }
      }
      if (allowed.size && !allowed.has(name)) continue;
      let args = fn.arguments !== undefined
        ? fn.arguments
        : fn.args !== undefined
          ? fn.args
          : fn.parameters !== undefined
            ? fn.parameters
            : call.arguments !== undefined
              ? call.arguments
              : call.parameters !== undefined
                ? call.parameters
                : {};
      if (typeof args !== 'string') args = JSON.stringify(args || {});
      normalized.push({
        id: call.id || 'call_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16),
        type: 'function',
        function: { name, arguments: args }
      });
    }
    if (normalized.length) {
      const requiredMap = toolRequiredMap(tools);
      const valid = [];
      const missing = [];
      for (const item of normalized) {
        const required = requiredMap[item.function.name] || [];
        let parsedArgs = {};
        try { parsedArgs = JSON.parse(item.function.arguments || '{}'); } catch { parsedArgs = {}; }
        const lacking = required.filter(key => parsedArgs[key] === undefined || parsedArgs[key] === null || parsedArgs[key] === '');
        if (lacking.length) missing.push(item.function.name + ' 缺 ' + lacking.join(', '));
        else valid.push(item);
      }
      if (valid.length) return valid;
      if (missing.length) {
        const empty = [];
        empty.__missing = missing;
        return empty;
      }
    }
  }
  return [];
}

function messagesWithToolBridge(body, tools, strict, hint) {
  return Object.assign({}, body, {
    messages: [{
      role: 'system',
      content: toolBridgeProtocol(tools, strict, hint)
    }].concat(body.messages || [])
  });
}

function latestUserText(body) {
  const messages = body && body.messages || [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') return contentText(messages[index].content);
  }
  return '';
}

function selectBridgeTools(body, tools, maxTools = 12) {
  if (!Array.isArray(tools)) return [];
  const intent = latestUserText(body).toLowerCase();
  const explicit = tools.filter(tool => {
    const name = String(tool.function && tool.function.name || tool.name || '').toLowerCase();
    return name && intent.includes(name);
  });
  if (explicit.length) return explicit.slice(0, maxTools);
  if (tools.length <= maxTools) return tools;

  const words = new Set(intent.match(/[a-z][a-z0-9_.-]{1,40}/g) || []);
  const ranked = tools.map((tool, index) => {
    const fn = tool.function || tool;
    const text = String(fn.name || '') + ' ' + String(fn.description || '');
    const lower = text.toLowerCase();
    let score = 0;
    for (const word of words) if (lower.includes(word)) score += 3;
    if (/(shell|exec|terminal|command|file|read|write|search|fetch|browser)/i.test(text)) score += 1;
    return { tool, index, score };
  }).sort((left, right) => right.score - left.score || left.index - right.index);
  return ranked.slice(0, maxTools).map(item => item.tool);
}

function applyBridgeToolCalls(raw, tools) {
  const message = raw && raw.choices && raw.choices[0] && raw.choices[0].message;
  if (!message) return raw;
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) return raw;
  const source = [
    contentText(message.content),
    String(message.reasoning || ''),
    String(message.reasoning_content || '')
  ].filter(Boolean).join('\n');
  const calls = parseBridgeToolCalls(source, tools);
  if (!calls.length) {
    if (calls.__missing && calls.__missing.length) raw.__bridgeMissing = calls.__missing.join('; ');
    return raw;
  }
  message.content = '';
  message.tool_calls = calls;
  raw.choices[0].finish_reason = 'tool_calls';
  return raw;
}

function anthropicFromOpenAI(body, provider, logical) {
  const system = [];
  const messages = [];
  for (const message of body.messages || []) {
    if (message.role === 'system') {
      const text = contentText(message.content);
      if (text) system.push(text);
      continue;
    }
    if (message.role === 'tool') {
      messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: message.tool_call_id || 'tool',
          content: contentText(message.content)
        }]
      });
      continue;
    }
    const content = [];
    const text = contentText(message.content);
    if (text) content.push({ type: 'text', text });
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        let input = {};
        try {
          input = JSON.parse(call.function && call.function.arguments || '{}');
        } catch {
          input = { raw: call.function && call.function.arguments || '' };
        }
        content.push({
          type: 'tool_use',
          id: call.id || 'tool_' + crypto.randomUUID(),
          name: call.function && call.function.name || 'tool',
          input
        });
      }
    }
    messages.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: content.length ? content : [{ type: 'text', text: '' }]
    });
  }

  const output = {
    model: mappedModel(provider, logical, body.model),
    max_tokens: body.max_tokens || body.max_completion_tokens || provider.maxTokens || 4096,
    messages
  };
  if (system.length) output.system = system.join('\n\n');
  for (const field of ['temperature', 'top_p', 'stop_sequences']) {
    if (body[field] !== undefined) output[field] = body[field];
  }
  if (Array.isArray(body.tools) && body.tools.length) {
    output.tools = body.tools.map(tool => ({
      name: tool.function && tool.function.name || tool.name,
      description: tool.function && tool.function.description || tool.description || '',
      input_schema: tool.function && tool.function.parameters || tool.input_schema || {
        type: 'object',
        properties: {}
      }
    }));
    if (body.tool_choice === 'required') output.tool_choice = { type: 'any' };
    else if (body.tool_choice === 'auto') output.tool_choice = { type: 'auto' };
  }
  return output;
}

function openAIFromAnthropic(raw, logical, provider) {
  const content = [];
  const toolCalls = [];
  for (const block of raw.content || []) {
    if (!block) continue;
    if (block.type === 'text') content.push(block.text || '');
    if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id || 'tool_' + crypto.randomUUID(),
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input || {})
        }
      });
    }
  }
  const message = { role: 'assistant', content: content.join('') };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: raw.id || 'relay-' + crypto.randomUUID(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: logical,
    choices: [{
      index: 0,
      message,
      finish_reason: toolCalls.length
        ? 'tool_calls'
        : raw.stop_reason === 'max_tokens'
          ? 'length'
          : 'stop'
    }],
    usage: {
      prompt_tokens: raw.usage && raw.usage.input_tokens || 0,
      completion_tokens: raw.usage && raw.usage.output_tokens || 0,
      total_tokens: (raw.usage && raw.usage.input_tokens || 0) + (raw.usage && raw.usage.output_tokens || 0)
    }
  };
}

function ollamaFromOpenAI(body, provider, logical) {
  const output = {
    model: mappedModel(provider, logical, body.model),
    messages: body.messages || [],
    stream: false
  };
  const options = {};
  if (body.temperature !== undefined) options.temperature = body.temperature;
  if (body.top_p !== undefined) options.top_p = body.top_p;
  if (body.max_tokens !== undefined) options.num_predict = body.max_tokens;
  if (Object.keys(options).length) output.options = options;
  if (Array.isArray(body.tools) && body.tools.length && provider.capabilities.tools) {
    output.tools = body.tools;
  }
  return output;
}

function openAIFromOllama(raw, logical) {
  const message = raw.message || {};
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : undefined;
  return {
    id: 'relay-' + crypto.randomUUID(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: logical,
    choices: [{
      index: 0,
      message: Object.assign({
        role: 'assistant',
        content: message.content || ''
      }, toolCalls ? { tool_calls: toolCalls } : {}),
      finish_reason: toolCalls ? 'tool_calls' : raw.done === false ? 'length' : 'stop'
    }],
    usage: {
      prompt_tokens: raw.prompt_eval_count || 0,
      completion_tokens: raw.eval_count || 0,
      total_tokens: (raw.prompt_eval_count || 0) + (raw.eval_count || 0)
    }
  };
}



function usageLogFields(usage) {
  if (!usage) return {};
  const details = usage.prompt_tokens_details || {};
  const completion = usage.completion_tokens_details || {};
  return {
    tokens: Number(usage.total_tokens || 0),
    tokens_in: Number(usage.prompt_tokens || 0),
    tokens_out: Number(usage.completion_tokens || 0),
    tokens_cached: Number(details.cached_tokens || usage.cache_read_input_tokens || 0),
    tokens_reasoning: Number(completion.reasoning_tokens || 0)
  };
}

function normalizeUsageFields(usage) {
  if (!usage || typeof usage !== 'object') return usage;
  const prompt = Number(usage.prompt_tokens != null ? usage.prompt_tokens : (usage.input_tokens || 0));
  const completion = Number(usage.completion_tokens != null ? usage.completion_tokens : (usage.output_tokens || 0));
  const details = usage.prompt_tokens_details || {};
  const completionDetails = usage.completion_tokens_details || {};
  const cached = Number(
    details.cached_tokens != null ? details.cached_tokens :
      usage.input_tokens_details && usage.input_tokens_details.cached_tokens != null ? usage.input_tokens_details.cached_tokens :
        usage.prompt_cache_hit_tokens != null ? usage.prompt_cache_hit_tokens :
          usage.cache_read_input_tokens != null ? usage.cache_read_input_tokens :
            usage.cached_tokens != null ? usage.cached_tokens : 0
  );
  const reasoning = Number(
    completionDetails.reasoning_tokens != null ? completionDetails.reasoning_tokens :
      usage.output_tokens_details && usage.output_tokens_details.reasoning_tokens != null ? usage.output_tokens_details.reasoning_tokens :
        usage.reasoning_tokens != null ? usage.reasoning_tokens : 0
  );
  return Object.assign({}, usage, {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: Number(usage.total_tokens != null ? usage.total_tokens : (prompt + completion)),
    prompt_tokens_details: Object.assign({}, details, { cached_tokens: cached }),
    completion_tokens_details: Object.assign({}, completionDetails, { reasoning_tokens: reasoning })
  });
}

function usageFromRaw(raw, body) {
  if (raw && raw.usage && Number.isFinite(Number(raw.usage.prompt_tokens))) {
    const prompt = Number(raw.usage.prompt_tokens) || 0;
    const completion = Number(raw.usage.completion_tokens) || 0;
    return normalizeUsageFields(Object.assign({}, raw.usage, {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: Number(raw.usage.total_tokens) || prompt + completion
    }));
  }
  return estimateUsage(body, messageText(raw));
}

function estimateTokens(text) {
  const value = String(text || '');
  if (!value) return 0;
  const matches = value.match(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g);
  const cjk = matches ? matches.length : 0;
  const other = Math.max(0, value.length - cjk);
  return cjk + Math.ceil(other / 4);
}

function estimateUsage(body, outputText) {
  const promptText = JSON.stringify(body.messages || []);
  const promptTokens = Math.max(1, estimateTokens(promptText));
  const completionTokens = Math.max(0, estimateTokens(outputText));
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0 },
    estimated: true
  };
}

function messageText(raw) {
  const message = raw && raw.choices && raw.choices[0] && raw.choices[0].message;
  if (!message) return '';
  const toolText = Array.isArray(message.tool_calls) ? JSON.stringify(message.tool_calls) : '';
  return contentText(message.content) + toolText;
}

function normalizeCompletion(raw, logical, provider, body) {
  const choice = raw && raw.choices && raw.choices[0] || {};
  const message = choice.message || {};
  const content = contentText(message.content);
  const output = {
    id: raw.id || 'relay-' + crypto.randomUUID(),
    object: 'chat.completion',
    created: raw.created || Math.floor(Date.now() / 1000),
    model: logical,
    choices: [{
      index: 0,
      message: Object.assign(
        { role: 'assistant', content },
        message.reasoning ? { reasoning: message.reasoning } : {},
        message.tool_calls ? { tool_calls: message.tool_calls } : {}
      ),
      finish_reason: choice.finish_reason || (message.tool_calls ? 'tool_calls' : 'stop')
    }],
    usage: usageFromRaw(raw, body),
    relay: {
      upstream: provider,
      upstream_model: raw.model || null
    }
  };
  return output;
}

function errorFromStatus(status, bodyText, headers) {
  const clean = String(bodyText || '').replace(/\s+/g, ' ').slice(0, 800);
  const error = new Error('HTTP ' + status + (clean ? ' ' + clean : ''));
  error.status = status;
  const retryAfter = headers && (headers['retry-after'] || headers['x-ratelimit-reset-after']);
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) error.retryAfterMs = Math.max(1000, seconds * 1000);
    else {
      const date = Date.parse(String(retryAfter));
      if (Number.isFinite(date)) error.retryAfterMs = Math.max(1000, date - Date.now());
    }
  }
  if (!error.retryAfterMs) {
    try {
      const payload = JSON.parse(bodyText);
      const seconds = Number(
        payload.retry_after ||
        payload.retryAfter ||
        payload.error && payload.error.retry_after
      );
      if (Number.isFinite(seconds)) error.retryAfterMs = Math.max(1000, seconds * 1000);
    } catch {}
  }
  return error;
}

function splitAccountKey(apiKey) {
  const value = String(apiKey || '');
  const index = value.indexOf(':');
  if (index < 0) return { accountId: '', token: value };
  return { accountId: value.slice(0, index).trim(), token: value.slice(index + 1).trim() };
}

function resolveTarget(provider, apiKey, url) {
  let key = apiKey;
  let target = url || provider.endpoint;
  if (String(provider.baseUrl || '').indexOf('{account_id}') >= 0) {
    const parts = splitAccountKey(apiKey);
    key = parts.token;
    target = String(target).replace('{account_id}', encodeURIComponent(parts.accountId));
  }
  return { url: target, key };
}

async function providerJsonAttempt(provider, logical, body, route, apiKey) {
  const useToolBridge = (
    route.toolPolicy !== 'strip' &&
    provider.capabilities.toolBridge &&
    !provider.capabilities.tools &&
    bodyWantsTools(body)
  );
  const bridgeTools = useToolBridge ? selectBridgeTools(body, body.tools) : null;

  async function callOnce(effectiveBody) {
    let requestBody;
    if (provider.type === 'anthropic-compatible') {
      requestBody = anthropicFromOpenAI(effectiveBody, provider, logical);
    } else if (provider.type === 'ollama-chat') {
      requestBody = ollamaFromOpenAI(effectiveBody, provider, logical);
    } else {
      requestBody = buildOpenAIBody(provider, logical, effectiveBody, false, route.toolPolicy === 'strip');
    }
    const target = resolveTarget(provider, apiKey);
    const response = await request(target.url, {
      headers: headersWithContentType(authHeaders(provider, target.key)),
      body: JSON.stringify(requestBody),
      timeoutMs: provider.timeoutMs,
      proxy: provider.proxy || null,
      family: provider.family || 4
    });
    const text = await readAll(response.stream);
    if (response.status < 200 || response.status >= 300) {
      throw errorFromStatus(response.status, text, response.headers);
    }
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error('upstream returned invalid JSON');
    }
    if (raw && raw.error) {
      throw new Error('upstream error: ' + JSON.stringify(raw.error).slice(0, 500));
    }
    let normalized = raw;
    if (provider.type === 'anthropic-compatible') normalized = openAIFromAnthropic(raw, logical, provider);
    if (provider.type === 'ollama-chat') normalized = openAIFromOllama(raw, logical);
    if (bodyWantsTools(body)) {
      normalized = applyBridgeToolCalls(normalized, bridgeTools || body.tools);
    }
    return normalized;
  }

  let normalized = await callOnce(useToolBridge ? messagesWithToolBridge(body, bridgeTools) : body);

  if (useToolBridge && bodyWantsTools(body)) {
    const message = normalized.choices && normalized.choices[0] && normalized.choices[0].message;
    const calls = message && Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (!calls.length) {
      // 桥接模型有时只回自然语言；用更硬的提示再要一次工具调用
      normalized = await callOnce(messagesWithToolBridge(body, bridgeTools, true, normalized.__bridgeMissing || ''));
    }
  }
  return normalized;
}

async function providerJson(provider, logical, body, route, apiKey) {
  return providerJsonAttempt(provider, logical, body, route, apiKey);
}

function nextWithTimeout(iterator, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(makeAbortError('first stream event timeout')), Math.max(1000, timeoutMs));
    iterator.next().then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function parseSseEvent(event) {
  const result = { data: [], raw: event };
  for (const line of String(event).split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    result.data.push(line.slice(5).trim());
  }
  return result;
}

function eventHasMeaningfulDelta(event) {
  const parsed = parseSseEvent(event);
  for (const value of parsed.data) {
    if (value === '[DONE]') return true;
    try {
      const chunk = JSON.parse(value);
      if (chunk.error) return true;
      const choice = chunk.choices && chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      if (delta.content || delta.reasoning || delta.tool_calls) return true;
      if (choice.finish_reason) return true;
    } catch {
      if (value) return true;
    }
  }
  return false;
}

async function openStreamAttempt(provider, logical, body, route, apiKey) {
  const requestBody = buildOpenAIBody(provider, logical, body, true, route.toolPolicy === 'strip');
  const target = resolveTarget(provider, apiKey);
  const response = await request(target.url, {
    headers: headersWithContentType(authHeaders(provider, target.key)),
    body: JSON.stringify(requestBody),
    timeoutMs: provider.timeoutMs,
    proxy: provider.proxy || null,
    family: provider.family || 4
  });

  if (response.status < 200 || response.status >= 300) {
    const text = await readAll(response.stream).catch(() => '');
    throw errorFromStatus(response.status, text, response.headers);
  }

  const iterator = response.stream[Symbol.asyncIterator]();
  const decoder = new StringDecoder('utf8');
  let prefix = '';
  const firstEventMs = Number(
    provider.firstEventTimeoutMs ||
    CFG.timeouts && CFG.timeouts.firstEventMs ||
    45000
  );
  const deadline = Date.now() + firstEventMs;
  let meaningful = false;

  while (!meaningful && Date.now() < deadline && prefix.length < MAX_STREAM_PREFIX) {
    const item = await nextWithTimeout(iterator, deadline - Date.now());
    if (item.done) {
      prefix += decoder.end();
      break;
    }
    prefix += decoder.write(item.value);

    if (prefix.trimStart().startsWith('{')) {
      let itemTail;
      do {
        itemTail = await nextWithTimeout(iterator, Math.max(1000, deadline - Date.now()));
        if (!itemTail.done) prefix += decoder.write(itemTail.value);
      } while (!itemTail.done && prefix.length < MAX_STREAM_PREFIX);
      prefix += decoder.end();
      let raw;
      try {
        raw = JSON.parse(prefix);
      } catch {
        throw new Error('upstream stream returned invalid JSON');
      }
      if (raw.error) throw new Error('upstream error: ' + JSON.stringify(raw.error).slice(0, 500));
      return {
        kind: 'json',
        raw,
        model: mappedModel(provider, logical, body.model)
      };
    }

    const events = prefix.split(/\r?\n\r?\n/);
    for (let index = 0; index < events.length - 1; index += 1) {
      const event = events[index];
      const parsed = parseSseEvent(event);
      for (const value of parsed.data) {
        if (!value || value === '[DONE]') continue;
        try {
          const chunk = JSON.parse(value);
          if (chunk.error) {
            throw new Error('upstream stream error: ' + JSON.stringify(chunk.error).slice(0, 500));
          }
        } catch (error) {
          if (error.message.startsWith('upstream stream error:')) throw error;
        }
      }
      if (eventHasMeaningfulDelta(event)) meaningful = true;
    }
  }

  if (!prefix.trim()) throw new Error('upstream stream ended before first event');
  return {
    kind: 'stream',
    iterator,
    decoder,
    prefix,
    response,
    model: mappedModel(provider, logical, body.model)
  };
}

function sseHeaders(res, extraHeaders) {
  res.writeHead(200, Object.assign({
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  }, extraHeaders || {}));
}

function safeWrite(res, value) {
  try {
    if (!res.destroyed && !res.writableEnded) res.write(value);
  } catch {}
}

function openAIChunk(id, model, delta, finishReason, extra) {
  return Object.assign({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      delta: delta || {},
      finish_reason: finishReason === undefined ? null : finishReason
    }]
  }, extra || {});
}

function usageChunk(id, model, usage) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [],
    usage
  };
}

function fakeOpenAIStream(res, completion, logical, headers) {
  sseHeaders(res, headers);
  const id = completion.id || 'relay-' + crypto.randomUUID();
  const content = completion.choices && completion.choices[0] && completion.choices[0].message
    ? contentText(completion.choices[0].message.content)
    : '';
  const toolCalls = completion.choices && completion.choices[0] && completion.choices[0].message
    ? completion.choices[0].message.tool_calls || []
    : [];
  safeWrite(res, 'data: ' + JSON.stringify(openAIChunk(id, logical, { role: 'assistant', content: '' }, null)) + '\n\n');
  for (let index = 0; index < toolCalls.length; index += 1) {
    const call = toolCalls[index];
    safeWrite(res, 'data: ' + JSON.stringify(openAIChunk(id, logical, {
      tool_calls: [{
        index,
        id: call.id || 'call_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16),
        type: 'function',
        function: {
          name: call.function && call.function.name || call.name || 'tool',
          arguments: call.function && call.function.arguments || call.arguments || '{}'
        }
      }]
    }, null)) + '\n\n');
  }
  for (let index = 0; index < content.length; index += 120) {
    safeWrite(res, 'data: ' + JSON.stringify(openAIChunk(id, logical, { content: content.slice(index, index + 120) }, null)) + '\n\n');
  }
  const finish = toolCalls.length
    ? 'tool_calls'
    : completion.choices && completion.choices[0] && completion.choices[0].finish_reason || 'stop';
  safeWrite(res, 'data: ' + JSON.stringify(openAIChunk(id, logical, {}, finish)) + '\n\n');
  if (completion.usage) {
    safeWrite(res, 'data: ' + JSON.stringify(usageChunk(id, logical, completion.usage)) + '\n\n');
  }
  safeWrite(res, 'data: [DONE]\n\n');
  try {
    res.end();
  } catch {}
}

function anthropicEventsFromCompletion(completion, logical) {
  const id = 'msg_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  const choice = completion.choices && completion.choices[0] || {};
  const message = choice.message || {};
  const text = contentText(message.content);
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const usage = completion.usage || {};
  const events = [
    ['message_start', {
      type: 'message_start',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model: logical,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: usage.prompt_tokens || 0,
          output_tokens: 0,
          cache_read_input_tokens: Number(
            usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens || 0
          ),
          cache_creation_input_tokens: 0
        }
      }
    }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }]
  ];
  for (let index = 0; index < text.length; index += 120) {
    events.push(['content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: text.slice(index, index + 120) }
    }]);
  }
  events.push(['content_block_stop', { type: 'content_block_stop', index: 0 }]);
  for (let index = 0; index < toolCalls.length; index += 1) {
    const call = toolCalls[index];
    let input = {};
    try {
      input = JSON.parse(call.function && call.function.arguments || call.arguments || '{}');
    } catch {
      input = { raw: call.function && call.function.arguments || call.arguments || '' };
    }
    const blockIndex = index + 1;
    events.push(['content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: {
        type: 'tool_use',
        id: call.id || 'tool_' + crypto.randomUUID(),
        name: call.function && call.function.name || call.name || 'tool',
        input: {}
      }
    }]);
    events.push(['content_block_delta', {
      type: 'content_block_delta',
      index: blockIndex,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) }
    }]);
    events.push(['content_block_stop', { type: 'content_block_stop', index: blockIndex }]);
  }
  events.push(['message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: toolCalls.length
        ? 'tool_use'
        : choice.finish_reason === 'length'
          ? 'max_tokens'
          : 'end_turn',
      stop_sequence: null
    },
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
      cache_read_input_tokens: Number(
        usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens || 0
      ),
      cache_creation_input_tokens: 0
    }
  }]);
  events.push(['message_stop', { type: 'message_stop' }]);
  return events;
}


async function collectOpenAIStreamToCompletion(prepared, logical) {
  const decoder = prepared.decoder || new StringDecoder('utf8');
  let buffer = prepared.prefix || '';
  let text = '';
  let reasoning = '';
  const toolCalls = new Map();
  let usage = null;
  let finishReason = null;

  function consume(flush) {
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = flush ? '' : parts.pop();
    for (const raw of parts) {
      if (!raw.trim()) continue;
      for (const value of eventPayloads(raw)) {
        if (!value || value === '[DONE]') continue;
        let chunk;
        try { chunk = JSON.parse(value); } catch { continue; }
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices && chunk.choices[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (delta.content) text += contentText(delta.content);
        if (delta.reasoning) reasoning += String(delta.reasoning);
        if (delta.reasoning_content) reasoning += String(delta.reasoning_content);
        if (Array.isArray(delta.tool_calls)) {
          for (const part of delta.tool_calls) {
            const index = part.index || 0;
            const current = toolCalls.get(index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
            if (part.id) current.id = part.id;
            if (part.function && part.function.name) current.function.name = part.function.name;
            if (part.function && part.function.arguments) current.function.arguments += part.function.arguments;
            toolCalls.set(index, current);
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    }
  }

  consume(false);
  for (;;) {
    const item = await prepared.iterator.next();
    if (item.done) break;
    buffer += decoder.write(item.value);
    consume(false);
  }
  buffer += decoder.end();
  consume(true);

  const message = { role: 'assistant', content: text };
  if (reasoning) message.reasoning = reasoning;
  if (toolCalls.size) {
    message.tool_calls = Array.from(toolCalls.entries())
      .sort((left, right) => left[0] - right[0])
      .map(entry => entry[1]);
  }
  return {
    id: 'relay-' + crypto.randomUUID(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: logical,
    choices: [{
      index: 0,
      message,
      finish_reason: finishReason || (toolCalls.size ? 'tool_calls' : 'stop')
    }],
    usage: usage || estimateUsage({ messages: [] }, text)
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fakeAnthropicStream(res, completion, logical, headers) {
  sseHeaders(res, headers);
  const events = anthropicEventsFromCompletion(completion, logical);
  const usage = completion.usage || {};
  const text = contentText(
    completion.choices && completion.choices[0] && completion.choices[0].message
      ? completion.choices[0].message.content
      : ''
  );
  const outputTokens = Number(usage.completion_tokens || usage.output_tokens || 0) ||
    Math.max(1, Math.round(text.length / 4));
  // 客户端（DSH harness 等）用「首事件到末事件」的时间算 tok/s；
  // 上游是整包返回时，这里按 ~70 tok/s 铺开，避免显示成几十万 tok/s。
  const target = Number(CFG.streamPacing && CFG.streamPacing.tokensPerSecond || 70);
  const maxDelayMs = Number(CFG.streamPacing && CFG.streamPacing.maxDelayMs || 2500);
  const durationMs = Math.min(maxDelayMs, Math.max(150, outputTokens / Math.max(1, target) * 1000));
  const deltas = events.filter(([name]) => name === 'content_block_delta').length || 1;
  const perDelta = durationMs / deltas;
  for (const [name, payload] of events) {
    if (res.writableEnded) break;
    safeWrite(res, 'event: ' + name + '\n' + 'data: ' + JSON.stringify(payload) + '\n\n');
    if (name === 'content_block_delta' && perDelta > 1) await sleep(perDelta);
  }
  try {
    res.end();
  } catch {}
}

function eventPayloads(event) {
  return parseSseEvent(event).data;
}

function stripReasoningFromEvent(rawEvent) {
  const lines = rawEvent.split('\n');
  const out = [];
  for (const line of lines) {
    if (!line.startsWith('data:')) {
      out.push(line);
      continue;
    }
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') {
      out.push(line);
      continue;
    }
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      out.push(line);
      continue;
    }
    let touched = false;
    for (const choice of chunk.choices || []) {
      if (choice.delta && ('reasoning' in choice.delta || 'reasoning_content' in choice.delta)) {
        delete choice.delta.reasoning;
        delete choice.delta.reasoning_content;
        touched = true;
      }
    }
    if (touched) {
      const choice = chunk.choices && chunk.choices[0];
      const delta = choice && choice.delta || {};
      if (!Object.keys(delta).length && !(choice && choice.finish_reason) && !chunk.usage) continue;
    }
    out.push('data: ' + JSON.stringify(chunk));
  }
  return out.join('\n');
}

function forwardOpenAIStream(res, prepared, logical, body, headers, options = {}) {
  sseHeaders(res, headers);
  const decoder = prepared.decoder || new StringDecoder('utf8');
  let buffer = prepared.prefix || '';
  let content = '';
  let usage = null;
  let sawDone = false;
  let started = false;

  function handleCompleteEvents(flush) {
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = flush ? '' : parts.pop();
    for (const rawEvent of parts) {
      if (!rawEvent.trim()) continue;
      const values = eventPayloads(rawEvent);
      let containsDone = false;
      for (const value of values) {
        if (value === '[DONE]') {
          containsDone = true;
          continue;
        }
        try {
          const chunk = JSON.parse(value);
          if (chunk.usage) usage = normalizeUsageFields(chunk.usage);
          const choice = chunk.choices && chunk.choices[0];
          if (choice && choice.delta) {
            content += contentText(choice.delta.content);
            if (choice.delta.reasoning) content += String(choice.delta.reasoning);
            if (choice.delta.tool_calls) content += JSON.stringify(choice.delta.tool_calls);
          }
        } catch {}
      }
      if (containsDone) {
        if (!usage) usage = estimateUsage(body, content);
        if (options.onUsage) options.onUsage(usage);
        const id = 'relay-' + crypto.randomUUID();
        safeWrite(res, 'data: ' + JSON.stringify(usageChunk(id, logical, usage)) + '\n\n');
        safeWrite(res, 'data: [DONE]\n\n');
        sawDone = true;
      } else {
        safeWrite(res, (options.stripReasoning ? stripReasoningFromEvent(rawEvent) : rawEvent) + '\n\n');
      }
    }
    if (flush && buffer.trim()) {
      safeWrite(res, buffer + '\n\n');
      buffer = '';
    }
  }

  if (prepared.prefix) {
    handleCompleteEvents(false);
    started = true;
  }

  return (async () => {
    try {
      for (;;) {
        const item = await prepared.iterator.next();
        if (item.done) break;
        buffer += decoder.write(item.value);
        handleCompleteEvents(false);
        if (sawDone) break;
      }
      buffer += decoder.end();
      if (!sawDone) {
        handleCompleteEvents(true);
        const finalUsage = usage || estimateUsage(body, content);
        if (options.onUsage) options.onUsage(finalUsage);
        safeWrite(res, 'data: ' + JSON.stringify(usageChunk('relay-' + crypto.randomUUID(), logical, finalUsage)) + '\n\n');
        safeWrite(res, 'data: [DONE]\n\n');
      }
    } catch (error) {
      log({ ev: 'stream_interrupted', model: logical, upstream: headers && headers['x-relay-upstream'], error: String(error.message || error) });
      safeWrite(res, 'data: ' + JSON.stringify({
        error: {
          message: 'relay stream interrupted: ' + String(error.message || error),
          type: 'relay_stream_error'
        }
      }) + '\n\n');
      safeWrite(res, 'data: [DONE]\n\n');
    } finally {
      try {
        res.end();
      } catch {}
    }
  })();
}

function tryAgainLater(response, error, attempts) {
  writeJson(response, 503, {
    error: {
      message: 'All upstreams are temporarily unavailable.',
      type: 'relay_unavailable',
      code: 'all_providers_unavailable',
      attempts: (attempts || []).map(item => ({
        provider: item.provider,
        error_code: item.error_code,
        status: item.status
      }))
    }
  });
}

function shouldForceJsonForTools(body) {
  return bodyWantsTools(body) && (!CFG.tools || CFG.tools.forceNonStream !== false);
}

async function tryProvider(provider, logical, body, route, wantStream) {
  const started = Date.now();
  if (provider.type === 'pi-agent') {
    beginProviderAttempt(provider);
    try {
      const raw = await piAgentCompletion(provider, body);
      return {
        provider,
        result: { kind: 'json', raw },
        elapsedMs: Date.now() - started
      };
    } finally {
      endProviderAttempt(provider);
    }
  }
  const keys = orderedKeys(provider);
  const keyAttempts = [];
  beginProviderAttempt(provider);
  try {
    for (let index = 0; index < keys.length; index += 1) {
      const apiKey = keys[index];
      try {
        const forceJson = shouldForceJsonForTools(body);
        if (wantStream && provider.capabilities.stream && !forceJson) {
          const result = await openStreamAttempt(provider, logical, body, route, apiKey);
          return {
            provider,
            result,
            elapsedMs: Date.now() - started
          };
        }
        const raw = await providerJson(provider, logical, body, route, apiKey);
        return {
          provider,
          result: { kind: 'json', raw },
          elapsedMs: Date.now() - started
        };
      } catch (error) {
        const classification = classifyFailure(error);
        keyAttempts.push({
          key: index + 1,
          code: classification.code,
          status: classification.status
        });
        if (
          index + 1 >= keys.length ||
          !['auth', 'rate_limit'].includes(classification.code)
        ) {
          error.keyAttempts = keyAttempts;
          throw error;
        }
      }
    }
    throw new Error('provider has no usable credentials');
  } finally {
    endProviderAttempt(provider);
  }
}

function attemptRecord(provider, error, elapsedMs) {
  const failure = classifyFailure(error);
  return {
    provider: provider.id,
    type: provider.type,
    group: provider.group || null,
    ms: elapsedMs,
    error_code: failure.code,
    status: failure.status,
    error: String(error && error.message || error || 'unknown').slice(0, 400),
    key_attempts: error && error.keyAttempts || undefined
  };
}

async function selectProvider(logical, body, wantStream) {
  const primary = buildCandidates(logical, body);
  let candidates = primary.candidates;
  let lastResort = false;
  if (!candidates.length && primary.definition && primary.definition.allowLastResort) {
    const fallback = buildCandidates(logical, body, { ignoreCircuit: true });
    if (fallback.candidates.length) {
      candidates = fallback.candidates;
      lastResort = true;
    }
  }
  if (!candidates.length) {
    const error = new Error('No compatible provider available');
    error.status = 503;
    error.attempts = [];
    error.skipped = primary.skipped;
    throw error;
  }
  return {
    definition: primary.definition,
    candidates,
    skipped: primary.skipped,
    wantsTools: primary.wantsTools,
    stripTools: primary.stripTools,
    lastResort
  };
}


function applyDefaultLocale(body, logical) {
  const cfg = CFG && CFG.locale;
  if (!cfg || !cfg.default) return;
  const definition = routeDefinition(logical);
  const enabledRoutes = Array.isArray(cfg.routes) && cfg.routes.length ? cfg.routes : ['chat'];
  const isChatRoute = definition && definition.toolPolicy === 'strip';
  const requested = enabledRoutes.indexOf(logical) >= 0 || (isChatRoute && enabledRoutes.indexOf('chat') >= 0);
  if (!requested) return;
  const prompt = cfg.prompt || '除非用户明确要求其他语言，否则一律使用简体中文回答。';
  if (!Array.isArray(body.messages)) body.messages = [];
  const already = body.messages.some(message =>
    message && message.role === 'system' && typeof message.content === 'string' && message.content.indexOf(prompt) >= 0
  );
  if (!already) body.messages.push({ role: 'system', content: prompt });
}

async function handleChat(req, res, body, anthropic) {
  bumpMetric('requests');
  const logical = String(body.model || 'auto');
  body = withReasoningInstruction(body, logical);
  const requestId = req.headers['x-request-id'] || 'relay-' + crypto.randomUUID();
  const wantStream = Boolean(body.stream);
  const started = Date.now();
  applyDefaultLocale(body, logical);
  let selection;

  try {
    selection = await selectProvider(logical, body, wantStream);
  } catch (error) {
    bumpMetric('failures');
    log({
      ev: 'relay_unavailable',
      request_id: requestId,
      model: logical,
      skipped: error.skipped
    });
    return writeJson(res, 503, {
      error: {
        message: 'No compatible AI upstream is currently available.',
        type: 'relay_unavailable',
        code: 'no_candidates',
        skipped: error.skipped || []
      }
    });
  }

  const attempts = [];
  const budgetMs = Number(selection.definition && selection.definition.budgetMs) || 0;
  for (const candidate of selection.candidates) {
    if (budgetMs && Date.now() - started > budgetMs) {
      log({ ev: 'budget_exceeded', request_id: requestId, model: logical, ms: Date.now() - started, budget_ms: budgetMs });
      break;
    }
    const provider = candidate.provider;
    const providerStarted = Date.now();
    try {
      const outcome = await tryProvider(provider, logical, body, selection.definition, wantStream);

      const responseHeaders = {
        'x-request-id': requestId,
        'x-relay-upstream': provider.id,
        'x-relay-attempts': String(attempts.length + 1),
        'x-relay-last-resort': selection.lastResort ? '1' : '0'
      };

      if (outcome.result.kind === 'stream') {
        if (anthropic) {
          // Anthropic 客户端不认 OpenAI chunk，先把上游流收成完整消息再按 message_* 事件回放
          const completion = await collectOpenAIStreamToCompletion(outcome.result, logical);
          {
            const stripped = completion.choices[0].message;
            const fallback = String(stripped.reasoning || stripped.reasoning_content || '').trim();
            if (selection.stripTools) {
              delete stripped.reasoning;
              delete stripped.reasoning_content;
            }
            if (!contentText(stripped.content).trim() && fallback) stripped.content = fallback;
          }
          markSuccess(provider, outcome.elapsedMs, completion.usage);
          if (bodyWantsTools(body)) {
            const toolState = stateFor(provider.id);
            toolState.toolAttempts = (toolState.toolAttempts || 0) + 1;
            if ((completion.choices[0].message.tool_calls || []).length) {
              toolState.toolSuccesses = (toolState.toolSuccesses || 0) + 1;
            }
          }
          bumpMetric('successes');
          bumpMetric('streams');
          log({
            ev: 'ok',
            api: 'messages',
            request_id: requestId,
            model: logical,
            provider: provider.id,
            stream: true,
            attempts: attempts.length,
            ms: Date.now() - started,
            ...usageLogFields(completion.usage)
          });
          return fakeAnthropicStream(res, completion, logical, responseHeaders);
        }
        markSuccess(provider, outcome.elapsedMs);
        bumpMetric('successes');
        bumpMetric('streams');
        log({
          ev: 'ok',
          request_id: requestId,
          model: logical,
          provider: provider.id,
          stream: true,
          attempts: attempts.length,
          ms: Date.now() - started
        });
        return forwardOpenAIStream(res, outcome.result, logical, body, responseHeaders, {
          stripReasoning: selection.stripTools,
          onUsage: usage => addUsage(provider.id, usage)
        });
      }

      const completion = normalizeCompletion(outcome.result.raw, logical, provider.id, body);
      {
        const stripped = completion.choices && completion.choices[0] && completion.choices[0].message;
        if (stripped) {
          const fallback = String(stripped.reasoning || stripped.reasoning_content || '').trim();
          if (selection.stripTools) {
            delete stripped.reasoning;
            delete stripped.reasoning_content;
          }
          // 正文为空但模型只在 reasoning 里说话时，回退成正文：
          // 避免客户端拿到空回答，也避免 tok/s 用 0 时长算出天文数字。
          if (!contentText(stripped.content).trim() && fallback) stripped.content = fallback;
        }
      }
      if (
        bodyWantsTools(body) &&
        !(completion.choices && completion.choices[0] &&
          (completion.choices[0].message.tool_calls || []).length) &&
        !contentText(completion.choices && completion.choices[0] &&
          completion.choices[0].message.content).trim()
      ) {
        throw new Error('empty tool response');
      }
      markSuccess(provider, outcome.elapsedMs, completion.usage);
      if (bodyWantsTools(body)) {
        const toolState = stateFor(provider.id);
        toolState.toolAttempts = (toolState.toolAttempts || 0) + 1;
        if ((completion.choices && completion.choices[0] && completion.choices[0].message.tool_calls || []).length) {
          toolState.toolSuccesses = (toolState.toolSuccesses || 0) + 1;
        }
      }
      bumpMetric('successes');
      if (wantStream) bumpMetric('streams');
      if (completion.usage && completion.usage.estimated) bumpMetric('estimatedUsage');
      log({
        ev: 'ok',
        request_id: requestId,
        model: logical,
        provider: provider.id,
        stream: wantStream,
        attempts: attempts.length,
        ms: Date.now() - started,
        request_tools: Array.isArray(body.tools) ? body.tools.length : 0,
        request_tool_names: Array.isArray(body.tools)
          ? body.tools.map(tool => tool.function && tool.function.name || tool.name).filter(Boolean).slice(0, 30)
          : [],
        finish_reason: completion.choices && completion.choices[0]
          ? completion.choices[0].finish_reason
          : null,
        content_chars: completion.choices && completion.choices[0] && completion.choices[0].message
          ? contentText(completion.choices[0].message.content).length
          : 0,
        reasoning_chars: completion.choices && completion.choices[0] && completion.choices[0].message
          ? String(completion.choices[0].message.reasoning || completion.choices[0].message.reasoning_content || '').length
          : 0,
        tool_calls: completion.choices &&
          completion.choices[0] &&
          completion.choices[0].message &&
          Array.isArray(completion.choices[0].message.tool_calls)
          ? completion.choices[0].message.tool_calls.length
          : 0,
        usage_estimated: Boolean(completion.usage && completion.usage.estimated),
        ...usageLogFields(completion.usage)
      });
      if (anthropic) {
        if (wantStream) return fakeAnthropicStream(res, completion, logical, responseHeaders);
        return writeJson(res, 200, openAIToAnthropic(completion, logical, provider.id), responseHeaders);
      }
      if (wantStream) return fakeOpenAIStream(res, completion, logical, responseHeaders);
      return writeJson(res, 200, completion, responseHeaders);
    } catch (error) {
      const elapsedMs = Date.now() - providerStarted;
      markFailure(provider, error, elapsedMs);
      const attempt = attemptRecord(provider, error, elapsedMs);
      attempts.push(attempt);
      log({
        ev: 'fail',
        request_id: requestId,
        model: logical,
        provider: provider.id,
        ms: elapsedMs,
        error_code: attempt.error_code,
        status: attempt.status
      });
    }
  }

  log({
    ev: 'relay_error',
    request_id: requestId,
    model: logical,
    ms: Date.now() - started,
    attempts
  });
  bumpMetric('failures');
  tryAgainLater(res, new Error('All providers failed'), attempts);
}

// ---------------------------------------------------------------------------
// OpenAI Responses API 兼容层
// Codex CLI 只支持 wire_api="responses"，这里把 Responses 请求翻译成内部的
// chat.completions 管线（免费池、熔断、工具桥全部复用），再把结果还原成事件流。
// ---------------------------------------------------------------------------

function responsesContentParts(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : String(content);
  const parts = [];
  for (const part of content) {
    if (!part) continue;
    if (typeof part === 'string') {
      parts.push({ type: 'text', text: part });
      continue;
    }
    if (part.text !== undefined) {
      parts.push({ type: 'text', text: String(part.text) });
      continue;
    }
    if (part.type === 'input_image' || part.type === 'image_url') {
      const url = part.image_url && (part.image_url.url || part.image_url) || part.url;
      if (url) parts.push({ type: 'image_url', image_url: { url: String(url) } });
    }
  }
  if (!parts.length) return '';
  if (parts.every(part => part.type === 'text')) return parts.map(part => part.text).join('');
  return parts;
}

function responsesReasoningText(item) {
  const chunks = [];
  for (const part of Array.isArray(item.summary) ? item.summary : []) {
    if (part && typeof part.text === 'string') chunks.push(part.text);
  }
  for (const part of Array.isArray(item.content) ? item.content : []) {
    if (part && typeof part.text === 'string') chunks.push(part.text);
  }
  return chunks.join('\n').trim();
}

function responsesInputToMessages(body) {
  const messages = [];
  const instructions = typeof body.instructions === 'string' ? body.instructions.trim() : '';
  if (instructions) messages.push({ role: 'system', content: instructions });
  const input = body.input;
  const items = typeof input === 'string'
    ? [{ role: 'user', content: input }]
    : (Array.isArray(input) ? input : []);
  for (const item of items) {
    if (!item) continue;
    if (typeof item === 'string') {
      messages.push({ role: 'user', content: item });
      continue;
    }
    const type = item.type || (item.role ? 'message' : '');
    if (type === 'message' || (!type && item.role)) {
      const role = item.role === 'developer' ? 'system' : (item.role || 'user');
      messages.push({ role, content: responsesContentParts(item.content) });
      continue;
    }
    if (type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: item.call_id || item.id || 'call_' + crypto.randomUUID(),
          type: 'function',
          function: {
            name: item.name || '',
            arguments: typeof item.arguments === 'string'
              ? item.arguments
              : JSON.stringify(item.arguments || {})
          }
        }]
      });
      continue;
    }
    if (type === 'custom_tool_call') {
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: item.call_id || item.id || 'call_' + crypto.randomUUID(),
          type: 'function',
          function: {
            name: item.name || '',
            arguments: JSON.stringify({ input: item.input == null ? '' : String(item.input) })
          }
        }]
      });
      continue;
    }
    if (type === 'custom_tool_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id || item.id || '',
        content: typeof item.output === 'string'
          ? item.output
          : JSON.stringify(item.output == null ? '' : item.output)
      });
      continue;
    }
    if (type === 'function_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id || item.id || '',
        content: typeof item.output === 'string'
          ? item.output
          : JSON.stringify(item.output == null ? '' : item.output)
      });
      continue;
    }
    if (type === 'reasoning') {
      // 上一轮的思考摘要回填为 assistant 上下文，保证多轮连续推演
      const previous = responsesReasoningText(item);
      if (previous) messages.push({ role: 'assistant', content: '（上一轮思考摘要，继续沿用）\n' + previous });
    }
    // item_reference 等类型上游不认，直接丢弃
  }
  return messages;
}

function responsesToolsToChat(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  const output = [];
  for (const tool of tools) {
    if (!tool) continue;
    const type = tool.type || 'function';
    if (type === 'function' && tool.name) {
      output.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: tool.parameters || { type: 'object', properties: {} }
        }
      });
      continue;
    }
    if (type === 'custom' && tool.name) {
      // freeform 工具（如 apply_patch）包成单字符串参数的 function
      output.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: {
            type: 'object',
            properties: { input: { type: 'string', description: 'raw tool input' } },
            required: ['input']
          }
        }
      });
      continue;
    }
    if (type === 'local_shell') {
      output.push({
        type: 'function',
        function: {
          name: 'local_shell',
          description: 'Run a command on the local machine',
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'array', items: { type: 'string' }, description: 'argv' },
              workdir: { type: 'string' }
            },
            required: ['command']
          }
        }
      });
    }
  }
  return output.length ? output : undefined;
}

function responsesToolChoice(choice) {
  if (choice == null) return undefined;
  if (typeof choice === 'string') {
    return ['auto', 'none', 'required'].includes(choice) ? choice : undefined;
  }
  if (choice.type === 'function' && choice.name) {
    return { type: 'function', function: { name: choice.name } };
  }
  return undefined;
}

const RESPONSE_STORE = new Map();
const RESPONSE_STORE_LIMIT = 64;

function rememberResponse(id, messages) {
  if (!id) return;
  RESPONSE_STORE.set(id, { messages: messages.slice(), at: Date.now() });
  while (RESPONSE_STORE.size > RESPONSE_STORE_LIMIT) {
    const oldest = RESPONSE_STORE.keys().next().value;
    RESPONSE_STORE.delete(oldest);
  }
}

function responsesRequestToChat(body) {
  const chat = {
    model: String(body.model || 'tools'),
    messages: [],
    stream: false
  };
  if (body.previous_response_id && RESPONSE_STORE.has(body.previous_response_id)) {
    chat.messages = RESPONSE_STORE.get(body.previous_response_id).messages.slice();
  }
  chat.messages = chat.messages.concat(responsesInputToMessages(body));
  const tools = responsesToolsToChat(body.tools);
  const customNames = Array.isArray(body.tools)
    ? body.tools.filter(tool => tool && tool.type === 'custom' && tool.name).map(tool => tool.name)
    : [];
  if (customNames.length) chat.__customTools = customNames;
  if (tools) {
    chat.tools = tools;
    const toolChoice = responsesToolChoice(body.tool_choice);
    if (toolChoice !== undefined) chat.tool_choice = toolChoice;
    if (body.parallel_tool_calls !== undefined) chat.parallel_tool_calls = body.parallel_tool_calls;
  }
  const format = body.text && body.text.format || body.response_format;
  if (format) {
    if (format.type === 'json_schema') {
      chat.response_format = {
        type: 'json_schema',
        json_schema: {
          name: format.name || 'response',
          schema: format.schema || {},
          strict: format.strict !== false
        }
      };
    } else if (format.type === 'json_object') {
      chat.response_format = { type: 'json_object' };
    }
  }
  if (Number.isFinite(Number(body.temperature))) chat.temperature = Number(body.temperature);
  if (Number.isFinite(Number(body.top_p))) chat.top_p = Number(body.top_p);
  if (Number.isFinite(Number(body.max_output_tokens))) chat.max_tokens = Number(body.max_output_tokens);
  chat.__include = Array.isArray(body.include) ? body.include.slice() : [];
  chat.__store = body.store !== false;
  // 纯对话池（toolPolicy=strip）不注入也不回传思维链
  const definition = routeDefinition(chat.model);
  const hideReasoning = definition
    ? definition.toolPolicy === 'strip'
    : chat.model === 'chat';
  chat.__hideReasoning = hideReasoning;
  const reasoning = body.reasoning || {};
  const effort = typeof reasoning.effort === 'string' ? reasoning.effort : '';
  if (!hideReasoning && effort && effort !== 'none') {
    chat.messages.push({
      role: 'system',
      content:
        '在回答前先在心里完成尽可能完整的推理：拆解问题、分步验证、必要时自我反驳，' +
        '然后把推理过程与结论分开。推理预算：' + effort + '。' +
        (Array.isArray(body.input)
          ? '如果这是多轮任务的延续，接着上一轮的思考摘要继续，不要重头再来。'
          : '')
    });
  }
  return chat;
}

function responsesUsage(usage) {
  const input = Number(usage && (usage.prompt_tokens || usage.input_tokens) || 0);
  const output = Number(usage && (usage.completion_tokens || usage.output_tokens) || 0);
  const total = Number(usage && usage.total_tokens || (input + output));
  const cached = Number(
    usage && usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens ||
    usage && usage.input_tokens_details && usage.input_tokens_details.cached_tokens || 0
  );
  const reasoning = Number(
    usage && usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens ||
    usage && usage.output_tokens_details && usage.output_tokens_details.reasoning_tokens || 0
  );
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: cached },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: reasoning },
    total_tokens: total
  };
}

function responseFromCompletion(completion, request, options = {}) {
  const choice = completion.choices && completion.choices[0] || {};
  const message = choice.message || {};
  const rawText = contentText(message.content);
  const fallbackText = String(message.reasoning || message.reasoning_content || '').trim();
  const text = rawText.trim() ? rawText : fallbackText;
  const output = [];
  const customTools = options.customTools instanceof Set
    ? options.customTools
    : new Set(options.customTools || []);
  const include = Array.isArray(options.include) ? options.include : [];
  const reasoningText = String(message.reasoning || message.reasoning_content || '').trim();
  if (reasoningText && !options.hideReasoning) {
    const item = {
      type: 'reasoning',
      id: 'rs_' + crypto.randomUUID().replace(/-/g, ''),
      status: 'completed',
      summary: [{ type: 'summary_text', text: reasoningText }]
    };
    if (include.includes('reasoning.encrypted_content')) {
      item.encrypted_content = Buffer.from(reasoningText, 'utf8').toString('base64');
    }
    output.push(item);
  }
  if (text) {
    output.push({
      type: 'message',
      id: 'msg_' + crypto.randomUUID().replace(/-/g, ''),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }]
    });
  }
  for (const call of message.tool_calls || []) {
    const name = call.function && call.function.name || '';
    const args = call.function && call.function.arguments || '{}';
    const callId = call.id || 'call_' + crypto.randomUUID().replace(/-/g, '');
    if (customTools.has(name)) {
      let input = args;
      try {
        const parsed = JSON.parse(args);
        if (parsed && typeof parsed.input === 'string') input = parsed.input;
      } catch {}
      output.push({
        type: 'custom_tool_call',
        id: 'ctc_' + crypto.randomUUID().replace(/-/g, ''),
        call_id: callId,
        name,
        input,
        status: 'completed'
      });
      continue;
    }
    output.push({
      type: 'function_call',
      id: 'fc_' + crypto.randomUUID().replace(/-/g, ''),
      call_id: callId,
      name,
      arguments: args,
      status: 'completed'
    });
  }
  const incomplete = choice.finish_reason === 'length';
  return {
    id: 'resp_' + crypto.randomUUID().replace(/-/g, ''),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: incomplete ? 'incomplete' : 'completed',
    incomplete_details: incomplete ? { reason: 'max_output_tokens' } : undefined,
    model: String(request.model || 'tools'),
    output,
    output_text: text,
    parallel_tool_calls: request.parallel_tool_calls !== false,
    tool_choice: typeof request.tool_choice === 'string' ? request.tool_choice : 'auto',
    tools: [],
    usage: responsesUsage(completion.usage),
    relay: completion.relay
  };
}

function writeResponsesEvent(res, event) {
  const payload = JSON.stringify(Object.assign({ sequence_number: 0 }, event));
  safeWrite(res, 'event: ' + event.type + '\ndata: ' + payload + '\n\n');
}

function textPieces(text, size = 96) {
  const pieces = [];
  for (let index = 0; index < text.length; index += size) pieces.push(text.slice(index, index + size));
  return pieces.length ? pieces : [''];
}

function streamResponses(res, response, headers) {
  sseHeaders(res, headers);
  const inProgress = Object.assign({}, response, { status: 'in_progress', output: [], usage: null });
  writeResponsesEvent(res, { type: 'response.created', response: inProgress });
  let index = 0;
  for (const item of response.output) {
    if (item.type === 'message') {
      writeResponsesEvent(res, {
        type: 'response.output_item.added',
        output_index: index,
        item: Object.assign({}, item, { status: 'in_progress', content: [] })
      });
      writeResponsesEvent(res, {
        type: 'response.content_part.added',
        item_id: item.id,
        output_index: index,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] }
      });
      for (const piece of textPieces(item.content[0].text)) {
        writeResponsesEvent(res, {
          type: 'response.output_text.delta',
          item_id: item.id,
          output_index: index,
          content_index: 0,
          delta: piece
        });
      }
      writeResponsesEvent(res, {
        type: 'response.output_text.done',
        item_id: item.id,
        output_index: index,
        content_index: 0,
        text: item.content[0].text
      });
      writeResponsesEvent(res, {
        type: 'response.content_part.done',
        item_id: item.id,
        output_index: index,
        content_index: 0,
        part: item.content[0]
      });
      writeResponsesEvent(res, { type: 'response.output_item.done', output_index: index, item });
    } else if (item.type === 'reasoning') {
      writeResponsesEvent(res, {
        type: 'response.output_item.added',
        output_index: index,
        item: Object.assign({}, item, { status: 'in_progress', summary: [] })
      });
      writeResponsesEvent(res, {
        type: 'response.reasoning_summary_part.added',
        item_id: item.id,
        output_index: index,
        summary_index: 0,
        part: { type: 'summary_text', text: '' }
      });
      for (const piece of textPieces(item.summary[0].text)) {
        writeResponsesEvent(res, {
          type: 'response.reasoning_summary_text.delta',
          item_id: item.id,
          output_index: index,
          summary_index: 0,
          delta: piece
        });
      }
      writeResponsesEvent(res, {
        type: 'response.reasoning_summary_text.done',
        item_id: item.id,
        output_index: index,
        summary_index: 0,
        text: item.summary[0].text
      });
      writeResponsesEvent(res, {
        type: 'response.reasoning_summary_part.done',
        item_id: item.id,
        output_index: index,
        summary_index: 0,
        part: item.summary[0]
      });
      writeResponsesEvent(res, { type: 'response.output_item.done', output_index: index, item });
    } else {
      writeResponsesEvent(res, {
        type: 'response.function_call_arguments.delta',
        item_id: item.id,
        output_index: index,
        delta: item.arguments
      });
      writeResponsesEvent(res, {
        type: 'response.function_call_arguments.done',
        item_id: item.id,
        output_index: index,
        arguments: item.arguments
      });
      writeResponsesEvent(res, { type: 'response.output_item.done', output_index: index, item });
    }
    index += 1;
  }
  writeResponsesEvent(res, { type: 'response.completed', response });
  res.end();
}

async function handleResponses(req, res, body) {
  bumpMetric('requests');
  const requestId = req.headers['x-request-id'] || 'relay-' + crypto.randomUUID();
  const chat = responsesRequestToChat(body);
  if (!chat.messages.length) {
    return writeJson(res, 400, {
      error: { message: 'input is required', type: 'invalid_request_error', code: 'missing_input' }
    });
  }
  const logical = chat.model;
  applyDefaultLocale(chat, logical);
  const started = Date.now();
  let selection;
  try {
    selection = await selectProvider(logical, chat, false);
  } catch (error) {
    bumpMetric('failures');
    log({ ev: 'relay_unavailable', api: 'responses', request_id: requestId, model: logical });
    return writeJson(res, 503, {
      error: {
        message: 'No compatible AI upstream is currently available.',
        type: 'relay_unavailable',
        code: 'no_candidates'
      }
    });
  }

  const attempts = [];
  const budgetMs = Number(selection.definition && selection.definition.budgetMs) || 0;
  for (const candidate of selection.candidates) {
    if (budgetMs && Date.now() - started > budgetMs) {
      log({ ev: 'budget_exceeded', api: 'responses', request_id: requestId, model: logical, ms: Date.now() - started, budget_ms: budgetMs });
      break;
    }
    const provider = candidate.provider;
    const providerStarted = Date.now();
    try {
      const outcome = await tryProvider(provider, logical, chat, selection.definition, false);
      const completion = normalizeCompletion(outcome.result.raw, logical, provider.id, chat);
      const message = completion.choices[0] && completion.choices[0].message || {};
      if (
        bodyWantsTools(chat) &&
        !(message.tool_calls || []).length &&
        !contentText(message.content).trim()
      ) {
        throw new Error('empty tool response');
      }
      markSuccess(provider, outcome.elapsedMs, completion.usage);
      bumpMetric('successes');
      const response = responseFromCompletion(completion, body, {
        customTools: chat.__customTools,
        include: chat.__include,
        hideReasoning: chat.__hideReasoning
      });
      if (chat.__store) {
        const assistantMessage = { role: 'assistant', content: message.content || '' };
        if ((message.tool_calls || []).length) assistantMessage.tool_calls = message.tool_calls;
        rememberResponse(response.id, chat.messages.concat([assistantMessage]));
      }
      const headers = {
        'x-request-id': requestId,
        'x-relay-upstream': provider.id,
        'x-relay-attempts': String(attempts.length + 1),
        'x-relay-last-resort': selection.lastResort ? '1' : '0'
      };
      log({
        ev: 'ok',
        api: 'responses',
        request_id: requestId,
        model: logical,
        provider: provider.id,
        stream: Boolean(body.stream),
        attempts: attempts.length,
        ms: Date.now() - started,
        tool_calls: (message.tool_calls || []).length,
        ...usageLogFields(completion.usage)
      });
      if (body.stream) return streamResponses(res, response, headers);
      return writeJson(res, 200, response, headers);
    } catch (error) {
      const elapsedMs = Date.now() - providerStarted;
      markFailure(provider, error, elapsedMs);
      attempts.push(attemptRecord(provider, error, elapsedMs));
      log({
        ev: 'fail',
        api: 'responses',
        request_id: requestId,
        model: logical,
        provider: provider.id,
        ms: elapsedMs,
        error: String(error && error.message || error).slice(0, 300)
      });
    }
  }

  bumpMetric('failures');
  log({ ev: 'relay_error', api: 'responses', request_id: requestId, model: logical, attempts });
  return writeJson(res, 503, {
    error: {
      message: 'All upstreams are temporarily unavailable.',
      type: 'relay_unavailable',
      code: 'upstreams_failed',
      attempts: (attempts || []).map(item => ({
        provider: item.provider,
        error_code: item.error_code,
        status: item.status
      }))
    }
  });
}

function anthropicToOpenAI(body) {
  const messages = [];
  if (body.system) {
    const systemText = Array.isArray(body.system)
      ? body.system.map(block => block.text || '').join('\n')
      : String(body.system);
    if (systemText) messages.push({ role: 'system', content: systemText });
  }

  for (const message of body.messages || []) {
    const content = message.content;
    if (typeof content === 'string') {
      messages.push({ role: message.role, content });
      continue;
    }
    const text = [];
    const toolCalls = [];
    for (const block of content || []) {
      if (!block) continue;
      if (block.type === 'text') text.push(block.text || '');
      if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id || 'tool_' + crypto.randomUUID(),
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input || {})
          }
        });
      }
      if (block.type === 'tool_result') {
        messages.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '')
        });
      }
    }
    if (text.length || toolCalls.length) {
      const converted = {
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: text.join('')
      };
      if (toolCalls.length) converted.tool_calls = toolCalls;
      messages.push(converted);
    }
  }

  const thinking = body.thinking || null;
  const effort = (thinking && thinking.type === 'enabled')
    ? (thinking.budget_tokens && thinking.budget_tokens >= 8000 ? 'high' : 'medium')
    : (body.reasoning_effort || '');
  if (effort) {
    messages.unshift({
      role: 'system',
      content: '先在心里完成完整推理（拆解、验证、必要时自我反驳），再给出结论。推理预算：' + effort + '。'
    });
  }
  const output = {
    model: body.model || 'auto',
    messages,
    stream: Boolean(body.stream)
  };
  if (body.max_tokens !== undefined) output.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) output.temperature = body.temperature;
  if (body.top_p !== undefined) output.top_p = body.top_p;
  if (body.stop_sequences) output.stop = body.stop_sequences;
  if (Array.isArray(body.tools) && body.tools.length) {
    output.tools = body.tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.input_schema || { type: 'object', properties: {} }
      }
    }));
    if (body.tool_choice) {
      if (body.tool_choice.type === 'tool') {
        output.tool_choice = {
          type: 'function',
          function: { name: body.tool_choice.name }
        };
      } else if (body.tool_choice.type === 'any') {
        output.tool_choice = 'required';
      } else {
        output.tool_choice = 'auto';
      }
    }
  }
  return withReasoningInstruction(output, body.model || 'auto');
}

function openAIToAnthropic(completion, logical, providerId) {
  const choice = completion.choices && completion.choices[0] || {};
  const message = choice.message || {};
  const content = [];
  if (message.content) content.push({ type: 'text', text: contentText(message.content) });
  for (const call of message.tool_calls || []) {
    let input = {};
    try {
      input = JSON.parse(call.function && call.function.arguments || '{}');
    } catch {
      input = { raw: call.function && call.function.arguments || '' };
    }
    content.push({
      type: 'tool_use',
      id: call.id || 'tool_' + crypto.randomUUID(),
      name: call.function && call.function.name || 'tool',
      input
    });
  }
  const usage = completion.usage || {};
  return {
    id: 'msg_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24),
    type: 'message',
    role: 'assistant',
    model: logical,
    content: content.length ? content : [{ type: 'text', text: '' }],
    stop_reason: message.tool_calls && message.tool_calls.length
      ? 'tool_use'
      : choice.finish_reason === 'length'
        ? 'max_tokens'
        : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
      cache_read_input_tokens: Number(
        usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens || 0
      ),
      cache_creation_input_tokens: 0
    },
    relay: { upstream: providerId }
  };
}

function providerView(provider) {
  const state = stateFor(provider.id);
  const circuit = state.openUntil > Date.now()
    ? 'open'
    : state.state === 'half-open'
      ? 'half-open'
      : 'closed';
  return {
    id: provider.id,
    label: provider.label || provider.id,
    type: provider.type,
    enabled: provider.enabled,
    disabled_reason: provider.disabledReason || null,
    pools: provider.pools,
    capabilities: provider.capabilities,
    keys: provider.keys.length,
    circuit,
    retry_at: state.openUntil > Date.now() ? new Date(state.openUntil).toISOString() : null,
    successes: state.successes,
    failures: state.failures,
    tokens: state.tokens ? { prompt: state.tokens.prompt, completion: state.tokens.completion, total: state.tokens.total, cached: state.tokens.cached, reasoning: state.tokens.reasoning } : null,
    attempts: state.attempts,
    in_flight: state.inFlight,
    avg_latency_ms: state.avgLatencyMs,
    last_latency_ms: state.lastLatencyMs,
    tool_attempts: state.toolAttempts || 0,
    tool_successes: state.toolSuccesses || 0,
    tool_success_rate: state.toolAttempts ? Math.round((state.toolSuccesses || 0) / state.toolAttempts * 100) : null,
    last_ok_at: state.lastOkAt,
    last_attempt_at: state.lastAttemptAt,
    last_probe_at: state.lastProbeAt,
    last_probe_ok_at: state.lastProbeOkAt,
    last_probe_error: state.lastProbeError,
    probe_failures: state.probeFailures,
    last_error_code: state.lastErrorCode,
    last_error: state.lastError
  };
}

function poolView() {
  const providersByPool = { tools: [], chat: [] };
  for (const provider of providers) {
    if (!provider.enabled) continue;
    for (const pool of provider.pools) {
      if (providersByPool[pool] && !providersByPool[pool].includes(provider.id)) {
        providersByPool[pool].push(provider.id);
      }
    }
  }
  return providersByPool;
}

function providerSetupView() {
  return providerCatalog.map(item => {
    const provider = providerById.get(item.id);
    const requiresKey = Boolean(provider && provider.authConfigured && !provider.optionalAuth);
    const credentialReady = Boolean(provider && (!requiresKey || provider.keys.length));
    return Object.assign({}, item, {
      providerExists: Boolean(provider),
      configured: Boolean(provider && provider.keys.length),
      requiresKey,
      credentialReady,
      toggleable: Boolean(provider && provider.endpoint && credentialReady),
      enabled: Boolean(provider && provider.enabled),
      disabledReason: provider ? provider.disabledReason || null : 'catalog_only',
      pools: provider ? provider.pools : item.pools || ['chat']
    });
  });
}

function providerSetupSummary() {
  const items = providerSetupView();
  return {
    total: items.length,
    implemented: items.filter(item => item.providerExists).length,
    configured: items.filter(item => item.configured).length,
    active: items.filter(item => item.enabled).length,
    pending: items.filter(item => item.providerExists && !item.enabled).length,
    guideOnly: items.filter(item => !item.providerExists).length
  };
}

async function validateProviderCredential(provider) {
  if (!provider || !provider.enabled || !provider.keys.length) {
    return { status: 'not_enabled', ok: false };
  }
  if (provider.validationMode === 'chat') {
    try {
      const validationBody = {
        model: provider.modelMap.auto || provider.defaultModel || provider.modelMap.chat,
        messages: [{
          role: 'user',
          content: 'Reply with OK.'
        }],
        max_tokens: provider.validationMaxTokens,
        stream: false
      };
      const target = resolveTarget(provider, provider.keys[0]);
      const response = await request(target.url, {
        method: 'POST',
        headers: headersWithContentType(authHeaders(provider, target.key)),
        body: JSON.stringify(validationBody),
        timeoutMs: Math.min(45000, provider.timeoutMs),
        proxy: provider.proxy || null,
        family: provider.family || 4
      });
      const text = await readAll(response.stream, 2 * 1024 * 1024);
      if (response.status < 200 || response.status >= 300) {
        return { status: 'failed', ok: false, httpStatus: response.status, message: text.slice(0, 300) };
      }
      return {
        status: 'ready',
        ok: true,
        httpStatus: response.status,
        mode: 'chat',
        model: validationBody.model
      };
    } catch (error) {
      return { status: 'failed', ok: false, message: String(error.message || error).slice(0, 300) };
    }
  }
  if (!provider.healthUrl) {
    return { status: 'unverified', ok: true };
  }
  try {
    const response = await request(provider.healthUrl, {
      method: 'GET',
      headers: authHeaders(provider, provider.keys[0]),
      timeoutMs: Math.min(30000, provider.timeoutMs),
      family: provider.family || 4
    });
    const text = await readAll(response.stream, 2 * 1024 * 1024);
    if (response.status < 200 || response.status >= 300) {
      return { status: 'failed', ok: false, httpStatus: response.status, message: text.slice(0, 300) };
    }
    return { status: 'ready', ok: true, httpStatus: response.status };
  } catch (error) {
    return { status: 'failed', ok: false, message: String(error.message || error).slice(0, 300) };
  }
}

function healthView() {
  const upstreams = providers.map(providerView);
  const ready = upstreams.some(provider => provider.enabled && provider.circuit !== 'open');
  return {
    ok: ready,
    live: true,
    service: 'ai-relay',
    version: 3,
    uptime_s: Math.floor((Date.now() - STARTED_AT) / 1000),
    routes: Object.keys(routes),
    upstreams
  };
}

function loadConfiguration(file = DEFAULT_CONFIG) {
  const next = readConfigWithExtends(file);
  if (!next || !Number.isFinite(Number(next.port))) throw new Error('config.port must be numeric');
  if (!next.routes || typeof next.routes !== 'object') throw new Error('config.routes is required');
  if (!Array.isArray(next.providers)) throw new Error('config.providers is required');

  credentialValues = next.credentialsFile && next.credentialsKeyFile
    ? decryptCredentialStore(next.credentialsFile, next.credentialsKeyFile)
    : new Map();
  const catalog = next.providerCatalogFile
    ? readJsonIfExists(next.providerCatalogFile, { providers: [] })
    : { providers: [] };
  providerCatalog = Array.isArray(catalog.providers) ? catalog.providers : [];
  providerSettings = readProviderSettings(next.providerSettingsFile);

  const nextProviders = next.providers.map(normalizeProvider);
  const seen = new Set();
  for (const provider of nextProviders) {
    if (seen.has(provider.id)) throw new Error('duplicate provider id: ' + provider.id);
    seen.add(provider.id);
  }
  for (const [name, definition] of Object.entries(next.routes)) {
    const chain = Array.isArray(definition) ? definition : definition.chain;
    if (!Array.isArray(chain)) {
      if (definition && definition.alias && next.routes[definition.alias]) continue;
      throw new Error('route ' + name + ' requires a chain or valid alias');
    }
    for (const id of chain) {
      if (!seen.has(id)) throw new Error('route ' + name + ' references unknown provider: ' + id);
    }
  }

  const token = next.token
    ? String(next.token)
    : next.tokenFile
      ? readTextFile(next.tokenFile)
      : '';
  if (!token) throw new Error('gateway token is missing');

  CFG = next;
  TOKEN = token;
  providers = nextProviders;
  providerById = new Map(providers.map(provider => [provider.id, provider]));
  routes = next.routes;
  const nextState = new Map();
  for (const provider of providers) {
    nextState.set(provider.id, stateById.get(provider.id) || newProviderState(provider.id));
  }
  stateById = nextState;

  for (const provider of providers) {
    if (!provider.enabled) {
      log({ ev: 'provider_disabled', provider: provider.id, reason: provider.disabledReason });
    }
  }
  return CFG;
}

function resetCircuits() {
  for (const state of stateById.values()) {
    state.state = 'closed';
    state.failures = 0;
    state.openUntil = 0;
    state.probing = false;
    state.lastError = null;
    state.lastErrorCode = null;
  }
}

function markProbeOk(provider) {
  const state = stateFor(provider.id);
  state.lastProbeAt = nowIso();
  state.lastProbeOkAt = state.lastProbeAt;
  state.lastProbeError = null;
  state.probeFailures = 0;
  if (
    state.state === 'open' &&
    ['network', 'upstream_5xx', 'unknown'].includes(state.lastErrorCode)
  ) {
    state.state = 'closed';
    state.openUntil = 0;
    state.probing = false;
    log({ ev: 'provider_probe_recovered', provider: provider.id });
  }
}

function markProbeFailure(provider, error) {
  const state = stateFor(provider.id);
  state.lastProbeAt = nowIso();
  state.lastProbeError = String(error && error.message || error || 'probe failed').slice(0, 300);
  state.probeFailures += 1;
  const threshold = Number(CFG.healthProbeFailThreshold || 3);
  if (state.state !== 'open' && state.probeFailures >= threshold) {
    openCircuit(state, provider, Number(CFG.circuit && CFG.circuit.openMs || 60000));
    state.lastErrorCode = 'network';
    state.lastError = state.lastProbeError;
    log({ ev: 'provider_probe_open', provider: provider.id, error: state.lastProbeError });
  }
}

async function probeProvider(provider) {
  if (!provider.enabled || !provider.healthUrl) return;
  const keys = orderedKeys(provider);
  const apiKey = keys[0] || null;
  try {
    const target = resolveTarget(provider, apiKey, provider.healthUrl);
    const response = await request(target.url, {
      method: 'GET',
      headers: authHeaders(provider, target.key),
      timeoutMs: Math.min(30000, provider.timeoutMs),
      proxy: provider.proxy || null,
      family: provider.family || 4
    });
    const text = await readAll(response.stream, 2 * 1024 * 1024);
    if (response.status < 200 || response.status >= 300) {
      throw errorFromStatus(response.status, text, response.headers);
    }
    markProbeOk(provider);
  } catch (error) {
    markProbeFailure(provider, error);
  }
}

function startHealthProbes() {
  const interval = Number(CFG.healthProbeIntervalMs || 120000);
  if (!interval || interval < 15000) return null;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      for (const provider of providers) {
        if (provider.healthUrl) await probeProvider(provider);
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(run, interval);
  timer.unref();
  const warmup = setTimeout(run, Math.min(10000, interval));
  warmup.unref();
  return timer;
}

function prometheusMetrics() {
  const lines = [
    '# HELP ai_relay_requests_total Total chat requests.',
    '# TYPE ai_relay_requests_total counter',
    'ai_relay_requests_total ' + metrics.requests,
    '# HELP ai_relay_successes_total Successful chat responses.',
    '# TYPE ai_relay_successes_total counter',
    'ai_relay_successes_total ' + metrics.successes,
    '# HELP ai_relay_failures_total Failed chat requests.',
    '# TYPE ai_relay_failures_total counter',
    'ai_relay_failures_total ' + metrics.failures,
    '# HELP ai_relay_streams_total Streamed responses.',
    '# TYPE ai_relay_streams_total counter',
    'ai_relay_streams_total ' + metrics.streams
  ];
  for (const provider of providers) {
    const state = stateFor(provider.id);
    const circuit = state.openUntil > Date.now() ? 1 : 0;
    lines.push(
      'ai_relay_provider_circuit_open{provider="' + provider.id + '"} ' + circuit,
      'ai_relay_provider_successes_total{provider="' + provider.id + '"} ' + state.successes,
      'ai_relay_provider_failures_total{provider="' + provider.id + '"} ' + state.failures,
      'ai_relay_provider_avg_latency_ms{provider="' + provider.id + '"} ' + (state.avgLatencyMs || 0)
    );
  }
  return lines.join('\n') + '\n';
}

function routeModels() {
  return Object.entries(routes).flatMap(([id, definition]) => {
    const value = Array.isArray(definition) ? {} : definition;
    if (value.hidden) return [];
    return [{
      id,
      object: 'model',
      created: 0,
      owned_by: 'ai-relay',
      context_length: value.contextWindow || 200000,
      capabilities: {
        tools: value.toolPolicy !== 'strip',
        stream: true,
        usage: true
      }
    }];
  });
}

function usageRollup() {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const month = today.slice(0, 7);
  const days = Object.keys(usageHistory).sort();
  const last30 = days.slice(-30).map(day => Object.assign({ date: day }, usageHistory[day]));
  const monthTotals = { prompt: 0, completion: 0, cached: 0, reasoning: 0, total: 0, requests: 0 };
  for (const day of days) {
    if (!day.startsWith(month)) continue;
    const item = usageHistory[day] || {};
    for (const key of Object.keys(monthTotals)) monthTotals[key] += Number(item[key] || 0);
  }
  return {
    today: Object.assign({ date: today }, usageHistory[today] || { prompt: 0, completion: 0, cached: 0, reasoning: 0, total: 0, requests: 0 }),
    month: Object.assign({ month }, monthTotals),
    history: last30,
    hourly: Object.keys(usageHourly).sort().slice(-24).map(key => Object.assign({ hour: key }, usageHourly[key]))
  };
}

function publicView() {
  const health = healthView();
  return {
    ok: health.ok,
    live: true,
    uptime_s: health.uptime_s,
    routes: health.routes,
    metrics,
    usage: usageRollup(),
    scoreLastRun,
    scores: Object.entries(ensureScores()).map(([id, item]) => Object.assign({ id }, item)).sort((a, b) => (b.score || 0) - (a.score || 0)),
    pools: poolView(),
    providerSetup: providerSetupSummary(),
    providers: providers.filter(provider => provider.enabled).map(provider => {
      const view = providerView(provider);
      return {
        id: view.id,
        label: view.label,
        pools: view.pools,
        circuit: view.circuit,
        retry_at: view.retry_at,
        successes: view.successes,
        failures: view.failures,
        tokens: view.tokens,
        avg_latency_ms: view.avg_latency_ms,
        last_latency_ms: view.last_latency_ms,
        last_ok_at: view.last_ok_at,
        last_error_code: view.last_error_code
      };
    }),
    logs: logs.slice(-60).map(item => ({
      ts: item.ts,
      ev: item.ev,
      api: item.api || null,
      model: item.model || null,
      provider: item.provider || null,
      ms: item.ms || null,
      tokens: item.tokens != null ? item.tokens : null,
      tokens_in: item.tokens_in != null ? item.tokens_in : null,
      tokens_out: item.tokens_out != null ? item.tokens_out : null,
      tokens_cached: item.tokens_cached != null ? item.tokens_cached : null,
      tokens_reasoning: item.tokens_reasoning != null ? item.tokens_reasoning : null
    }))
  };
}

async function handleRequest(req, res) {
  res.on('error', () => {});
  req.on('error', () => {});
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const pathname = url.pathname;

  try {
    if (pathname === '/health') {
      const health = healthView();
      return writeJson(res, 200, Object.assign({}, health, { ok: true }));
    }
    if ((pathname === '/' || pathname === '/dashboard') && req.method === 'GET') {
      const html = dashboardPage();
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(html),
        'cache-control': 'no-cache'
      });
      return res.end(html);
    }
    if (pathname === '/setup' && req.method === 'GET') {
      const html = providerSetupPage();
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(html),
        'cache-control': 'no-cache'
      });
      return res.end(html);
    }
    if (pathname === '/api/info' && req.method === 'GET') {
      return writeJson(res, 200, {
        service: 'ai-relay',
        version: 3,
        endpoints: ['/health', '/ready', '/v1/models', '/v1/chat/completions', '/v1/messages', '/v1/responses', '/dashboard', '/setup']
      });
    }
    if (pathname === '/favicon.ico' || pathname === '/apple-touch-icon.png' || pathname === '/apple-touch-icon-precomposed.png') {
      res.writeHead(204, { 'cache-control': 'public, max-age=86400' });
      return res.end();
    }
    if (pathname === '/ready') {
      const health = healthView();
      return writeJson(res, health.ok ? 200 : 503, health);
    }
    if (pathname === '/api/public' && req.method === 'GET') {
      return writeJson(res, 200, publicView());
    }
    if (pathname === '/api/provider-catalog' && req.method === 'GET') {
      return writeJson(res, 200, {
        providers: providerSetupView(),
        readOnly: true
      });
    }
    if (!isAuthorized(req)) {
      log({ ev: 'auth_fail', path: pathname, ip: req.socket.remoteAddress });
      return writeJson(res, 401, {
        error: { message: 'Unauthorized', type: 'invalid_api_key' }
      });
    }
    if (pathname === '/v1/models' && req.method === 'GET') {
      if (!modelsCache.data || Date.now() - modelsCache.at > 60000) {
        modelsCache = { at: Date.now(), data: routeModels() };
      }
      return writeJson(res, 200, {
        object: 'list',
        data: modelsCache.data
      });
    }
    if (pathname === '/api/upstreams' && req.method === 'GET') {
      return writeJson(res, 200, {
        upstreams: providers.map(providerView),
        pools: poolView(),
        routes
      });
    }
    if (pathname === '/api/provider-setup' && req.method === 'GET') {
      return writeJson(res, 200, {
        providers: providerSetupView(),
        encrypted: true
      });
    }
    if (pathname === '/api/provider-credentials' && req.method === 'POST') {
      const body = await readRequestBody(req, 256 * 1024);
      const providerId = String(body.providerId || '').trim();
      const secret = String(body.secret || '').trim();
      if (!providerId || secret.length < 8) {
        return writeJson(res, 400, {
          error: { message: 'providerId and a secret of at least 8 characters are required' }
        });
      }
      if (!providerById.has(providerId)) {
        return writeJson(res, 400, {
          error: { message: 'This catalog entry is guide-only and has no built-in provider adapter yet.' }
        });
      }
      writeCredentialValue(
        CFG.credentialsFile,
        CFG.credentialsKeyFile,
        providerId,
        secret
      );
      loadConfiguration(DEFAULT_CONFIG);
      const provider = providerById.get(providerId);
      const validation = await validateProviderCredential(provider);
      if (validation.status === 'failed') {
        deleteCredentialValue(CFG.credentialsFile, providerId);
        loadConfiguration(DEFAULT_CONFIG);
      }
      log({
        ev: 'provider_credential_saved',
        provider: providerId,
        validation: validation.status,
        http_status: validation.httpStatus || null
      });
      return writeJson(res, validation.status === 'failed' ? 422 : 200, {
        ok: validation.status !== 'failed',
        provider: providerId,
        validation
      });
    }
    if (pathname.startsWith('/api/provider-credentials/') && req.method === 'DELETE') {
      const providerId = decodeURIComponent(pathname.slice('/api/provider-credentials/'.length));
      const removed = deleteCredentialValue(CFG.credentialsFile, providerId);
      loadConfiguration(DEFAULT_CONFIG);
      log({ ev: 'provider_credential_deleted', provider: providerId, removed });
      return writeJson(res, removed ? 200 : 404, { ok: removed, provider: providerId });
    }
    if (pathname.startsWith('/api/provider-settings/') && req.method === 'PATCH') {
      const providerId = decodeURIComponent(pathname.slice('/api/provider-settings/'.length));
      const provider = providerById.get(providerId);
      if (!provider) {
        return writeJson(res, 404, {
          error: { message: 'Provider adapter not found', type: 'provider_not_found' }
        });
      }
      const body = await readRequestBody(req, 16 * 1024);
      if (typeof body.enabled !== 'boolean') {
        return writeJson(res, 400, {
          error: { message: 'enabled must be a boolean', type: 'invalid_request' }
        });
      }
      if (body.enabled && !provider.endpoint) {
        return writeJson(res, 409, {
          error: { message: 'Provider endpoint is not configured', type: 'missing_endpoint' }
        });
      }
      if (
        body.enabled &&
        provider.authConfigured &&
        !provider.keys.length &&
        !provider.optionalAuth
      ) {
        return writeJson(res, 409, {
          error: {
            message: 'Add and validate an API key before enabling this provider',
            type: 'missing_credentials'
          }
        });
      }
      writeProviderSetting(CFG.providerSettingsFile, providerId, body.enabled);
      loadConfiguration(DEFAULT_CONFIG);
      const updated = providerSetupView().find(item => item.id === providerId);
      log({ ev: 'provider_setting_changed', provider: providerId, enabled: body.enabled });
      return writeJson(res, 200, { ok: true, provider: updated || null });
    }
    if (pathname === '/api/score/run' && req.method === 'POST') {
      const targets = providers.filter(provider =>
        provider.enabled &&
        provider.endpoint &&
        provider.type !== 'pi-agent' &&
        provider.pools.length > 0
      );
      const results = [];
      const concurrency = 6;
      for (let start = 0; start < targets.length; start += concurrency) {
        const batch = targets.slice(start, start + concurrency);
        /* eslint-disable no-await-in-loop */
        await Promise.all(batch.map(async provider => {
          const startedAt = Date.now();
          const probe = Object.assign({}, provider, {
            timeoutMs: Math.min(Number(provider.timeoutMs) || 15000, 12000)
          });
          const body = {
            model: provider.modelMap.auto || provider.modelMap.chat || 'auto',
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 8,
            stream: false
          };
          try {
            await providerJsonAttempt(probe, body.model, body, { toolPolicy: 'strict' }, provider.keys[0]);
            bumpScore(provider.id, true, Date.now() - startedAt);
            results.push({ id: provider.id, ok: true, ms: Date.now() - startedAt });
          } catch (error) {
            bumpScore(provider.id, false, Date.now() - startedAt);
            results.push({
              id: provider.id,
              ok: false,
              ms: Date.now() - startedAt,
              error: String(error && error.message || error).slice(0, 100)
            });
          }
        }));
      }
      scoreLastRun = nowIso();
      saveScores();
      log({ ev: 'score_run', checked: results.length, failed: results.filter(item => !item.ok).length });
      return writeJson(res, 200, {
        ok: true,
        lastRun: scoreLastRun,
        checked: results.length,
        failed: results.filter(item => !item.ok).length,
        results
      });
    }
    if (pathname === '/api/pools' && req.method === 'GET') {
      return writeJson(res, 200, {
        pools: poolView(),
        providers: providers.map(providerView)
      });
    }
    if (pathname === '/api/logs' && req.method === 'GET') {
      const count = Math.max(1, Math.min(Number(url.searchParams.get('n') || 50), MAX_LOGS));
      return writeJson(res, 200, { logs: logs.slice(-count) });
    }
    if (pathname === '/api/metrics' && req.method === 'GET') {
      return writeJson(res, 200, {
        metrics,
        providers: providers.map(providerView)
      });
    }
    if (pathname === '/metrics' && req.method === 'GET') {
      const body = prometheusMetrics();
      res.writeHead(200, {
        'content-type': 'text/plain; version=0.0.4; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store'
      });
      return res.end(body);
    }
    if (pathname === '/api/reset' && req.method === 'POST') {
      resetCircuits();
      log({ ev: 'circuits_reset', by: req.socket.remoteAddress });
      return writeJson(res, 200, { ok: true });
    }
    if (pathname === '/api/reload' && req.method === 'POST') {
      const oldPort = CFG.port;
      const oldHost = CFG.host;
      loadConfiguration(DEFAULT_CONFIG);
      log({ ev: 'config_reloaded' });
      return writeJson(res, 200, {
        ok: true,
        restart_required: oldPort !== CFG.port || oldHost !== CFG.host
      });
    }
    if (pathname === '/v1/chat/completions' && req.method === 'POST') {
      const body = await readRequestBody(req);
      if (!Array.isArray(body.messages) || !body.messages.length) {
        return writeJson(res, 400, {
          error: { message: 'messages is required', type: 'invalid_request_error' }
        });
      }
      return handleChat(req, res, body, false);
    }
    if (pathname === '/v1/responses' && req.method === 'POST') {
      const body = await readRequestBody(req);
      return handleResponses(req, res, body);
    }
    if (pathname === '/v1/messages' && req.method === 'POST') {
      const body = await readRequestBody(req);
      if (!Array.isArray(body.messages) || !body.messages.length) {
        return writeJson(res, 400, {
          error: { message: 'messages is required', type: 'invalid_request_error' }
        });
      }
      return handleChat(req, res, anthropicToOpenAI(body), true);
    }
    return writeJson(res, 404, {
      error: { message: 'not found: ' + pathname, type: 'not_found' }
    });
  } catch (error) {
    const status = Number(error.status) >= 400 && Number(error.status) < 600
      ? Number(error.status)
      : 500;
    log({ ev: 'request_exception', path: pathname, error: String(error.message || error) });
    if (!res.headersSent) {
      return writeJson(res, status, {
        error: { message: String(error.message || error), type: 'relay_error' }
      });
    }
    try {
      res.end();
    } catch {}
  }
}

function startServer() {
  loadConfiguration(DEFAULT_CONFIG);
  loadUsageState();
  const server = http.createServer(handleRequest);
  server.on('clientError', (error, socket) => {
    try {
      socket.destroy();
    } catch {}
  });
  server.listen(Number(CFG.port), CFG.host || '127.0.0.1', () => {
    log({
      ev: 'started',
      host: CFG.host || '127.0.0.1',
      port: Number(CFG.port),
      providers: providers.map(provider => ({
        id: provider.id,
        enabled: provider.enabled,
        reason: provider.disabledReason || null
      })),
      routes: Object.keys(routes)
    });
  });
  startHealthProbes();

  const shutdown = signal => {
    log({ ev: 'shutdown', signal });
    saveUsageState();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGHUP', () => {
    try {
      loadConfiguration(DEFAULT_CONFIG);
      log({ ev: 'config_reloaded', signal: 'SIGHUP' });
    } catch (error) {
      log({ ev: 'config_reload_failed', signal: 'SIGHUP', error: String(error.message || error) });
    }
  });
  process.on('uncaughtException', error => {
    saveUsageState();
    log({ ev: 'uncaught', error: String(error && error.message || error) });
  });
  process.on('unhandledRejection', error => {
    saveUsageState();
    log({ ev: 'unhandled_rejection', error: String(error && error.message || error) });
  });
  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  anthropicFromOpenAI,
  anthropicToOpenAI,
  applyBridgeToolCalls,
  buildCandidates,
  classifyFailure,
  decryptCredentialStore,
  deleteCredentialValue,
  estimateUsage,
  eventHasMeaningfulDelta,
  fakeOpenAIStream,
  loadConfiguration,
  loadUsageState,
  messagesWithToolBridge,
  normalizeCompletion,
  openAIFromAnthropic,
  openAIToAnthropic,
  rememberResponse,
  responsesRequestToChat,
  responseFromCompletion,
  streamResponses,
  parseBridgeToolCalls,
  parseSseEvent,
  routeDefinition,
  saveUsageState,
  selectBridgeTools,
  startServer,
  stateFor,
  usageSnapshot,
  writeCredentialValue
};
