'use strict';
// 源维护管道的单元测试：规范化 / 去重 / 状态机 / 失效剔除 / 目录投影 / 指标。
// 不访问网络；校验逻辑通过构造的 verification 结果驱动。

const test = require('node:test');
const assert = require('node:assert/strict');

const P = {
  verification: { okStatuses: [200, 401, 403, 405, 429], timeoutMs: 1000, userAgent: 'test', concurrency: 2 },
  lifecycle: { degradeAfterConsecutiveFailures: 2, deprecateAfterConsecutiveFailures: 3, staleAfterDays: 14, removeAfterDays: 30 },
  probe: { preferUrl: 'docsUrl', fallbackUrls: ['pricingUrl', 'keyUrl', 'endpoint'] },
  dedupe: { aliases: { 'z-ai': 'zhipu', 'google-gemini': 'gemini' } }
};
const L = () => import('../scripts/lib/sources-lib.mjs');
const ok = (id, at) => ({ id, checkedAt: at, result: 'reachable', ok: true, httpStatus: 200, latencyMs: 12, url: 'https://example.com' });
const bad = (id, at) => ({ id, checkedAt: at, result: 'unreachable', ok: false, httpStatus: null, latencyMs: 1000, url: 'https://example.com', error: 'timeout' });

test('normalizeUrl / normalizeName 规范化与别名', async () => {
  const { normalizeUrl, normalizeName } = await L();
  assert.equal(normalizeUrl('https://WWW.Example.com/docs/'), 'example.com/docs');
  assert.equal(normalizeUrl('https://api.example.com/'), 'api.example.com');
  assert.equal(normalizeName('Google Gemini (Free Tier)'), 'google-gemini', '括号补充说明被剥离');
  assert.equal(normalizeName('z-ai', P.dedupe.aliases), 'zhipu');
});

test('去重：同 host 不同计划不合并，显式别名会合并', async () => {
  const { dedupe } = await L();
  const sources = [
    { id: 'kimi-code', name: 'Kimi Code', endpoint: 'https://api.moonshot.cn/v1', relayIds: [], catalogIds: ['kimi-code'], tags: [], evidence: [], models: [] },
    { id: 'moonshot', name: 'Moonshot Trial', endpoint: 'https://api.moonshot.cn/v1', relayIds: ['moonshot'], catalogIds: ['moonshot'], tags: [], evidence: [], models: [] },
    { id: 'z-ai', name: 'Z.ai', endpoint: 'https://api.z.ai/v4', relayIds: [], catalogIds: [], tags: [], evidence: [], models: [] },
    { id: 'zhipu', name: 'Zhipu', endpoint: 'https://open.bigmodel.cn/api/paas/v4', relayIds: [], catalogIds: [], tags: [], evidence: [], models: [] }
  ];
  const { merged, duplicates } = dedupe(sources, P.dedupe.aliases);
  assert.equal(merged.length, 3, 'kimi-code 与 moonshot 应保留为两个独立计划');
  assert.equal(duplicates.length, 1, 'z-ai 应通过别名合并进 zhipu');
  assert.equal(duplicates[0].kept, 'zhipu');
  assert.ok(duplicates[0].merged === 'z-ai');
});

test('状态机：成功置 active，连续失败降级/停用，成功后恢复', async () => {
  const { applyVerification } = await L();
  const s = { id: 'x', status: 'active', confidence: 'official', verification: {} };
  applyVerification(s, bad('x', '2026-11-12T00:00:00Z'), P, '2026-11-12T00:00:00Z');
  assert.equal(s.status, 'active', '单次失败不降级，避免网络抖动误判');
  assert.equal(s.verification.consecutiveFailures, 1);
  applyVerification(s, bad('x', '2026-11-12T01:00:00Z'), P, '2026-11-12T01:00:00Z');
  assert.equal(s.status, 'degraded');
  applyVerification(s, bad('x', '2026-11-12T02:00:00Z'), P, '2026-11-12T02:00:00Z');
  assert.equal(s.status, 'deprecated');
  applyVerification(s, ok('x', '2026-11-12T03:00:00Z'), P, '2026-11-12T03:00:00Z');
  assert.equal(s.status, 'active');
  assert.equal(s.verification.consecutiveFailures, 0);
  assert.ok(s.verification.lastOkAt);
});

test('状态机：社区线索不升级为 active，人工剔除不自动恢复', async () => {
  const { applyVerification } = await L();
  const community = { id: 'c', status: 'unverified', confidence: 'community', verification: {} };
  applyVerification(community, ok('c', '2026-11-12T00:00:00Z'), P, '2026-11-12T00:00:00Z');
  assert.equal(community.status, 'unverified');
  assert.equal(community.verification.endpointReachable, true);

  const removed = { id: 'r', status: 'removed', confidence: 'official', verification: {} };
  applyVerification(removed, ok('r', '2026-11-12T00:00:00Z'), P, '2026-11-12T00:00:00Z');
  assert.equal(removed.status, 'removed', '人工剔除不能被自动探测恢复');
});

test('失效剔除：老化后停用/剔除，并保留墓碑原因', async () => {
  const { prune } = await L();
  const at = '2026-12-31T00:00:00Z';
  const sources = [
    { id: 'stale', status: 'active', verification: { lastOkAt: '2026-11-01T00:00:00Z' }, firstSeenAt: '2026-10-01T00:00:00Z' },
    { id: 'fresh', status: 'active', verification: { lastOkAt: '2026-12-30T00:00:00Z' }, firstSeenAt: '2026-10-01T00:00:00Z' }
  ];
  const changes = prune(sources, P, at);
  assert.equal(sources[0].status, 'removed');
  assert.ok(sources[0].removedReason);
  assert.equal(sources[1].status, 'active');
  assert.ok(changes.length >= 2);
});

test('目录投影：剔除源不进入 provider-catalog，9 个必需字段齐全', async () => {
  const { projectCatalog } = await L();
  const required = ['id', 'name', 'kind', 'pool', 'loginUrl', 'docsUrl', 'models', 'quota', 'note'];
  const sources = [
    { id: 'live', name: 'Live', category: 'permanent-free', auth: 'api-key', status: 'active', confidence: 'official',
      docsUrl: 'https://example.com/docs', keyUrl: 'https://example.com/keys', models: ['m1'], quota: 'free', evidence: [], verification: {} },
    { id: 'dead', name: 'Dead', category: 'trial-credit', auth: 'api-key', status: 'removed', confidence: 'official',
      docsUrl: '', models: [], quota: '', evidence: [], verification: {} }
  ];
  const catalog = projectCatalog(sources, { providers: [] });
  assert.equal(catalog.providers.length, 1);
  assert.equal(catalog.providers[0].id, 'live');
  for (const key of required) assert.ok(catalog.providers[0][key] !== undefined, `missing ${key}`);
  assert.equal(catalog.providers[0].loginUrl, 'https://example.com/keys');
});

test('指标：可达率按已探测源计算，槽位映射取 config 交集', async () => {
  const { computeMetrics } = await L();
  const sources = [
    { id: 'a', status: 'active', category: 'permanent-free', confidence: 'official', models: ['m1'], relayIds: ['p1'],
      verification: { lastResult: 'reachable', endpointReachable: true, latencyMs: 10 } },
    { id: 'b', status: 'active', category: 'trial-credit', confidence: 'aggregator', models: ['m2'], relayIds: ['ghost'],
      verification: { lastResult: 'http-error', endpointReachable: false, latencyMs: 20 } },
    { id: 'c', status: 'removed', category: 'trial-credit', confidence: 'official', models: [], relayIds: [], verification: {} }
  ];
  const m = computeMetrics(sources, { candidates: [] }, [], { providers: [{ id: 'p1', enabled: true }, { id: 'p2', enabled: false }] });
  assert.equal(m.coverage.totalSources, 3);
  assert.equal(m.availability.checked, 2);
  assert.equal(m.availability.reachable, 1);
  assert.equal(m.availability.endpointReachableRate, 50);
  assert.equal(m.coverage.mappedRelaySlots, 1, 'ghost 不在 config.json，不应计入');
  assert.equal(m.coverage.slotConsolidation.totalSlotRefs, 2);
});
