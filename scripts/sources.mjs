#!/usr/bin/env node
/**
 * 免费源持续维护 CLI
 *
 *   node scripts/sources.mjs init         从种子构建/合并 data/sources.json（幂等）
 *   node scripts/sources.mjs discover     抓取公开清单 → data/candidates.json（带出处）
 *   node scripts/sources.mjs verify       并发 HTTP 可用性校验 → 更新状态 + 每日快照
 *   node scripts/sources.mjs reconcile    去重 / 分类 / 状态更新 / 失效剔除 → 审计流水
 *   node scripts/sources.mjs sync         从注册表投影 provider-catalog.json
 *   node scripts/sources.mjs report       生成 docs/SOURCES.md、SOURCE-AUDIT.md、metrics.json、README 片段
 *   node scripts/sources.mjs all          以上全流程（CI / 每日定时任务调用）
 *
 * 环境变量：SOURCES_TIMEOUT_MS、SOURCES_CONCURRENCY、SOURCES_SKIP_VERIFY=1
 */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { SEEDS, SEED_VERSION, SEED_DATE, INITIAL_REMOVED } from './sources-seed.mjs';
import {
  ROOT, DATA, DOCS, REGISTRY, CANDIDATES, FEEDS, METRICS, CATALOG,
  now, loadJson, saveJson, policy, normalizeName, normalizeUrl, slug, dedupe, classify,
  mapConcurrent, verifyOne, applyVerification, prune, projectCatalog, computeMetrics
} from './lib/sources-lib.mjs';

const P = policy();
const AT = now();
const args = process.argv.slice(2);
const cmd = args[0] || 'all';
const only = args.find(a => a.startsWith('--only='))?.slice(7);
if (Number(process.env.SOURCES_TIMEOUT_MS)) P.verification.timeoutMs = Number(process.env.SOURCES_TIMEOUT_MS);
if (Number(process.env.SOURCES_CONCURRENCY)) P.verification.concurrency = Number(process.env.SOURCES_CONCURRENCY);

const AUDIT_LOG = path.join(DATA, 'audit-log.json');
const HISTORY = path.join(DATA, 'history');
const README = path.join(ROOT, 'README.md');

function audit(events) {
  const log = loadJson(AUDIT_LOG, { version: 1, events: [] });
  log.events.push(...events.map(e => ({ at: AT, ...e })));
  log.events = log.events.slice(-500);
  saveJson(AUDIT_LOG, log);
}

// ── init ──────────────────────────────────────────────────────────────────
function init() {
  const existing = loadJson(REGISTRY, null);
  const byId = new Map((existing?.sources || []).map(s => [s.id, s]));
  const sources = SEEDS.map(seed => {
    const prev = byId.get(seed.id);
    const evidence = (seed.evidence || []).map(url => ({
      url,
      kind: /PROVIDER-SOURCES\.md/.test(url) ? 'project-audit'
        : /^https?:\/\/(github\.com|www\.github\.com)\//.test(url) ? 'aggregator-list'
        : /mp\.weixin|51cto|51cos|hefeng\.chat|blog\.csdn/.test(url) ? 'community-report' : 'official',
      retrievedAt: SEED_DATE
    }));
    const base = {
      ...seed,
      evidence,
      confidence: seed.confidence || 'aggregator',
      firstSeenAt: prev?.firstSeenAt || SEED_DATE,
      // 有 catalogIds 的是原有 provider-catalog.json 的 34 条；其余为 2026-11-12 全网搜寻新增
      addedBy: prev?.addedBy || (seed.catalogIds?.length ? 'existing-catalog' : 'discovery-2026-11-12'),
      status: prev?.status || (INITIAL_REMOVED[seed.id] ? 'removed'
        : seed.confidence === 'community' ? 'unverified' : 'active'),
      verification: prev?.verification || {},
      // 墓碑时间必须沿用首次记录，否则每次 init 都会把「剔除日期」刷新成当天，审计失真
      removedAt: prev?.removedAt,
      removedReason: prev?.removedReason,
      tags: seed.tags || [],
      models: seed.models || [],
      relayIds: seed.relayIds || [],
      catalogIds: seed.catalogIds || []
    };
    if (INITIAL_REMOVED[seed.id] && !base.removedAt) {
      base.removedAt = AT;
      base.removedReason = INITIAL_REMOVED[seed.id];
    }
    return base;
  });
  const registry = {
    version: SEED_VERSION,
    schema: 'free-token-cloud/sources@1',
    updatedAt: AT,
    seedDate: SEED_DATE,
    policy: 'data/sources-policy.json',
    note: '单一数据源（SSOT）。status/verification 由 verify+reconcile 自动更新，请勿手工编辑这两组字段。',
    sources
  };
  saveJson(REGISTRY, registry);
  const added = sources.filter(s => !byId.has(s.id)).length;
  console.log(`[init] registry: ${sources.length} 源（新增 ${added}），SSOT → ${path.relative(ROOT, REGISTRY)}`);
  if (added) audit([{ type: 'registry-init', added, total: sources.length, seedVersion: SEED_VERSION }]);
  return registry;
}

// ── discover ──────────────────────────────────────────────────────────────
const REJECT_PATTERNS = [/shared\s+key/i, /cracked/i, /captcha/i, /bypass/i, /free\s+gpt-4\s+no\s+key/i];
// 清单 README 的章节标题不是「源」，必须过滤，否则会被当成新线索造成假阳性
const HEADING_NOISE = /^(contents|contributing|glossary|license|sponsors|table of contents|faq|installation|usage|features|quick start|overview|why|roadmap|disclaimer|acknowledg|free providers|providers with trial credits|provider apis|inference providers|supported providers|models|limits|notes|examples|api reference|troubleshooting|how it works|compatible clis|how it compares|desktop app|works with|languages|premium|using the api|screenshots|keys|playground|analytics|limitations|contributors|getting started|pricing|comparison|changelog|credits|community|support|feedback|star history)/i;
function parseHeadings(md) {
  const out = [];
  const re = /^#{2,4}\s+(.+?)\s*$/gm;
  let m;
  while ((m = re.exec(md))) {
    let raw = m[1].trim();
    let url = '';
    // 形如 `### [NVIDIA NIM](https://...) 🇺🇸`：链接后还可能带国旗 emoji
    const link = raw.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (link) { url = link[2]; raw = link[1] + raw.slice(link[0].length); }
    const name = raw
      .replace(/[\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{1F300}-\u{1FAFF}\u{FE0F}\u{200D}]/gu, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[*_`]/g, '').trim();
    if (!name || name.length > 80 || HEADING_NOISE.test(name)) continue;
    out.push({ name, url });
  }
  return out;
}
/** 有些聚合器把 provider 列在 HTML 表格的 <b> 标签里（如 freellmapi），而非 markdown 标题 */
function parseHtmlBold(md) {
  const section = md.match(/^## Supported providers\s*\n([\s\S]*?)(?=^## )/m);
  const body = section ? section[1] : md;
  const out = [];
  for (const m of body.matchAll(/<b>([^<]{2,60})<\/b>/g)) {
    const name = m[1].trim().replace(/[*_`]/g, '');
    if (!name || HEADING_NOISE.test(name)) continue;
    out.push({ name, url: '' });
  }
  return out;
}

async function discover(registry) {
  const feeds = loadJson(FEEDS, { feeds: [] }).feeds.filter(f => f.enabled && f.url.startsWith('http'));
  const results = [];
  for (const feed of feeds) {
    try {
      const res = await fetch(feed.url, {
        headers: {
          accept: feed.accept || 'text/markdown,text/plain,*/*',
          'user-agent': P.verification.userAgent
        },
        signal: AbortSignal.timeout(20000)
      });
      const md = await res.text();
      const headings = feed.parse === 'html-b' ? parseHtmlBold(md) : parseHeadings(md);
      for (const h of headings) {
        // url 只能是条目标题里的厂商链接；缺失时留空，绝不能回退到 feed 自身的
        // github.com 地址（否则所有无链接的章节标题都会因 host=github.com 被误标为已覆盖）
        results.push({ id: slug(h.name), name: h.name, url: h.url || '',
          feedId: feed.id, feedUrl: feed.sourceUrl || feed.url, feedApiUrl: feed.url,
          feedLicense: feed.license, retrievedAt: AT });
      }
      console.log(`[discover] ${feed.id}: HTTP ${res.status}, ${headings.length} 个条目`);
    } catch (error) {
      console.log(`[discover] ${feed.id}: 抓取失败 ${String(error.message || error).slice(0, 100)}`);
      results.push({ id: `feed-error-${feed.id}`, name: feed.name, url: feed.url,
        feedId: feed.id, feedUrl: feed.url, retrievedAt: AT, fetchError: String(error.message || error).slice(0, 140) });
    }
  }
  const aliases = P.dedupe?.aliases || {};
  const knownKeys = new Set(registry.sources.flatMap(s => [
    normalizeName(s.id, aliases), normalizeName(s.name, aliases),
    ...(s.relayIds || []).map(v => normalizeName(v, aliases))
  ]));
  const knownHosts = new Set(registry.sources.flatMap(s =>
    [s.docsUrl, s.pricingUrl, s.keyUrl, s.endpoint].map(u => normalizeUrl(u, P.dedupe).split('/')[0])).filter(Boolean));

  const seen = new Set();
  const candidates = [];
  for (const c of results) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    const host = normalizeUrl(c.url, P.dedupe).split('/')[0];
    const rejected = REJECT_PATTERNS.some(r => r.test(c.name));
    const known = !c.fetchError && (knownKeys.has(normalizeName(c.name, aliases)) || (host && knownHosts.has(host)));
    candidates.push({ ...c, disposition: c.fetchError ? 'feed-error' : rejected ? 'rejected' : known ? 'known' : 'new',
      matchReason: known ? (host && knownHosts.has(host) ? 'host' : 'name-alias') : null });
  }
  const json = { version: 1, generatedAt: AT, generator: 'scripts/sources.mjs discover',
    feedCount: feeds.length, note: '候选池仅作线索；进入注册表必须人工补官方证据并核实额度。',
    candidates };
  saveJson(CANDIDATES, json);
  const n = candidates.filter(c => c.disposition === 'new').length;
  console.log(`[discover] 候选 ${candidates.length} 条（已覆盖 ${candidates.filter(c => c.disposition === 'known').length}，新线索 ${n}，排除 ${candidates.filter(c => c.disposition === 'rejected').length}）`);
  audit([{ type: 'discovery', feeds: feeds.length, candidates: candidates.length, newLeads: n }]);
  return json;
}

// ── verify ────────────────────────────────────────────────────────────────
async function verify(registry) {
  if (process.env.SOURCES_SKIP_VERIFY === '1') { console.log('[verify] 跳过（SOURCES_SKIP_VERIFY=1）'); return []; }
  const targets = registry.sources.filter(s => s.status !== 'removed' && (!only || s.id === only));
  const results = await mapConcurrent(targets, P.verification.concurrency, s => verifyOne(s, P));
  const changes = [];
  for (let i = 0; i < targets.length; i++) {
    const { change } = applyVerification(targets[i], results[i] || {}, P, AT);
    if (change) changes.push(change);
  }
  registry.updatedAt = AT;
  saveJson(REGISTRY, registry);
  saveJson(path.join(HISTORY, `${AT.slice(0, 10)}.json`), {
    date: AT.slice(0, 10), generatedAt: AT, checked: results.length,
    reachable: results.filter(r => r.ok).length, results
  });
  const reachable = results.filter(r => r.ok).length;
  console.log(`[verify] ${results.length} 源，端点可达 ${reachable}（${(reachable / results.length * 100).toFixed(1)}%），状态变更 ${changes.length}`);
  audit([{ type: 'verification', checked: results.length, reachable, changes }]);
  return changes;
}

// ── runtime-check（服务器只读复核） ────────────────────────────────────────
/**
 * 生产服务器视角的每日复核：只探测、只写独立快照，不修改注册表状态、
 * 不重生成 provider-catalog、不刷新文档。
 * 原因：服务器出网与 GitHub Actions runner 不同（部分境外域名不通），
 * 若让它跑完整 all，会把「本机不可达」误写成「源失效」，与 CI 的权威数据冲突。
 */
async function runtimeCheck(registry) {
  const targets = registry.sources.filter(s => s.status !== 'removed' && (!only || s.id === only));
  const results = await mapConcurrent(targets, P.verification.concurrency, s => verifyOne(s, P));
  const reachable = results.filter(r => r.ok).length;
  const checked = results.filter(r => r.result !== 'skipped').length;
  const snapshot = {
    generatedAt: AT,
    runtime: process.env.SOURCES_RUNTIME_ID || 'server',
    perspective: '从本机出网视角探测；只反映本机可达性，不代表源本身失效',
    authority: 'data/sources.json 的 status 由 GitHub Actions 权威维护，本快照不修改它',
    checked,
    reachable,
    rate: checked ? +(reachable / checked * 100).toFixed(1) : 0,
    unreachable: results.filter(r => !r.ok && r.result !== 'skipped')
      .map(r => ({ id: r.id, result: r.result, httpStatus: r.httpStatus, error: r.error || null })),
    results
  };
  saveJson(path.join(DATA, 'runtime-health.json'), snapshot);
  console.log(`[runtime-check] ${snapshot.runtime}: ${checked} 源，可达 ${reachable}（${snapshot.rate}%）→ data/runtime-health.json`);
  console.log(`[runtime-check] 注册表状态未被修改；权威更新由 GitHub Actions 完成`);
  return snapshot;
}

// ── reconcile ─────────────────────────────────────────────────────────────
function reconcile(registry) {
  const before = registry.sources.length;
  const { merged, duplicates } = dedupe(registry.sources, P.dedupe?.aliases || {});
  merged.forEach(classify);
  const lifecycle = prune(merged, P, AT);
  registry.sources = merged;
  registry.updatedAt = AT;
  registry.lastReconciledAt = AT;
  saveJson(REGISTRY, registry);
  console.log(`[reconcile] ${before} → ${merged.length} 源，合并重复 ${duplicates.length}，生命周期变更 ${lifecycle.length}`);
  audit([{ type: 'reconcile', before, after: merged.length, duplicates, lifecycle }]);
  return duplicates;
}

// ── sync ─────────────────────────────────────────────────────────────────
function sync(registry) {
  const prev = loadJson(CATALOG, { providers: [] });
  const next = projectCatalog(registry.sources, prev);
  saveJson(CATALOG, next);
  console.log(`[sync] provider-catalog.json: ${prev.providers?.length || 0} → ${next.providers.length} 条`);
  audit([{ type: 'catalog-sync', from: prev.providers?.length || 0, to: next.providers.length }]);
}

// ── report ───────────────────────────────────────────────────────────────
const esc = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const short = (s, n = 88) => { const t = String(s || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const CATEGORY_TITLE = {
  'permanent-free': '永久免费层', 'free-model': '永久免费模型', anonymous: '匿名免费（无需 key）',
  'trial-credit': '试用 / 注册赠金', 'open-quota': '开发者计划 / 开源配额',
  gateway: '聚合网关免费路由', subscription: '自有订阅额度', local: '本地自托管兜底'
};
const STATUS_ICON = { active: '✅ 可用', degraded: '⚠️ 降级', unverified: '🔎 待核实', deprecated: '⏸ 停用', removed: '❌ 已剔除' };

function renderSourcesMd(registry, metrics) {
  const groups = {};
  for (const s of registry.sources) (groups[s.category] ||= []).push(s);
  const lines = [
    '# 免费源清单（Free Source Registry）',
    '',
    `> 自动生成，勿手工编辑。注册表：[\`data/sources.json\`](../data/sources.json) · 生成时间：**${AT}**`,
    `> 口径：**独立免费计划/渠道**（不是路由槽位）。已接入运行时槽位见 [README 调度章节](../README.md)。`,
    '',
    '## 总览',
    '',
    '| 指标 | 数值 |',
    '|---|---:|',
    `| 独立免费源（含墓碑） | **${metrics.coverage.totalSources}** |`,
    `| 参与清单的可用源（status=active） | **${metrics.coverage.activeSources}** |`,
    `| 端点可达率 | **${metrics.availability.endpointReachableRate}%**（${metrics.availability.reachable}/${metrics.availability.checked} 已探测） |`,
    `| 官方证据 + 状态可用占比 | **${metrics.availability.officialVerifiedRate}%** |`,
    `| 社区线索（待官方复核，不进路由） | ${metrics.coverage.communityReport} |`,
    `| 已剔除（保留墓碑） | ${metrics.coverage.removedSources} |`,
    `| 覆盖模型标识 | ${metrics.coverage.distinctModels} |`,
    `| 映射到运行时槽位 | ${metrics.coverage.mappedRelaySlots}（config.json 共 ${metrics.coverage.configuredRelayProviders} 条） |`,
    `| 槽位收敛 | ${metrics.coverage.slotConsolidation.totalSlotRefs} 个槽位引用 → ${metrics.coverage.slotConsolidation.distinctSources} 个独立计划（${metrics.coverage.slotConsolidation.multiSlotSources} 个源含多槽位） |`,
    '',
    '**图例**：✅ 已核实可用 · ⚠️ 连续探测失败降级 · 🔎 端点可达但额度事实待官方核实 · ⏸ 停用 · ❌ 失效剔除。',
    '',
    '**来源标注规则**：`官方` = 厂商文档/定价/控制台；`清单` = 公开 awesome 清单（用于交叉验证）；`审计` = 本项目历史审计记录。',
    '`confidence=community` 的额度数字来自社区汇总，仅作线索，**不作为事实承诺**，接入前必须回官方页复核。',
    ''
  ];
  for (const [cat, title] of Object.entries(CATEGORY_TITLE)) {
    const list = (groups[cat] || []).filter(s => s.status !== 'removed').sort((a, b) => a.id.localeCompare(b.id));
    if (!list.length) continue;
    lines.push(`## ${title} · \`${cat}\` · ${list.length} 条`, '');
    lines.push('| ID | 来源 | 认证 | 免费额度（原文摘要） | 证据 | 状态 / 探测 | 最后核查(UTC) | 出处 |',
      '|---|---|---|---|---|---|---|---|');
    for (const s of list) {
      const ev = (s.evidence || []).slice(0, 2).map(e => `[${e.kind === 'official' ? '官方' : e.kind === 'project-audit' ? '审计' : e.kind === 'community-report' ? '社区' : '清单'}](${e.url})`).join(' ');
      const probe = s.verification?.lastResult;
      const probeTag = probe === 'reachable' ? ' · 可达' : probe === 'unreachable' ? ' · 超时' : probe === 'http-error' ? ' · 链接异常' : '';
      lines.push(`| \`${s.id}\` | ${esc(s.name)} | ${s.auth} | ${esc(short(s.quota, 96))} | ${s.confidence} | ${STATUS_ICON[s.status] || s.status}${probeTag} | ${(s.verification?.lastCheckedAt || '—').slice(0, 16).replace('T', ' ')} | ${ev || '—'} |`);
    }
    lines.push('');
    const notes = list.filter(s => s.note);
    if (notes.length) {
      lines.push('<details><summary>备注与合规说明</summary>', '');
      for (const s of notes) lines.push(`- **${s.id}**：${s.note}`);
      lines.push('', '</details>', '');
    }
  }
  lines.push('## 已剔除（保留墓碑，不参与路由）', '');
  lines.push('| ID | 名称 | 剔除原因 | 剔除时间 |', '|---|---|---|---|');
  for (const s of registry.sources.filter(s => s.status === 'removed'))
    lines.push(`| \`${s.id}\` | ${esc(s.name)} | ${esc(s.removedReason || s.note || '人工剔除')} | ${(s.removedAt || '—').slice(0, 10)} |`);
  lines.push('', '## 维护方式', '',
    '```bash', 'npm run sources:all     # 发现 → 校验 → 去重/剔除 → 同步 → 报告',
    'npm run sources:verify  # 只跑可用性校验', 'npm run sources:report  # 只重新生成文档', '```', '',
    'GitHub Actions 与服务器 systemd timer 每日各跑一次；每次校验快照落在 `data/history/YYYY-MM-DD.json`。',
    '');
  return lines.join('\n');
}

function renderAuditMd(registry) {
  const log = loadJson(AUDIT_LOG, { events: [] });
  const events = [...log.events].reverse().slice(0, 60);
  const lines = [
    '# 源变更审计 / 更新记录', '',
    `> 自动生成自 [\`data/audit-log.json\`](../data/audit-log.json)，最新时间 **${AT}**。`,
    '> 每次发现、校验、去重、状态变更、剔除、目录同步都留痕；剔除只置 `status=removed` 并保留原因，不删除记录。', '',
    '## 本次优化（2026-11-12，v6.0.0）', '',
    '| 动作 | 结果 | 证据 |', '|---|---|---|',
    '| 建立单一数据源 | `data/sources.json`，逐源带官方出处、额度、分类、状态、时间戳 | 本文件 |',
    '| 来源发现 | 3 个公开清单（awesome-free-llm-apis / free-llm-api-resources / freellmapi）+ 官方证据链接自动抓取 | `data/candidates.json` |',
    '| 可用性校验 | 并发 HTTP 探测官方文档/定价 URL，401/403/405/429 视为在线 | `data/history/*.json` |',
    '| 去重分类 | id / 名称别名 / 显式别名表三键合并；14 个 kilo-* 与 10 个 ovh-* 槽位收敛为 2 个独立源 | `data/audit-log.json` |',
    '| 失效剔除 | GitHub Models（2026-07-30 退役）、Chutes（无免费层）置 removed 并保留墓碑 | `docs/PROVIDER-SOURCES.md` |',
    '| 文档 | 新增 SOURCES / SOURCE-AUDIT / MAINTENANCE / BENCHMARK / CHANGELOG / CONTRIBUTING | `docs/` |',
    '| 自动化 | GitHub Actions 每日 + systemd timer 每日；CI 跑全部测试与 schema 校验 | `.github/workflows/` |',
    '', '## 事件流水（最近 60 条）', '',
    '| 时间(UTC) | 类型 | 摘要 |', '|---|---|---|'
  ];
  for (const e of events) {
    let summary = '';
    if (e.type === 'verification') summary = `探测 ${e.checked} 源 / 可达 ${e.reachable} / 状态变更 ${e.changes?.length || 0}`;
    else if (e.type === 'discovery') summary = `${e.feeds} 个清单 / ${e.candidates} 候选 / ${e.newLeads} 新线索`;
    else if (e.type === 'reconcile') summary = `${e.before} → ${e.after} 源 / 合并重复 ${e.duplicates?.length || 0} / 生命周期 ${e.lifecycle?.length || 0}`;
    else if (e.type === 'catalog-sync') summary = `provider-catalog.json ${e.from} → ${e.to} 条`;
    else if (e.type === 'registry-init') summary = `注册表初始化，新增 ${e.added} 源，共 ${e.total}`;
    else summary = JSON.stringify(e).slice(0, 120);
    lines.push(`| ${e.at.slice(0, 16).replace('T', ' ')} | ${e.type} | ${esc(summary)} |`);
  }
  lines.push('', '## 人工决策记录', '',
    '- **2026-10-27**：排除 GitHub Models（已退役）、Chutes（无免费层）、Hugging Face Free（额度波动）、DeepSeek（云端池主动排除）、共享网关/CAPTCHA 绕过。见 `docs/PROVIDER-SOURCES.md`。',
    '- **2026-11-12**：约 20 条国内/国际额度来自社区汇总，统一标 `confidence=community` 与 `status=unverified`，不进路由、不承诺额度数字。',
    '- **2026-11-12**：`confidence=official` 与 `aggregator` 的区分只影响「是否可直接启用」，不影响是否收录。',
    '');
  return lines.join('\n');
}

function renderReadmeFragment(registry, metrics) {
  const c = metrics.coverage, a = metrics.availability;
  const rows = [];
  for (const cat of Object.keys(CATEGORY_TITLE)) {
    const list = registry.sources.filter(s => s.category === cat && s.status !== 'removed');
    if (!list.length) continue;
    rows.push(`| ${CATEGORY_TITLE[cat]} | ${list.length} | ${list.filter(s => s.status === 'active').length} | ${list.filter(s => s.status === 'unverified').length} |`);
  }
  return [
    '| 分类 | 源数 | 已核实可用 | 待官方核实 |', '|---|---:|---:|---:|',
    ...rows,
    '',
    `**合计 ${c.totalSources} 个独立免费源**（含 ${c.removedSources} 个已剔除墓碑）；端点可达率 **${a.endpointReachableRate}%**（${a.reachable}/${a.checked} 探测）；覆盖 ${c.distinctModels} 个模型标识，映射 ${c.mappedRelaySlots} 个运行时槽位。`,
    `完整逐源清单（含官方出处、额度原文摘要、最后核查时间、失效原因）见 [docs/SOURCES.md](docs/SOURCES.md)，变更流水见 [docs/SOURCE-AUDIT.md](docs/SOURCE-AUDIT.md)。`,
    `清单由 \`npm run sources:all\` 自动生成，每日经 GitHub Actions 与服务器 timer 复核；生成时间 ${AT}。`
  ].join('\n');
}

function report(registry, candidates, duplicates) {
  const config = loadJson(path.join(ROOT, 'config.json'), {});
  const metrics = computeMetrics(registry.sources, candidates, duplicates, config);
  metrics.documents = {
    readme: fs.existsSync(README), architecture: fs.existsSync(path.join(DOCS, 'ARCHITECTURE.md')),
    sourcesList: true, sourceAudit: true, maintenance: fs.existsSync(path.join(DOCS, 'MAINTENANCE.md')),
    benchmark: fs.existsSync(path.join(DOCS, 'BENCHMARK.md')),
    changelog: fs.existsSync(path.join(ROOT, 'CHANGELOG.md')),
    contributing: fs.existsSync(path.join(ROOT, 'CONTRIBUTING.md')),
    ci: fs.existsSync(path.join(ROOT, '.github', 'workflows', 'ci.yml')),
    sourceAutomation: fs.existsSync(path.join(ROOT, '.github', 'workflows', 'sources.yml')),
    perSourceEvidence: registry.sources.every(s => (s.evidence || []).length > 0),
    perSourceTimestamp: registry.sources.every(s => s.firstSeenAt &&
      (s.verification?.lastCheckedAt || s.removedAt || s.status === 'removed')),
    perSourceStatus: registry.sources.every(s => !!s.status)
  };
  metrics.documents.score = Math.round(Object.values(metrics.documents).filter(v => v === true).length / Object.keys(metrics.documents).length * 100);
  saveJson(METRICS, metrics);
  fs.mkdirSync(DOCS, { recursive: true });
  fs.writeFileSync(path.join(DOCS, 'SOURCES.md'), renderSourcesMd(registry, metrics));
  fs.writeFileSync(path.join(DOCS, 'SOURCE-AUDIT.md'), renderAuditMd(registry));

  if (fs.existsSync(README)) {
    const START = '<!-- SOURCES:START -->', END = '<!-- SOURCES:END -->';
    const md = fs.readFileSync(README, 'utf8');
    if (md.includes(START) && md.includes(END)) {
      const next = md.slice(0, md.indexOf(START) + START.length) + '\n\n' + renderReadmeFragment(registry, metrics) + '\n\n' + md.slice(md.indexOf(END));
      fs.writeFileSync(README, next);
      console.log('[report] README 源清单片段已刷新');
    }
  }
  console.log(`[report] 文档完整度 ${metrics.documents.score}% · 源覆盖 ${metrics.coverage.totalSources} · 可达率 ${metrics.availability.endpointReachableRate}%`);
  return metrics;
}

// ── main ──────────────────────────────────────────────────────────────────
(async () => {
  let registry = loadJson(REGISTRY, null);
  if (!registry || cmd === 'init') registry = init();
  if (cmd === 'init') return;
  if (cmd === 'runtime-check') { await runtimeCheck(registry); return; }
  let candidates = loadJson(CANDIDATES, { candidates: [] });
  let duplicates = [];
  if (cmd === 'all' || cmd === 'discover') candidates = await discover(registry);
  if (cmd === 'all' || cmd === 'verify') await verify(registry);
  if (cmd === 'all' || cmd === 'reconcile') duplicates = reconcile(registry);
  if (cmd === 'all' || cmd === 'sync') sync(registry);
  if (cmd === 'all' || cmd === 'report') report(registry, candidates, duplicates);
  if (cmd === 'all') console.log('[all] 完成：源发现 → 校验 → 去重/剔除 → 同步 → 报告');
})().catch(error => { console.error('[sources] 失败：', error); process.exitCode = 1; });
