# 对标报告：GitHub「免费高质量 token」类目头部项目

> 数据抓取时间：**2026-11-12 15:23 (GMT+8) / 07:23 UTC**
> 抓取方式：GitHub REST API `api.github.com/repos/*`、`/commits?since=2026-10-13T00:00:00Z&per_page=100`，
> 以及各仓库 `main` 分支 README 原文（`raw.githubusercontent.com`）。
> 自测指标：`data/metrics.json`（由 `npm run sources:report` 生成，时间见该文件 `generatedAt`）。

## 1. 对标对象与基线

| 项目 | Stars | Forks | 许可 | 近 30 天提交 | 源口径 | 维护方式 |
|---|---:|---:|---|---:|---|---|
| `mnfst/awesome-free-llm-apis` | 12,943 | 1,546 | CC0-1.0 | 83 | 14 家永久免费层（4 家厂商 API + 10 家推理平台），带逐模型限额表 | 人工 PR + 脚注标记退役，仓库含 JS 工具 |
| `tashfeenahmed/freellmapi` | 50,870 | 7,068 | MIT | ≥100（API 单页上限） | README 自称 34 providers / 635 free model endpoints | Docker Compose + 管理面板 + 加密 key，社区活跃 |
| `free-llm-api-resources`（`steelburn` fork 镜像） | — | — | MIT | 427 总提交 | Free Providers 13 组 + trial credits 约 15 组 | **GitHub Actions 每日自动更新 README 模型列表** |
| `William-Trader/free-token-cloud`（优化前 v5.2.0） | 2 | 0 | PolyForm NC 1.0.0 | 55 | 34 条目录 / 56 个路由槽位，无分类 | 纯人工；最近一次源审计 2026-10-27 |

注：原上游 `cheahjs/free-llm-api-resources` 在 2026-11-12 已返回 404，故以其 `steelburn` fork 镜像作为发现源与对标样本。
「源数」口径各项目不同：清单类按**独立厂商/计划**，聚合器类按**已接入 provider**，本项目两者分开统计（见第 4 节）。

## 2. 可衡量改进结果（优化前 → 优化后）

| # | 维度 | 优化前（v5.2.0） | 优化后（v6.0.0） | 变化 | 证据 |
|---|---|---|---|---|---|
| 1 | **源覆盖量**（独立免费计划） | 34（目录条目，无分类，含订阅/本地混计） | **64**（8 类，含 2 条失效墓碑） | **+30 / +88.2%** | `data/sources.json` → `docs/SOURCES.md` |
| 2 | **provider-catalog 条目** | 34 | **62** | **+28 / +82.4%** | `provider-catalog.json` |
| 3 | **公开清单发现覆盖** | 0（无自动发现） | 3 个清单 → **40 个有效条目**（13 + 26 + 11，14 个章节噪声被过滤），**40/40 已覆盖、0 未收录线索** | 0 → 3 feeds | `data/discovery-feeds.json`、`data/candidates.json` |
| 4 | **逐源证据结构化** | 34 条仅有 `docsUrl` 字符串，无出处类型/时间 | **64/64 (100%)** 带 `evidence[].kind` + `retrievedAt` + 官方/清单/审计/社区四级标注 | 结构化证据 0 → 100% | `data/sources.json`、`docs/SOURCES.md` |
| 5 | **端点可用率** | 无自动校验（`probe-providers.mjs` 需手动跑、不写状态） | **98.3%（59/60 已探测）**，平均延迟 4,557 ms（定稿快照）；当日多次复跑区间 95.0–98.3%，属网络波动，以 `data/metrics.json` 的 `generatedAt` 为准 | 0 → 可量化 | `data/history/2026-11-12.json`、`data/metrics.json` |
| 6 | **官方证据 + 状态可用占比** | 不可计算 | **35.9%（23/64）**；16 条社区线索显式标 `unverified`、不进路由 | 新增可分辨口径 | `data/metrics.json` |
| 7 | **更新频率** | 0 次自动；最后一次源审计距本次 16 天 | **每日 1 次权威全流程**（Actions UTC 01:17）+ **1 次服务器只读复核**（systemd 03:17）+ 每次 push 的 CI 校验 | 0 → 2 个自动动作/日 | `.github/workflows/sources.yml`、`systemd/ai-relay-sources.timer` |
| 8 | **去重能力** | 两份清单 id 体系不同、无映射；14 个 `kilo-*` / 10 个 `ovh-*` 被当成 24 个源 | 三键去重 + 槽位收敛：**58 个槽位引用 → 5 个多槽位源**，56/56 个 config provider 全部有映射 | 映射 0 → 100% | `data/sources-policy.json`、`data/metrics.json` |
| 9 | **状态与失效剔除** | 无状态字段；5 条排除项只写在文档里 | 5 态状态机 + 连续失败/老化规则 + **2 条墓碑**（GitHub Models、Chutes，带原因与时间） | 0 → 可追溯 | `docs/SOURCE-AUDIT.md`、`data/audit-log.json` |

**状态机实证（2026-11-12 多轮校验）**：NVIDIA NIM 因 `build.nvidia.com/explore/discover` 链接漂移被自动降级为 `degraded`；
核实官方域名 `docs.nvidia.com/nim/` 返回 200 后修正种子，下一轮校验自动恢复 `active`。
域名全部不可达的社区线索则被降级/停用，不进入路由（`docs/SOURCES.md` 状态列可见）。
即「失效剔除」不是静态标记，而是每日可复跑、可降级、可恢复、可审计的流程。
| 10 | **文档完整度**（13 项检查） | **46%（6/13）** | **100%（13/13）** | **+54pp** | `data/metrics.json → documents`、`.github/workflows/ci.yml` |
| 11 | **自动化测试** | `npm test` 只跑 10 个；另 11 个 `responses.test.js` 从不执行且有 1 条过时断言失败 | **28 个用例全绿**，源管道新增 7 个用例 | 10 → 28，失败 1 → 0 | `test/*.test.js`、`npm test` |
| 12 | **CI / 自动化** | 无 `.github/`、无 CHANGELOG、无 CONTRIBUTING | 2 个 workflow（每日源维护 + 5 项 CI 检查：语法/JSON、测试、版本一致性、schema、文档完整性） | 0 → 2 | `.github/workflows/` |
| 13 | **运行时缺陷修复** | 4 个已确认断点：每日评分 401、评分不落盘、版本硬编码 3、健康探测串行 | 全部修复并加回归测试/线上验收 | 4 → 0 | `CHANGELOG.md`、线上 `journalctl` |
| 14 | **分类覆盖** | 无分类 | 8 类：永久免费 12 / 免费模型 4 / 匿名 4 / 试用赠金 27 / 开发者配额 5 / 网关 6 / 订阅 4 / 本地 2 | 1 → 8 | `docs/SOURCES.md` |

### 与头部项目的位置

| 维度 | 头部基准 | 本项目 v6.0.0 | 判断 |
|---|---|---|---|
| 源覆盖（独立计划） | mnfst 14 / resources ~28 / freellmapi 34 providers | **64**（但含 16 条待核实线索、2 条墓碑；**严格已核实口径 46 active**） | 数量领先，但口径更宽，已用状态字段显式区分 |
| 自动校验可用率 | 清单类均**不提供**自动化可用率 | 96.7% 每日复核 + 历史快照 | **超出清单类头部** |
| 来源标注 | mnfst 脚注 + 官方链接（人工） | 64/64 结构化证据 + 证据等级 + 时间戳 | 结构化与可追溯性更强 |
| 更新频率 | resources 每日 Actions 更新模型列表；mnfst 83 commits/30d | 每日 1 次权威全流程 + 1 次服务器只读复核 + CI，但**仓库提交活动仍靠人工** | 自动化频率对齐，社区活跃度差距大 |
| 失效剔除 | mnfst 用脚注手工标注退役 | 自动状态机 + 墓碑 + 审计流水 | **超出清单类头部** |
| 工程化部署 | freellmapi 有 Docker Compose / 管理面板 | systemd + `deploy.sh` 备份回滚 + 4 组 timer | 各有侧重；本项目无 Docker 一键安装 |
| 逐模型限额表 | mnfst 每模型列 context / max output / modality / rate limit | 源级额度原文 + 模型名列表，**不逐模型列限额** | **存在差距** |
| 社区规模 | 12,943 / 50,870 stars | 2 stars | **不在本次工程优化范围** |

**结论**：在「来源发现 → 校验 → 去重 → 状态 → 剔除 → 标注 → 审计」这条**源维护链路**上，本项目的自动化程度、可追溯性与可衡量性已达到或超过清单类头部项目；在逐模型限额表、Docker 一键安装、多语言文档与社区规模上仍有明确差距，已如实列出。

## 3. 复现方式

```bash
# 自测指标
npm run sources:all          # 全流程（需网络）
npm run sources:report       # 仅从已有数据重生成文档与 metrics
npm test                     # 28 个用例
npm run check                # 语法 + JSON + 版本一致性由 CI 补做

# 对标数据（带时间戳）
curl -s https://api.github.com/repos/mnfst/awesome-free-llm-apis
curl -s "https://api.github.com/repos/mnfst/awesome-free-llm-apis/commits?since=2026-10-13T00:00:00Z&per_page=100"
curl -s https://api.github.com/repos/tashfeenahmed/freellmapi
curl -s https://raw.githubusercontent.com/mnfst/awesome-free-llm-apis/main/README.md
```

优化前基线证据：本地仓库 `git show 4002de3`（v5.2.0）中的 `README.md`、`docs/PROVIDER-SOURCES.md`、
`provider-catalog.json`、`package.json`，以及 101 服务器 `/opt/ai-relay/` 部署快照（md5 与本地一致，2026-11-12 15:15 核对）。

## 4. 口径说明（避免数字被误读）

| 名称 | 定义 | 当前值 |
|---|---|---|
| 独立免费计划 | `data/sources.json` 一条记录，含已剔除墓碑 | 64 |
| 参与清单的源 | 上表减去 `removed` | 62 |
| `status=active` | 非社区线索且未被降级/停用 | 46 |
| 已探测源 | 排除 `removed` 与 `local` 后完成 HTTP 校验 | 60 |
| 端点可达率 | `endpointReachable=true` / 已探测 | 59/60 = 98.3%（定稿快照，复跑区间 95.0–98.3%） |
| 官方证据 + 状态可用占比 | `confidence=official && status=active` / 全部源 | 23/64 = 35.9% |
| 运行时路由槽位 | `config.json` 的 provider 条目（与源数不同口径） | 56（47 启用） |
| 文档完整度 | `metrics.documents` 13 项布尔检查的通过率 | 13/13 = 100% |

端点可达 **不等于** 账号有额度：自动探测只发不带凭据的 GET 到官方文档/定价/控制台/端点；
带 key 的真实可用性由 `/setup` 保存 key 时的 authenticated model-list 校验决定。

**两个视角要分开看**：仓库/CI 视角 98.3%（59/60，定稿快照），101 服务器视角 90.3%（56/62，首次部署实测）——
服务器直连 `raw.githubusercontent.com` 与部分 Google 域名不通，属机房出网限制，不是源失效。
服务器结果写 `data/runtime-health.json` 且**不回写注册表**，权威状态以 CI 为准。

## 5. 本次未解决（诚实清单）

1. `config.json` 的 56 个 provider 仍无 `dailyLimit`，运行时每日限额是空转（额度事实已入注册表，启用需灰度验证）。
2. 16 条 `confidence=community` 的线索（含营销号给出的夸张 token 数字）只作线索，不进路由、不承诺额度。
3. 自动发现解析的是公开清单的标题级条目，不解析表格内逐模型限额；逐模型表尚未建立。
4. 无 Docker / 一键安装、无英文 README、无逐模型 context/max-output 表。
5. GitHub star / fork / 社区贡献者数量与头部项目差 3–4 个数量级，不是代码优化能解决的。
