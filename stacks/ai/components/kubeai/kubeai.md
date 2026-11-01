# KubeAI (experimental)

|                |                                                                |
| -------------- | -------------------------------------------------------------- |
| Homepage       | https://www.kubeai.org/                                        |
| Helm chart     | https://github.com/substratusai/kubeai/blob/main/charts/kubeai |
| vLLM arguments | https://docs.vllm.ai/en/stable/serving/engine_args.html        |
| Endpoint       | `https://kubeai.<domain>/`                                     |
|                | `https://kubeai.<domain>/openai/v1/models`                     |
|                | `https://kubeai.<domain>/openai/v1/audio/transcriptions`       |

KubeAI provides OpenAI-compatible API to Ollama, llama.cpp, and vLLM. It allows autoscalling and more control over the models and inference engines.

It's generally more useful for dedicated GPU clusters or when using an agent deployed with cloud providers. It is included here for experiments as it supports vLLM engine as an alternative to Ollama. It's faster but also uses more VRAM.

Models run continuously (`minReplicas: 1`). Longhorn volumes are not used; per-node models live on the host path in `kubeai:modelStoragePath`.

Make sure nothing else is loaded into GPU memory (`nvidia-smi`), otherwise the model pods will likely fail to start.

llama.cpp and vLLM models are downloaded from HuggingFace. You need to create a free account and access token with permission to `Read access to contents of all public gated repos you can access` at https://huggingface.co/settings/tokens. Ollama models are pulled from the Ollama registry instead.

```sh
pulumi config set kubeai:enabled true
pulumi config set --secret kubeai:huggingfaceToken <hf_token>
pulumi up
```

## Models

Declare each model host first. Every node gets its own host-path volume, and its GPU environment is applied to the models on it:

```sh
pulumi config set --path 'kubeai:modelNodes.<node>.storageSize' 50Gi
pulumi config set --path 'kubeai:modelNodes.<node>.env.HSA_OVERRIDE_GFX_VERSION' '11.0.0'
pulumi config set --path 'kubeai:modelNodes.<node>.env.HCC_AMDGPU_TARGETS' gfx1103
```

Then define the models. Ollama models are pulled into the node's volume before the model starts; llama.cpp and vLLM models download from `url` instead:

```sh
pulumi config set --path 'kubeai:modelDefinitions.<model>.node' <node>
pulumi config set --path 'kubeai:modelDefinitions.<model>.engine' OLlama
pulumi config set --path 'kubeai:modelDefinitions.<model>.source' '<ollama-model>'
```

`engine` defaults to `OLlama`; use `LlamaCpp` or `VLLM` with `url`. A `modelDefinitions` entry requires a matching `kubeai:modelNodes` entry.

## Images

The Ollama model server and loader use `kubeai:ollama/image`, which defaults to `ollama/ollama:0.40.12-rocm`. LlamaCpp and vLLM use the KubeAI chart images by default. Override an engine when a newer or different build is needed:

```sh
pulumi config set kubeai:ollama/image ollama/ollama:<version>-rocm
pulumi config set kubeai:llamacpp/image ghcr.io/ggml-org/llama.cpp:<tag>
pulumi config set kubeai:vllm/image <image>
```

Overrides apply to the `amd-gpu` image selected by the per-node profiles. On GPUs where the chart's ROCm llama.cpp build does not work, use a Vulkan build such as `ghcr.io/ggml-org/llama.cpp:server-vulkan-b10680`.

## Upgrade from the catalog

`kubeai:models` and the upstream catalog chart were removed. A deploy fails if `kubeai:models` is still set:

```sh
pulumi config rm kubeai:models
```

Move catalog entries to `kubeai:modelDefinitions`, with their hosts under `kubeai:modelNodes`. The definition schema currently supports text generation; embeddings, reranking, speech-to-text, and per-model engine `env`/`args` are not available.

## Monitoring

Prometheus monitoring and related Grafana dashboard for vLLM can be enabled with:

```sh
pulumi config set prometheus:enabled true
pulumi config set prometheus:enableComponentMonitoring true
```

Note that Prometheus has to be installed first before changing that switch.
