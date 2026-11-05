# Hermes Agent

|                   |                                                                     |
| ----------------- | ------------------------------------------------------------------- |
| Homepage          | https://hermes-agent.nousresearch.com/                              |
| Source code       | https://github.com/NousResearch/hermes-agent                        |
| Documentation     | https://hermes-agent.nousresearch.com/docs/                         |
| Configuration     | https://hermes-agent.nousresearch.com/docs/user-guide/configuration |
| Docker            | https://hermes-agent.nousresearch.com/docs/user-guide/docker        |
| Docker Image      | https://hub.docker.com/r/nousresearch/hermes-agent                  |
| Dockerfile        | https://github.com/NousResearch/hermes-agent/blob/main/Dockerfile   |
| Operational notes | [spec/hermes.md](../../spec/hermes.md)                              |
| Endpoints         | `https://hermes.<domain>/`                                          |

Self-improving agent with a dashboard, chat, sessions, memory and cron. The
default profile monitors your cluster and chats over White Noise, and uses
[agentgateway](./agentgateway.md) for models when one is configured.

- **`kubectl`**: read-only cluster access, Secrets excluded.
- **`gh`**: GitHub, after you set a token.

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
2. Add personal profiles from **Profiles → Create**. Each has its own model,
   keys, skills, memory, sessions and gateway.
3. White Noise is the main chat channel (below); other platforms are added per
   profile from **Channels**.

## Configuration

### Files

```sh
# config.yaml and SOUL.md are seeded on first start, then owned by the dashboard/agent
# Point at your own SOUL.md before the first deploy
pulumi config set hermes:soulFile <path>

# Re-copy the seeded config.yaml, discarding dashboard edits
pulumi config set hermes:recreateConfig true
```

### Access

```sh
# Groups in hermes:auth/allowedGroups must already exist in Pocket ID
# hermes:trustedProxies overrides the proxy CIDRs on a non-k3s cluster

# Without Pocket ID, retrieve the generated admin password
pulumi stack output --show-secrets --json | jq -r '.apps.hermes.dashboardPassword'
```

Without `hermes:model`, pick a provider and model on the dashboard's **Models**
page.

### GitHub token

```sh
# Fine-grained token, limited to the repositories the agent needs
pulumi config set --secret hermes:GITHUB_TOKEN <token>
```

- **Repository access** → **Only select repositories**
- **Permissions → Repository permissions**:

    - **Metadata**: Read (always required)
    - **Contents**: Read
    - **Issues**: Read and write — only if it should triage or comment
    - **Pull requests**: Read and write — only if it should open or review PRs

### Forgejo token

```sh
# Token for the forge the agent pushes to
pulumi config set --secret hermes:FORGEJO_TOKEN <token>
```

Mint it under **Settings → Applications → Generate new token** with the
`write:repository` scope, from an account made for the agent rather than your own.

### OpenAI-compatible API

Other in-cluster apps can reach the agent over an OpenAI-compatible API. The port
stays cluster-only and the gateway supplies the key.

```sh
pulumi config set --path 'agentgateway:providers.hermes.baseUrl' 'http://hermes.hermes:8642/v1'
pulumi config set --path 'agentgateway:providers.hermes.models[0]' 'hermes-agent'
pulumi up

# The agent's own URL and key, for a client that skips the gateway
pulumi stack output --show-secrets --json | jq -r '.apps.hermes.apiUrl,.apps.hermes.apiServerKey'
```

Clients then reach `hermes/hermes-agent` on `https://ai.<domain>/v1` with any
virtual key. The model id is the profile name (`hermes-agent` for the default),
and a mismatched bare id silently runs the gateway's default model instead.

Each request runs a full agent turn, so a key that can reach the agent is access
to the agent, not a chat model.

#### Profiles

```sh
pulumi config set hermes:profiles alice,bob

pulumi config set --path 'agentgateway:providers.alice.baseUrl' 'http://hermes.hermes:8642/p/alice/v1'
pulumi config set --path 'agentgateway:providers.alice.models[0]' 'alice'

pulumi config set --path 'agentgateway:providers.bob.baseUrl' 'http://hermes.hermes:8642/p/bob/v1'
pulumi config set --path 'agentgateway:providers.bob.models[0]' 'bob'

pulumi up
```

- Each profile gets its own provider and key; the model id is the profile name.
- Add `clientPrefix: hermes` to a provider to group the catalog as
  `hermes/alice` and `hermes/bob`.
- A profile created on the dashboard afterwards answers after the next deploy.

### Speech

Voice works through [speaches](./speaches.md) when it is enabled, with nothing to
configure here. Without it, voice notes arrive untranscribed and replies are
text-only.

```sh
pulumi config set speaches:enabled true
```

## Webhooks

An event can start an agent turn without a chat. The seeded route `forgejo-pr`
wakes the agent for a comment or a review on a pull request.

The route belongs to the deploy and is merged into the profile on every start,
so a change here reaches an existing install on `pulumi up`. Routes you add
through the dashboard are left alone.

```sh
# The full payload URL; also exported as the cluster endpoint `hermes-webhook`
pulumi stack output --json | jq -r '.endpoints.cluster["hermes-webhook"]'

# The shared HMAC secret the sender signs with
pulumi stack output --show-secrets --json | jq -r '.apps.hermes.webhookSecret'
```

The secret is generated on first deploy. Pin it with
`pulumi config set --secret hermes:webhook/secret <value>` when it has to be known
beforehand, and keep both ends on that value.

Add the hook on the repository under **Settings → Webhooks → Add webhook**:

- payload URL: the exported value above
- content type: `application/json`
- secret: the exported secret above
- events: _Issue Comment_, _Pull Request Comment_, _Pull Request Review_

Each repository needs its own hook; the route serves all of them.

- The port is cluster-only, so the sender must reach the cluster network. The
  `forgejo` component here does; a public forge such as `github.com` does not
  without a route to the service.
- The agent's own comments never wake it, so its replies cannot start a loop.

## White Noise connector

```sh
# Adds a connector with its own identity; nothing secret to set
pulumi config set hermes:marmot/enabled true
# npub or 64-char hex, comma-separated; empty denies everyone
pulumi config set hermes:marmot/welcomerAllowlist <npub>
pulumi config set hermes:marmot/allowedUsers <npub>
pulumi up
```

Invite each agent from White Noise. The script prints one `profile npub` line per
connector, including every profile in `hermes:profiles`:

```sh
./scripts/wn-agent-npub.sh
```

- `welcomerAllowlist`: who may invite the agent into a group.
- `allowedUsers`: who may message it; `allowAllUsers` defaults to false.
- Both lists apply to every profile, so the npub invited into a group decides
  which profile answers.

After the first invite, save the group as the home channel, where cron and agent
messages deliver:

```sh
./scripts/wn-agent-groups.sh
pulumi config set hermes:marmot/homeChannel <group-id>
pulumi up
```

Enabling the connector on a profile that already exists needs
`hermes:recreateConfig true`. A recreated group gets a new id; update
`hermes:marmot/homeChannel` if that happens.

## Plugins

```sh
# Every plugin the gateway should load, comma-separated
pulumi config set hermes:plugins marmot,reports
```

A plugin installed on the volume but missing here answers `404 Plugin not found`.
`marmot` has to be in the list for the connector to deliver anything.

## Uninstall

- Setting `hermes:enabled false` and running `pulumi up` removes the deployment.
- Delete the repository webhook you added for `forgejo-pr`.
- Remove the `agentgateway:providers.*` entries that point at the agent.
