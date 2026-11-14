# 源变更审计 / 更新记录

> 自动生成自 [`data/audit-log.json`](../data/audit-log.json)，最新时间 **2026-11-14T07:38:14.041Z**。
> 每次发现、校验、去重、状态变更、剔除、目录同步都留痕；剔除只置 `status=removed` 并保留原因，不删除记录。

## 本次优化（2026-11-12，v6.0.0）

| 动作 | 结果 | 证据 |
|---|---|---|
| 建立单一数据源 | `data/sources.json`，逐源带官方出处、额度、分类、状态、时间戳 | 本文件 |
| 来源发现 | 3 个公开清单（awesome-free-llm-apis / free-llm-api-resources / freellmapi）+ 官方证据链接自动抓取 | `data/candidates.json` |
| 可用性校验 | 并发 HTTP 探测官方文档/定价 URL，401/403/405/429 视为在线 | `data/history/*.json` |
| 去重分类 | id / 名称别名 / 显式别名表三键合并；14 个 kilo-* 与 10 个 ovh-* 槽位收敛为 2 个独立源 | `data/audit-log.json` |
| 失效剔除 | GitHub Models（2026-07-30 退役）、Chutes（无免费层）置 removed 并保留墓碑 | `docs/PROVIDER-SOURCES.md` |
| 文档 | 新增 SOURCES / SOURCE-AUDIT / MAINTENANCE / BENCHMARK / CHANGELOG / CONTRIBUTING | `docs/` |
| 自动化 | GitHub Actions 每日 + systemd timer 每日；CI 跑全部测试与 schema 校验 | `.github/workflows/` |

## 事件流水（最近 60 条）

| 时间(UTC) | 类型 | 摘要 |
|---|---|---|
| 2026-11-14 07:38 | catalog-sync | provider-catalog.json 62 → 62 条 |
| 2026-11-14 07:38 | reconcile | 64 → 64 源 / 合并重复 0 / 生命周期 0 |
| 2026-11-14 07:38 | verification | 探测 62 源 / 可达 60 / 状态变更 0 |
| 2026-11-14 07:38 | discovery | 3 个清单 / 40 候选 / 0 新线索 |
| 2026-11-13 08:04 | catalog-sync | provider-catalog.json 62 → 62 条 |
| 2026-11-13 08:04 | reconcile | 64 → 64 源 / 合并重复 0 / 生命周期 0 |
| 2026-11-13 08:04 | verification | 探测 62 源 / 可达 61 / 状态变更 0 |
| 2026-11-13 08:04 | discovery | 3 个清单 / 40 候选 / 0 新线索 |
| 2026-11-12 08:53 | catalog-sync | provider-catalog.json 62 → 62 条 |
| 2026-11-12 08:53 | reconcile | 64 → 64 源 / 合并重复 0 / 生命周期 0 |
| 2026-11-12 08:53 | verification | 探测 62 源 / 可达 61 / 状态变更 0 |
| 2026-11-12 08:53 | discovery | 3 个清单 / 40 候选 / 0 新线索 |
| 2026-11-12 08:25 | discovery | 3 个清单 / 40 候选 / 0 新线索 |
| 2026-11-12 08:23 | catalog-sync | provider-catalog.json 62 → 62 条 |
| 2026-11-12 08:23 | reconcile | 64 → 64 源 / 合并重复 0 / 生命周期 0 |
| 2026-11-12 08:23 | verification | 探测 62 源 / 可达 61 / 状态变更 0 |
| 2026-11-12 08:23 | discovery | 3 个清单 / 40 候选 / 1 新线索 |
| 2026-11-12 08:21 | catalog-sync | provider-catalog.json 62 → 62 条 |
| 2026-11-12 08:21 | reconcile | 64 → 64 源 / 合并重复 0 / 生命周期 0 |
| 2026-11-12 08:21 | verification | 探测 62 源 / 可达 61 / 状态变更 1 |
| 2026-11-12 08:21 | discovery | 3 个清单 / 34 候选 / 0 新线索 |
| 2026-11-12 08:19 | catalog-sync | provider-catalog.json 62 → 62 条 |
| 2026-11-12 08:19 | reconcile | 64 → 64 源 / 合并重复 0 / 生命周期 0 |
| 2026-11-12 08:19 | verification | 探测 62 源 / 可达 60 / 状态变更 1 |
| 2026-11-12 08:19 | discovery | 3 个清单 / 52 候选 / 14 新线索 |
| 2026-11-12 08:16 | catalog-sync | provider-catalog.json 62 → 62 条 |
| 2026-11-12 08:16 | reconcile | 64 → 64 源 / 合并重复 0 / 生命周期 0 |
| 2026-11-12 08:16 | verification | 探测 62 源 / 可达 60 / 状态变更 1 |
| 2026-11-12 08:16 | discovery | 3 个清单 / 59 候选 / 0 新线索 |
| 2026-11-12 07:59 | catalog-sync | provider-catalog.json 62 → 62 条 |
| 2026-11-12 07:59 | reconcile | 64 → 64 源 / 合并重复 0 / 生命周期 0 |
| 2026-11-12 07:59 | verification | 探测 62 源 / 可达 60 / 状态变更 3 |
| 2026-11-12 07:59 | discovery | 3 个清单 / 59 候选 / 21 新线索 |
| 2026-11-12 07:55 | catalog-sync | provider-catalog.json 62 → 62 条 |
| 2026-11-12 07:55 | reconcile | 64 → 64 源 / 合并重复 0 / 生命周期 0 |
| 2026-11-12 07:55 | verification | 探测 62 源 / 可达 59 / 状态变更 2 |
| 2026-11-12 07:55 | discovery | 3 个清单 / 59 候选 / 21 新线索 |
| 2026-11-12 07:43 | catalog-sync | provider-catalog.json 61 → 62 条 |
| 2026-11-12 07:43 | reconcile | 64 → 64 源 / 合并重复 0 / 生命周期 0 |
| 2026-11-12 07:43 | verification | 探测 62 源 / 可达 60 / 状态变更 0 |
| 2026-11-12 07:43 | discovery | 3 个清单 / 59 候选 / 21 新线索 |
| 2026-11-12 07:43 | registry-init | 注册表初始化，新增 64 源，共 64 |

## 人工决策记录

- **2026-10-27**：排除 GitHub Models（已退役）、Chutes（无免费层）、Hugging Face Free（额度波动）、DeepSeek（云端池主动排除）、共享网关/CAPTCHA 绕过。见 `docs/PROVIDER-SOURCES.md`。
- **2026-11-12**：约 20 条国内/国际额度来自社区汇总，统一标 `confidence=community` 与 `status=unverified`，不进路由、不承诺额度数字。
- **2026-11-12**：`confidence=official` 与 `aggregator` 的区分只影响「是否可直接启用」，不影响是否收录。
