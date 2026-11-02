# Open-WebUI

|                       |                                                        |
| --------------------- | ------------------------------------------------------ |
| Homepage              | https://openwebui.com/                                 |
| Source code           | https://github.com/open-webui/open-webui               |
| Documentation         | https://docs.openwebui.com/                            |
| Environment variables | https://docs.openwebui.com/reference/env-configuration |
| Endpoints             | `https://webui.<domain>/`                              |

User-friendly AI Interface supporting Ollama, OpenAI API, and other LLM backends.

```sh
cd stacks/ai

# Enable Open-WebUI
pulumi config set open-webui:enabled true

# (Required) secret key used to encrypt OAuth credentials and API keys
KEY=$(openssl rand -base64 32)
pulumi config set open-webui:WEBUI_SECRET_KEY "$KEY" --secret

# Reference the deployed core stack: organization/project/stack
pulumi config set orangelab:coreStackRef example-org/orangelab/lab

# (Optional) persist admin-UI changes in the volume; false keeps the environment authoritative
pulumi config set open-webui:ENABLE_PERSISTENT_CONFIG true

# Deploy
pulumi up
```

## Models

Model backends are connected by the stack when the matching component is enabled. [Agentgateway](../agentgateway/agentgateway.md) and [Ollama](../ollama/ollama.md) are wired automatically; additional providers can be added in the Open WebUI admin UI.

### Image generation

[ComfyUI](../comfyui/comfyui.md) and [SD.Next](../sdnext/sdnext.md) are
connected automatically, one at a time: ComfyUI first, then SD.Next.

```sh
pulumi config set comfyui:enabled true
pulumi up
```

ComfyUI runs the model file selected with `comfyui:modelFile`
(`components/comfyui/models/flux2-klein-4b.json` by default). The model comes
from that file, which ComfyUI downloads on first start, so chat image generation
works without further setup and the model field needs no selection.

Other models, such as Flux, Qwen-Image or an SD 1.5/SDXL checkpoint, need their
own workflow and node mapping in **Admin Settings → Images**; see
[ComfyUI](../comfyui/comfyui.md#models-and-workflows). Persistent config must be
enabled for a custom workflow to survive a restart.

Image editing is a separate engine and is not configured by the stack. It needs
a ComfyUI edit workflow (image input, or an instruction model such as
Qwen-Image-Edit) set in the same admin section.

### Agentgateway

When `agentgateway:enabled` is true, Open WebUI receives the gateway's in-cluster `/v1` endpoint and an `open-webui` virtual key. No model list is set in code; Open WebUI discovers the gateway's models, including virtual models such as `assistant`, `coding`, and `private-assistant`, from `/v1/models`.

`open-webui:DEFAULT_MODELS` pre-selects models for new chats for all users. It is a default, not an access restriction: a user's own default, a group default, or a model URL parameter takes precedence, and users can always pick another model. Models that no longer exist are dropped. Leave it unset to keep the user's own selection or the first available model.

### Ollama

Enable the [Ollama](../ollama/ollama.md) component when using standalone Ollama instead of [KubeAI](../kubeai/kubeai.md). Open WebUI connects to it through `OLLAMA_BASE_URLS`, and models are pulled on start from `ollama:models`:

```sh
pulumi config set ollama:enabled true
pulumi config set ollama:models gemma4,qwen2.5-coder:1.5b
pulumi up
```

Both connections appear when Agentgateway and Ollama are enabled together, so disable the one you don't use.

### Other backends

Add any OpenAI-compatible provider in **Admin Settings → Connections**.

UI changes only survive restarts when persistent config is enabled:

```sh
pulumi config set open-webui:ENABLE_PERSISTENT_CONFIG true
```

With persistent config disabled, Open WebUI reloads its configuration from the environment on startup and connections added in the UI are lost.

## Voice

Voice uses the [Speaches](../speaches/speaches.md) component instead of models bundled in the Open WebUI image. Enable it and redeploy:

```sh
pulumi config set speaches:enabled true
pulumi up
```

Open WebUI receives the Speaches endpoint for both STT and TTS. The slim image is sufficient; no Whisper model, audio conversion tooling, or local TTS runs inside Open WebUI.

Speaches provides the default Kokoro voice, and users can choose another voice in **Settings → Audio**. Leave the personal TTS engine set to **Default** to use the server-side voice.

## OpenID Connect (Pocket ID)

OIDC is optional. The discovery URL is resolved automatically from the core stack.
When enabled, the client is restricted to `admin` and `open-webui-users`.

- The core stack must have Pocket ID enabled and deployed first.
- The discovery URL comes from `security.apps.pocket.oidcProviderUrl` through `orangelab:coreStackRef`.
- Omit `open-webui:auth` to leave OAuth disabled.

### Automated setup (Recommended)

Run the generic Pocket ID client script from the AI stack directory:

```sh
cd stacks/ai

# Set the core stack reference if it is not already configured
pulumi config set orangelab:coreStackRef example-org/orangelab/lab

./components/open-webui/pocket-open-webui.sh
```

The script can be run after Open WebUI is deployed. It prints the client ID and secret commands. Run those commands, then run `pulumi up`.

Existing clients are reused without rotating their secret. If the client was deleted, the script creates a new client and secret.

### Manual setup

Create the client in Pocket ID before deploying Open WebUI:

| Field        | Value                                                   |
| ------------ | ------------------------------------------------------- |
| Name         | `Open WebUI`                                            |
| Callback URL | `<open-webui-url>/oauth/oidc/callback`                  |
| Launch URL   | `<open-webui-url>`                                      |
| Icon         | Optional; see [selfh.st/icons](https://selfh.st/icons/) |

Replace `<open-webui-url>` with the public URL provided by the selected routing provider. For the current Traefik configuration, it is `https://webui.<domain>`.

Copy the client ID and generate/copy the client secret. The secret is shown only once.

Set the client values in the AI stack:

```sh
pulumi config set open-webui:auth pocket
pulumi config set open-webui:auth/clientId <client-id>
pulumi config set open-webui:auth/clientSecret <client-secret> --secret

# Optional: change the login label
pulumi config set open-webui:auth/providerName "Pocket ID"

pulumi up
```

When OIDC is enabled:

- The local login form, password authentication, and local signups are disabled.
- OAuth signup remains enabled so Pocket ID users can be provisioned in Open WebUI.
- Existing Open WebUI accounts are matched by email automatically.

## Upgrades

`open-webui:image` is pinned (`v0.12.5-slim` by default). Keep it pinned: a
rolling tag such as `main-slim` lets any `pulumi up` pick up a new version, and a
minor upgrade runs a database migration as a side effect of an unrelated change.
Upgrade deliberately by bumping the tag and deploying that on its own.

## Backup and Restore

The secret key is required at deployment and must be generated by you before running `pulumi up` - it encrypts OAuth credentials and API keys, which would need to be re-configured after restoring from backup or restoring the volume into a new stack. The key is stored encrypted in the Pulumi stack config, but also save it in a password manager:

```sh
pulumi config --show-secrets --json | jq -r '.["open-webui:WEBUI_SECRET_KEY"].value'
```

## Admin User Management

If you need to manage the admin user or reset permissions, you can access the admin panel at `https://webui.<domain>/admin/users`.

The first user to sign in becomes the admin automatically when `DEFAULT_USER_ROLE` is set to `admin`.
