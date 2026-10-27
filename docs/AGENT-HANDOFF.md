# 交接说明：给本地 agent 的部署任务（Free Token Cloud）

> 你接手的是「Free Token Cloud」——一台小机器就能跑的自托管免费模型中转。
> 本文是**硬约束 + 操作步骤**：先按红线做，再按清单验证，最后给主人证据。

---

## 0. 先读这三份

| 文件 | 作用 |
|---|---|
| `README.md` | 产品定位、池容量、接口、控制台 |
| `docs/ARCHITECTURE.md` | 组件、端口、数据流 |
| `docs/HARNESS.md` | 本机 agent / DSH Harness 接入方式 |

再看 `docs/PROVIDER-SOURCES.md`（上游来源与合规边界）。

---

## 1. 红线（违反即返工）

1. **不许动主人的付费接口**：DeepSeek / OpenAI / Anthropic / 其他已付费的 key、base_url、余额、计费方式，一律只读。
2. **不许改主人的默认模型**：现有默认 provider/模型（例如 `deepseek-flash`、`gpt-5`）保持原样；本中转只能作为**新增 provider**（建议 id `ai-relay`）并存。
3. **不许复用付费 key**：本中转的 token 自己生成；缺 key 时继续跑匿名池，不要拿主人的 key 去“补齐”。
4. **不许覆盖式改配置**：改 `config.toml` / `openclaw.json` / harness profile 前先备份，只做追加或合并；同一个根键、同一个 `[model_providers.x]` 只能出现一次。
5. **密钥只落 600（Windows 用 ACL）**：不写进仓库、日志、聊天记录、命令行参数。
6. **端口避让**：默认 `8801`（内部）与 `8080`（公网）。被占用就换，并把实际端口写进 `.env.local` 与 README 的 <RELAY_HOST> 说明。
7. **不碰别人的服务**：不重启、不改动与本项目无关的 systemd / 计划任务 / nginx 站点。

---

## 2. 组件与端口

| 组件 | 默认位置 | 端口 | 说明 |
|---|---|---|---|
| relay-core | `/opt/ai-relay` | 127.0.0.1:8801 | 路由、双池、工具桥、Responses/Anthropic 入口、控制台 |
| edge | nginx | :8080 | Bearer 鉴权、反代、限流 |
| dashboard | 由 relay 提供 | `/`、`/dashboard` | 免登录只读面板；数据走 `/api/public` |
| provider-setup | 同上 | `/setup` | 粘贴厂商 key，校验后启用 |
| stackctl | `/opt/free-token-cloud/bin` | — | 组合栈状态/启停 |

对外接口：

- `POST /v1/chat/completions`（OpenAI）
- `POST /v1/responses`（Codex / Responses 客户端）
- `POST /v1/messages`（Anthropic / Harness）
- `GET /v1/models`、`GET /health`、`GET /api/public`

---

## 3. Linux / macOS 部署（最短路径）

```bash
git clone <repo> && cd free-token-cloud
printf 'RELAY_HOST=<你的域名或IP>\nRELAY_REMOTE_DIR=/opt/ai-relay\n' > .env.local
chmod 600 .env.local
sudo RELAY_TOKEN="$(openssl rand -hex 24)" bash scripts/install-server.sh   # 或按 README 手工装
```

本机自用（不装 nginx）时：

```bash
npm ci --omit=dev || true
node router.js            # 直接听 127.0.0.1:8801
```

验证：`curl -s localhost:8801/health`、`curl -s -H "Authorization: Bearer <token>" localhost:8801/v1/models`。

---

## 4. Windows 电脑：自己做好接口适配

**原则：把 Linux 那套语义翻译成 Windows 等价物，不改产品行为，也不碰主人已有环境。**

| Linux/macOS | Windows 等价做法 |
|---|---|
| systemd `ai-relay.service` | NSSM 注册服务，或「任务计划程序」开机启动 `node router.js` |
| systemd timer（watchdog） | 任务计划程序每 5 分钟跑 `watchdog` 等价 PowerShell |
| launchd（本机 Codex 桥） | 任务计划程序常驻，或 NSSM；端口同样只绑 `127.0.0.1` |
| `/opt/ai-relay` | `C:\free-token-cloud\relay`（不要写进 `Program Files`） |
| bash `install-server.sh` | 逐条翻译成 PowerShell（建目录、写 token 文件、设 ACL） |
| nginx :8080 | 可选：Caddy / IIS ARR / 或不装边缘层，直接暴露 127.0.0.1 并只给本机 agent 用 |
| `chmod 600` | `icacls <file> /inheritance:r /grant:r "%USERNAME%:R"` |
| `curl -N` 流式 | PowerShell `Invoke-WebRequest` 或直接用 Node 脚本，注意不要缓冲 |
| 环境变量 `RELAY_TOKEN` | 用户级环境变量，或读取 `%APPDATA%\free-token-cloud\token` |

Windows 适配注意：

1. **路径不要含中文与空格**，否则 nginx/服务参数容易解析失败。
2. 文件统一 **UTF-8 无 BOM**；`.ps1` 里避免把 `\n` 当换行。
3. 防火墙只放行你要暴露的端口；本机 agent 用就绑 `127.0.0.1`。
4. 流式响应不要经过会缓冲的代理（IIS 需关闭 output buffering）。
5. 不要注册与主人现有服务同名的 Windows 服务。

---

## 5. 并存接入（本地 agent）

目标：本中转当“第二通道”，主人原来的默认模型不受影响。

- **OpenClaw**：只在 `models.providers` 里**追加** `ai-relay`，默认 `model.primary` 不动；需要时用 `--model ai-relay/tools` 或 `ai-relay/chat`。
- **Codex / 其他 agent**：新增 `[model_providers.ai-relay]`（`wire_api = "responses"`），默认 `model_provider` 保持原值；不要改 `model`。
- **DSH Harness**：按 `docs/harness.profile.example.yml` 追加 `ai-relay` provider，`baseURL` 用你自己的地址，token 走环境变量；不要替换原有 DeepSeek 路由。
- **本机桥（可选）**：若需要“同一菜单里同时出现付费模型与免费池”，可在本机跑一个按模型名分流的小代理；它只监听 `127.0.0.1`，不代理、不记录付费 key。

---

## 6. 验证清单（逐条留证）

```bash
curl -s http://127.0.0.1:8801/health
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8801/v1/models
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8801/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"chat","messages":[{"role":"user","content":"只回答四个字：部署完成"}]}'
curl -sN -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8801/v1/messages \
  -H 'content-type: application/json' \
  -d '{"model":"tools","stream":true,"messages":[{"role":"user","content":"说一句话"}]}'
```

- [ ] `/health` 返回 `ok:true`
- [ ] `/v1/models` 至少列出 `tools`、`chat`
- [ ] chat 返回 200，`usage.total_tokens > 0`
- [ ] `/v1/messages` 流式出现 `message_start` / `message_delta` / `message_stop`
- [ ] 控制台 `/` 显示“服务正常”，且 `/api/public` 可读
- [ ] 主人原有默认模型仍可用（另开一次调用验证，没被动过）
- [ ] token 文件权限 600（Windows ACL 仅本人）
- [ ] 重启后服务自动恢复

验证完把**命令 + 关键数字**贴给主人，不要贴 token。

---

## 7. 回滚

1. 停服务（systemd / NSSM / 任务计划）。
2. 还原配置备份（`config.toml.bak-*`、`providers.json.bak-*`）。
3. 删除新增的 `[model_providers.ai-relay]` 段落（只删自己加的）。
4. 恢复默认 `model_provider` / `model`。
5. 重新验证主人原服务可用。

---

## 8. 交付话术（给主人看）

> 已按“并存”方式接入：默认模型和付费 key 未改动；新增 provider `ai-relay` 指向本机中转。
> 证据：`/health` ok、`/v1/models` 含 tools/chat、chat 200 返回 usage、`/v1/messages` 流式事件完整。
> 回滚：删除新增 provider 段并还原备份即可。
