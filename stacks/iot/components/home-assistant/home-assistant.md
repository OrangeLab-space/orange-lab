# Home Assistant

|            |                                                               |
| ---------- | ------------------------------------------------------------- |
| Homepage   | https://www.home-assistant.io/                                |
| Helm chart | https://artifacthub.io/packages/helm/helm-hass/home-assistant |
| Endpoints  | `https://home-assistant.<domain>/`                            |

Using zone is optional, but helps with making sure the application is deployed on same network as the sensors.

## Installation

```sh
kubectl label nodes <node-name> topology.kubernetes.io/zone=home

pulumi config set home-assistant:enabled true

pulumi config set home-assistant:requiredNodeLabel "topology.kubernetes.io/zone=home"

pulumi up
```

## Pocket ID Launcher

Home Assistant does not support Pocket ID as a native OIDC login provider, but it
can appear in Pocket ID's App Dashboard as a launcher available to every Pocket
ID user:

```sh
cd stacks/iot
./components/home-assistant/pocket-home-assistant.sh
```

Do not apply the `home-assistant:auth` commands printed by the script; Home
Assistant uses the client only as a Pocket ID launcher and does not support
Pocket ID OIDC login.

The ZBT-2 Thread radio is owned by the separate [OpenThread Border
Router](../openthread/openthread.md) component. Home Assistant connects to its
REST API and does not mount or access the radio directly.

## Device access

Home Assistant can access host devices such as USB or serial adapters (for
example a Zigbee/Z-Wave stick or a USB Bluetooth dongle). Give each device a
unique volume name and its path on the node:

```sh
pulumi config set home-assistant:devices '[{"name":"usb-device","device":"/dev/ttyACM0"}]'
```

The device must exist at the configured path on the node where Home Assistant is
scheduled, so pin it with `home-assistant:requiredNodeLabel`. Device mounts
automatically enable privileged mode for the container, as required by the Home
Assistant Helm chart. Only configure the device paths Home Assistant needs.

## Integrations (OpenThread Matter)

Configure the OpenThread Border Router and Matter integrations with:

| Integration                | URL |
| -------------------------- | --- |
| OpenThread Border Router   | `http://openthread.openthread:8081` |
| Matter                     | `ws://matter.matter:5580/ws`        |
