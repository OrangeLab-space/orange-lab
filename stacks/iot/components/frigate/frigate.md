# Frigate

|               |                                                                       |
| ------------- | --------------------------------------------------------------------- |
| Homepage      | https://frigate.video/                                                |
| Source code   | https://github.com/blakeblackshear/frigate                            |
| Documentation | https://docs.frigate.video/                                           |
| Configuration | https://docs.frigate.video/configuration/                             |
| Docker Image  | https://github.com/blakeblackshear/frigate/pkgs/container/frigate     |
| Endpoints     | `https://frigate.<domain>/`                                           |

Frigate is a local NVR that performs realtime AI object detection on IP camera
streams. Detection runs on a CPU by default, or on a Google Coral USB accelerator,
NVIDIA/AMD GPU, or Intel GPU when configured. Events are published through
[Mosquitto](../mosquitto/mosquitto.md) and can be consumed by
[Home Assistant](../home-assistant/home-assistant.md).

## Installation

```sh
cd stacks/iot

# MQTT broker (recommended, required for the Home Assistant integration)
pulumi config set mosquitto:enabled true
pulumi config set --secret mosquitto:password "$(openssl rand -base64 24)"

# Frigate with a USB Coral accelerator
pulumi config set frigate:enabled true
pulumi config set frigate:coral true

# Run on the node with the Coral (and the recordings disk, if used)
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
            "roles": ["record"]
          },
          {
            "path": "rtsp://viewer:cam-password@10.0.10.10:554/sub",
            "roles": ["detect"]
          }
        ]
      },
      "detect": { "fps": 5 }
    }
  },
  "record": { "enabled": true }
}
EOF

pulumi config set --secret frigate:config "$(cat frigate.json)"
```

`detect.width`/`height` are optional — omit them and Frigate auto-detects the
stream resolution. Point `detect` at a low-resolution sub stream and `record` at
the main stream when the camera offers both.

The `detectors`, `mqtt` and `tls` sections are generated automatically from
`frigate:coral`, `frigate:gpu` and the enabled Mosquitto broker — set them
explicitly in `frigate:config` to override the defaults. `tls` is disabled
because the routing provider terminates TLS. When no cameras are configured, a
disabled placeholder camera is used so Frigate starts normally. The config file
is managed by Pulumi and read-only in the container; edit it here rather than in
the Frigate UI (Frigate logs a harmless "Config file is read-only" error).

## Detectors and hardware acceleration

- **USB Coral (recommended)** — `frigate:coral true` mounts `/dev/bus/usb` and
  configures the `edgetpu` detector. Pin the pod to the node with the device.
- **NVIDIA / AMD GPU** — set `frigate:gpu nvidia` or `frigate:gpu amd` and point
  `frigate:image` at the matching image tag (`-tensorrt` / `-rocm`).
- **CPU** — the fallback when no accelerator is configured; expect higher CPU
  usage per camera.

For hardware-accelerated video decoding, mount the render device and set
`ffmpeg.hwaccel_args` in `frigate:config`:

```sh
pulumi config set --path 'frigate:devices[0].name' dri
pulumi config set --path 'frigate:devices[0].device' /dev/dri
```

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

## Manual and debugging

`frigate:config` is rendered into `/config/config.yml` and stored as the
Kubernetes Secret `frigate-config-yml`. Inspect what was generated and deployed:

```sh
kubectl get secret frigate-config-yml -n frigate -o jsonpath='{.data.config\.yml}' | base64 -d
kubectl exec -n frigate deploy/frigate -- cat /config/config.yml
kubectl logs -n frigate deploy/frigate -f
```

If a config section is invalid, Frigate starts in safe mode and logs the
validation error — fix `frigate:config` and `pulumi up` again. The
`Config file is read-only, unable to migrate config file` error is expected and
harmless (the file is managed by Pulumi).

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
