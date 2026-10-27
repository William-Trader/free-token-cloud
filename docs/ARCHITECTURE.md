# Free Token Cloud Architecture

Free Token Cloud is a self-owned composition. It does not run a third-party
gateway process.

```text
OpenClaw / Codex / OpenAI clients
              |
              v
      edge :8080 (nginx)
              |
              v
   relay-core :8801
      |               |
      v               v
 credential vault   anonymous pool
 /opt/ai-relay/     Kilo / OVH / LLM7 / Pollinations
 secrets
      |
      v
 provider setup page + login links + encrypted keys
```

## Components

| Component | Runtime | Responsibility |
|---|---|---|
| `relay-core` | Node/systemd | Token auth, pools, tool bridge, failover, metrics and dashboard |
| `credential-vault` | relay-core | AES-256-GCM encrypted provider keys |
| `provider-setup` | relay-core | Login links, key entry, validation and activation |
| `edge` | nginx | Public entry, request size, rate limiting and stream-safe proxying |
| `control` | direct HTTPS/HTTP | No local gateway runtime |

## Pool Rules

- `tools` accepts only verified tool-capable or text-tool-bridge providers.
- `chat` strips tools and is safe for conversation-only models.
- Added keys are validated before promotion into routing.
- Provider failures fall through to the 19/29-slot anonymous pool.
- Provider secrets stay on 101. The workstation never stores them.
- Aggregate request and token usage persists in `/opt/ai-relay/state/usage.json`.
- Raw request history remains append-only in `/opt/ai-relay/logs/relay.jsonl`.
- Per-provider connection switches persist in `/opt/ai-relay/state/provider-settings.json`.
- Provider endpoint health can be audited with `npm run providers:probe`.

## Failure Isolation

1. Credential validation failure does not enable a broken provider.
2. Relay-core failure does not alter encrypted credentials.
3. nginx can be restarted without rebuilding relay-core.
4. Provider cooldowns are local to each slot.
5. `ai-relay-watchdog.timer` restarts only the relay on liveness failure.

## Security Boundary

- Public: nginx `:8080`, bearer-token protected `/v1/*`.
- Loopback: relay-core `:8801`.
- Public dashboard and setup page: nginx `:8080`.
- Provider credentials: `/opt/ai-relay/secrets/credentials.enc.json`.
- No provider key, cookie or OAuth secret is placed in this repository.
