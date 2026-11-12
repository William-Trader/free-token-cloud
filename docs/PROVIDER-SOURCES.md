# Provider Source Audit

Checked 2026-10-27. Only official provider endpoints and user-owned
credentials are eligible. The project does not use shared keys, browser
cookies, CAPTCHA bypasses or quota-evasion accounts.

## Added

| Provider | Access | Endpoint | Evidence |
|---|---|---|---|
| Qwen / Bailian | New-user model quota, often 1M tokens for 90 days | `https://dashscope.aliyuncs.com/compatible-mode/v1` | Alibaba Model Studio free-quota documentation |
| Cerebras | $5 promotional credit for eligible accounts, 30 days | `https://api.cerebras.ai/v1` | Cerebras pricing and inference documentation |
| SambaNova | $5 signup credit, limited Developer tier | `https://api.sambanova.ai/v1` | SambaNova Cloud onboarding and pricing |
| DeepInfra | BYOK; program or promotional credits vary by account | `https://api.deepinfra.com/v1/openai` | DeepInfra OpenAI API and pricing documentation |
| Novita | Free models and promotional credits vary by account | `https://api.novita.ai/v3/openai` | Novita model catalog and API documentation |

## Existing audited sources

- Gemini: official AI Studio free tier.
- Groq: official Free Plan with model-specific RPM/RPD/TPM.
- OpenRouter: official `:free` models with daily request limits.
- Cloudflare Workers AI: daily neuron allowance; requires an account-ID adapter.
- Cohere: evaluation key with monthly call cap.
- SiliconFlow: selected zero-price models.

## Excluded after verification

- GitHub Models: fully retired on 2026-07-30.
- Chutes: states that it has no free tier.
- Hugging Face Free: current Free accounts may have no monthly inference credit.
- DeepSeek: intentionally excluded from the cloud pool; local OpenClaw direct use is allowed.
- Shared third-party gateways, browser-session exports and CAPTCHA bypasses.

## Operational rule

`npm run providers:probe` checks network reachability. A reachable endpoint is
not proof of account quota. Saving a key in Provider Setup performs the
authenticated model-list check before the provider is enabled.

---

## 2026-11-12 更新（v6.0.0）

本文件保留为**人工审计决策记录**；逐源事实、状态、时间戳与出处已迁到单一数据源
[`data/sources.json`](../data/sources.json)，并由 [`docs/SOURCES.md`](SOURCES.md) 自动渲染。
新增/剔除/状态变更流水见 [`docs/SOURCE-AUDIT.md`](SOURCE-AUDIT.md)，维护流程见
[`docs/MAINTENANCE.md`](MAINTENANCE.md)。

本轮复核结论：

| 决策 | 依据 | 结果 |
|---|---|---|
| 保留 2026-10-27 的 5 条排除项 | 官方条款 / 服务退役公告 / 无免费层声明 | GitHub Models、Chutes 置 `removed` 并保留墓碑；DeepSeek 云端池仍排除 |
| 新增 30 条独立免费计划 | 3 个公开清单 + 厂商官方页交叉验证 | 注册表 34 → 64 条；其中 16 条仅社区汇总，标 `confidence=community` / `status=unverified` |
| 多槽位收敛 | `config.json` 中 14 个 `kilo-*`、10 个 `ovh-*` 实为同一计费计划 | 映射为 2 个独立源 + 24 个槽位引用，不再按槽位重复计数 |
| 额度口径纠偏 | 公开清单与厂商页冲突 | 一律以厂商官方页为准；社区数字只在 `note` 里作线索，不作为承诺 |
| 自动化复核 | 每日 HTTP 探测 | 401/403/405/429 视为端点在线；连续失败/老化才降级或剔除 |

自动化源校验不携带任何凭据、不发推理请求、不消耗账号额度；带 key 的真实可用性仍以
Provider Setup 保存 key 时的 authenticated model-list 校验为准。
