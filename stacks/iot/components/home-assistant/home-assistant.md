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

## OpenID Connect (Pocket ID)

OIDC is optional; the core stack must have Pocket ID enabled and deployed first.

```sh
cd stacks/iot

# Point at the core stack if not already configured
pulumi config set orangelab:coreStackRef example-org/orangelab/lab

# Create a public (PKCE) client and print the client config (no client secret)
./components/home-assistant/pocket-home-assistant.sh

# Apply the printed commands, then deploy
pulumi config set home-assistant:auth pocket
pulumi config set home-assistant:auth/clientId <client-id>

# Optional: Pocket ID group that gets the Home Assistant admin role (default: admin)
# pulumi config set home-assistant:auth/adminGroup admin

pulumi up
```

Install the [OpenID Connect/SSO Authentication](https://github.com/christiaangoossens/hass-oidc-auth)
integration from a local mirror instead of GitHub:

```sh
# The mirror must serve the release asset at /releases/download/<version>/hass-oidc-auth.zip
pulumi config set home-assistant:oidcRepo https://forgejo.<domain>/<owner>/hass-oidc-auth
pulumi config set home-assistant:oidcVersion v1.2.1
pulumi up
```

A Forgejo pull mirror copies git (branches/tags) only, not releases. To host the asset,
migrate the repo once with **Releases** checked (migration and continuous mirroring are
mutually exclusive), or attach the zip to a release manually.

- Installed to `/config/custom_components/auth_oidc`, configured as `auth_oidc` in `configuration.yaml`, and refetched only when `home-assistant:oidcVersion` changes.
- SSO appears on the login screen; local username/password stays as a backup.
- Logins link to existing users by username; new identities get the normal user role. Linked logins bypass MFA.
- Restrict sign-in with the OIDC client's group restriction in Pocket ID (**Settings -> OIDC Clients -> Home Assistant**).
- Remove any UI-configured integration first - only the YAML setup is supported.

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

The ZBT-2 Thread radio is owned by the separate [OpenThread Border
Router](../openthread/openthread.md) component. Home Assistant connects to its
REST API and does not mount or access the radio directly.

Configure the OpenThread Border Router and Matter integrations with:

| Integration                | URL |
| -------------------------- | --- |
| OpenThread Border Router   | `http://openthread.openthread:8081` |
| Matter                     | `ws://matter.matter:5580/ws`        |
