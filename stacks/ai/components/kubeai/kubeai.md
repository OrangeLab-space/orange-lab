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

Declare each model host first. Every node needs its GPU type; it selects the node's resource profile and GPU resource. Each node also gets its own host-path volume, and its GPU environment is applied to the models on it:

```sh
pulumi config set --path 'kubeai:modelNodes.<node>.gpu' amd   # or nvidia
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

`minReplicas` defaults to 1. Set it to 0 to scale the model to zero when idle,
releasing its GPU; the next request waits for the model to load again.

```sh
pulumi config set --path 'kubeai:modelDefinitions.<model>.minReplicas' 0
```

## Scheduling

Model pods are pinned to their model node by hostname. On a tainted node, set
`kubeai:tolerations`; it is applied to the KubeAI controller, the model loader
Jobs and every model server profile:

```sh
pulumi config set kubeai:tolerations 'orangelab/dedicated=nvidia:NoSchedule'
```

The loader Job runs on the model node to pull models into the host-path volume,
so it needs the same toleration as the model server.

## Images

Model server images are configured per engine and GPU under `kubeai:images`. The default is:

```yaml
kubeai:images:
    ollama:
        amd: ollama/ollama:0.40.12-rocm
        nvidia: ollama/ollama:0.40.12
```

Overrides replace the whole map, so copy the default entries and add your own:

```sh
pulumi config set --path 'kubeai:images.ollama.amd' ollama/ollama:<version>-rocm
pulumi config set --path 'kubeai:images.ollama.nvidia' ollama/ollama:<version>
pulumi config set --path 'kubeai:images.llamacpp.amd' ghcr.io/ggml-org/llama.cpp:<tag>
pulumi config set --path 'kubeai:images.vllm.amd' <image>
```

The keys map to the chart's `modelServers.<engine>.images.<gpu>-gpu`; engines or GPUs not set use the chart defaults (for example, LlamaCpp and vLLM use CUDA images on NVIDIA). The Ollama loader uses `kubeai:images.ollama.<gpu>`, so keep both Ollama entries when overriding if you run Ollama models on both GPU types. On GPUs where the chart's ROCm llama.cpp build does not work, use a Vulkan build such as `ghcr.io/ggml-org/llama.cpp:server-vulkan-b10680`.

## Upgrade from the catalog

`kubeai:models` and the upstream catalog chart were removed. A deploy fails if `kubeai:models` is still set:

```sh
pulumi config rm kubeai:models
```

Move catalog entries to `kubeai:modelDefinitions`, with their hosts under `kubeai:modelNodes`. The definition schema currently supports text generation; embeddings, reranking, speech-to-text, and per-model engine `env`/`args` are not available.

The per-engine image keys were replaced by `kubeai:images.<engine>.<gpu>`. A deploy fails if an old key is still set; remove each one that is configured:

```sh
pulumi config rm kubeai:ollama/image
pulumi config rm kubeai:llamacpp/image
pulumi config rm kubeai:vllm/image
```

## Monitoring

Prometheus monitoring and related Grafana dashboard for vLLM can be enabled with:

```sh
pulumi config set prometheus:enabled true
pulumi config set prometheus:enableComponentMonitoring true
```

Note that Prometheus has to be installed first before changing that switch.
