# Agentgateway

|               |                                                                                        |
| ------------- | -------------------------------------------------------------------------------------- |
| Homepage      | https://agentgateway.dev/                                                              |
| Source code   | https://github.com/agentgateway/agentgateway                                           |
| Documentation | https://agentgateway.dev/docs/                                                         |
| Model catalog | https://agentgateway.dev/model-catalog                                                 |
| Cost catalog  | https://agentgateway.dev/docs/kubernetes/latest/documentation/llm/cost-controls/costs/ |
| API reference | https://agentgateway.dev/docs/kubernetes/latest/reference/api/                         |
| Helm values   | https://agentgateway.dev/docs/kubernetes/latest/reference/helm/agentgateway/           |
| Analytics     | `https://agentgateway.<domain>/ui/llm/analytics`                                       |
| Logs          | `https://agentgateway.<domain>/ui/llm/logs`                                            |
| Config dump   | `https://agentgateway.<domain>/config_dump`                                            |
| Endpoints     | `https://ai.<domain>/v1`                                                               |
|               | `https://agentgateway.<domain>/`                                                       |

OpenAI-compatible gateway that puts any number of OpenAI-compatible providers behind one endpoint. Provider endpoints and credentials live in the gateway; clients get virtual keys and see one model catalog.

## Installation

```sh
cd stacks/ai
pulumi config set agentgateway:enabled true
pulumi config set --path 'agentgateway:providers.ollama.baseUrl' 'http://ollama.ollama:11434/v1'
pulumi config set --path 'agentgateway:providers.ollama.models[0]' 'gemma4'
pulumi config set --path 'agentgateway:providers.opencode.baseUrl' 'https://opencode.ai/inference/go/openai/v1'
pulumi config set --path 'agentgateway:providers.opencode.models[0]' 'deepseek-v4.1-flash'
# OpenCode Go needs a session id; clients that send one keep it
pulumi config set --path 'agentgateway:requestHeaders.x-opencode-session' 'orangelab-gateway'
pulumi config set agentgateway:clients open-webui,opencode
pulumi config set --secret agentgateway:opencode/apiKey <provider-key>
pulumi up
```

Ollama needs no key; the `opencode/apiKey` secret is only required for providers that authenticate.

## Providers and models

`agentgateway:providers` maps a provider name to its OpenAI-compatible endpoint and models:

| Provider   | `baseUrl`                                    | Client model                   |
| ---------- | -------------------------------------------- | ------------------------------ |
| `ollama`   | `http://ollama.ollama:11434/v1`              | `ollama/gemma4`                |
| `opencode` | `https://opencode.ai/inference/go/openai/v1` | `opencode/deepseek-v4.1-flash` |

The name is arbitrary. `baseUrl` can point at an in-cluster service or an external API; it must be an OpenAI-compatible `/v1` endpoint. Clients request `<provider>/<model>`; the prefix is stripped before the request reaches the upstream.

`clientPrefix` overrides that first half, so several providers can publish one
namespace — one Hermes profile per provider, all reachable as `hermes/<profile>`:

```yaml
agentgateway:providers:
    alice:
        baseUrl: http://hermes.hermes:8642/p/alice/v1
        clientPrefix: hermes
        models: [alice]
```

Each provider keeps its own `baseUrl` and key; only the client-visible label
changes. Two providers that would publish the same id are rejected at preview.

Every provider's API key is a separate secret, named `<provider>/apiKey`:

```sh
pulumi config set --secret agentgateway:opencode/apiKey <provider-key>
```

Providers without a key, like Ollama, skip the auth header.

The declared models are the allow-list. `/v1/models` lists exactly them, and requests for anything else fail.

A provider hosted by another component in this stack — the agent's OpenAI-compatible API — is declared the same way, but its credential is minted by the gateway instead of set by you, because the gateway is the only client: enabling both components is enough, no `<provider>/apiKey` secret to create.

```sh
pulumi config set --path 'agentgateway:providers.hermes.baseUrl' 'http://hermes.hermes:8642/v1'
pulumi config set --path 'agentgateway:providers.hermes.models[0]' 'hermes-agent'
```

The generated credential is exported for the hosting component (`apps.hermes.apiServerKey`).
An agent that serves several profiles declares one provider per profile, named
after it and pointed at its `/p/<profile>/v1` path; see [hermes](../hermes/hermes.md).

OpenCode serves the same model IDs from two paths, and the path selects the bill: `/inference/go/openai/v1` draws on an OpenCode Go subscription, `/inference/openai/v1` charges the Console pay-as-you-go balance. Both accept the same Console API key. Models outside the Go catalog are only on the balance path, so put them under a second provider if you need them. Go also requires an `x-opencode-session` header; `agentgateway:requestHeaders` supplies it because clients that are not coding agents do not send one. A client-sent value always wins over the configured fallback.

## Virtual models

Virtual models publish a stable client-facing name and route to concrete models. Targets use the same `<provider>/<model>` names as the provider config:

```yaml
agentgateway:virtualModels:
    assistant:
        targets:
            - model: opencode/deepseek-v4.1-flash
    coding:
        targets:
            - model: opencode/deepseek-v4.1-flash
    private-assistant:
        targets:
            - model: ollama/gemma4
```

`assistant` and `coding` point at DeepSeek; `private-assistant` points at the local Gemma model so requests stay on the cluster. The default strategy is `failover`; add `priority` to order fallback targets or `weight` for a `weighted` split. Virtual models must be public and cannot set their own policies. Set the structure with `pulumi config set --path` or in your stack file.

## Virtual keys

Pulumi generates one key per client in `agentgateway:clients`. The keys are not stored in the cluster; the gateway keeps SHA-256 hashes in a ConfigMap.

Retrieve a key in your terminal:

```sh
pulumi stack output --show-secrets --json | jq -r '.apps.agentgateway.apiKeys'
```

Point an OpenAI-compatible client at `https://ai.<domain>/v1` with the key:

```sh
curl https://ai.<domain>/v1/chat/completions \
    -H "Authorization: Bearer <virtual-key>" \
    -H "Content-Type: application/json" \
    -d '{"model":"ollama/gemma4","messages":[{"role":"user","content":"Hello"}]}'
```

Provider credentials never leave the gateway's Secrets. Revoking a client means removing its key from `agentgateway:clients` and redeploying.

## Dashboard

The dashboard is read-only in Kubernetes mode. It runs in dump mode, so the navigation is limited to Models, Client Setup, Listeners, Routes, Policies, and CEL Playground. Open `/ui/llm/analytics` directly for the token and spend charts, or `/ui/llm/logs` for request logs.

Virtual API keys are not shown in the UI: the cluster only stores their SHA-256 hashes. Retrieve the raw keys from `apps.agentgateway.apiKeys` as shown above.

Agentgateway's admin interface binds to loopback, so a small Caddy sidecar exposes `/ui`, `/api`, and `/config_dump`. The read-only UI needs the config dump to render the model inventory. Destructive admin endpoints (`/logging`, `/debug`, `/quitquitquit`) stay inside the pod.

The request log uses a SQLite database in the proxy pod's temporary volume. History is lost when the pod restarts; Prometheus metrics provide the durable view. Prompt and completion content is stored in that database (`frontendPolicies.accessLog.database.llm: full`), so the Logs page shows full conversations.

Costs come from a model cost catalog. Agentgateway ships a built-in catalog for common public models; models it does not know show tokens but no cost. Add an overlay in the stack config:

```yaml
agentgateway:modelCosts:
    providers:
        openai:
            models:
                deepseek-v4.1-flash:
                    rates: { input: '0.30', output: '1.20', cacheRead: '0.006' }
                gemma4:
                    rates: { input: '0', output: '0' }
```

Rates are USD per 1M tokens. The provider id is `openai` because these models use the OpenAI-compatible provider, and the model names are the upstream names. Set the structure with `pulumi config set --path` or in your stack file.

This is an overlay on the built-in catalog, so don't set top-level `metadata`; a catalog with `metadata` is treated as a base catalog instead of an overlay. Numeric rate values are normalized to strings, including `inputAudio`, `outputAudio`, and values inside `cacheWriteDetails`.

### Pocket ID

The dashboard is private by default. To restrict it to Pocket ID groups, deploy once so the endpoint exists, then from `stacks/ai`:

```sh
pulumi config set agentgateway:auth/allowedGroups admin,agentgateway-admin
./components/agentgateway/pocket-agentgateway.sh
# apply the clientId/clientSecret commands printed by the script, then:
pulumi config set agentgateway:auth pocket
pulumi up
```

The groups must already exist in Pocket ID. The API endpoint stays on virtual keys and does not use OIDC.

If the script returns `401 not_signed_in`, the core stack's `pocket:apiKey` is missing, expired, or belongs to a non-admin. Create a new key under **Administration → API Keys** and set it in the repository root:

```sh
pulumi config set pocket:apiKey <key> --secret
```

## Advanced

Prompt guard and MCP server examples: [`spec/agentgateway.md`](../../../../spec/agentgateway.md).

## Limitations

- Requires the Traefik routing provider.
- The dashboard database is per-pod and ephemeral.
- Providers must expose an OpenAI-compatible API.
- Any valid virtual key can call any declared model; per-client model restrictions are not configured.
