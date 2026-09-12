# KubeAI (experimental)

|                |                                                                            |
| -------------- | -------------------------------------------------------------------------- |
| Homepage       | https://www.kubeai.org/                                                    |
| Helm chart     | https://github.com/substratusai/kubeai/blob/main/charts/kubeai             |
| Model catalog  | https://github.com/substratusai/kubeai/blob/main/charts/models/values.yaml |
| vLLM arguments | https://docs.vllm.ai/en/stable/serving/engine_args.html                    |
| Endpoint       | `https://kubeai.<domain>/`                                                 |
|                | `https://kubeai.<domain>/openai/v1/models`                                 |
|                | `https://kubeai.<domain>/openai/v1/audio/transcriptions`                   |

KubeAI provides OpenAI-compatible API to Ollama and vLLM. It allows autoscalling and more control over the models and inference engines.

It's generally more useful for dedicated GPU clusters or when using an agent deployed with cloud providers. It is included here for experiments as it supports vLLM engine as an alternative to Ollama. It's faster but also uses more VRAM.

Currently the models are loaded into memory on first request and stay in memory for 30 minutes. Longhorn volumes are NOT used.

Make sure nothing else is loaded into GPU memory (`nvidia-smi`), otherwise the model pods will likely fail to start.

KubeAI models are downloaded from HuggingFace. You need to create free account and access token with permission to `Read access to contents of all public gated repos you can access` at https://huggingface.co/settings/tokens

```sh
pulumi config set kubeai:enabled true
pulumi config set --secret kubeai:huggingfaceToken <hf_token>
pulumi up
```

Prometheus monitoring and related Grafana dashboard for vLLM can be enabled with:

```sh
pulumi config set prometheus:enabled true
pulumi config set prometheus:enableComponentMonitoring true
```

Note that Prometheus has to be installed first before changing that switch.
