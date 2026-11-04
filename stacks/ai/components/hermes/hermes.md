# Hermes Agent

|               |                                                                     |
| ------------- | ------------------------------------------------------------------- |
| Homepage      | https://hermes-agent.nousresearch.com/                              |
| Source code   | https://github.com/NousResearch/hermes-agent                        |
| Documentation | https://hermes-agent.nousresearch.com/docs/                         |
| Configuration | https://hermes-agent.nousresearch.com/docs/user-guide/configuration |
| Docker        | https://hermes-agent.nousresearch.com/docs/user-guide/docker        |
| Docker Image  | https://hub.docker.com/r/nousresearch/hermes-agent                  |
| Dockerfile    | https://github.com/NousResearch/hermes-agent/blob/main/Dockerfile   |
| Endpoints     | `https://hermes.<domain>/`                                          |

Self-improving agent with a dashboard, chat, sessions, memory and cron.
Default profile is set up to monitor your cluster and communicate using White Noise (Marmot protocol, Nostr).
Uses [agentgateway](./agentgateway.md) for models when one is configured.

## Tools

- **`kubectl`** with read-only cluster access, excluding Secrets.
- **`gh`** for GitHub, once you set a token.

## Installation

```sh
cd stacks/ai
pulumi config set hermes:enabled true

# (Recommended) Run on a model agentgateway serves
pulumi config set agentgateway:clients open-webui,hermes
pulumi config set hermes:model assistant

# (Recommended) Pocket ID login instead of the generated admin password
./components/hermes/pocket-hermes.sh
# apply the two commands it prints:
pulumi config set hermes:auth pocket
pulumi config set hermes:auth/clientId <client-id>

# (Optional) GitHub token
pulumi config set --secret hermes:GITHUB_TOKEN <token>

pulumi up
```

## Post-Installation

1. Open `https://hermes.<domain>/` and sign in.
2. The default profile is the cluster operator; `hermes:soulFile` picks the
   `SOUL.md` seeded into it.
3. Add personal profiles from **Profiles → Create**. Each has its own model,
   keys, skills, memory, sessions and gateway.
4. White Noise is the main chat channel (below); other platforms can be added
   per profile from **Channels**.

## Configuration files

```sh
# config.yaml and SOUL.md are seeded on first start, then owned by the dashboard/agent
# Point hermes:soulFile at your own SOUL.md before the first deploy
pulumi config set hermes:soulFile <path>

# Re-copy the seeded config.yaml, discarding dashboard edits
pulumi config set hermes:recreateConfig true
```

## GitHub access

```sh
# Fine-grained token, limited to the repositories the agent needs
pulumi config set --secret hermes:GITHUB_TOKEN <token>
```

1. Open **GitHub → Settings → Developer settings → Personal access tokens →
   Fine-grained tokens**, then **Generate new token**.
2. **Repository access** → **Only select repositories**.
3. **Permissions → Repository permissions**:
    - **Metadata**: Read (always required)
    - **Contents**: Read
    - **Issues**: Read and write — only if it should triage or comment
    - **Pull requests**: Read and write — only if it should open or review PRs

## Forgejo access

```sh
# Token for the forge the agent pushes to
pulumi config set --secret hermes:FORGEJO_TOKEN <token>
```

Mint it under **Settings → Applications → Generate new token** with the
`write:repository` scope. Use an account made for the agent rather than your own,
so the token can be revoked without locking you out of your repositories.

## Models

```sh
# Any model or virtual model agentgateway serves
pulumi config set hermes:model assistant
```

Without `hermes:model`, pick a provider and model on the dashboard's **Models**
page.

## OpenAI-compatible API

Other in-cluster apps can talk to the agent over an OpenAI-compatible API. It is
enabled by [agentgateway](./agentgateway.md), which is its only client, on a port
that stays cluster-only — it never appears on the dashboard's hostname. The key is
generated, so there is nothing to set: the gateway mints it, sends it upstream, and
the agent requires it.

```sh
# The agent becomes a provider of its own in the gateway's model catalog
pulumi config set --path 'agentgateway:providers.hermes.baseUrl' 'http://hermes.hermes:8642/v1'
pulumi config set --path 'agentgateway:providers.hermes.models[0]' 'hermes-agent'
pulumi up
```

The agent then answers to `hermes/hermes-agent` on `https://ai.<domain>/v1` with
any virtual key, so every gateway client — Open WebUI, `n8n`, a script — reaches it
without its own credential.

The model id is the profile name, and `hermes-agent` for the default profile — so
list exactly that under `agentgateway:providers.hermes.models`; a mismatched bare
model is ignored upstream and silently runs the gateway's default model instead.

```sh
pulumi stack output --show-secrets --json | jq -r '.apps.hermes.apiUrl,.apps.hermes.apiServerKey'
```

That endpoint runs a full agent turn per request, and that agent's tools act on the
cluster and its volume. Treat a virtual key that can reach `hermes/default` as access
to the agent, not as a chat model.

## Speech

Voice works through [speaches](./speaches.md) when it is enabled; the models are
read from `speaches:*`, so there is nothing to configure here.

```sh
pulumi config set speaches:enabled true
```

Speech-to-text turns inbound voice notes into text, and text-to-speech lets the
agent reply with audio. Without it, a voice note arrives as an untranscribed
attachment and replies are text-only; the seeded `config.yaml` has no `stt` or
`tts` block to fall back on.

## Pocket ID

```sh
./components/hermes/pocket-hermes.sh
pulumi config set hermes:auth pocket
pulumi config set hermes:auth/clientId <client-id>
pulumi up

# The script registers https://hermes.<domain>/auth/callback
# Allowed groups (hermes:auth/allowedGroups) must already exist in Pocket ID
# hermes:trustedProxies overrides the proxy CIDRs for a non-k3s cluster

# Without hermes:auth the dashboard uses a generated admin password
pulumi stack output --show-secrets --json | jq -r '.apps.hermes.dashboardPassword'
```

## White Noise connector

```sh
# Adds a connector with its own identity; nothing secret to set
pulumi config set hermes:marmot/enabled true
# npub or 64-char hex, comma-separated; empty denies everyone
pulumi config set hermes:marmot/welcomerAllowlist <npub>
pulumi config set hermes:marmot/allowedUsers <npub>
pulumi up

# welcomerAllowlist: who may invite the agent into a group
# allowedUsers: who may message it; allowAllUsers defaults to false
# One npub serves one profile
# Find the agent's npub, then invite it from White Noise
./scripts/wn-agent-npub.sh
```

```sh
# After the first invite, save the home channel (cron and hermes send deliver there)
./scripts/wn-agent-groups.sh
pulumi config set hermes:marmot/homeChannel <group-id>
pulumi up

# A recreated group gets a new id; update the key if that happens
# Enabling the connector on an existing profile needs hermes:recreateConfig true
```

The connector is two artefacts from one [upstream release][mdk]: the `wn-agent`
binary (the transport, run as a sidecar) and `hermes-marmot-plugin` (the gateway
platform adapter). `init/install-wn-agent.sh` installs and checksum-verifies
both on every start, so a fresh volume needs no manual step. Installing only the
binary leaves `platforms.marmot` configured but unregistered, and messages never
arrive.

## Plugins

```sh
# Every plugin the gateway should load, comma-separated
pulumi config set hermes:plugins marmot,reports
```

Hermes loads a plugin only when it is named under `plugins.enabled`, so this list
is what reaches the gateway — a plugin installed on the volume but missing from it
is discovered in the UI while every one of its routes answers `404 Plugin not
found`. `marmot` has to be there for the connector to deliver anything.

[mdk]: https://github.com/marmot-protocol/mdk/releases
