# DeepSeek Harness Integration

The local DSH Desktop profile can use Free Token Cloud and the native DeepSeek
route at the same time.

## Route

```yaml
- id: llm-pi-ai
  config:
    providers:
      ai-relay:
        displayName: Free Token Cloud
        api: anthropic-messages
        baseURL: http://<RELAY_HOST>:8080
        apiKeyEnv: QSP_AI_TOKEN
        timeoutMs: 320000
        streamIdleTimeoutMs: 120000
        models:
          - id: tools
            name: AI Relay Tools
            contextWindow: 200000
            maxTokens: 8192
            input: [text]
            reasoningEfforts: false
          - id: chat
            name: AI Relay Chat
            contextWindow: 200000
            maxTokens: 8192
            input: [text]
            reasoningEfforts: false
```

Set `agent-default-model` to `provider: ai-relay`, `model: tools` for the
default route. The original DeepSeek route remains available for manual
selection.

## Credential

Harness resolves `QSP_AI_TOKEN` from its managed credential file:

```text
~/Library/Application Support/dsh-desktop/harness/.credentials.yaml
```

The file must remain mode `600`. Its `refs.QSP_AI_TOKEN` value is the local
relay master token, not an Ollama key and not a DeepSeek API key.

## Profile Patch

```text
~/Library/Application Support/dsh-desktop/harness/profiles/web/cordis.patch.yml
```

The base URL intentionally omits `/v1`; the Harness Anthropic transport adds
`/v1/messages`. Authentication uses the `x-api-key` header, which relay-core
accepts alongside bearer authentication.
