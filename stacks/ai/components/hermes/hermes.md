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

### Profiles

Profiles can serve their own route on the same API, each with its own key. List
them, and declare each as a gateway provider named after it:

```sh
pulumi config set hermes:profiles alice,bob

pulumi config set --path 'agentgateway:providers.alice.baseUrl' 'http://hermes.hermes:8642/p/alice/v1'
pulumi config set --path 'agentgateway:providers.alice.models[0]' 'alice'

pulumi config set --path 'agentgateway:providers.bob.baseUrl' 'http://hermes.hermes:8642/p/bob/v1'
pulumi config set --path 'agentgateway:providers.bob.models[0]' 'bob'

pulumi up
```

Clients then see `alice/alice` and `bob/bob`, reached with the same virtual keys;
provider name and model id are both the profile name. Add `clientPrefix: hermes` to
each profile's provider to group them as `hermes/alice` and `hermes/bob` instead,
beside `hermes/default` for the default profile. The prefix only groups the
catalog: the provider, and so the key, stays per profile.

The key is written to the profile's `.env` when the pod starts, so a profile
created on the dashboard afterwards answers on the next deploy. A name in
`hermes:profiles` with no profile behind it gets no key and stays unreachable.

## Webhooks

An event can start an agent turn without a chat: a sender POSTs a signed payload
and the agent runs the route attached to it. The listener is cluster-only, like
the API port — it never appears on the dashboard's hostname.

```sh
# The full hook URL; also exported as the cluster endpoint `hermes-webhook`
pulumi stack output --json | jq -r '.endpoints.cluster["hermes-webhook"]'

# The shared HMAC secret a sender signs with
pulumi stack output --show-secrets --json | jq -r '.apps.hermes.webhookSecret'
```

The secret is generated on first deploy. Pin your own instead
(`pulumi config set --secret hermes:webhook/secret <value>`) when the value has
to be known before the deploy, and keep both ends on that value.

The route is the last path segment, and the deploy seeds one: `forgejo-pr` wakes
the agent for a comment or a review on a pull request. The exported value is
therefore the complete payload URL — host, port and route — not a base someone
has to finish by hand:

`http://hermes.hermes:8644/webhooks/forgejo-pr`

Adding the hook is the one step this stack cannot do for you, because the hook
lives on the repository, not on the deployment: whoever administers it opens
**Settings → Webhooks → Add webhook** on Forgejo or GitHub, pastes that payload
URL, picks `application/json`, enters the shared secret, and selects the comment
events (_Issue Comment_, _Pull Request Comment_, _Pull Request Review_). Every
repository that points at the route is served by it — the payload names the
repository, so a second repo needs its own hook but no new route.

Two things to know before handing the URL to a repository owner:

- the port is cluster-only, so only a sender that reaches the cluster network can
  deliver — the `forgejo` component in this stack does, a repository on a public
  forge such as `github.com` does not without a route to the service;
- the secret is the deploy's, not the repository's: `apps.hermes.webhookSecret`
  and the listener's `WEBHOOK_SECRET` are the same value, so there is nothing
  extra to mint per repository.

The route needs nothing on the sender's side beyond those two values, and two
guards keep it closed:

- a comment whose author is the agent (`sender.login == agent`) never wakes it,
  so its own replies do not start a loop;
- `init/forgejo-pr.py` drops everything that is not a comment or a review on a
  pull request, and flattens the provider payload into `repo`, `number`, `title`,
  `author`, `url` and `body`, which is what the route prompt reads.

Both forges sign the raw body into `X-Hub-Signature-256` (`sha256=<hex>` HMAC) and
name the event in `X-GitHub-Event`, so a GitHub-shaped hook works unchanged
against Forgejo, and no adapter sits between the two.

The route and its script are seeded like `config.yaml`: written when the volume
has none, and restored by `hermes:recreateConfig true`. A later `hermes webhook
subscribe forgejo-pr` (or a dashboard edit) rewrites the route on the volume, so
pass `--secret` with the shared value if you recreate it by hand — `subscribe`
mints a per-route secret otherwise, and the hook on the sender would still be
signing with the old one.

Test a route without the sender: `hermes webhook test forgejo-pr`.

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
