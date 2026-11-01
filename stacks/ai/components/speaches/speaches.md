# Speaches

|               |                                                                     |
| ------------- | ------------------------------------------------------------------- |
| Homepage      | https://speaches.ai/                                                |
| Source code   | https://github.com/speaches-ai/speaches                             |
| Documentation | https://speaches.ai/                                                |
| Configuration | https://speaches.ai/configuration/                                  |
| Docker Image  | https://github.com/speaches-ai/speaches/pkgs/container/speaches     |
| API           | OpenAI-compatible `/v1/audio/transcriptions` and `/v1/audio/speech` |
| Endpoint      | `http://speaches.speaches:8000/v1` (cluster only)                   |

Local speech-to-text and text-to-speech behind an OpenAI-compatible API. Models are downloaded once and cached on the node. Open WebUI uses this service for voice input and spoken responses.

## Installation

```sh
cd stacks/ai
pulumi config set speaches:enabled true
pulumi config set speaches:requiredNodeLabel kubernetes.io/hostname=<host>
pulumi up
```

Open WebUI is connected automatically when both components are enabled. Voice input and playback no longer depend on the Open WebUI image.

## Models

The defaults are:

| Setting             | Default                            |
| ------------------- | ---------------------------------- |
| `speaches:sttModel` | `Systran/faster-whisper-base`      |
| `speaches:ttsModel` | `speaches-ai/Kokoro-82M-v1.0-ONNX` |
| `speaches:ttsVoice` | `af_heart`                         |

Both models are preloaded on startup. The model cache lives at `speaches:storagePath` (default `/srv/speaches-cache`) on the node where Speaches runs and survives pod restarts.

The cache is node-local, so `speaches:requiredNodeLabel` must select the node that should host it. Moving Speaches to another node starts with an empty cache and downloads the models again.

List the available voices from the cluster:

```sh
kubectl exec deploy/speaches -- curl -s http://localhost:8000/v1/audio/voices
```

## Hardware

The CPU image is `speaches:image`. For an NVIDIA GPU, Speaches provides a CUDA image under `speaches:nvidia/image`, selected automatically when `speaches:gpu` is `nvidia`:

```sh
pulumi config set speaches:gpu nvidia
pulumi config set speaches:requiredNodeLabel kubernetes.io/hostname=<gpu-node>
```

Speaches does not support AMD ROCm. On an AMD node it can only run on CPU, so use the default CPU image and do not set `speaches:gpu`.

Models stay loaded while the pod is running. STT is fast on CPU. TTS is CPU-heavy and its latency varies much more between nodes; an NVIDIA GPU speeds up STT most, while TTS gains little end-to-end because text processing dominates the request.

## Reuse from other apps

Any client that supports an OpenAI STT or TTS base URL can use the service:

- STT: `http://speaches.speaches:8000/v1/audio/transcriptions`
- TTS: `http://speaches.speaches:8000/v1/audio/speech`
- Voices: `http://speaches.speaches:8000/v1/audio/voices`

Use any non-empty API key. The service is cluster-only and is not routed through Agentgateway, which remains the LLM gateway. Other stacks can read the AI stack's outputs: `apps.speaches` (`apiUrl`, `sttModel`, `ttsModel`, `ttsVoice`), or the cluster endpoints `endpoints.cluster.speaches` (API base), `speaches-stt`, `speaches-tts`, and `speaches-voices`.

## Voice selection in Open WebUI

Open WebUI reads the voice list from Speaches. The default `af_heart` is a Kokoro voice; each user can choose another voice in **Settings → Audio**. The server-side engine is already configured, so leave the personal TTS engine set to **Default**.
