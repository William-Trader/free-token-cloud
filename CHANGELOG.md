# Changelog

本项目所有 notable changes 记录在此。版本号遵循 [Semantic Versioning](https://semver.org/)。
源清单的逐日变更不写在这里，见 [docs/SOURCE-AUDIT.md](docs/SOURCE-AUDIT.md) 与 `data/audit-log.json`。

## v6.0.0 — 免费源持续维护体系（2026-11-12）

### 新增

- **单一数据源（SSOT）**：`data/sources.json`，64 个独立免费计划，逐条带官方/清单出处、额度原文、分类、认证方式、状态、时间戳与证据等级；`provider-catalog.json` 由它投影生成，不再手工维护两份互相漂移的清单。
- **来源发现**：`data/discovery-feeds.json` 配置 3 个公开清单（mnfst/awesome-free-llm-apis、free-llm-api-resources、tashfeenahmed/freellmapi）+ 官方证据链接；每日抓取写入 `data/candidates.json`，候选带 feed 出处与抓取时间。
- **可用性校验**：并发 HTTP 探测官方 docs/pricing/控制台/端点（多 URL 回退），401/403/405/429 视为在线；每日快照落 `data/history/YYYY-MM-DD.json`。
- **去重分类**：id / 名称别名 / 显式别名表三键合并；按 8 类（永久免费层、免费模型、匿名、试用赠金、开发者配额、网关、订阅、本地）打标签；14 个 `kilo-*` 与 10 个 `ovh-*` 路由槽位收敛到 2 个独立计划。
- **状态更新与失效剔除**：连续失败降级/停用、14 天未验证老化、30 天不可用剔除；剔除保留墓碑与原因，不删记录。
- **自动化**：`.github/workflows/sources.yml` 每日 UTC 01:17 全流程并提交；`.github/workflows/ci.yml` 跑 28 个测试、语法/JSON/schema/版本一致性/文档完整性检查；服务器 `ai-relay-sources.timer` 每日 03:17 复核。
- **文档**：`docs/SOURCES.md`（逐源清单）、`docs/SOURCE-AUDIT.md`（变更流水）、`docs/MAINTENANCE.md`（维护手册）、`docs/BENCHMARK.md`（对标报告）、`CONTRIBUTING.md`、独立 `CHANGELOG.md`；README 增加自动刷新的源覆盖表与来源标注章节。
- **测试**：新增 `test/sources.test.js`（7 个用例：规范化、去重、状态机、剔除、目录投影、指标）；`npm test` 现在覆盖 `test/*.test.js` 全部文件。

### 修复

- **每日评分巡检从未生效**：`score-run.sh` 读了 token 却硬编码 `Bearer ***`，撞 `/api/score/run` 的鉴权门返回 401（线上 journal 2026-11-12 09:00 实证）。现改为从 stdin 传 `--config -`，token 不进命令行/进程列表，并检查 HTTP 状态码。
- **评分 EWMA 从不落盘**：`config.json` 缺 `scoresFile`，`saveScores()` 静默返回；现已补配置，并在 `router.js` 加同目录回退，旧配置升级也生效。
- **`healthView().version` / `/api/info.version` 硬编码 `3`**：改为 `APP_VERSION` 常量并与 `package.json` 由 CI 校验一致。
- **健康探测串行**：56 个源逐个 `await`，单轮最坏 N×超时；改为并发 6 分批（与 `/api/score/run` 一致）。
- **`scripts/score-run.sh` 与根副本漂移**：改为 wrapper，单一实现。
- **过时测试断言**：`test/responses.test.js` 中「chat 池永不暴露思维链」与 v5.1+ 语义冲突（README 明确 chat/tools 都转发 reasoning），该测试此前从未被 `npm test` 执行；已改为验证「仅显式 `stripReasoning` 才隐藏」。
- **文档数字漂移**：README 的 54/19/29/30/20 与真实 56 provider / 47 enabled 对齐；`stack/MANIFEST.json` 版本与许可冲突已修正；README/交接文档提到但不存在的 `scripts/install-server.sh`、Docker Compose 改为真实入口（`deploy.sh` / `stackctl`）；个人本地路径改为通用路径。

- **线上发现源全失败**：101 服务器（阿里云上海）直连 `raw.githubusercontent.com` 返回 000，Node `fetch` 又不读系统代理，导致服务器侧 3 个公开清单全部抓取失败。已把发现源改为 `api.github.com/repos/<owner>/<repo>/contents/README.md` + `Accept: application/vnd.github.raw`（服务器实测 200 / 25,146 B）。
- **服务器与 CI 数据打架**：服务器若跑完整 `sources:all`，会把「本机连不上某境外域名」误记成「源失效」。新增 `runtime-check` 只读复核子命令与 `data/runtime-health.json` 快照；服务器 timer 只探测、不回写注册表/目录/文档，GitHub Actions 保持唯一权威。
- **macOS tar 扩展头噪音**：`deploy.sh` 同步 `scripts/data/docs` 时 Linux tar 刷 `LIBARCHIVE.xattr.com.apple.provenance` 警告，加 `COPYFILE_DISABLE=1` 消除。

### 已知差距（不在本次改动范围）

- `config.json` 的 56 个 provider 仍无 `dailyLimit`，`providerLimited()` / `quotaBonus` / `/api/public.quotas` 仍是空转。额度事实已进注册表，但**运行时每日限额未启用**——启用会改变线上调度行为，需在独立版本灰度验证。
- `confidence=community` 的 16 条线索不进路由、不承诺额度数字，须逐条回官方页复核后才能升为 `official`。

## 历史版本（v2.0.0 – v5.2.0，摘自 README，保持原文）

- **v5.2.0**：API 质量优化——① `reasoning_effort` 被上游 400 拒绝时自动剥离并持久化记忆，OVH / LLM7 一类“不支持推理参数”的源不再每次失败；② 单次尝试超时按剩余预算封顶，坏源不再突破 `budgetMs`（实测从 29s 收敛到 20s 内）；③ 巡检把 429 记为 `rate_limited` 而非失败，避免把被限流的可用源打到 5 分；④ tools 路由原生 function calling +0.22、桥接 -0.08、高 rpm +0.04；⑤ 桥接与思考提示并入首条 system，修掉 OVH `System message must be at the beginning`；⑥ 限流冷却 30s→10s、全候选冷却时按最近 retry 窗口等待，503 显著减少；⑦ 链路剪枝（ovh-nemo / kilo-laguna / llm7-minimax）并按实测重排 tools/chat。回归：chat 10/10 @2.8s，tools 10/10 @4.3s。
- **v5.1.0**：Agent 接入修复——① chat / tools 两个池都接受 `reasoning_effort` 并注入推理指令，`chat` 不再被强制剥离思维链；② `reasoning_effort` 进入转发字段，上游能真正提高推理档位；③ 透传流的每个 chunk 把 `model` 改回逻辑名，修掉 OpenClaw「Model route changed」与模型归属错乱；④ 合成流补发 `reasoning_content`，深度思考在客户端可见；⑤ 带工具调用时把上游写进 `content` 的思维链降级到 `reasoning`，正文不再出现大段思考；⑥ Responses 侧 `reasoning.effort` 同时设置 `reasoning_effort`，仅显式 `stripReasoning` 才隐藏。实测 OpenClaw `ai-relay/chat` 5s 出结论、`ai-relay/tools` 20s 完成 `exec`，工具 3/3 成功且正文为空、思维链独立。
- **v5.0.0**：私有算力池大版本——请求单飞（相同并发合并）、响应缓存、额度感知调度与每日限额、队列 24、评分巡检、自愈；实测相同请求 10 并发 1 次上游 / 1.67s（原 10 次 / 20.25s）。
- **v4.5.0**：免费额度与多并发——每上游每日计数（无 key 600 / keyed 1000）达限额自动跳过；控制台新增「免费额度」面板；队列并发提到 24，瞬时全限流时 6×400ms 等待重挑。实测 10 并发 10/10 成功。
- **v4.4.0**：三项扩容落地——多 key 目录轮换（`<provider>*.key` 自动纳入）、keyed 槽位预置（填 key 即启用）、响应缓存（120s，非流式/温度≤0.5/无工具）+ 请求队列（12 并发，排队 20s）。实测缓存命中 1.78s → 0.076s。
- **v4.3.1**：巡检提速与去噪——并发 4→6、单次探测超时封顶 12s，排除本机 agent 桥（piagent）等非聊天上游；25 个上游 25.4s 完成（原 27.8s/26 个）。
- **v4.3.0**：源评分与巡检——每日 09:00 自动探活所有启用上游，按「连通性 + 延迟」算 0–100 分（EWMA），分数直接参与调度加权；控制台底部新增「源评分与巡检」面板，巡检结果只显示在前端，不推送本机。
- **v4.2.0**：延迟优化——调度权重改为速度 30%、成功率 55%，>8s 源直接扣分；新增请求预算（tools 20s / chat 25s），超出立即停止换源。实测 tools 1.0–1.7s、chat 1.3–1.4s。
- **v4.1.4**：修复控制台 `usageMode` 未定义导致 usage 区块渲染失败；Token 卡改为占两格（双倍宽度），移动端同样占满一行。
- **v4.1.3**：控制台容错——每个区块独立渲染（单块出错不再拖垮整页，并在页脚显示错误原因）；时间戳非法不再污染图表；上游超时收紧（无 key 30s/首包 12s，keyed 45s/20s），平均延迟从 68.8s 降到个位数。
- **v4.1.2**：自愈增强——watchdog 巡检 `/health`、`/ready`、`/api/public` 与 nginx/mihomo，异常自动重启；systemd 关闭启动频率限制；前端断连改为「重连中…」并 4 秒自动重试。
- **v4.1.1**：用量图支持 **30 分钟 / 24 小时** 切换（小时桶持久化，保留 72 小时）；30 天趋势柱宽封顶并居中，修掉“单日一片蓝”。
- **v4.1.0**：用量统计升级——持久化按天桶，`/api/public` 暴露今日/本月/30 天趋势；控制台新增今日/本月卡片与 30 天柱状图；多 key 扫描（同目录 `<id>*.key` 自动轮换）扩容额度。
- **v4.0.0**：综合优化版——自适应调度（成功率/延迟/空闲/优先级）、工具健康度统计、原生工具优先 + 桥接重试；实测 10 次工具调用 9 次成功（llm7×5、kilo-nemotron×2、pollinations×2）。
- **v3.8.0**：全球免费源复查（5 个候选）——Airforce / VoidAI 匿名不可用，已作为 keyed 槽位预置；匿名池按实测收敛为 26 对话 / 17 工具（淘汰 503/429/超时），provider 条目 58、目录 34；链按实测健康度排序。
- **v3.7.4**：仓库脱敏复查——移除个人路径（`piAgentCwd` 改占位符）、测试夹具统一为 `test-token`；确认工作区/历史/release 无真实 key、无服务器 IP。
- **v3.7.3**：Ollama Cloud 接入池（`gpt-oss:20b`），凭据校验通过；新增隐藏路由 `ollama` 便于定向调用；chat 链把 ollama-cloud 排在 gemini 之后。
- **v3.7.2**：README 增加 PiAgent 接入说明与兼容矩阵（仅接 `tools`、`anthropic-messages`、推理档位）。
- **v3.7.1**：源健康重排（按实测 200 结果排序，移除 503/超时/429 的死槽位并重置熔断）；Anthropic `thinking` 与 `reasoning_effort` 会转成推理提示，PiAgent 等客户端开推理后真正生效。
- **v3.7.0**：Provider 支持 `proxy`（HTTP CONNECT 隧道），Gemini 经本机代理可直连；Gemini 模型更新为 `gemini-3.5-flash-lite`，校验改用 chat 模式；GitHub 仓库清除服务器地址痕迹。
- **v3.6.1**：Cloudflare Workers AI 正式可接入——支持 `<account_id>:<api_token>` 形式（地址模板自动替换 account id），`/setup` 页对应行出现 Key 输入框；校验走 `/models`。
- **v3.6.0**：预置 9 个 keyed 适配器（Zhipu / Moonshot / Together / Nebius / Hyperbolic / Fireworks / Requesty / Vercel AI Gateway / Chutes），目录扩到 31 条；keyed 槽位排到 tools/chat 链首，填 key 即启用，缺 key 自动跳过。
- **v3.5.0**：全网匿名源复查——接入 LLM7 `codestral-latest`（原生 function calling，进 tools 池），淘汰 Kilo `xingchen`（429）与 `super-120b`（404）；现 30 对话 / 20 工具槽位、54 个 provider 条目。
- **v3.4.6**：补工具参数校验回归测试；OpenClaw（chat completions）与 Codex（responses）工具调用端到端复测通过。
- **v3.4.5**：工具参数按 schema 校验——缺必填字段不接收，向模型回传缺失项并重试一次；402/配额类统一冷却；最终错误脱敏（不再把上游 quota 原文透给客户端）。
- **v3.4.4**：修复 agent 工具调用不稳——工具桥提示词改为「只输出 JSON，必须调用」并在无 tool_calls 时同 provider 重试一次；tools 链重排为 llm7 → kilo-cohere → kilo-dots → kilo → kilo-glyph。实测 5 次 4 次返回 tool_use。
- **v3.4.3**：README 全面对齐实际状态——54 个 provider 条目 / 29 对话 / 19 工具槽位、Token 合并与分开视图、缓存口径与移动端说明；移除已删除的 Playground 描述。
- **v3.4.2**：主 Token 卡拆成「读取 / 输出 / 缓存」三列 + 总计；缓存卡改为按请求的命中率；表格横向滚动、指标两列、池卡堆叠等移动端优化。
- **v3.4.1**：控制台 Token 可视化改版——卡片内堆叠条（读取/缓存/输出）、合并视图 + 分开视图、日志显示 `in→out`、槽位表显示 `总量 (in→out)`。
- **v3.4.0**：默认语言规则（`locale`）——仅对 `chat` 对话池注入「默认简体中文」，`tools`/编码链路不受影响；可用 `locale.routes` 调整范围。
- **v3.3.3**：usage 统一规范化——流式/非流式、OpenAI/Anthropic 都保证 `prompt_tokens_details.cached_tokens` 与 `completion_tokens_details.reasoning_tokens` 存在；兼容 `prompt_cache_hit_tokens`、`cache_read_input_tokens` 等厂商字段。
- **v3.3.2**：Anthropic 流量 usage 补齐 `input_tokens / output_tokens / cache_read_input_tokens / cache_creation_input_tokens`（流式与非流式），OpenAI 侧保留 `prompt_tokens_details` / `completion_tokens_details`，harness 可区分读取、输出与缓存命中。
- **v3.3.1**：新增 `docs/AGENT-HANDOFF.md`——给本地 agent 的部署交接（红线、Windows 适配、并存接入、验证与回滚）。
- **v3.3.0**：缓存命中与明细 token 上线——全局/上游统计 `cachedTokens`、`reasoningTokens`、`cacheHits`；控制台新增缓存命中卡、Token 拆分（输入/输出/缓存/推理）、槽位与日志显示 cached。
- **v3.2.1**：修复 harness 显示天文数字 tok/s——`/v1/messages` 流式改为真正的 Anthropic 事件回放（不再透传 OpenAI chunk），并按 `streamPacing` 节流到约 70 tok/s；正文为空时回退 reasoning，避免 0 时长。
- **v3.2.0**：许可从 Unlicense 收紧为 **PolyForm Noncommercial 1.0.0**——非商用免费，商用需单独授权。
- **v3.1.1**：修复 Provider 接入页禁用控件无反馈、登录链接无法打开时无备用路径；
  新增复制登录链接，Ollama 等公开模型目录改用真实最小推理校验，并完成内置 Harness 接入。
- **v3.1.0**：新增 Qwen/百炼、Cerebras、SambaNova、DeepInfra、Novita 五个官方
  Provider 适配，并将匿名池扩到 19 个工具槽位、29 个对话槽位；加入端点探测与来源审计。
- **v3.0.0**：抽取关键组件为自有 `free-token-cloud` 产品；新增 AES-256-GCM 凭据仓、
  Provider 登录目录、Web 接入页、Key 校验与自动启用、101 统一 stack 和 `stackctl`。
- **v2.6.0**：全链路 Token 用量统计——指标卡、双池、槽位表、用量图表、日志逐条显示 prompt/completion/total。
- **v2.5.0**：控制台改版——移除试跑器，新增双池面板（环形成功率、当前选定 API、成员状态）、30 分钟用量堆叠图、接口拆分与上游 TOP。
- **v2.4.2**：修复控制台脚本语法错误（换行转义），状态栏不再卡在「连接中」；刷新失败会明确提示并在 5 秒后重试。
- **v2.4.1**：控制台移除登录密码，改为公开只读 `/api/public`（`/v1/*` 仍鉴权）；Playground 单独填 token。
- **v2.4.0**：新增 Web 控制台（`/`、`/dashboard`）：实时指标、30 分钟流量、槽位熔断状态、日志、流式 Playground。
- **v2.2.2**：`chat` 池在 `/v1/chat/completions`（非流式与流式）也会剥离 `reasoning` 字段，OpenClaw 等上游客户端不会再看到思维链。
- **v2.2.1**：对话池（`chat`）不再注入推理提示、不再返回 `reasoning` 条目，避免把思维链暴露给用户；工具池（`tools`）保持原行为。
- **v2.2.0**：Codex 功能对齐——`custom_tool_call`（apply_patch 等 freeform 工具）、`local_shell`、结构化输出（`text.format` / `json_schema`）、`previous_response_id` 链式上下文、`incomplete` 状态、cached / reasoning usage、`reasoning.encrypted_content` 兼容。
- **v2.1.0**：`/v1/responses` 支持逐轮长思考（推理预算、思考摘要回填、reasoning 事件）；工具池与对话池同源头。
- **v2.0.0**：首个公开版（已脱敏，Unlicense）。

