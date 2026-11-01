# AI Stack

AI-related components for running large language models, image generation, and workflow automation.

**Prerequisite**: Core stack must be deployed first (network, storage).

## Components

- [Ollama](./components/ollama/ollama.md) - Local LLM inference server with GPU support.
- [Agentgateway](./components/agentgateway/agentgateway.md) - OpenAI-compatible gateway for local and external models, with virtual keys and a usage dashboard.
- [Speaches](./components/speaches/speaches.md) - Local OpenAI-compatible speech-to-text and text-to-speech for voice input and responses.
- [Open WebUI](./components/open-webui/open-webui.md) - Web interface for LLMs with support for multiple backends.
- [InvokeAI](./components/invokeai/invokeai.md) - Professional image generation toolkit.
- [n8n](./components/n8n/n8n.md) - Workflow automation with AI node integration.
- [KubeAI](./components/kubeai/kubeai.md) - Private AI SDK providing OpenAI-compatible API (experimental).
- [Automatic1111](./components/automatic1111/automatic1111.md) - Stable Diffusion WebUI (deprecated).
- [SDNext](./components/sdnext/sdnext.md) - Alternative Stable Diffusion WebUI (deprecated).

## Migrate from Root Stack

If AI components were previously deployed in the root stack, migrate their settings before deploying in this stack.

Plain values can just be copied from `Pulumi.<stack>.yaml` to `stacks/ai/Pulumi.<stack>.yaml`.

Secrets use different encryption keys so the values have to be exported first.

Get plaintext values from the root stack:

```sh
# copy all settings from: ollama,open-webui,invokeai,n8n,kubeai,automatic1111,sdnext

# export secrets
pulumi config get open-webui:WEBUI_SECRET_KEY
pulumi config get n8n:N8N_ENCRYPTION_KEY
pulumi config get kubeai:huggingfaceToken
pulumi config get invokeai:huggingfaceToken
```

Then set them in the AI stack:

```sh
cd stacks/ai
# copy all settings from root stack

# set secrets with new stack encryption key
pulumi config set --secret open-webui:WEBUI_SECRET_KEY <value>
pulumi config set --secret n8n:N8N_ENCRYPTION_KEY <value>
pulumi config set --secret kubeai:huggingfaceToken <value>
pulumi config set --secret invokeai:huggingfaceToken <value>
```
