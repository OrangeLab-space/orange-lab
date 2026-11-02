# InvokeAI

|                       |                                                     |
| --------------------- | --------------------------------------------------- |
| Homepage              | https://invoke-ai.github.io/InvokeAI/               |
| Source code           | https://github.com/invoke-ai/InvokeAI               |
| Environment variables | https://invoke-ai.github.io/InvokeAI/configuration/ |
| Tutorials             | https://www.youtube.com/@invokeai                   |
| Endpoints             | `https://invokeai.<domain>/`                        |

Generative AI platform with a clean user interface.

Note: The community edition does not support user authentication so the images you create will be visible to everyone on your Tailnet.

Note: Unlike _ComfyUI_, it doesn't integrate with Open WebUI.

```sh
pulumi config set invokeai:enabled true

# (Optional) set token to access gated models
pulumi config set invokeai:huggingfaceToken <TOKEN> --secret
pulumi up
```

On an AMD node, set `invokeai:gpu amd`. The ROCm image
`ghcr.io/invoke-ai/invokeai:main-rocm` is selected from `invokeai:amd/image`
automatically; `invokeai:image` is the CUDA/CPU image.

## Pocket ID Launcher

InvokeAI community edition does not support user authentication or OIDC, but it
can appear in Pocket ID's App Dashboard as an unrestricted launcher:

```sh
cd stacks/ai
./components/invokeai/pocket-invokeai.sh
```

Do not apply the `invokeai:auth` commands printed by the script; InvokeAI uses
the client only as a Pocket ID launcher.
