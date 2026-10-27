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
const { StringDecoder } = require('string_decoder');

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
  estimatedUsage: 0
};

let CFG = null;
let TOKEN = '';
let providers = [];
let providerById = new Map();
let routes = {};
let stateById = new Map();
let groupStates = new Map();

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

function request(urlString, options = {}) {
  const target = new URL(urlString);
  const transport = target.protocol === 'https:' ? https : http;
  const timeoutMs = Number(options.timeoutMs || 90000);

  return new Promise((resolve, reject) => {
    const req = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      method: options.method || 'POST',
      headers: options.headers || {},
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
  if (raw.type === 'ollama-chat') return base + '/api/chat';
  if (raw.type === 'anthropic-compatible') return base + '/v1/messages';
  return base + '/chat/completions';
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
  provider.priority = Number.isFinite(raw.priority) ? raw.priority : 100;
  provider.toolPriority = Number.isFinite(raw.toolPriority) ? raw.toolPriority : provider.priority;
  provider.maxConcurrency = Math.max(1, Number(raw.maxConcurrency || 4));
  provider.rpm = Math.max(0, Number(raw.rpm || 0));
  provider.group = raw.group ? String(raw.group) : '';
  provider.maxKeyAttempts = Math.max(1, Number(raw.maxKeyAttempts || 3));
  provider.enabled = raw.enabled !== false;
  provider.pools = Array.isArray(raw.pools)
    ? [...new Set(raw.pools.filter(pool => pool === 'tools' || pool === 'chat'))]
    : [provider.capabilities.tools || provider.capabilities.toolBridge ? 'tools' : 'chat', 'chat'];
  provider.keys = loadProviderKeys(raw);
  provider.authConfigured = raw.authConfigured !== undefined
    ? Boolean(raw.authConfigured)
    : hasConfiguredAuth(raw);

  if (!provider.enabled) provider.disabledReason = 'disabled_in_config';
  else if (!provider.endpoint) provider.disabledReason = 'missing_endpoint';
  else if (provider.authConfigured && !provider.keys.length && raw.optionalAuth !== true) {
    provider.disabledReason = 'missing_api_key';
  }
  if (provider.disabledReason) provider.enabled = false;
  return provider;
}

function hasConfiguredAuth(raw) {
  return Boolean(
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
  if (status === 429 || /rate.?limit|too many requests|free.?limit|quota|insufficient_quota|credits?/.test(lower)) {
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
    return failure;
  }
  const immediate = failure.code === 'auth' || failure.code === 'rate_limit' || failure.code === 'model_unavailable';
  if (immediate) {
    openCircuit(state, provider, failure.cooldownMs);
  } else if (state.failures >= Number(circuit.failThreshold || 3)) {
    const base = Number(circuit.openMs || 60000);
    openCircuit(state, provider, Math.min(Number(circuit.maxOpenMs || 300000), base * 2 ** Math.max(0, state.failures - 1)));
  }
  return failure;
}

function markSuccess(provider, elapsedMs) {
  const state = stateFor(provider.id);
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

function toolBridgeProtocol(tools) {
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
  return [
    '[Tool bridge protocol]',
    'You may call the tools listed below.',
    'When a tool is needed, reply with ONLY one JSON object and no markdown:',
    '{"tool_calls":[{"name":"tool_name","arguments":{"key":"value"}}]}',
    'Do not invent a tool result. If no tool is needed, answer normally.',
    'Available tools:',
    JSON.stringify(definitions)
  ].join('\n');
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
    if (normalized.length) return normalized;
  }
  return [];
}

function messagesWithToolBridge(body, tools) {
  return Object.assign({}, body, {
    messages: [{
      role: 'system',
      content: toolBridgeProtocol(tools)
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
  if (!calls.length) return raw;
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

function usageFromRaw(raw, body) {
  if (raw && raw.usage && Number.isFinite(Number(raw.usage.prompt_tokens))) {
    const prompt = Number(raw.usage.prompt_tokens) || 0;
    const completion = Number(raw.usage.completion_tokens) || 0;
    return {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: Number(raw.usage.total_tokens) || prompt + completion
    };
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

async function providerJsonAttempt(provider, logical, body, route, apiKey) {
  const useToolBridge = (
    route.toolPolicy !== 'strip' &&
    provider.capabilities.toolBridge &&
    !provider.capabilities.tools &&
    bodyWantsTools(body)
  );
  const bridgeTools = useToolBridge ? selectBridgeTools(body, body.tools) : null;
  const effectiveBody = useToolBridge ? messagesWithToolBridge(body, bridgeTools) : body;
  let requestBody;
  let endpoint = provider.endpoint;
  if (provider.type === 'anthropic-compatible') {
    requestBody = anthropicFromOpenAI(effectiveBody, provider, logical);
  } else if (provider.type === 'ollama-chat') {
    requestBody = ollamaFromOpenAI(effectiveBody, provider, logical);
  } else {
    requestBody = buildOpenAIBody(provider, logical, effectiveBody, false, route.toolPolicy === 'strip');
  }

  const response = await request(endpoint, {
    headers: headersWithContentType(authHeaders(provider, apiKey)),
    body: JSON.stringify(requestBody),
    timeoutMs: provider.timeoutMs,
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
  const response = await request(provider.endpoint, {
    headers: headersWithContentType(authHeaders(provider, apiKey)),
    body: JSON.stringify(requestBody),
    timeoutMs: provider.timeoutMs,
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
        usage: { input_tokens: usage.prompt_tokens || 0, output_tokens: 0 }
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
    usage: { output_tokens: usage.completion_tokens || 0 }
  }]);
  events.push(['message_stop', { type: 'message_stop' }]);
  return events;
}

function fakeAnthropicStream(res, completion, logical, headers) {
  sseHeaders(res, headers);
  for (const [name, payload] of anthropicEventsFromCompletion(completion, logical)) {
    safeWrite(res, 'event: ' + name + '\n' + 'data: ' + JSON.stringify(payload) + '\n\n');
  }
  try {
    res.end();
  } catch {}
}

function eventPayloads(event) {
  return parseSseEvent(event).data;
}

function forwardOpenAIStream(res, prepared, logical, body, headers) {
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
          if (chunk.usage) usage = chunk.usage;
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
        const id = 'relay-' + crypto.randomUUID();
        safeWrite(res, 'data: ' + JSON.stringify(usageChunk(id, logical, usage)) + '\n\n');
        safeWrite(res, 'data: [DONE]\n\n');
        sawDone = true;
      } else {
        safeWrite(res, rawEvent + '\n\n');
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
      message: 'No compatible AI upstream is currently available.',
      type: 'relay_unavailable',
      code: 'all_providers_unavailable',
      attempts
    }
  });
}

function shouldForceJsonForTools(body) {
  return bodyWantsTools(body) && (!CFG.tools || CFG.tools.forceNonStream !== false);
}

async function tryProvider(provider, logical, body, route, wantStream) {
  const started = Date.now();
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

async function handleChat(req, res, body, anthropic) {
  metrics.requests += 1;
  const logical = String(body.model || 'auto');
  const requestId = req.headers['x-request-id'] || 'relay-' + crypto.randomUUID();
  const wantStream = Boolean(body.stream);
  const started = Date.now();
  let selection;

  try {
    selection = await selectProvider(logical, body, wantStream);
  } catch (error) {
    metrics.failures += 1;
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
  for (const candidate of selection.candidates) {
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
        markSuccess(provider, outcome.elapsedMs);
        metrics.successes += 1;
        metrics.streams += 1;
        log({
          ev: 'ok',
          request_id: requestId,
          model: logical,
          provider: provider.id,
          stream: true,
          attempts: attempts.length,
          ms: Date.now() - started
        });
        return forwardOpenAIStream(res, outcome.result, logical, body, responseHeaders);
      }

      const completion = normalizeCompletion(outcome.result.raw, logical, provider.id, body);
      if (
        bodyWantsTools(body) &&
        !(completion.choices && completion.choices[0] &&
          (completion.choices[0].message.tool_calls || []).length) &&
        !contentText(completion.choices && completion.choices[0] &&
          completion.choices[0].message.content).trim()
      ) {
        throw new Error('empty tool response');
      }
      markSuccess(provider, outcome.elapsedMs);
      metrics.successes += 1;
      if (wantStream) metrics.streams += 1;
      if (completion.usage && completion.usage.estimated) metrics.estimatedUsage += 1;
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
        usage_estimated: Boolean(completion.usage && completion.usage.estimated)
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
  metrics.failures += 1;
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
    if (type === 'function_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id || item.id || '',
        content: typeof item.output === 'string'
          ? item.output
          : JSON.stringify(item.output == null ? '' : item.output)
      });
    }
    // reasoning / item_reference 等类型上游不认，直接丢弃
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

function responsesRequestToChat(body) {
  const chat = {
    model: String(body.model || 'tools'),
    messages: responsesInputToMessages(body),
    stream: false
  };
  const tools = responsesToolsToChat(body.tools);
  if (tools) {
    chat.tools = tools;
    const toolChoice = responsesToolChoice(body.tool_choice);
    if (toolChoice !== undefined) chat.tool_choice = toolChoice;
    if (body.parallel_tool_calls !== undefined) chat.parallel_tool_calls = body.parallel_tool_calls;
  }
  if (Number.isFinite(Number(body.temperature))) chat.temperature = Number(body.temperature);
  if (Number.isFinite(Number(body.top_p))) chat.top_p = Number(body.top_p);
  if (Number.isFinite(Number(body.max_output_tokens))) chat.max_tokens = Number(body.max_output_tokens);
  return chat;
}

function responsesUsage(usage) {
  const input = Number(usage && (usage.prompt_tokens || usage.input_tokens) || 0);
  const output = Number(usage && (usage.completion_tokens || usage.output_tokens) || 0);
  const total = Number(usage && usage.total_tokens || (input + output));
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: total
  };
}

function responseFromCompletion(completion, request) {
  const choice = completion.choices && completion.choices[0] || {};
  const message = choice.message || {};
  const text = contentText(message.content);
  const output = [];
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
    output.push({
      type: 'function_call',
      id: 'fc_' + crypto.randomUUID().replace(/-/g, ''),
      call_id: call.id || 'call_' + crypto.randomUUID().replace(/-/g, ''),
      name: call.function && call.function.name || '',
      arguments: call.function && call.function.arguments || '{}',
      status: 'completed'
    });
  }
  return {
    id: 'resp_' + crypto.randomUUID().replace(/-/g, ''),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
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
    } else {
      writeResponsesEvent(res, {
        type: 'response.output_item.added',
        output_index: index,
        item: Object.assign({}, item, { status: 'in_progress', arguments: '' })
      });
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
  metrics.requests += 1;
  const requestId = req.headers['x-request-id'] || 'relay-' + crypto.randomUUID();
  const chat = responsesRequestToChat(body);
  if (!chat.messages.length) {
    return writeJson(res, 400, {
      error: { message: 'input is required', type: 'invalid_request_error', code: 'missing_input' }
    });
  }
  const logical = chat.model;
  const started = Date.now();
  let selection;
  try {
    selection = await selectProvider(logical, chat, false);
  } catch (error) {
    metrics.failures += 1;
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
  for (const candidate of selection.candidates) {
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
      markSuccess(provider, outcome.elapsedMs);
      metrics.successes += 1;
      const response = responseFromCompletion(completion, body);
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
        tool_calls: (message.tool_calls || []).length
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

  metrics.failures += 1;
  log({ ev: 'relay_error', api: 'responses', request_id: requestId, model: logical, attempts });
  return writeJson(res, 503, {
    error: {
      message: 'All upstreams failed for this response.',
      type: 'relay_unavailable',
      code: 'upstreams_failed',
      attempts
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
  return output;
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
      output_tokens: usage.completion_tokens || 0
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
    attempts: state.attempts,
    in_flight: state.inFlight,
    avg_latency_ms: state.avgLatencyMs,
    last_latency_ms: state.lastLatencyMs,
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

function healthView() {
  const upstreams = providers.map(providerView);
  const ready = upstreams.some(provider => provider.enabled && provider.circuit !== 'open');
  return {
    ok: ready,
    live: true,
    service: 'ai-relay',
    version: 2,
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
    const response = await request(provider.healthUrl, {
      method: 'GET',
      headers: authHeaders(provider, apiKey),
      timeoutMs: Math.min(30000, provider.timeoutMs),
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
    if (pathname === '/' && req.method === 'GET') {
      return writeJson(res, 200, {
        service: 'ai-relay',
        version: 2,
        endpoints: ['/health', '/ready', '/v1/models', '/v1/chat/completions', '/v1/messages']
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
    if (!isAuthorized(req)) {
      log({ ev: 'auth_fail', path: pathname, ip: req.socket.remoteAddress });
      return writeJson(res, 401, {
        error: { message: 'Unauthorized', type: 'invalid_api_key' }
      });
    }
    if (pathname === '/v1/models' && req.method === 'GET') {
      return writeJson(res, 200, {
        object: 'list',
        data: routeModels()
      });
    }
    if (pathname === '/api/upstreams' && req.method === 'GET') {
      return writeJson(res, 200, {
        upstreams: providers.map(providerView),
        pools: poolView(),
        routes
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
    log({ ev: 'uncaught', error: String(error && error.message || error) });
  });
  process.on('unhandledRejection', error => {
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
  estimateUsage,
  eventHasMeaningfulDelta,
  fakeOpenAIStream,
  loadConfiguration,
  messagesWithToolBridge,
  normalizeCompletion,
  openAIFromAnthropic,
  openAIToAnthropic,
  responsesRequestToChat,
  responseFromCompletion,
  streamResponses,
  parseBridgeToolCalls,
  parseSseEvent,
  routeDefinition,
  selectBridgeTools,
  startServer,
  stateFor
};
