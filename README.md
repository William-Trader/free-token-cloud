# Free Token Cloud

一台 **2 核 1G** 的服务器（或者只要你的 PC），就能把一堆免费模型聚合成**你自己的** OpenAI / Anthropic 兼容入口，
给远程设备、Agent、手机发 token 用——限流、超时、报错时自动换上游，客户端只认一个地址。

## 面向需求

| 你的处境 | 本项目怎么解 |
|---|---|
| 只有一台 2 核 1G 小机器或自己的 PC | 单进程 Node，无数据库、无 Redis，常驻内存几十 MB；nginx 开一个 8080 端口，其余端口只监听 `127.0.0.1` |
| 想给远程设备／朋友发 token，而不是发 key | 服务器上 `token` 单文件 Bearer 鉴权，任何 OpenAI 兼容客户端填两行配置就能接入 |
| 免费额度分散、随时 429 | 19 个免费/匿名工具槽位、29 个对话槽位，按池排队，熔断 + 冷却 + 半开探测自动切 |
| 想按自己的路子"白嫖"更多 token | **可改造框架**：provider、池、路由链、超时、并发、冷却全在 `config.json`，改完调 `/api/reload` 热加载，不用改代码 |
| 源码开放但**禁止商用** | **PolyForm Noncommercial 1.0.0**：个人、教育、研究、非营利可自由使用/修改/分发；**任何商业用途需单独授权** |

一句话：**你出机器和改造想法，框架已经把"多上游 + 故障切换 + 统一 token 入口"这部分写好了。**

## 3.0 关键组件

Free Token Cloud 是独立自有组合产品：

| 组件 | 101 上的位置 | 职责 |
|---|---|---|
| `relay-core` | `/opt/ai-relay` | tools/chat 双池、工具桥、Responses/OpenAI/Anthropic 入口、控制台 |
| `credential-vault` | `/opt/ai-relay/secrets` | AES-256-GCM 加密 Provider Key |
| `provider-setup` | `/setup` | 登录链接、Key 粘贴、校验、自动启用 |
| `edge` | nginx `:8080` | Bearer 鉴权入口、限流、流式反代 |

统一组合根目录部署在 `/opt/free-token-cloud`，包含组件清单、Provider 登录策略、
Docker Compose、架构文档和 `stackctl`。

```bash
npm run stack:deploy
ssh <RELAY_HOST> /opt/free-token-cloud/bin/stackctl status
ssh <RELAY_HOST> /opt/free-token-cloud/bin/stackctl login
```

Provider 接入页：

```text
http://<RELAY_HOST>:8080/setup
```

登录厂商获取 API Key 后，在页面输入 relay master token，再粘贴 Key。密钥会加密保存，
路由会请求厂商 `/models` 验证，成功后才启用。未登录或失败时继续落到匿名池。

也可以直接让你的 agent（Codex / Claude Code / OpenClaw 等）把本项目部署到你的**本地电脑**上，
给自己提供免费 token。但先说好：**别要求太高**，工程还在持续开发中，能跑通、能切换、能干活，
但边角和稳定性还会变。觉得有用就点个 **Star** —— star 多一点，这个源才不容易断更、不容易失效。

部署后把远端地址填进 `.env.local` 或 `RELAY_URL`，例如 `http://<RELAY_HOST>:8080`。  
OpenClaw provider：`ai-relay`；模型：`ai-relay/tools`（默认）、`ai-relay/chat`。

DSH Desktop / DeepSeek Harness 接入说明见 `docs/HARNESS.md`；Harness 默认使用
`ai-relay/tools`，同时保留本地 DeepSeek 路由供手动切换。

把项目交给本地 agent 部署时，先让它读 [`docs/AGENT-HANDOFF.md`](docs/AGENT-HANDOFF.md)：
里面有红线（不动付费 key/默认模型）、Windows 适配对照表、并存接入方式与验证/回滚清单。

## 当前实测状态

2026-10-27 实测通过的上游：

| Provider | Model | Key | Stream | Tools | 备注 |
|---|---|---:|---:|---:|---|
| Kilo | `kilo-auto/free` | 不需要 | 是 | 原生 | 免费池自动换模型 |
| Kilo | `nvidia/nemotron-3.5-super-vl:free` | 不需要 | 是 | 文本桥 | 1M 上下文 |
| Kilo | `reflection/beam-free` | 不需要 | 是 | 文本桥 | 1M 上下文 |
| Kilo | `stealth/glyph-cluster` | 不需要 | 是 | 文本桥 | 256K 上下文 |
| Kilo | `dots-studio/dots-3-note-preview:free` | 不需要 | 是 | 文本桥 | 512K 上下文 |
| Kilo | `cohere/north-mini-code:free` | 不需要 | 是 | 文本桥 | 256K 上下文 |
| Kilo | `openrouter/free` | 不需要 | 是 | 文本桥 | 免费模型路由 |
| LLM7 | `gpt-oss:20b` | 可选 | 是 | 原生 | 匿名可用；免费 token 可提高限额 |
| OVH AI Endpoints | `gpt-oss-20b` | 不需要 | 是 | 文本桥 | 匿名约 2 RPM |
| OVH AI Endpoints | `gpt-oss-120b` | 不需要 | 是 | 文本桥 | 独立 2 RPM 配额 |
| OVH AI Endpoints | `Meta-Llama-3_3-70B-Instruct` | 不需要 | 是 | 文本桥 | 独立 2 RPM 配额 |
| OVH AI Endpoints | `Mistral-Nemo-Instruct-2407` | 不需要 | 是 | 文本桥 | 独立 2 RPM 配额 |
| OVH AI Endpoints | `Mistral-Small-3.2-24B-Instruct-2506` | 不需要 | 是 | 文本桥 | 独立 2 RPM 配额 |
| OVH AI Endpoints | `Qwen3.6-27B` | 不需要 | 是 | 文本桥 | 独立 2 RPM 配额 |
| OVH AI Endpoints | `Qwen3.5-397B-A17B` | 不需要 | 是 | 文本桥 | 独立 2 RPM 配额 |
| OVH AI Endpoints | `Qwen2.5-VL-72B-Instruct` | 不需要 | 是 | 文本桥 | 独立 2 RPM 配额 |
| OVH AI Endpoints | `Qwen3.5-9B` | 不需要 | 是 | 文本桥 | 独立 2 RPM 配额 |
| OVH AI Endpoints | `Qwen3.8-27B` | 不需要 | 是 | 文本桥 | 独立 2 RPM 配额 |
| Pollinations | `openai-fast` | 可选 | 是 | 原生 | 最终兜底，匿名约 30 秒一次 |

当前配置共 **44 个 provider 条目**（含需要 key 的扩展槽，缺 key 自动禁用、不占重试时间）；匿名池实际可用 **29 个对话槽位、19 个工具槽位**：

```text
# Kilo（共享账号额度，group=kilo）
kilo, kilo-nemotron, kilo-beam, kilo-glyph, kilo-dots, kilo-cohere, kilo-openrouter,
kilo-lfm, kilo-omni, kilo-ultra, kilo-laguna, kilo-flint, kilo-lightning, kilo-laguna-xs,
# LLM7（匿名可用）
llm7, llm7-minimax, llm7-nemo, llm7-nemotron,
# OVH（按模型独立限额）
ovh-oss20, ovh-oss120, ovh-llama70, ovh-nemo, ovh-small,
ovh-qwen36, ovh-qwen397, ovh-qwen-vl, ovh-qwen35-9b, ovh-qwen38-27b,
# 兜底
pollinations
```

v2.3.0 新增 8 个槽位：`liquid/lfm-2.5-2.6b:free`、`nemotron-3-nano-omni-30b-a3b-reasoning:free`、
`nemotron-3-ultra-550b-a55b:free`、`poolside/laguna-s-2.1:free`、`recursive/flint-v1.0:free`，
以及 LLM7 的 `minimax-m2.7`、`mistral-Nemo-Instruct-2407`、`nemotron-3-nano:30b`（均实测 200）。

Kilo 的多个模型共享账号级额度，路由器用 provider group 统一限制；OVH 的匿名
限额按模型分别计算，所以某个 OVH 模型冷却时其他 OVH 模型仍可服务。

有 key 才启用的扩展槽：

| Provider | 默认模型 | Key 文件 |
|---|---|---|
| OpenRouter | `openai/gpt-oss-120b:free` | `/opt/ai-relay/keys/openrouter.key` |
| Gemini | `gemini-2.5-flash-lite` | `/opt/ai-relay/keys/gemini.key` |
| Groq | `openai/gpt-oss-120b` | `/opt/ai-relay/keys/groq.key` |
| NVIDIA NIM | `openai/gpt-oss-20b` | `/opt/ai-relay/keys/nvidia.key` |
| Mistral | `mistral-small-latest` | `/opt/ai-relay/keys/mistral.key` |
| Qwen / Bailian | `qwen3.8-flash` | 加密凭据仓 |
| Cerebras | `gpt-oss-120b` | 加密凭据仓 |
| SambaNova | `gpt-oss-120b` | 加密凭据仓 |
| DeepInfra | `Qwen/Qwen3.8-Flash` | 加密凭据仓 |
| Novita | `qwen/qwen3.8-flash` | 加密凭据仓 |
| LLM7 token | 提高限额 | `/opt/ai-relay/keys/llm7.key` |
| Pollinations key | 提高限额 | `/opt/ai-relay/keys/pollinations.key` |

未在这台 101 上完成真实工具验收的 keyed provider 先只进入 `chat` 池；补 key 并通过
`ai-relay` 的 tool-call 自测后，才应提升到 `tools` 池。

Zhipu/ChatGLM 网页链路已从运行时删除。原 systemd 单元停在 `/opt/ai-relay/backups/zhipu-20261027/`，不再启动，也不参与路由。

## 自动切换

默认链：

```text
openrouter -> gemini -> groq -> nvidia -> mistral -> kilo -> llm7
           -> ovh-oss20 -> ovh-oss120 -> ovh-llama70 -> ovh-nemo
           -> ovh-small -> pollinations
```

所有入口只运行在 101 服务器；不使用 DeepSeek 付费 token，也没有本地中转兜底。没有 key 的扩展槽启动时自动禁用，不占重试时间。实际匿名请求从 Kilo 开始。

`tools` 链优先使用：

```text
kilo -> llm7 -> ovh-oss20 -> ovh-oss120 -> ovh-llama70
     -> ovh-nemo -> ovh-small -> pollinations
```

切换规则：

1. 连接失败、超时、HTTP 5xx：记录失败，连续 3 次后熔断。
2. HTTP 429/402 或响应体含 rate limit/quota：立即冷却，按 `Retry-After` 或 `retry_after` 恢复。
3. 401/403：鉴权类冷却 10 分钟。
4. 熔断到期后进入 half-open，只放一个探测请求。
5. 每 2 分钟后台 GET 一次 `/models` 健康端点；网络故障恢复后可自动关闭熔断。
6. 所有候选都冷却时允许一次 last-resort 尝试，避免彻底假死。

## 工具调用

请求带 `tools` 时，路由只选：

- 原生 function calling 上游；或
- 配置了 `toolBridge` 的上游。

文本桥会把工具定义和调用协议注入系统消息，要求模型只输出：

```json
{"tool_calls":[{"name":"tool_name","arguments":{"key":"value"}}]}
```

路由再把该 JSON 归一化成标准 OpenAI `tool_calls`。工具名不在请求白名单内时会拒绝调用。

为保证真实 agent 工具链：

1. 带 `tools` 的请求强制上游走非流式，完成归一化后再向客户端发标准 SSE。
2. 从用户请求里优先提取明确提到的工具（例如 `exec`），最多注入 12 个相关工具，避免大工具表淹没小模型。
3. 扫描正文、`reasoning`、`reasoning_content`，兼容 `functions.exec`、`tool.exec` 等前缀。
4. 空工具响应不记成功，自动切下一个上游。
5. OpenClaw 只暴露两个模型：`ai-relay/chat` 为仅对话，`ai-relay/tools` 为工具池。

真实本地 agent 验收已通过：OpenClaw 通过 `ai-relay/tools` 调用 `exec` 创建临时文件，
文件确实落到本机磁盘，返回 `toolSummary.calls=1`、`tools=["exec"]`、`failures=0`。

## 流式与 usage

- 流式请求在收到第一个有效 token 前不会向客户端写入数据，因此首包前断连仍可切上游。
- 客户端收到首个 token 后若上游断开，会发送结构化 `relay_stream_error`；不会拼接另一个模型的重复回答。
- 上游没有 usage 时，路由估算 prompt/completion token，并在 `[DONE]` 前补标准 usage chunk。
- 支持 OpenAI `/v1/chat/completions` 与 Anthropic `/v1/messages`。

## 逐轮长思考（reasoning）

`/v1/responses` 会把 Responses 的 reasoning 语义接住：

- **推理预算**：请求里的 `reasoning.effort`（`low/medium/high/max`）会转成系统提示里的推理预算，
  要求模型先拆解、分步验证、再给结论。免费上游不认数值型 effort，所以走提示词约束。
- **逐轮延续**：多轮时上一轮的 `type: "reasoning"` 摘要会回填成 assistant 上下文，
  模型接着上一轮的思路继续，不重头再来。
- **思考回传**：上游返回 `reasoning` / `reasoning_content` 时，`output` 里会多一条 `type: "reasoning"` 条目，
  流式则发送 `response.reasoning_summary_part.*` 与 `response.reasoning_summary_text.*` 事件。
- `include: ["reasoning.encrypted_content"]` 会被忽略：免费池没有加密推理可回传，但对话上下文不丢。

## 更新日志

- **v3.4.5**：工具参数按 schema 校验——缺必填字段不接收，向模型回传缺失项并重试一次；402/配额类统一冷却；最终错误脱敏（不再把上游 quota 原文透给客户端）。
- **v3.4.4**：修复 agent 工具调用不稳——工具桥提示词改为「只输出 JSON，必须调用」并在无 tool_calls 时同 provider 重试一次；tools 链重排为 llm7 → kilo-cohere → kilo-dots → kilo → kilo-glyph。实测 5 次 4 次返回 tool_use。
- **v3.4.3**：README 全面对齐实际状态——44 个 provider 条目 / 29 对话 / 19 工具槽位、Token 合并与分开视图、缓存口径与移动端说明；移除已删除的 Playground 描述。
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

## 客户端兼容矩阵（Codex / OpenClaw）

**Codex（`wire_api = "responses"`）**

| 能力 | 状态 |
|---|---|
| `/v1/responses` 原生入口 | ✅ |
| 流式事件（文本/工具/推理） | ✅ `response.*` 事件序列 |
| 函数工具 + 并行调用 | ✅ `function_call`，支持 `parallel_tool_calls` |
| freeform 工具（apply_patch） | ✅ `custom_tool_call` / `custom_tool_call_output` |
| `local_shell` | ✅ 映射为函数工具 |
| 结构化输出 | ✅ `text.format` / `json_schema` / `json_object` |
| 多轮上下文 | ✅ `previous_response_id`（进程内 64 条） |
| 推理预算 / 思考摘要 | ✅ `reasoning.effort` + `reasoning` 条目（仅 `tools` 池） |
| `incomplete`（长度截断） | ✅ `incomplete_details` |
| 图片输入 | ✅ `input_image` 透传（上游支持时） |
| `reasoning.encrypted_content` | ⚠️ 用摘要 base64 代替，不参与续算 |

**OpenClaw / 通用 OpenAI 客户端（`/v1/chat/completions`、`/v1/messages`）**

| 能力 | 状态 |
|---|---|
| `ai-relay/tools`（工具池） | ✅ 工具调用、并行、文本桥；OpenClaw 实测 `exec` 成功 |
| `ai-relay/chat`（对话池） | ✅ 只对话，`toolPolicy=strip` |
| 思维链隐藏 | ✅ `chat` 池在 Responses **与** Chat Completions（含流式）都剥离 `reasoning` |
| 多上游熔断 / 冷却 / 半开 | ✅ 两个入口共用一套路由 |
| Anthropic 兼容 | ✅ `/v1/messages`（含流式事件合成） |
| usage / 估算 token | ✅ 上游缺失时补齐 |

## 默认语言

`config.json` 的 `locale` 控制默认回答语言：

```json
"locale": {
  "default": "zh-CN",
  "routes": ["chat"],
  "prompt": "除非用户明确要求其他语言，否则一律使用简体中文回答。"
}
```

- 默认**只对 `chat` 池生效**：纯对话默认中文；`tools` 池（编码/工具调用）不注入，避免影响代码与工具参数。
- 开销：每次对话多约 20 个 prompt token，无额外模型调用。
- 想让 `tools` 也中文：把 `"tools"` 加进 `routes`；想全关：`"default": ""`。
- 用户明确要求其他语言时，提示词允许模型切换。

## 性能

- **连接复用**：出站 HTTP/HTTPS 走 keep-alive Agent（64 并发、15s 空闲回收），省掉每次请求的 TLS 握手，冷启动后首批请求延迟明显下降。
- **模型清单缓存**：`/v1/models` 结果缓存 60 秒，客户端轮询不再穿透到路由层。
- **首包超时与熔断**：上游 45s 首包超时、连续 3 次失败熔断，坏上游不会拖住整条链。
- 单进程、无数据库，2C1G 即可承载；扩容只增加槽位，不增加常驻内存压力。

## 控制台（Dashboard）

部署后直接打开 `http://<RELAY_HOST>:8080/`，**无需登录**，每 5 秒自动刷新；页面数据来自公开只读接口 `/api/public`。

- **实时指标**：总请求、成功率、平均延迟、可用槽位、流式计数
- **流量图**：最近 30 分钟按分钟聚合的成功/失败柱状图
- **双池面板**：tools / chat 分开显示，环形成功率、可用/熔断数、平均延迟、成员状态点，以及**当前选定 API**
- **用量图**：最近 30 分钟按池堆叠（tools/chat/失败），接口拆分（`/v1/responses` vs `/v1/chat`）
- **Token 可视化**：主卡分「读取 / 输出 / 缓存」三列 + 总计与堆叠条；用量区提供**合并视图**（一条堆叠条 + 图例）与**分开视图**（四行独立条形）
- **缓存命中**：按请求的命中率（`cacheHits / usageEvents`）+ 绝对 cached tokens；日志逐条显示 `in→out` 与 cached
- **槽位表**：按池/状态筛选，熔断剩余时间、成功失败数、延迟条、最近错误
- **实时日志**：最近 100 条，带 R/C 标记（Responses / Chat Completions）
- **接入片段**：一键复制 curl，发给任何 OpenAI 兼容客户端

页面与公开接口不含任何凭据；`/v1/*` 仍走 Bearer 鉴权。移动端已适配：指标两列、池卡堆叠、表格横向滚动、日志精简。

缓存口径：**只有上游上报缓存字段时才有数据**（`cached_tokens` / `prompt_cache_hit_tokens` / `cache_read_input_tokens` 都会归一化）。免费池多数不报，界面显示 0 不代表链路坏了；接了报缓存的厂商就会亮。

## 接口

鉴权：`Authorization: Bearer <token>` 或 `x-api-key`。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/health` | 存活和上游熔断状态，免鉴权 |
| GET | `/ready` | 是否有可用上游 |
| GET | `/v1/models` | 逻辑模型列表 |
| POST | `/v1/chat/completions` | OpenAI 兼容对话 |
| POST | `/v1/responses` | OpenAI Responses API（Codex CLI / Codex App 直接用这个） |
| POST | `/v1/messages` | Anthropic 兼容对话 |
| GET | `/api/upstreams` | 详细上游状态 |
| GET | `/api/pools` | 工具池与对话池成员 |
| GET | `/api/provider-setup` | Provider 目录、Key 状态与接入说明，需 master token |
| POST | `/api/provider-credentials` | 加密保存并校验 Provider Key |
| DELETE | `/api/provider-credentials/:id` | 删除加密 Provider Key |
| GET | `/api/logs?n=50` | 最近请求日志 |
| GET | `/api/metrics` | JSON 指标 |
| GET | `/metrics` | Prometheus 文本指标 |
| POST | `/api/reset` | 手动清熔断 |
| POST | `/api/reload` | 热加载 config |

响应头包含 `x-request-id`、`x-relay-upstream`、`x-relay-attempts`。

## 接 Codex

Codex CLI/App 只支持 `wire_api = "responses"`，所以本仓库实现了 `/v1/responses`
适配层（把 Responses 请求翻译成 chat 池，再把结果还原成 `response.*` 事件流）。
配置示例：

```toml
[model_providers.ai-relay]
name = "AI Relay"
base_url = "http://<RELAY_HOST>:8080/v1"
wire_api = "responses"
http_headers = { "Authorization" = "Bearer <RELAY_TOKEN>" }
```

然后 `codex exec -c model_provider=ai-relay -m tools "..."` 即可；`tools` 走工具池，
`chat` 只对话。实测 Codex 能经由免费池完成读文件、跑命令这类真实工具调用。

## 本地验证

```bash
cd ~/openclaw资产库/openclaw/workspace/projects/ai-relay
npm test
npm run check
RELAY_URL=http://<RELAY_HOST>:8080 RELAY_TEST_MODEL=chat ./smoke.mjs
RELAY_URL=http://<RELAY_HOST>:8080 RELAY_TEST_MODEL=tools ./smoke.mjs --tools
```

OpenClaw 端到端：

```bash
openclaw agent exec --model ai-relay/tools --timeout 180 --json '只回答四个字：免费可用'
```

## 部署

```bash
cd ~/openclaw资产库/openclaw/workspace/projects/ai-relay
./deploy.sh
```

部署脚本会：

1. 本地做 JS 语法与 JSON 校验。
2. 远端备份 `server.js`、`config.json`、systemd unit。
3. 上传 `router.js`、`config.json`、`watchdog.sh`。
4. 重启 `ai-relay.service`。
5. 30 秒内健康检查失败则自动回滚。

远端回滚目录：`/opt/ai-relay/backups/<timestamp>/`。

## 运维

```bash
systemctl status ai-relay ai-relay-watchdog.timer
systemctl restart ai-relay
journalctl -u ai-relay -n 100 --no-pager
tail -f /opt/ai-relay/logs/service.log
tail -f /opt/ai-relay/logs/relay.jsonl
tail -f /opt/ai-relay/logs/watchdog.log
```

Nginx 配置模板在 `nginx/`，systemd 模板在 `systemd/`。公网入口是 HTTP Bearer；对不受信任网络应改用 HTTPS。

## 加 key

以 Groq 为例：

```bash
ssh <RELAY_HOST>   # 或 ~/.ssh/config 里的别名
install -d -m 700 /opt/ai-relay/keys
umask 077
printf '%s\n' 'GROQ_API_KEY' > /opt/ai-relay/keys/groq.key
systemctl restart ai-relay
```

配置里该 provider 已存在，补 key 后会自动启用，无需改代码。多个 key 可写入 `apiKeyFiles`，路由会轮换并在 401/限流时尝试下一把。

## 边界

- 只接官方 API、明确提供匿名访问的公开端点，或用户自己的 key。
- 不做验证码、登录态、付费墙、封禁或站点风控绕过。
- 免费池会随上游策略变化；`/health`、探测和 smoke test 是运行时事实来源。
- 不要把个人隐私、密钥或机密材料发给明确声明会记录/训练数据的免费上游。

## 许可

**PolyForm Noncommercial License 1.0.0** —— 源码开放、非商用免费：

- 允许：个人学习、研究实验、爱好项目、教育教学、公益/公共机构、非营利组织；可修改、可分发（需随附许可与 Required Notice）。
- **不允许：任何商业用途**（含公司内部生产、对外提供服务、打包进商业产品、SaaS 转售）。
- 商用需单独授权：在 [Issues](https://github.com/William-Trader/free-token-cloud/issues) 留言或联系作者。
- 该许可**不是 OSI 认可的开源许可**，属于「源码可见 + 非商用」。

完整条款见 [LICENSE](LICENSE)。
