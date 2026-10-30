# Application Configuration

This document describes application configuration and common settings for OrangeLab.

## Deploying Applications

After system components have been deployed, you can add any of the optional applications.

All available settings can be found in `Pulumi.yaml` (or `stacks/*/Pulumi.yaml`). Override defaults with `pulumi config` or by directly modifying `Pulumi.<stack>.yaml`.

## Core Stack Reference

Module stacks use `orangelab:coreStackRef` to reference the deployed core
stack. The reference is a fully qualified Pulumi stack name in the form
`organization/project/stack` and allows applications to consume shared core
outputs, including the Pocket ID OIDC provider URL.

Configure it in each module stack before deploying applications that depend on
core outputs:

```sh
# From the core stack directory, print the fully-qualified stack name
cd /
pulumi stack ls -Q
# Pulumi Cloud: example-org/orangelab/lab
# local or RustFS: organization/orangelab/lab
# Ignore the trailing * that marks the current stack

cd stacks/<module>

# Use the value printed above
pulumi config set orangelab:coreStackRef <stack-ref>
```

The referenced core stack must be deployed first. For example, applications
using Pocket ID authentication need this reference before their first
`pulumi up`, together with their OIDC client configuration:

```sh
pulumi config set <app>:auth pocket
pulumi config set <app>:auth/clientId <client-id>
pulumi config set <app>:auth/clientSecret <client-secret> --secret
pulumi up
```

The reference is optional for applications that do not consume core stack
outputs.

```sh
# enable app
pulumi config set <app>:enabled true

# configure app-specific settings from Pulumi.yaml if needed
pulumi config set ollama:hostname ollama-api
pulumi config set ollama:storageSize 100Gi

# deploy
pulumi up
# or
pulumi up -r # --refresh Pulumi state if out of sync

# Show the app's external endpoint URL. Apps with `network/public: true` answer
# on the internet and live under `endpoints.public`; everything else is
# tailnet-only and lives under `endpoints.private`.
pulumi stack output --show-secrets --json | jq -r '.endpoints.private.<app>'
# Make request to provision HTTP certificate and activate endpoint
curl https://<app>.<domain>/
```

## Enable/Disable Applications

To remove an application, set the `enabled` flag to `false`. This will remove all resources associated with the app.

```sh
# Remove application including storage
pulumi config set <app>:enabled false
pulumi up
```

To keep storage around (for example downloaded Ollama models) but remove all other resources, use `storageOnly`:

```sh
# Remove application resources but keep related storage
pulumi config set <app>:enabled true
pulumi config set <app>:storageOnly true
# Optional: enable database in storageOnly mode if used by application
pulumi config set <app>:db/enabled true
pulumi up
```

## Common Configuration Settings

The following settings are supported by most applications in OrangeLab:

| Setting                      | Description                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| `enabled`                    | Enable or disable the application                                                            |
| `hostname`                   | Hostname for the HTTPS endpoint, used with Tailscale for access                              |
| `routingProvider`            | Override global routing provider (`tailscale` or `traefik`) for this application             |
| `network/public`             | Expose this application to the public internet (see [Public services](./public-services.md)) |
| `version`                    | Lock Helm chart version to a specific release (uses latest if not specified)                 |
| `storageOnly`                | Disable application but retain storage (useful for temporarily disabling while keeping data) |
| `storageSize`                | Expand default storage size if needed (e.g., for large models)                               |
| `fromVolume`                 | Attach existing Longhorn volume instead of creating new one                                  |
| `storageClass`               | Force specific storage class used by the application                                         |
| `preferredNodeLabel`         | Deploy to node with specified label if exists (soft constraint)                              |
| `requiredNodeLabel`          | Deploy only to node with specified label (hard constraint)                                   |
| `excludeNodeLabel`           | Do not deploy to nodes with specified label (hard constraint)                                |
| `requiredVolumeLabel`        | Pin volume to node(s) it may attach to. Immutable - requires app redeploy to change          |
| `storage/snapshotEnabled`    | Enable snapshots (defaults to `longhorn:snapshotEnabled`)                                    |
| `storage/snapshotCron`       | Snapshot schedule (defaults to `longhorn:snapshotCron`)                                      |
| `storage/snapshotRetain`     | Snapshot retention (defaults to `longhorn:snapshotRetain`)                                   |
| `storage/backupEnabled`      | Enable/disable backup participation (unset inherits `longhorn:backupAllVolumes`)             |
| `storage/backupCron`         | Backup schedule (defaults to `longhorn:backupCron`)                                          |
| `storage/backupRetain`       | Backup retention (defaults to `longhorn:backupRetain`)                                       |
| `storage/backupFullInterval` | Full-backup interval (defaults to `longhorn:backupFullInterval`)                             |
| `auth`                       | Enable OIDC authentication with the selected provider                                        |
| `auth/clientId`              | OIDC client ID                                                                               |
| `auth/clientSecret`          | OIDC client secret (not required by apps using a public/PKCE client)                         |
| `auth/providerUrl`           | Override the OIDC discovery URL                                                              |
| `auth/providerName`          | Name of the OIDC provider, used in the login button label                                    |
| `auth/groupMap`              | App role -> Pocket ID groups, for apps with native role mapping (object)                     |
| `auth/adminGroup`            | Pocket ID group granting the app's admin role (defaults to `<app>-admin`)                    |
| `auth/allowedGroups`         | Comma-separated Pocket ID groups allowed to sign in; unset keeps the client unrestricted     |

The `storage/*` keys can also be prefixed with a component/volume name, e.g.
`nextcloud:data/storage/backupEnabled`. Component values override app-level
values, which override the global `longhorn:*` defaults. `backupVolume` was
removed; use `storage/backupEnabled` instead.

### Custom Hostnames

Set a custom hostname for the HTTPS endpoint:

```sh
pulumi config set ollama:hostname ollama-api
```

The application will be available at `https://ollama-api.<domain>/`.

### Routing Provider Override

Override the global routing provider for specific applications. Useful for running admin tools on Tailscale while serving public applications via Traefik:

```sh
# Override global setting for specific app
pulumi config set prometheus:routingProvider tailscale
pulumi config set nextcloud:routingProvider traefik
```

When using `traefik`, ensure `orangelab:customDomain` is set in the current
stack or inherited from a deployed core stack via `orangelab:coreStackRef`.
When using `tailscale`, ensure `tailscale:tailnet` is set.

### Public exposure

Applications are private by default. To reach one from the public internet:

```sh
pulumi config set <app>:network/public true
pulumi up
```

Under **Traefik**, this adds a second route under the application's normal
`<app>.<domain>` name; under **Tailscale**, it enables
[Tailscale Funnel](../components/network/tailscale/tailscale.md#public-exposure-with-funnel)
on the existing `<app>.<tailnet>.ts.net` name. Turning it off removes the public
route; the private name is unaffected.

Public exposure is optional. The recommended setups require it only for
Headscale, Pocket ID and, with Tailscale + Pocket ID, Caddy's WebFinger endpoint.
TCP and UDP ports marked `public: true` are published at `<port> + 10000`. See
[Public services](./public-services.md) for both gateway methods, DNS, and port
forwarding.

See [Network module](../components/network/NETWORK.md) for choosing between
routing providers and mesh VPN control planes.

### Version Pinning

Lock a Helm chart to a specific version. Set to empty string to use the latest version instead of the pinned default:

```sh
# Use specific version (default from Pulumi.yaml)
pulumi config set longhorn:version 1.8.1

# Use latest chart version
pulumi config set longhorn:version ""
```

Some Helm charts support separate `appVersion` for upgrading the application before the chart is updated:

```sh
# Upgrade Open-WebUI before new Helm chart is published
pulumi config set open-webui:appVersion 0.6.1
```

### Node Placement

Control which nodes run specific applications:

```sh
# Soft constraint - prefer this node if available
pulumi config set ollama:preferredNodeLabel orangelab/ollama

# Hard constraint - only run on these nodes
pulumi config set prometheus:requiredNodeLabel orangelab/prometheus=true

# Hard exclusion - do not run on nodes with this label
pulumi config set nfd:excludeNodeLabel orangelab/alpine
```

### Volume Affinity

`requiredVolumeLabel` controls which nodes may **attach** the volume. It is a
Kubernetes node label, not a Longhorn storage tag. Use it only when the volume
must be mounted from specific nodes (e.g., a NAS available on the local
network); it does not affect where Longhorn stores replicas.

**Important:** Volume affinity is immutable - once set, the field cannot be changed without recreating the volume. This requires redeploying the application.

```sh
# Pin main app volume to node with NAS
pulumi config set <app>:requiredVolumeLabel kubernetes.io/hostname=nas

# Pin database volume specifically (does not affect app volume)
pulumi config set <app>:db/requiredVolumeLabel kubernetes.io/hostname=nas
```

### Volume Placement Tags

Replica placement is a property of the Longhorn volume, not of the Pulumi
config. For a static volume (`fromVolume`), the PV and `requiredVolumeLabel`
only decide where the volume may be attached; the data lives on the nodes and
disks chosen when the volume was created.

Select **Node Tag** and **Disk Tag** in the Longhorn UI when creating, cloning
or restoring a volume:

- **Clone Volume** copies the source volume's tags; adjust them before confirming.
- **Restore from backup** starts with both fields empty; set them explicitly.
- A tag must already exist on the node or disk (_Node → Edit Node and Disks_).

Example tag scheme:

| Tag                   | Use                                                                   |
| --------------------- | --------------------------------------------------------------------- |
| `bitcoin`, `jellyfin` | Dedicated volume/disk(s). No fallback only when one disk has the tag. |
| `hdd`                 | Spinning disks, bulk media                                            |
| `ssd`                 | Solid-state disks                                                     |
| `usb`                 | External/USB disks                                                    |

Node tags follow the same pattern; use one only when the disk tag is not
specific enough (e.g. the same kind of disk exists on several nodes).

Tags are ANDed: `["ssd", "fast"]` requires a disk carrying both. Prefer a
category tag (`hdd`, `ssd`, `usb`) unless the volume belongs on specific
disks; if only one disk carries the tag, there is no rebuild target when it
fails.

Changing tags on an existing volume applies to new replicas only, and moving
existing data needs a rebuild or clone. See
[Longhorn volume placement](../spec/longhorn.md#volume-placement-is-a-property-of-the-volume-not-the-pv).

### GPU

GPU node labeling is automatic with Node Feature Discovery (NFD) enabled.

Switch to ROCm image if needed:

```sh
pulumi config set ollama:gpu amd

# component only
pulumi config set immich:machine-learning/gpu nvidia
```

More details at [/components/hardware/amd-gpu-operator/amd-gpu-operator.md](/components/hardware/amd-gpu-operator/amd-gpu-operator.md)

When `<app>:gpu` is used then node affinity is set so deployment is placed on nodes with the selected GPU. Setting `requiredNodeLabel` overrides this behaviour.

#### GPU Device Selection

In multi-GPU setups, you can restrict an application to specific GPU devices:

```sh
# AMD - use only the first GPU
pulumi config set ollama:HIP_VISIBLE_DEVICES "0"
pulumi config set ollama:ROCR_VISIBLE_DEVICES "0"

# NVIDIA - use first two GPUs
pulumi config set ollama:CUDA_VISIBLE_DEVICES "0,1"
```

These use standard GPU runtime environment variables. See [Ollama environment variables](https://github.com/ollama/ollama/blob/main/envconfig/config.go) for more options.

### Storage

```sh
# Removes all resources (incl. storage) when false
pulumi config set ollama:enabled false
pulumi up

# Disable application but retain its storage volumes (when using dynamic volumes):
pulumi config set ollama:storageOnly true
pulumi up

# Expand storage size to 200GB (dynamic volumes)
# Pulumi updates the PVC size on the next deploy; Longhorn expands the volume.
# For local volumes the size is used for scheduling only.
# A static volume (fromVolume) is bound by name and its PVC cannot be resized:
# disable the app, patch the Longhorn volume, then re-enable - see the
# resize-storage skill below.
pulumi config set ollama:storageSize 200Gi

# Attach existing Longhorn volume to an application.
# Volumes can be cloned or restored from a backup using Longhorn UI;
# choose Node/Disk tags there to control where replicas are stored.
pulumi config set ollama:fromVolume existing-volume-name

# Enable backups for this application (uses the global backup job)
pulumi config set ollama:storage/backupEnabled true

# Optional app-level snapshot/backup schedule and retention
# Unset values fall back to the global `longhorn:` settings
pulumi config set ollama:storage/snapshotEnabled true
pulumi config set ollama:storage/snapshotCron '0 */6 * * *'
pulumi config set ollama:storage/backupCron '0 2 * * *'
pulumi config set ollama:storage/backupRetain 14

# Optional per-component overrides
# Use the component name passed to addStorage({ name: ... })
pulumi config set <app>:<component>/storage/backupEnabled false
pulumi config set <app>:<component>/storage/backupCron '0 3 * * *'
```

This approach allows you to safely disable applications without losing data, even during breaking changes.

Expanding storage is the one operation where the Pulumi setting alone is not
enough. A dynamic volume expands on the next deploy. A volume attached with
`fromVolume` is statically bound, so Kubernetes will not resize its PVC: disable
the app, patch the Longhorn volume, then re-enable it. Agents: see the
[resize-storage skill](/.agents/skills/resize-storage/SKILL.md) for the full
procedure.

#### Using Static Volume Names

While dynamically provisioned volumes are convenient for initial deployments, using static volumes allows you to shutdown all application resources without loss of data. It also helps with having descriptive names for volumes instead of auto-generated ones.

Recommended Workflow to create static volumes:

```sh
# Start with dynamic volumes for initial deployment
pulumi config set <app>:enabled true
pulumi up

# Once app is stable, stop it but leave storage around
pulumi config set <app>:storageOnly true
pulumi up

# Clone the volume in Longhorn UI and give it descriptive name, f.e. the app name.
# Select Node/Disk tags in the clone dialog (or in the restore dialog, which
# starts with empty tags) if the volume should be pinned.

# Attach the cloned/restored volume and start the app
pulumi config set <app>:fromVolume "<volume>"
pulumi config set <app>:enabled true
pulumi config delete <app>:storageOnly
pulumi up
```

### Storage class

Default storage classes:

- Regular applications: `longhorn`
- GPU workloads: `longhorn-gpu`
- Large volumes: `longhorn-large`

For single node or non-Linux systems, you can use override application to use `local-path` storage class instead:

```sh
pulumi config set longhorn:enabled false

pulumi config set ollama:storageClass local-path
```

### OAuth / OIDC

Applications normally resolve the OIDC discovery URL from the referenced core
stack. For an application-specific provider or an environment where automatic
discovery is not appropriate, override it with the application's auth provider
URL setting:

```sh
pulumi config set <app>:auth/providerUrl <issuer-url>
```

Applications using a core stack's OIDC provider require the core stack reference
and the provider-specific client settings:

```sh
pulumi config set <app>:auth pocket
pulumi config set <app>:auth/clientId <client-id>
pulumi config set <app>:auth/clientSecret <client-secret> --secret
pulumi up
```
