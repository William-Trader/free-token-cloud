# Free Token Cloud

一台 **2 核 1G** 的服务器，就能把一堆免费模型聚合成**你自己的** OpenAI / Anthropic 兼容入口，
给远程设备、Agent、手机发 token 用——限流、超时、报错时自动换上游，客户端只认一个地址。

## 面向需求

| 你的处境 | 本项目怎么解 |
|---|---|
| 只买得起一台 2 核 1G 小机器 | 单进程 Node，无数据库、无 Redis，常驻内存几十 MB；nginx 开一个 8080 端口，其余端口只监听 `127.0.0.1` |
| 想给远程设备／朋友发 token，而不是发 key | 服务器上 `token` 单文件 Bearer 鉴权，任何 OpenAI 兼容客户端填两行配置就能接入 |
| 免费额度分散、随时 429 | 17 个免费/匿名上游槽位，按池（`tools` / `chat`）排队，熔断 + 冷却 + 半开探测自动切 |
| 想按自己的路子"白嫖"更多 token | **可改造框架**：provider、池、路由链、超时、并发、冷却全在 `config.json`，改完调 `/api/reload` 热加载，不用改代码 |
| 不想被许可条款绑住 | **Unlicense（公共领域，本仓库能给出的最高权限许可）**：随便用、随便改、可商用、可闭源分发、无需署名 |

一句话：**你出机器和改造想法，框架已经把"多上游 + 故障切换 + 统一 token 入口"这部分写好了。**

也可以直接让你的 agent（Codex / Claude Code / OpenClaw 等）把本项目部署到你的**本地电脑**上，
给自己提供免费 token。但先说好：**别要求太高**，工程还在持续开发中，能跑通、能切换、能干活，
但边角和稳定性还会变。觉得有用就点个 **Star** —— star 多一点，这个源才不容易断更、不容易失效。

部署后把远端地址填进 `.env.local` 或 `RELAY_URL`，例如 `http://<RELAY_HOST>:8080`。  
OpenClaw provider：`ai-relay`；模型：`ai-relay/tools`（默认）、`ai-relay/chat`。

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
| Pollinations | `openai-fast` | 可选 | 是 | 原生 | 最终兜底，匿名约 30 秒一次 |

当前匿名池共有 17 个独立槽位：

```text
kilo, kilo-nemotron, kilo-beam, kilo-glyph, kilo-dots,
kilo-cohere, kilo-openrouter,
llm7,
ovh-oss20, ovh-oss120, ovh-llama70, ovh-nemo, ovh-small,
ovh-qwen36, ovh-qwen397, ovh-qwen-vl,
pollinations
```

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

**Unlicense（公共领域）** —— 本仓库能给出的最高权限许可：可商用、可修改、可闭源分发、无需署名、无任何附加条件。
见 [LICENSE](LICENSE)。
