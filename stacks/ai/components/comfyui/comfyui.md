# ComfyUI

|               |                                             |
| ------------- | ------------------------------------------- |
| Homepage      | https://www.comfy.org/                      |
| Source code   | https://github.com/comfyanonymous/ComfyUI   |
| Documentation | https://docs.comfy.org/                     |
| Docker image  | https://hub.docker.com/r/yanwk/comfyui-boot |
| Dockerfile    | https://github.com/YanWenKun/ComfyUI-Docker |
| Endpoints     | `https://comfyui.<domain>/`                 |

Engine for image and video generation. It runs recent models (Flux,
Qwen-Image, Z-Image) and is Open WebUI's image generation backend.

```sh
pulumi config set comfyui:enabled true
pulumi config set comfyui:requiredNodeLabel kubernetes.io/hostname=<gpu-node>
pulumi up
```

The first start downloads Flux.2 Klein 4B (~16 GB) so image generation works
immediately; later starts reuse the files. [Open WebUI](../open-webui/open-webui.md)
connects to ComfyUI automatically when both are enabled.

## GPU images

| `comfyui:gpu` | Image                              |
| ------------- | ---------------------------------- |
| `nvidia`      | `yanwk/comfyui-boot:cu130-slim-v2` |
| `amd`         | `yanwk/comfyui-boot:rocm`          |
| `intel`       | `yanwk/comfyui-boot:xpu`           |
| `''` (CPU)    | `yanwk/comfyui-boot:cpu`           |

`cu130-slim-v2` needs a recent NVIDIA driver; use `cu126-slim` for older ones.
For AMD, `rocm` is ROCm 7.2 and covers RDNA 2 and newer, including gfx1150 and
gfx1151 integrated GPUs. Override the chipset when ROCm does not detect it:

```sh
pulumi config set comfyui:gpu amd
pulumi config set comfyui:HSA_OVERRIDE_GFX_VERSION 11.5.0
```

## Storage

Models, custom nodes, generated images and user settings live under `/data`,
backed by the node-local directory `comfyui:storagePath` (default
`/srv/comfyui-models`).

The cache is node-local, so `comfyui:requiredNodeLabel` must select the node
that should host it (required before enabling):

```sh
pulumi config set comfyui:requiredNodeLabel kubernetes.io/hostname=<gpu-node>
```

Moving ComfyUI to another node starts with an empty cache and downloads the
model files again.

## CLI args

`comfyui:cliArgs` is passed to ComfyUI for every model. The value starts with
`-`, so it needs `--` before the key:

```sh
pulumi config set -- comfyui:cliArgs --lowvram
```

`--fp8_e4m3fn-unet` is only needed for Flux.1 on a GPU with ~32 GB of VRAM.
Leaving it set slows the other models (Z-Image by ~17 s), so remove it when
switching back.

## Models

A model file (JSON) describes everything for one model: the files to download,
the model name Open WebUI passes in, the node mapping and the ComfyUI API
workflow. Bundled examples live in `components/comfyui/models/`:

| File                            | Model                                     | Steps |
| ------------------------------- | ----------------------------------------- | ----- |
| `flux2-klein-4b.json` (default) | `flux-2-klein-4b.safetensors`             | 4     |
| `z-image-turbo.json`            | `z_image_turbo_int8_convrot.safetensors`  | 8     |
| `qwen-image-2.1.json`           | `qwen_image_2.1_int8_convrot.safetensors` | 25    |
| `flux1-dev.json`                | `flux1-dev-fp8.safetensors`               | 20    |

`comfyui:modelFile` points at one of them. Its files are downloaded on first
start into the node-local cache; files that already exist are skipped.

### Speed

Measured at 1024x1024 on an AMD Radeon 890M integrated GPU (~31 GB shared VRAM)
with `comfyui:cliArgs` unset. "Cold" is the first run after ComfyUI loaded the
model, "warm" the next one:

| Model           | Steps | Cold | Warm |
| --------------- | ----- | ---- | ---- |
| Flux.2 Klein 4B | 4     | 48s  | 30s  |
| Z-Image Turbo   | 8     | 56s  | 42s  |
| Qwen-Image 2.1  | 25    | 188s | 158s |
| Flux.1 dev fp8  | 20    | 288s | 272s |

The Flux.1 numbers use `comfyui:cliArgs: --fp8_e4m3fn-unet`; without it the
checkpoint needs more VRAM than the GPU has.

### Model file format

```json
{
    "model": "flux-2-klein-4b.safetensors",
    "files": [
        {
            "url": "https://...",
            "path": "models/diffusion_models/flux-2-klein-4b.safetensors"
        }
    ],
    "nodes": [
        { "type": "model", "node_ids": ["1"], "key": "unet_name" },
        { "type": "prompt", "node_ids": ["4"] },
        { "type": "seed", "node_ids": ["7"], "key": "noise_seed" }
    ],
    "workflow": { "1": { "class_type": "UNETLoader", "inputs": {} } }
}
```

`files` is optional. `model` and `nodes` are what Open WebUI fills the graph
with; `workflow` is the API-format graph itself. Relative paths resolve from
`stacks/ai`, so a file outside the repo works too.

### Switching models

Replace the model file; models already in `/srv/comfyui-models` are not
downloaded again:

```sh
pulumi config set comfyui:modelFile components/comfyui/models/z-image-turbo.json
```

Set it to `''` to leave the workflow and model to Open WebUI's admin UI. That
needs persistent config, otherwise the stack's environment values replace the
UI settings on restart:

```sh
pulumi config set open-webui:ENABLE_PERSISTENT_CONFIG true
```

### Adding a model

1. Open the model's template in ComfyUI's workflow browser, adapt it and export
   it with **Workflow → Export (API)**.
2. Save a JSON file with `model`, `files`, `nodes` and `workflow` (format
   above). Templates come from ComfyUI's workflow browser and
   [Comfy-Org/workflow_templates](https://github.com/Comfy-Org/workflow_templates).
3. Point the config at it — no OrangeLab file needs editing:

    ```sh
    pulumi config set comfyui:modelFile /home/me/workflows/my-model.json
    ```

Models can also be installed directly in ComfyUI via **Manager → Model Manager
→ Install via URL**, or copied with
`kubectl -n comfyui cp <file> deploy/comfyui:/data/models/<type>/`. Those are
usable in ComfyUI immediately but are not wired into Open WebUI without a model
file that references them.

### Model examples

- **Qwen-Image 2.1** (int8, ~17 GB) from `Comfy-Org/Qwen-Image-2.1`:
  `diffusion_models/qwen_image_2.1_int8_convrot.safetensors`,
  `text_encoders/qwen3vl_8b_int8_convrot.safetensors`,
  `vae/qwen_image_2.1_vae_bf16.safetensors`.
- **Flux.2 Klein 4B** (default, ~16 GB) from `Comfy-Org/Flux-2-Klein-4B`:
  `split_files/diffusion_models/flux-2-klein-4b.safetensors`,
  `split_files/text_encoders/qwen_3_4b.safetensors`,
  `split_files/vae/flux2-vae.safetensors`. Four steps at cfg 1.
- **Flux.1 dev** (fp8, ~17 GB) from `Comfy-Org/Flux-1-Dev`:
  `flux1-dev-fp8.safetensors`, an all-in-one checkpoint that loads with
  **Load Checkpoint**. Needs `cliArgs: --fp8_e4m3fn-unet` on 32 GB GPUs; 20 steps
  take minutes on integrated graphics.
- **Z-Image Turbo** (int8, ~15 GB) from `Comfy-Org/Z-Image-Turbo`:
  `split_files/diffusion_models/z_image_turbo_int8_convrot.safetensors`,
  `split_files/text_encoders/qwen_3_4b.safetensors`,
  `split_files/vae/ae.safetensors`. Eight steps at cfg 1.

Keep the folder name from each path below `models/`; ComfyUI scans those folders
on start.

## Open WebUI

When Open WebUI is enabled, ComfyUI takes precedence over SD.Next for chat
image generation. Open WebUI runs the model file selected
with `comfyui:modelFile` (`components/comfyui/models/flux2-klein-4b.json` by
default), at 1024x1024, 4 steps and cfg 1.

Other models need their own model file, set with `comfyui:modelFile`. See
[Open WebUI](../open-webui/open-webui.md#image-generation).

## Authentication

ComfyUI has no login. It is reachable only on the tailnet, treat its URL as admin access to the models and outputs.
