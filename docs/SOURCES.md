# 免费源清单（Free Source Registry）

> 自动生成，勿手工编辑。注册表：[`data/sources.json`](../data/sources.json) · 生成时间：**2026-11-14T07:38:14.041Z**
> 口径：**独立免费计划/渠道**（不是路由槽位）。已接入运行时槽位见 [README 调度章节](../README.md)。

## 总览

| 指标 | 数值 |
|---|---:|
| 独立免费源（含墓碑） | **64** |
| 参与清单的可用源（status=active） | **46** |
| 端点可达率 | **96.7%**（58/60 已探测） |
| 官方证据 + 状态可用占比 | **35.9%** |
| 社区线索（待官方复核，不进路由） | 16 |
| 已剔除（保留墓碑） | 2 |
| 覆盖模型标识 | 97 |
| 映射到运行时槽位 | 56（config.json 共 56 条） |
| 槽位收敛 | 58 个槽位引用 → 64 个独立计划（5 个源含多槽位） |

**图例**：✅ 已核实可用 · ⚠️ 连续探测失败降级 · 🔎 端点可达但额度事实待官方核实 · ⏸ 停用 · ❌ 失效剔除。

**来源标注规则**：`官方` = 厂商文档/定价/控制台；`清单` = 公开 awesome 清单（用于交叉验证）；`审计` = 本项目历史审计记录。
`confidence=community` 的额度数字来自社区汇总，仅作线索，**不作为事实承诺**，接入前必须回官方页复核。

## 永久免费层 · `permanent-free` · 11 条

| ID | 来源 | 认证 | 免费额度（原文摘要） | 证据 | 状态 / 探测 | 最后核查(UTC) | 出处 |
|---|---|---|---|---|---|---|---|
| `aionlabs` | Aion Labs | api-key | 永久免费层，无需信用卡：15 RPM / 20,000 tokens/天；偏角色扮演与叙事 | official | ✅ 可用 · 可达 | 2026-11-14 07:38 | [官方](https://www.aionlabs.ai/app/api-keys/) [清单](https://github.com/mnfst/awesome-free-llm-apis) |
| `cerebras` | Cerebras Inference | api-key | 免费开发者层；另有符合条件账号的推广赠金（约 $5 / 30 天，历史上曾提供，以控制台为准） | aggregator | ✅ 可用 · 可达 | 2026-11-14 07:38 | [官方](https://inference-docs.cerebras.ai/) [审计](https://github.com/William-Trader/free-token-cloud/blob/main/docs/PROVIDER-SOURCES.md) |
| `cloudflare-workers-ai` | Cloudflare Workers AI | api-key | 10,000 Neurons/天免费（全部 Workers AI 用量共享），00:00 UTC 重置；超额不计费而是请求失败；7 个模型需付费计划 | official | ✅ 可用 · 可达 | 2026-11-14 07:38 | [官方](https://developers.cloudflare.com/workers-ai/platform/pricing/) [清单](https://github.com/mnfst/awesome-free-llm-apis) |
| `cohere` | Cohere Trial API key | api-key | Trial key：1,000 次调用/月、20 RPM，仅限非商业用途，无需信用卡 | official | ✅ 可用 · 可达 | 2026-11-14 07:38 | [官方](https://docs.cohere.com/docs/rate-limits) [清单](https://github.com/mnfst/awesome-free-llm-apis) |
| `gemini` | Google AI Studio / Gemini API | api-key | 永久免费层，无需信用卡；Google 已不再公布逐模型 RPD，需在 AI Studio 查看账号配额。免费层 prompt 可能用于改进产品（EEA/CH/UK 除外） | official | ✅ 可用 · 可达 | 2026-11-14 07:38 | [官方](https://ai.google.dev/gemini-api/docs/pricing) [清单](https://github.com/mnfst/awesome-free-llm-apis) |
| `groq` | Groq Free Plan | api-key | Free Plan：30 RPM / 1,000 RPD / 8,000 TPM / 200,000 TPD（聊天模型，逐模型可能不同） | official | ✅ 可用 · 可达 | 2026-11-14 07:38 | [官方](https://console.groq.com/docs/rate-limits) [清单](https://github.com/mnfst/awesome-free-llm-apis) |
| `jina-ai` | Jina AI（Embedding / Reranker） | api-key | 免费层含 100 万 token 额度（社区汇总），官方定价页为准；专精 embedding / reranker，非对话模型 | community | 🔎 待核实 · 可达 | 2026-11-14 07:38 | [官方](https://jina.ai/pricing) [社区](http://mp.weixin.qq.com/s?__biz=MzIyOTM0MDgwNQ==&mid=2247484095&idx=1) |
| `longcat` | 美团 LongCat 开放平台 | api-key | 社区汇总 Flash-Lite 系列 5 亿 Token/天、Chat/Thinking 系列 500 万 Token/天，按天重置（待官方复核，数字异常大，仅作线索） | community | 🔎 待核实 · 可达 | 2026-11-14 07:38 | [官方](https://longcat.ai/platform/docs) [社区](http://mp.weixin.qq.com/s?__biz=MzIyOTM0MDgwNQ==&mid=2247484095&idx=1) |
| `mistral` | Mistral AI La Plateforme / Codestral | api-key | La Plateforme 免费层（Experiment plan），需手机号验证；Codestral 另有独立免费入口 | official | ✅ 可用 · 可达 | 2026-11-14 07:38 | [官方](https://docs.mistral.ai/deployment/laplateforme/overview) [清单](https://github.com/steelburn/free-llm-api-resources) |
| `ollama-cloud` | Ollama Cloud | api-key | 提供免费层模型，按官方定价页为准；账号自有 key | aggregator | ✅ 可用 · 可达 | 2026-11-14 07:38 | [官方](https://docs.ollama.com/cloud) [清单](https://github.com/tashfeenahmed/freellmapi) |
| `yi-lightning` | 零一万物 Yi-Lightning | api-key | 社区汇总为 Yi-Lightning 免费、5 RPM 限速（待官方复核） | community | 🔎 待核实 · 可达 | 2026-11-14 07:38 | [官方](https://platform.lingyiwanwu.com/docs) [社区](http://mp.weixin.qq.com/s?__biz=MzIyOTM0MDgwNQ==&mid=2247484095&idx=1) |

<details><summary>备注与合规说明</summary>

- **gemini**：免费层地区限制与数据处理条款见官方 available-regions / terms 页。

</details>

## 永久免费模型 · `free-model` · 4 条

| ID | 来源 | 认证 | 免费额度（原文摘要） | 证据 | 状态 / 探测 | 最后核查(UTC) | 出处 |
|---|---|---|---|---|---|---|---|
| `baidu-qianfan` | 百度智能云千帆（ERNIE 免费模型） | api-key | ERNIE-Speed / ERNIE-Lite 等部分模型永久零价（按 QPS 限速）；另有 ERNIE-4.5 系列每模型约 100 万 Token / 90 天的免费额度（社区汇总，待… | community | 🔎 待核实 · 可达 | 2026-11-14 07:38 | [官方](https://cloud.baidu.com/doc/WENXINWORKSHOP/) [社区](https://blog.51cto.com/u_15404184/14598592) |
| `siliconflow` | SiliconFlow 硅基流动（零价模型） | api-key | 部分模型永久零价；2026-05-15 起使用免费模型需实名认证（仅支持中国大陆证件，海外用户需联系支持） | official | ✅ 可用 · 可达 | 2026-11-14 07:38 | [官方](https://siliconflow.cn/pricing) [清单](https://github.com/mnfst/awesome-free-llm-apis) |
| `xfyun-spark` | 讯飞星火 Spark-Lite | api-key | Spark-Lite 永久免费（社区汇总为不限 token / 2 QPS），另有新用户赠金；以官方定价页为准 | community | 🔎 待核实 · 可达 | 2026-11-14 07:38 | [官方](https://www.xfyun.cn/doc/spark/) [社区](https://hefeng.chat/blog/1) |
| `zhipu` | 智谱 AI / Z.ai（GLM Flash 免费模型） | api-key | GLM-4.7-Flash / GLM-4.6V-Flash 等标记 Free 的模型永久零价，单并发；国际站 https://api.z.ai/api/paas/v4 提供同款免费模型 | official | ✅ 可用 · 可达 | 2026-11-14 07:38 | [官方](https://docs.bigmodel.cn/cn/guide/models/free/glm-4.7-flash) [清单](https://github.com/mnfst/awesome-free-llm-apis) |

<details><summary>备注与合规说明</summary>

- **zhipu**：GLM-4.5-Flash 官方已公告退役并将自动路由到 4.7-Flash，属观察项。去重：Z.ai / GLM 国际站与本条为同一计划，合并记录。

</details>

## 匿名免费（无需 key） · `anonymous` · 4 条

| ID | 来源 | 认证 | 免费额度（原文摘要） | 证据 | 状态 / 探测 | 最后核查(UTC) | 出处 |
|---|---|---|---|---|---|---|---|
| `kilo` | Kilo Gateway（Kilo Code free pool） | anonymous | 免费模型无需信用卡、无需 API key：200 请求/小时/IP；kilo-auto/free 自动路由，目录可能滞后于实际可用模型 | official | ✅ 可用 · 可达 | 2026-11-14 07:38 | [官方](https://kilo.ai/docs/gateway/authentication) [清单](https://github.com/mnfst/awesome-free-llm-apis) |
| `llm7` | LLM7.io | token | 匿名可达 turbo 模型；免费 token 上限 1 RPS / 60 RPM / 250 请求每小时 / 100,000 tokens 每 24 小时，额度可能无预告下调 | official | ✅ 可用 · 可达 | 2026-11-14 07:38 | [官方](https://docs.llm7.io/limits) [清单](https://github.com/mnfst/awesome-free-llm-apis) |
| `ovh` | OVHcloud AI Endpoints（匿名层） | anonymous | 永久匿名免费层：2 RPM / IP / 模型，无需注册或 key；带 key 的付费层 400 RPM/项目/模型；新 Public Cloud 账号另有最高 $200 试用金 | official | ✅ 可用 · 可达 | 2026-11-14 07:38 | [官方](https://www.ovhcloud.com/en/public-cloud/ai-endpoints/catalog/) [清单](https://github.com/mnfst/awesome-free-llm-apis) |
| `pollinations` | Pollinations.AI | anonymous | 匿名文本/图像生成端点，无需 key；速率限制按 IP 动态调整 | official | ✅ 可用 · 可达 | 2026-11-14 07:38 | [清单](https://github.com/pollinations/pollinations/blob/master/APIDOCS.md) [清单](https://github.com/tashfeenahmed/freellmapi) |

<details><summary>备注与合规说明</summary>

- **kilo**：config.json 里 14 个 kilo-* 槽位此前没有 catalog 条目，本次合并为一个独立源并映射全部槽位（去重实证）。
- **ovh**：config.json 里 10 个 ovh-* 槽位此前无 catalog 条目，本次合并映射。目录标注部分模型 2026-11-04 EOL，需周期性复核。

</details>

## 试用 / 注册赠金 · `trial-credit` · 26 条

| ID | 来源 | 认证 | 免费额度（原文摘要） | 证据 | 状态 / 探测 | 最后核查(UTC) | 出处 |
|---|---|---|---|---|---|---|---|
| `ai21` | AI21 Labs | api-key | 注册试用赠金，以控制台为准 | aggregator | ✅ 可用 · 可达 | 2026-11-14 07:38 | [官方](https://docs.ai21.com/) [清单](https://github.com/steelburn/free-llm-api-resources) |
| `alibaba-intl` | Alibaba Cloud Model Studio (International) | api-key | 国际站新用户各模型免费额度（常见 90 天有效期），以控制台为准 | aggregator | ✅ 可用 · 可达 | 2026-11-14 07:38 | [官方](https://www.alibabacloud.com/help/en/model-studio/) [清单](https://github.com/steelburn/free-llm-api-resources) |
| `baseten` | Baseten | api-key | 注册试用赠金，以控制台为准 | aggregator | ✅ 可用 · 可达 | 2026-11-14 07:38 | [官方](https://docs.baseten.co/) [清单](https://github.com/steelburn/free-llm-api-resources) |
| `deepinfra` | DeepInfra | api-key | BYOK/推广赠金随账号而异，无统一永久免费层 | aggregator | ✅ 可用 · 可达 | 2026-11-14 07:38 | [官方](https://deepinfra.com/docs) [审计](https://github.com/William-Trader/free-token-cloud/blob/main/docs/PROVIDER-SOURCES.md) |
| `deepseek-trial` | DeepSeek 开放平台（新用户赠金） | api-key | 社区汇总新注册赠送 500 万 Token（待官方复核）；本项目云端池主动排除 DeepSeek，仅本地直连用 | community | 🔎 待核实 · 可达 | 2026-11-14 07:38 | [官方](https://api-docs.deepseek.com/) [社区](https://hefeng.chat/blog/1) |
| `fireworks` | Fireworks AI | api-key | 新用户赠金（社区汇总约 $1 起），以控制台为准 | aggregator | ✅ 可用 · 可达 | 2026-11-14 07:38 | [官方](https://docs.fireworks.ai/) [清单](https://github.com/steelburn/free-llm-api-resources) |
| `hyperbolic` | Hyperbolic | api-key | 注册赠金/部分零价模型，以官方定价页为准 | aggregator | ✅ 可用 · 可达 | 2026-11-14 07:38 | [官方](https://docs.hyperbolic.xyz/) [清单](https://github.com/steelburn/free-llm-api-resources) |
| `inference-net` | Inference.net | api-key | 注册试用赠金，以控制台为准 | aggregator | ✅ 可用 · 可达 | 2026-11-14 07:38 | [官方](https://docs.inference.net/) [清单](https://github.com/steelburn/free-llm-api-resources) |
| `minimax` | MiniMax 开放平台 | api-key | 新用户赠金，以控制台为准（社区汇总） | community | 🔎 待核实 · 可达 | 2026-11-14 07:38 | [官方](https://platform.minimaxi.com/document/) [社区](https://www.51cos.com/?p=3741/) |
| `mobile-moma` | 中国移动 MoMA | api-key | 社区汇总为 9000 万 Token 免费额度、整合 300+ 模型（待官方复核） | community | 🔎 待核实 · 超时 | 2026-11-14 07:38 | [官方](https://www.10086.cn/) [社区](http://mp.weixin.qq.com/s?__biz=MzIyOTM0MDgwNQ==&mid=2247484095&idx=1) |
| `modal` | Modal | api-key | 每月免费计算额度（可用于自托管推理），以官方定价页为准 | aggregator | ✅ 可用 · 可达 | 2026-11-14 07:38 | [官方](https://modal.com/pricing) [清单](https://github.com/steelburn/free-llm-api-resources) |
| `moonshot` | Moonshot AI 开放平台 | api-key | 新用户赠金（社区汇总为 ¥15 代金券），需以控制台为准 | community | 🔎 待核实 · 可达 | 2026-11-14 07:38 | [官方](https://platform.moonshot.cn/docs/) [社区](https://blog.51cto.com/u_15404184/14598592) |
| `nebius` | Nebius AI Studio | api-key | 新用户推广赠金，以控制台为准 | aggregator | ✅ 可用 · 可达 | 2026-11-14 07:38 | [官方](https://docs.nebius.ai/) [清单](https://github.com/steelburn/free-llm-api-resources) |
| `nlpcloud` | NLP Cloud | api-key | 注册试用赠金，以控制台为准 | aggregator | ✅ 可用 · 可达 | 2026-11-14 07:38 | [官方](https://docs.nlpcloud.com/) [清单](https://github.com/steelburn/free-llm-api-resources) |
| `novita` | Novita AI | api-key | 免费模型与推广赠金随账号而异，以模型目录标价为准 | aggregator | ✅ 可用 · 可达 | 2026-11-14 07:38 | [官方](https://novita.ai/docs) [审计](https://github.com/William-Trader/free-token-cloud/blob/main/docs/PROVIDER-SOURCES.md) |
| `openai-trial` | OpenAI 新用户试用金（线索） | api-key | 社区汇总 $5 / 1 个月过期（未在官方页复核，历史上多次调整） | community | 🔎 待核实 · 可达 | 2026-11-14 07:38 | [官方](https://openai.com/api/pricing/) [社区](http://mp.weixin.qq.com/s?__biz=MzIyOTM0MDgwNQ==&mid=2247484095&idx=1) |
| `qiniu-ai` | 七牛云 AI 大模型 API | api-key | 社区汇总为 600 万 Token 免费额度、无时效限制（待官方复核） | community | 🔎 待核实 · 可达 | 2026-11-14 07:38 | [官方](https://developer.qiniu.com/aitokenapi/) [社区](https://hefeng.chat/blog/1) |
| `qwen` | 阿里云百炼 / DashScope (Qwen) | api-key | 新用户各模型独立免费额度（常见 100 万 Token / 90 天），有效期与模型范围以控制台为准；部分模型另有永久免费额度 | official | ✅ 可用 · 可达 | 2026-11-14 07:38 | [官方](https://help.aliyun.com/zh/model-studio/) [审计](https://github.com/William-Trader/free-token-cloud/blob/main/docs/PROVIDER-SOURCES.md) |
| `sambanova` | SambaNova Cloud | api-key | 注册赠金（历史约 $5）与有限的 Developer tier；额度随账号政策变化 | aggregator | ✅ 可用 · 可达 | 2026-11-14 07:38 | [官方](https://docs.sambanova.ai/cloud/) [审计](https://github.com/William-Trader/free-token-cloud/blob/main/docs/PROVIDER-SOURCES.md) |
| `scaleway` | Scaleway Generative APIs | api-key | 免费层/试用额度，以官方定价页为准 | aggregator | ✅ 可用 · 可达 | 2026-11-14 07:38 | [官方](https://www.scaleway.com/en/docs/generative-apis/) [清单](https://github.com/steelburn/free-llm-api-resources) |
| `tencent-tokenhub` | 腾讯云混元 / TokenHub | api-key | 新用户免费体验额度，每个主账号限领一次（社区汇总，待官方复核） | community | 🔎 待核实 · 可达 | 2026-11-14 07:38 | [官方](https://cloud.tencent.com/document/product/1729) [社区](https://hefeng.chat/blog/1) |
| `together` | Together AI | api-key | 新用户赠金/部分免费端点，额度随账号政策变化 | aggregator | ✅ 可用 · 可达 | 2026-11-14 07:38 | [官方](https://docs.together.ai/docs/) [清单](https://github.com/steelburn/free-llm-api-resources) |
| `upstage` | Upstage | api-key | 注册试用赠金，以控制台为准 | aggregator | ✅ 可用 · 可达 | 2026-11-14 07:38 | [官方](https://developers.upstage.ai/) [清单](https://github.com/steelburn/free-llm-api-resources) |
| `volcengine-ark` | 火山引擎方舟（协作奖励计划） | api-key | 安心体验模式每模型一次性免费 Token；「协作奖励计划」社区汇总为每天 200 万 Token 按天重置（待官方复核） | community | 🔎 待核实 · 可达 | 2026-11-14 07:38 | [官方](https://www.volcengine.com/docs/82379) [社区](https://blog.51cto.com/u_15404184/14598592) |
| `xai-grok` | xAI Grok（免费额度线索） | api-key | 社区汇总 $25/月免费额度（2026 年营销文章口径，未在官方页复核） | community | 🔎 待核实 · 可达 | 2026-11-14 07:38 | [官方](https://docs.x.ai/) [社区](http://mp.weixin.qq.com/s?__biz=MzIyOTM0MDgwNQ==&mid=2247484095&idx=1) |
| `xiaomi-mimo` | 小米 MiMo 开发者平台 | api-key | 社区汇总新用户 7 亿+ Token、30 天有效（待官方复核，数字异常大，仅作线索） | community | ⏸ 停用 · 链接异常 | 2026-11-14 07:38 | [官方](https://mimo.ai.xiaomi.com/) [社区](http://mp.weixin.qq.com/s?__biz=MzIyOTM0MDgwNQ==&mid=2247484095&idx=1) |

<details><summary>备注与合规说明</summary>

- **alibaba-intl**：与 qwen（国内百炼）为不同区域计划，分别记录但共享厂商映射。
- **deepseek-trial**：按 docs/PROVIDER-SOURCES.md 的合规决定，不接入云端池；保留为线索并标注。

</details>

## 开发者计划 / 开源配额 · `open-quota` · 5 条

| ID | 来源 | 认证 | 免费额度（原文摘要） | 证据 | 状态 / 探测 | 最后核查(UTC) | 出处 |
|---|---|---|---|---|---|---|---|
| `gonka` | Gonka Broker | api-key | 永久免费层：短信（非 VoIP）验证后每月至少 1M tokens（按最贵模型计），不结转；仅免费额度时限速更低，模型随网络治理轮换 | official | ✅ 可用 · 可达 | 2026-11-14 07:38 | [官方](https://gonkabroker.com/free-llm-api/) [清单](https://github.com/mnfst/awesome-free-llm-apis) |
| `huggingface` | Hugging Face Inference Providers | api-key | 注册账号每月有小额推理额度，PRO 与组织账号额度更高；免费账号月度额度曾调整，需以账号页为准 | aggregator | ✅ 可用 · 可达 | 2026-11-14 07:38 | [官方](https://huggingface.co/docs/inference-providers/pricing) [清单](https://github.com/steelburn/free-llm-api-resources) |
| `modelscope` | ModelScope API-Inference | api-key | 注册用户免费：2,000 次/天（总量），单模型动态配额上限 500 次/天；需绑定阿里云账号并实名 | official | ✅ 可用 · 可达 | 2026-11-14 07:38 | [官方](https://modelscope.cn/docs/model-service/API-Inference/limits) [清单](https://github.com/mnfst/awesome-free-llm-apis) |
| `nvidia` | NVIDIA NIM / Developer Program | api-key | NVIDIA Developer Program 会员免费，100+ 托管模型；官方不公开统一 RPM/RPD 表，按模型与并发动态调整；仅限原型/研究/开发/测试 | official | ✅ 可用 · 可达 | 2026-11-14 07:38 | [官方](https://build.nvidia.com/explore/discover) [清单](https://github.com/mnfst/awesome-free-llm-apis) |
| `scnet` | 国家超算互联网（SCNet） | api-key | 限时免费 DeepSeek 对话服务与算力配额（社区汇总，待官方复核） | community | 🔎 待核实 · 可达 | 2026-11-14 07:38 | [官方](https://www.scnet.cn/) [社区](https://hefeng.chat/blog/1) |

<details><summary>备注与合规说明</summary>

- **huggingface**：2026-10-27 审计曾记录「Free 账号可能无月度额度」，故降级为 open-quota 并标注波动。
- **nvidia**：托管端点为试用性质，条款要求不提交个人或机密数据；生产需 AI Enterprise 许可。

</details>

## 聚合网关免费路由 · `gateway` · 6 条

| ID | 来源 | 认证 | 免费额度（原文摘要） | 证据 | 状态 / 探测 | 最后核查(UTC) | 出处 |
|---|---|---|---|---|---|---|---|
| `airforce` | Airforce | api-key | keyed 免费/推广槽位，额度随账号政策变化 | aggregator | ✅ 可用 · 可达 | 2026-11-14 07:38 | [官方](https://airforce.ai/) [清单](https://github.com/William-Trader/free-token-cloud) |
| `opencode-zen` | OpenCode Zen | api-key | 推广期免费模型路由（DeepSeek V4 Flash / Nemotron 等），以官方 Zen 页面为准 | aggregator | ✅ 可用 · 可达 | 2026-11-14 07:38 | [官方](https://opencode.ai/docs/zen/) [清单](https://github.com/steelburn/free-llm-api-resources) |
| `openrouter` | OpenRouter :free models | api-key | 免费模型 20 RPM / 50 RPD（所有 :free 模型共享）；一次性充值 ≥ $10 后提升到 1,000 RPD | official | ✅ 可用 · 可达 | 2026-11-14 07:38 | [官方](https://openrouter.ai/docs/api-reference/limits) [清单](https://github.com/mnfst/awesome-free-llm-apis) |
| `requesty` | Requesty Router | api-key | 聚合路由，免费额度随活动变动；需以账号控制台为准 | aggregator | ✅ 可用 · 可达 | 2026-11-14 07:38 | [官方](https://docs.requesty.ai/) [审计](https://github.com/William-Trader/free-token-cloud/blob/main/docs/PROVIDER-SOURCES.md) |
| `vercel-ai-gateway` | Vercel AI Gateway | api-key | 提供免费额度/免费模型路由，额度与模型范围以官方定价页为准 | aggregator | ✅ 可用 · 可达 | 2026-11-14 07:38 | [官方](https://vercel.com/docs/ai-gateway/pricing) [清单](https://github.com/steelburn/free-llm-api-resources) |
| `voidai` | VoidAI | api-key | keyed 免费/推广槽位，额度随账号政策变化 | aggregator | ✅ 可用 · 可达 | 2026-11-14 07:38 | [官方](https://voidai.app/) [清单](https://github.com/William-Trader/free-token-cloud) |

## 自有订阅额度 · `subscription` · 4 条

| ID | 来源 | 认证 | 免费额度（原文摘要） | 证据 | 状态 / 探测 | 最后核查(UTC) | 出处 |
|---|---|---|---|---|---|---|---|
| `claude-code` | Claude Code（自有订阅） | oauth | 用户自有订阅，按订阅等级分配用量 | official | ✅ 可用 · 可达 | 2026-11-14 07:38 | [官方](https://docs.anthropic.com/en/docs/claude-code/overview) |
| `codex-chatgpt` | Codex / ChatGPT（自有订阅） | oauth | 用户自有 ChatGPT 订阅，按订阅等级分配用量 | official | ✅ 可用 · 可达 | 2026-11-14 07:38 | [官方](https://developers.openai.com/codex/) |
| `github-copilot` | GitHub Copilot（自有订阅） | oauth | 用户自有订阅附带的请求额度；免费版有月度补全/聊天次数上限 | official | ✅ 可用 · 可达 | 2026-11-14 07:38 | [官方](https://docs.github.com/en/copilot) |
| `kimi-code` | Kimi Code（自有订阅） | api-key | 用户自有订阅/账号额度 | official | ✅ 可用 · 可达 | 2026-11-14 07:38 | [官方](https://platform.moonshot.cn/docs/) |

<details><summary>备注与合规说明</summary>

- **github-copilot**：只允许账号本人 OAuth；共享/租借账号属排除项。

</details>

## 本地自托管兜底 · `local` · 2 条

| ID | 来源 | 认证 | 免费额度（原文摘要） | 证据 | 状态 / 探测 | 最后核查(UTC) | 出处 |
|---|---|---|---|---|---|---|---|
| `local-openai-compatible` | 本地 OpenAI 兼容推理（Ollama / LM Studio / vLLM） | local | 本机算力，零外部额度；作为所有云源失效时的最后兜底 | official | ✅ 可用 | 2026-11-14 07:38 | [清单](https://github.com/ollama/ollama/blob/main/docs/api.md) |
| `piagent` | PiAgent 本地桥 | local | 本地进程，不消耗外部额度 | official | ✅ 可用 | 2026-11-14 07:38 | [清单](https://github.com/William-Trader/free-token-cloud) |

<details><summary>备注与合规说明</summary>

- **piagent**：属于本项目的本地 agent 桥，不是外部免费源；保留在目录中以便池视图完整。

</details>

## 已剔除（保留墓碑，不参与路由）

| ID | 名称 | 剔除原因 | 剔除时间 |
|---|---|---|---|
| `chutes` | Chutes | 2026-10-27 审计：官方声明无免费层 | 2026-11-12 |
| `github-models` | GitHub Models | 2026-10-27 审计：服务已于 2026-07-30 全面退役；第三方清单仍列出，按失效剔除 | 2026-11-12 |

## 维护方式

```bash
npm run sources:all     # 发现 → 校验 → 去重/剔除 → 同步 → 报告
npm run sources:verify  # 只跑可用性校验
npm run sources:report  # 只重新生成文档
```

GitHub Actions 与服务器 systemd timer 每日各跑一次；每次校验快照落在 `data/history/YYYY-MM-DD.json`。
