#!/usr/bin/env node
/**
 * 免费源管道公共库：规范化 / 去重 / 分类 / 可用性校验 / 状态机 / 失效剔除 / 投影 / 指标。
 * 零依赖，Node >= 20。所有时间统一 ISO-8601 UTC。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 必须用 fileURLToPath：仓库路径含中文，import.meta.url.pathname 会是百分号编码
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DATA = path.join(ROOT, 'data');
export const DOCS = path.join(ROOT, 'docs');
export const REGISTRY = path.join(DATA, 'sources.json');
export const CANDIDATES = path.join(DATA, 'candidates.json');
export const FEEDS = path.join(DATA, 'discovery-feeds.json');
export const POLICY = path.join(DATA, 'sources-policy.json');
export const METRICS = path.join(DATA, 'metrics.json');
export const CATALOG = path.join(ROOT, 'provider-catalog.json');

export const now = () => new Date().toISOString();
export const daysBetween = (a, b) => Math.abs(new Date(b) - new Date(a)) / 86400000;

export function loadJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
export function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}
export const policy = () => loadJson(POLICY, {});

// ── 规范化与去重 ──────────────────────────────────────────────────────────
export function normalizeName(value, aliases = {}) {
  let s = String(value || '').toLowerCase().trim();
  s = s.replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '');
  return aliases[s] || s;
}
export function normalizeUrl(value, cfg = {}) {
  if (!value || value.startsWith('local://') || value.startsWith('127.0.0.1')) return '';
  try {
    const u = new URL(value);
    let host = u.hostname.toLowerCase();
    if (cfg.stripWww !== false) host = host.replace(/^www\./, '');
    let p = u.pathname;
    if (cfg.stripTrailingSlash !== false && p.length > 1) p = p.replace(/\/+$/, '');
    return `${host}${p === '/' ? '' : p}`;
  } catch { return String(value).toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, ''); }
}
export function slug(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
export function sourceKeys(source, aliases = {}) {
  // 只用 id / 名称别名 / 主端点主机做键。
  // 不能用 docsUrl 的主机名（很多源文档都在 github.com），也不能用 relayIds
  // （不同源可能共享同一个网关槽位，例如 openrouter 与 kilo 都有 kilo-openrouter）。
  const keys = new Set([
    `id:${normalizeName(source.id, aliases)}`,
    `name:${normalizeName(source.name, aliases)}`
  ]);
  for (const [alias, target] of Object.entries(aliases)) {
    if (target === source.id) keys.add(`alias:${alias}`);
  }
  // 端点主机名只作为记录，不作为自动合并键：同一厂商常有「订阅」与「试用赠金」
  // 两个不同计划（例如 Kimi Code 与 Moonshot 试用），自动按 host 合并会丢计划粒度。
  return [...keys].filter(Boolean);
}

/** 去重：按 id / 名称别名 / 主机名 / 映射槽位合并，返回合并后的列表与重复记录 */
export function dedupe(sources, aliases = {}) {
  const index = new Map();
  const merged = [];
  const duplicates = [];
  for (const source of sources) {
    const keys = sourceKeys(source, aliases);
    let hit = null;
    for (const k of keys) { if (index.has(k)) { hit = index.get(k); break; } }
    if (!hit) {
      const item = { ...source, dedupeKeys: keys };
      merged.push(item);
      for (const k of keys) index.set(k, item);
    } else {
      // 别名合并时优先保留规范 id（alias 的 target），避免合并方向取决于数组顺序
      let keeper = hit, incoming = source;
      if (aliases[hit.id] && aliases[hit.id] === source.id) {
        keeper = source; incoming = hit;
        merged[merged.indexOf(hit)] = keeper;
        for (const [k, v] of index) if (v === hit) index.set(k, keeper);
      }
      duplicates.push({ kept: keeper.id, merged: incoming.id, reason: keys.find(k => index.get(k) === keeper) });
      keeper.relayIds = [...new Set([...(keeper.relayIds || []), ...(incoming.relayIds || [])])];
      keeper.catalogIds = [...new Set([...(keeper.catalogIds || []), ...(incoming.catalogIds || [])])];
      keeper.tags = [...new Set([...(keeper.tags || []), ...(incoming.tags || [])])];
      keeper.evidence = [...new Set([...(keeper.evidence || []), ...(incoming.evidence || [])])].slice(0, 8);
      keeper.models = [...new Set([...(keeper.models || []), ...(incoming.models || [])])].slice(0, 20);
      for (const k of keys) index.set(k, keeper);
    }
  }
  return { merged, duplicates };
}

/** 分类补齐：按 category / auth / region / confidence 派生标签 */
export function classify(source) {
  const tags = new Set(source.tags || []);
  tags.add(source.category);
  tags.add(`auth:${source.auth}`);
  tags.add(`region:${source.region}`);
  if (source.confidence === 'community') tags.add('needs-verification');
  if (source.category === 'trial-credit') tags.add('expiring');
  if (source.category === 'local') tags.add('offline-capable');
  source.tags = [...tags];
  return source;
}

// ── 可用性校验 ────────────────────────────────────────────────────────────
export async function mapConcurrent(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try { out[i] = await fn(items[i], i); }
      catch (error) { out[i] = { error: String(error?.message || error) }; }
    }
  });
  await Promise.all(workers);
  return out;
}

export function probeUrlsFor(source, p) {
  if (source.region === 'local' || source.auth === 'local') return [];
  const cfg = p.probe || {};
  return [...new Set([source[cfg.preferUrl || 'docsUrl'], ...(cfg.fallbackUrls || []).map(k => source[k])]
    .filter(u => u && /^https?:\/\//.test(u)))].slice(0, 4);
}

/** 依次尝试官方文档 / 定价 / 控制台 / 端点；任一在线即视为可达，避免单页 404 误判源失效 */
export async function verifyOne(source, p) {
  const checkedAt = now();
  const urls = probeUrlsFor(source, p);
  if (!urls.length) return { id: source.id, checkedAt, url: '', result: 'skipped', ok: true, reason: 'local source' };
  const started = Date.now();
  const attempts = [];
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        method: 'GET', redirect: 'follow',
        headers: { accept: 'text/html,application/json,*/*', 'user-agent': p.verification.userAgent },
        signal: AbortSignal.timeout(p.verification.timeoutMs)
      });
      await response.body?.cancel().catch(() => {});
      const httpStatus = response.status;
      const ok = p.verification.okStatuses.includes(httpStatus);
      attempts.push({ url, httpStatus, ok });
      if (ok) return { id: source.id, checkedAt, url, result: 'reachable', ok,
        httpStatus, latencyMs: Date.now() - started, attempts };
    } catch (error) {
      attempts.push({ url, error: String(error?.message || error).slice(0, 120) });
    }
  }
  const last = attempts.at(-1) || {};
  return { id: source.id, checkedAt, url: urls[0], result: last.error ? 'unreachable' : 'http-error',
    ok: false, httpStatus: last.httpStatus ?? null, latencyMs: Date.now() - started,
    error: last.error || `all ${attempts.length} probe URLs returned non-ok`, attempts };
}

/** 状态机：连续失败降级、多次失败停用、长期未验证老化、长期停用剔除（保留墓碑） */
export function applyVerification(source, result, p, at = now()) {
  const v = { ...(source.verification || {}) };
  const wasRemoved = source.status === 'removed';
  if (result.result === 'skipped') {
    v.lastCheckedAt = at; v.lastResult = 'skipped';
    source.verification = v;
    return { source, change: null };
  }
  const before = source.status;
  const failures = Number(v.consecutiveFailures || 0);
  v.lastCheckedAt = at;
  v.lastResult = result.result;
  v.httpStatus = result.httpStatus;
  v.latencyMs = result.latencyMs ?? null;
  v.checkedUrl = result.url;
  v.checkMethod = 'HTTP GET on official docs/pricing URL';
  if (result.error) v.lastError = result.error; else delete v.lastError;

  if (result.ok) {
    v.consecutiveFailures = 0;
    v.lastOkAt = at;
    v.endpointReachable = true;
    // 社区来源即使端点在线也不升级为 active：额度事实仍需官方复核
    if (source.confidence === 'community') source.status = 'unverified';
    else if (!['deprecated', 'removed'].includes(source.status)) source.status = 'active';
    else if (source.status === 'deprecated') source.status = 'active'; // 自动恢复
  } else {
    v.consecutiveFailures = failures + 1;
    v.endpointReachable = false;
    if (v.consecutiveFailures >= p.lifecycle.deprecateAfterConsecutiveFailures) source.status = 'deprecated';
    else if (v.consecutiveFailures >= p.lifecycle.degradeAfterConsecutiveFailures) source.status = 'degraded';
  }
  if (wasRemoved) source.status = 'removed'; // 人工剔除不被自动恢复
  const change = before !== source.status ? { id: source.id, from: before, to: source.status, at } : null;
  source.verification = v;
  return { source, change };
}

export function prune(sources, p, at = now()) {
  const changes = [];
  for (const s of sources) {
    if (s.status === 'removed') continue;
    const v = s.verification || {};
    const lastOk = v.lastOkAt || s.firstSeenAt || at;
    const staleDays = daysBetween(lastOk, at);
    if (staleDays > p.lifecycle.staleAfterDays && s.status !== 'deprecated') {
      changes.push({ id: s.id, from: s.status, to: 'deprecated', at, reason: `超过 ${p.lifecycle.staleAfterDays} 天未验证` });
      s.status = 'deprecated';
    }
    if (staleDays > p.lifecycle.removeAfterDays && s.status === 'deprecated') {
      changes.push({ id: s.id, from: 'deprecated', to: 'removed', at, reason: `超过 ${p.lifecycle.removeAfterDays} 天不可用` });
      s.status = 'removed'; s.removedAt = at; s.removedReason = '长期不可用，自动剔除';
    }
  }
  return changes;
}

// ── 投影到现有 provider-catalog.json（保持 9 字段兼容） ────────────────────
const KIND_BY_AUTH = { 'api-key': 'api-key', token: 'api-key', anonymous: 'optional-token',
  oauth: 'subscription-oauth', local: 'guide', custom: 'guide' };
const POOL_BY_CATEGORY = { local: 'agent', subscription: 'agent', trial: 'chat' };

export function projectCatalog(sources, previous) {
  const prevById = new Map((previous?.providers || []).map(p => [p.id, p]));
  const providers = sources
    .filter(s => s.status !== 'removed')
    .map(s => {
      const prev = prevById.get(s.id) || {};
      const ids = s.catalogIds || [];
      const id = ids[0] || s.id;
      return {
        id, name: s.name, kind: s.kind || KIND_BY_AUTH[s.auth] || 'api-key',
        pool: prev.pool || POOL_BY_CATEGORY[s.category] || 'chat',
        loginUrl: s.keyUrl || s.docsUrl || '',
        docsUrl: s.docsUrl || '',
        models: (s.models || []).slice(0, 8),
        quota: s.quota || '',
        note: s.note || `${s.category} · ${s.confidence} · 核查 ${s.verification?.lastCheckedAt || 'pending'}`,
        // 增强字段（router.js 会忽略未知字段）
        sourceId: s.id, category: s.category, status: s.status, confidence: s.confidence,
        evidence: (s.evidence || []).slice(0, 4), lastCheckedAt: s.verification?.lastCheckedAt || null
      };
    });
  return { version: 2, generatedAt: now(), generatedBy: 'scripts/sources.mjs sync',
    sourceRegistry: 'data/sources.json', providers };
}

// ── 指标 ──────────────────────────────────────────────────────────────────
export function computeMetrics(sources, candidates, duplicates, config) {
  const by = k => sources.filter(s => s.status === k).length;
  const checked = sources.filter(s => s.verification?.lastResult && s.verification.lastResult !== 'skipped');
  const reachable = checked.filter(s => s.verification?.endpointReachable === true);
  const official = sources.filter(s => s.confidence === 'official');
  const officialActive = official.filter(s => s.status === 'active');
  const categoryCounts = {};
  for (const s of sources) categoryCounts[s.category] = (categoryCounts[s.category] || 0) + 1;
  const relayIds = new Set(sources.flatMap(s => s.relayIds || []));
  const configuredIds = new Set((config?.providers || []).map(p => p.id));
  const mappedRelaySlots = [...relayIds].filter(id => configuredIds.has(id)).length;
  const models = new Set(sources.flatMap(s => s.models || []));
  return {
    generatedAt: now(),
    coverage: {
      totalSources: sources.length,
      totalCandidates: candidates?.candidates?.length || 0,
      newCandidates: candidates?.candidates?.filter(c => c.disposition === 'new').length || 0,
      activeSources: by('active'), degradedSources: by('degraded'),
      unverifiedSources: by('unverified'), deprecatedSources: by('deprecated'), removedSources: by('removed'),
      officialConfidence: official.length, communityReport: sources.length - official.length - sources.filter(s => s.confidence === 'aggregator').length,
      aggregatorConfidence: sources.filter(s => s.confidence === 'aggregator').length,
      distinctCategories: Object.keys(categoryCounts).length,
      categoryCounts, distinctModels: models.size,
      mappedRelaySlots,
      declaredRelaySlots: relayIds.size,
      slotConsolidation: {
        multiSlotSources: sources.filter(s => (s.relayIds || []).length > 1).length,
        totalSlotRefs: relayIds.size,
        distinctSources: sources.length,
        note: '多个 config.json 槽位收敛到同一独立计划（如 14 个 kilo-* → 1 个 Kilo Gateway）'
      },
      configuredRelayProviders: config?.providers?.length || 0,
      enabledRelayProviders: config?.providers?.filter(p => p.enabled).length || 0,
      duplicatesMerged: duplicates.length
    },
    availability: {
      checked: checked.length,
      reachable: reachable.length,
      endpointReachableRate: checked.length ? +(reachable.length / checked.length * 100).toFixed(1) : 0,
      officialVerifiedRate: sources.length ? +(officialActive.length / sources.length * 100).toFixed(1) : 0,
      avgLatencyMs: reachable.length
        ? Math.round(reachable.reduce((a, s) => a + (s.verification.latencyMs || 0), 0) / reachable.length) : null
    },
    maintenance: {
      checkFrequency: '每日 1 次（GitHub Actions cron + systemd timer）',
      discoveryFrequency: '每日 1 次（3 个公开清单 + 官方证据链接）',
      dedupeStrategy: 'id / 名称别名 / 显式别名表三键合并 + 多槽位收敛映射（不按 host 自动合并不同计划）',
      lifecycle: policy().lifecycle,
      removedKeptAsTombstone: sources.filter(s => s.status === 'removed').every(s => !!s.removedReason || !!s.removedAt || !!s.note)
    }
  };
}
