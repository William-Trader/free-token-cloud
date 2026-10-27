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
