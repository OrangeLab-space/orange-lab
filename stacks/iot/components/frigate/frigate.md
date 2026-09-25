# Frigate

|               |                                                                   |
| ------------- | ----------------------------------------------------------------- |
| Homepage      | https://frigate.video/                                            |
| Source code   | https://github.com/blakeblackshear/frigate                        |
| Documentation | https://docs.frigate.video/                                       |
| Configuration | https://docs.frigate.video/configuration/                         |
| Docker Image  | https://github.com/blakeblackshear/frigate/pkgs/container/frigate |
| Endpoints     | `https://frigate.<domain>/`                                       |

Frigate is a local NVR that performs realtime AI object detection on IP camera
streams. Detection runs on a CPU by default, or on a Google Coral USB accelerator
or NVIDIA/AMD GPU when configured. Events are published through
[Mosquitto](../mosquitto/mosquitto.md) and can be consumed by
[Home Assistant](../home-assistant/home-assistant.md).

## Installation

```sh
cd stacks/iot

# MQTT broker (recommended, required for the Home Assistant integration)
pulumi config set mosquitto:enabled true
pulumi config set --secret mosquitto:password "$(openssl rand -base64 24)"

# Frigate with AMD GPU
pulumi config set frigate:enabled true
pulumi config set frigate:gpu amd

# Run on the node with the Coral
pulumi config set frigate:requiredNodeLabel "kubernetes.io/hostname=<node>"

pulumi up
```

## Configuration

The Frigate configuration is a JSON object in `frigate:config`. It is stored as a
Kubernetes Secret and mounted as `/config/config.yml`, so each camera's
credentials go directly in its own RTSP URL. Set it as a secret:

```sh
cat > frigate.json <<'EOF'
{
  "cameras": {
    "front_door": {
      "ffmpeg": {
        "inputs": [
          {
            "path": "rtsp://viewer:cam-password@10.0.10.10:554/main",
            "roles": ["record","audio"]
          },
          {
            "path": "rtsp://viewer:cam-password@10.0.10.10:554/sub",
            "roles": ["detect"]
          }
        ]
      },
    }
  },
  "record": { "enabled": true }
}
EOF

pulumi config set --secret frigate:config "$(cat frigate.json)"
```

Point `detect` at a low-resolution sub stream and `record` at
the main stream when the camera offers both.

The `detectors`, `mqtt` and `tls` sections are generated automatically from
`frigate:coral`, `frigate:gpu` and the enabled Mosquitto broker — set them
explicitly in `frigate:config` to override the defaults. `tls` is disabled
because the routing provider terminates TLS. When no cameras are configured, a
disabled placeholder camera is used so Frigate starts normally.

## Detectors and hardware acceleration

- **USB Coral** — `frigate:coral true` mounts the Coral and configures the `edgetpu` detector.
- **NVIDIA GPU** — `frigate:gpu nvidia` selects the `-tensorrt` image, GPU device access, and a node labelled `orangelab/gpu-nvidia`.
- **AMD GPU** — `frigate:gpu amd` selects the `-rocm` image, GPU device access, and a node labelled `orangelab/gpu-amd`.
- **CPU** — fallback when no accelerator is configured.

With `frigate:gpu` set the image tag is managed for you (`-tensorrt` / `-rocm` appended); to control the tag yourself, leave `frigate:gpu` unset and set the full tag in `frigate:image`.

Object detection is configured in the Frigate UI (**Settings → System → Detectors and model**): add an **ONNX** detector (device `AUTO`) and, on the **Custom Model** tab, use path `/config/model_cache/yolo.onnx`, label map `/labelmap/coco-80.txt`, `320x320`, `rgb` / `nchw` / `float`, model type `yolo-generic`. Export the model first (see the [Frigate guide](https://docs.frigate.video/configuration/object_detectors/#onnx)) and put it in `/config/model_cache/` — Frigate loads local ONNX files only; on `-rocm` it is converted to MIGraphX on first start.

An Intel iGPU is not covered by `frigate:gpu`; pass its render device through for
hardware-accelerated decoding (e.g. Coral for detection plus iGPU decode):

```sh
pulumi config set --path 'frigate:devices[0].name' dri
pulumi config set --path 'frigate:devices[0].device' /dev/dri
```

With `frigate:gpu amd` `/dev/dri` is already mounted.

### AMD (ROCm)

`frigate:gpu amd` uses the `:stable-rocm` image and mounts `/dev/kfd` / `/dev/dri`. ROCm does not officially support integrated GPUs; if it fails to initialise, override the chipset, e.g. `pulumi config set frigate:HSA_OVERRIDE_GFX_VERSION 11.0.0`.

## Storage

Frigate's data directory (`/config`) defaults to a 1Gi Longhorn volume
(`frigate:storageSize`). Recordings default to a 50Gi Longhorn volume
(`frigate:media/storageSize`). For
continuous recording, a local disk avoids replication overhead — set
`frigate:media/hostPath` and pin the app to that node:

```sh
pulumi config set frigate:media/hostPath /mnt/media/frigate
pulumi config set frigate:requiredNodeLabel "kubernetes.io/hostname=<node>"
```

Shared memory (`frigate:shmSize`) and the cache (`frigate:cacheSize`) are
memory-backed. Increase `frigate:shmSize` when running many high-resolution
cameras.

## Applying config changes

`frigate:config` seeds `/config/config.yml` on first start. The `detectors`,
`mqtt`, `tls` and (with SSO) `auth`/`proxy` sections are generated by OrangeLab
and merged into that seed. After that **Frigate's UI owns the file** — adding
cameras and tuning settings under **Settings** persists them in the `/config`
volume, and Frigate preserves those generated sections when it saves.

Because the file is only seeded when missing or empty, later `frigate:config`
changes do not apply on their own. To overwrite the file from `frigate:config` (discarding
UI edits), enable the recreate flag for one deploy and turn it off again:

```sh
pulumi config set frigate:config/recreate true
pulumi up
pulumi config set frigate:config/recreate false
```

## Authentication

Frigate keeps its own user database and does not support OIDC/OAuth. On first
start with no users it creates an `admin` user and prints a **randomly generated
password** in the logs — there is no config option to set it:

```sh
kubectl logs -n frigate deploy/frigate | grep -i password
```

```text
frigate.app  INFO    : ***    User: admin                                   ***
frigate.app  INFO    : ***    Password: <random>                            ***
```

Log in at `https://frigate.<domain>/` (port `8971`) and change the password under
**Settings → Users**.

### Reset password

If you are locked out, temporarily add `auth.reset_admin_password: true` to your
`frigate:config`, deploy, and read the new password from the logs. This prints a
fresh random password and replaces the whole config value, so include your
existing cameras:

```sh
jq '.auth.reset_admin_password = true' frigate.json > frigate-reset.json
pulumi config set --secret frigate:config "$(cat frigate-reset.json)"
pulumi up
kubectl logs -n frigate deploy/frigate | grep -i password

# restore the original config without the reset flag
pulumi config set --secret frigate:config "$(cat frigate.json)"
pulumi up
```

### Single sign-on (Pocket ID)

Frigate has no native OIDC, but it can trust an upstream proxy. Setting
`frigate:auth pocket` disables Frigate's own login and protects the route with
[Pocket ID](../../../../components/security/pocket/pocket.md) through the shared
Traefik OIDC middleware. The middleware forwards the authenticated user and
groups (`X-Forwarded-User` / `X-Forwarded-Groups`), which Frigate maps to roles:

- each key of `frigate:auth/groupMap` is a Frigate role (`admin`, `viewer`, or a
  custom role);
- each value lists the Pocket ID groups that grant that role;
- authenticated users matching no group get `frigate:auth/defaultRole` (default
  `viewer`; must be `admin` or `viewer`).

`groupMap` defaults to `{admin: [admin]}`. Set the whole map to add a read-only
role for the `viewers` group:

```sh
pulumi config set frigate:auth/groupMap '{"admin":["admin"],"viewer":["viewers"]}'
```

Roles other than `admin`/`viewer` are custom read-only roles and must also be
defined in `frigate:config` under `auth.roles`, otherwise they grant no camera
access.

Create the OIDC client from the iot stack directory and apply the printed
commands:

```sh
cd stacks/iot
./components/frigate/pocket-frigate.sh

pulumi config set frigate:auth pocket
pulumi config set frigate:auth/clientId <client-id>
pulumi config set frigate:auth/clientSecret <secret> --secret
pulumi up
```

The shared Traefik/Frigate proxy secret is generated automatically (it is not
configurable). Read it for debugging with:

```sh
pulumi stack output apps --show-secrets --json | jq -r '.frigate.proxySecret'
```

While SSO is enabled, Frigate's own user database is ignored. Logging out is
handled by the middleware: Frigate's generated `proxy.logout_url` is `/logout`
(the Traefik OIDC middleware's logout route), which ends the Pocket ID session and
returns to Frigate instead of falling back to Frigate's built-in login. The
internal API on port `5000` stays unauthenticated, so the Home Assistant
integration and recordings are unaffected. If Pocket ID is unavailable, remove
`frigate:auth` and deploy to re-enable Frigate's own login:

```sh
pulumi config rm frigate:auth
pulumi up
```

## Manual and debugging

`frigate:config` is rendered into `/config/config.yml` and stored as the
Kubernetes Secret `frigate-config-yml`. Inspect what was generated and deployed:

```sh
kubectl get secret frigate-config-yml -n frigate -o jsonpath='{.data.config\.yml}' | base64 -d
kubectl exec -n frigate deploy/frigate -- cat /config/config.yml
kubectl logs -n frigate deploy/frigate -f
```

If a config section is invalid, Frigate starts in safe mode and logs the
validation error — fix it in the UI, or in `frigate:config` with
`frigate:config/recreate true`, then `pulumi up` again.

## Post-Installation

1. Open `https://frigate.<domain>/` and log in with the admin credentials (see
   [Authentication](#authentication)).
2. The [Frigate integration](https://docs.frigate.video/integrations/home-assistant/)
   is installed into Home Assistant automatically when this component is enabled
   (see [Frigate integration](../home-assistant/home-assistant.md#frigate-integration)).
   Add it under **Settings → Devices & Services → Add Integration → Frigate** with
   URL `http://frigate.frigate:5000`.
3. Add the **MQTT** integration using the [Mosquitto](../mosquitto/mosquitto.md)
   credentials to receive events and sensors.
