# Matter Server

|              |                                                                             |
| ------------ | --------------------------------------------------------------------------- |
| Source code  | https://github.com/matter-js/matterjs-server                                |
| Docker Image | https://github.com/matter-js/matterjs-server/pkgs/container/matterjs-server |
| WebSocket    | `ws://matter.matter:5580/ws`                                                |
| Dashboard    | `https://matter.<domain>`                                                   |

The Matter controller server for Home Assistant's Matter integration, built on
matter.js. It is a separate service — Home Assistant (container install in
Kubernetes) cannot run it internally, so the Matter integration URL must point
here.

## Installation

```sh
pulumi config set matter:enabled true
# (Optional) Host Bluetooth adapter index for BLE commissioning, -1 disables it
pulumi config set matter:bluetoothAdapter 0
# (Optional) Pin the interface Matter announces on (recommended with multiple NICs)
pulumi config set matter:primaryInterface <lan-interface>
# Must run on the same node as the border router and the Bluetooth adapter
pulumi config set matter:requiredNodeLabel "kubernetes.io/hostname=<node>"
pulumi up
```

Runs on the host network for Matter commissioning (mDNS discovery, IPv6).

## Wiring to Home Assistant

Configure Home Assistant's Matter integration with the WebSocket URL:

```sh
# From stacks/iot
pulumi stack output endpoints --json | jq -r '.matterWebsocket'
# ws://matter.matter:5580/ws
```

Thread commissioning goes through the OTBR component — the Matter server and
OTBR should be scheduled on the same node so the Matter server's mDNS discovery
and OTBR's announcements overlap.

## Commissioning without a phone or Google

The server exposes a web dashboard at `https://matter.<domain>` that commissions
a device over Bluetooth directly, without the Companion app or any Google
services. The dashboard runs in production mode, so it connects to the server
automatically:

1. Open the dashboard and sign in with Pocket ID.
2. Select **Commission** and enter the device's Matter setup code — the `MT:...`
   string from the QR label, or the 11-digit manual code.
3. Keep the device near the node running this server while it is commissioned
   (Bluetooth range); the server uses the host adapter `matter:bluetoothAdapter`.
4. For a Thread device the controller must know the Thread dataset first. Home
   Assistant sets it through the Matter integration, or the OTBR component's
   active dataset can be supplied in the dashboard.

The device appears under **Nodes** once commissioned.

## Pocket ID Launcher

The Matter dashboard has no built-in authentication, but it can appear in Pocket
ID's App Dashboard as a launcher icon:

```sh
# From stacks/iot
MATTER_URL=$(pulumi stack output --json | jq -er '.endpoints.matterDashboard')

../../scripts/pocket-client.sh \
  --app-name matter \
  --client-name "Matter Server" \
  --launch-url "$MATTER_URL" \
  --callback-url "$MATTER_URL/" \
  --dark-icon-url https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/matter.svg \
  --light-icon-url https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/matter-light.svg
```

Do not apply the `matter:auth` commands printed by the script; Matter uses the
client only as a Pocket ID launcher.

> [!WARNING]
> The Matter dashboard is not protected by Pocket ID - anyone who can reach its
> URL can manage devices.
