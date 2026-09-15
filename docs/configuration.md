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
# From the core stack directory, list the stack and its Pulumi Cloud URL
cd /
pulumi stack ls
# Use the organization/project/stack path from the URL column
# Example URL: https://app.pulumi.com/example-org/orangelab/lab

cd stacks/<module>

# Use the value printed above
pulumi config set orangelab:coreStackRef example-org/orangelab/lab
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

# Show the app's external endpoint URL
pulumi stack output --show-secrets --json | jq -r '.endpoints.<app>'
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

| Setting               | Description                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------- |
| `enabled`             | Enable or disable the application                                                            |
| `hostname`            | Hostname for the HTTPS endpoint, used with Tailscale for access                              |
| `routingProvider`     | Override global routing provider (`tailscale` or `traefik`) for this application             |
| `version`             | Lock Helm chart version to a specific release (uses latest if not specified)                 |
| `storageOnly`         | Disable application but retain storage (useful for temporarily disabling while keeping data) |
| `storageSize`         | Expand default storage size if needed (e.g., for large models)                               |
| `fromVolume`          | Attach existing Longhorn volume instead of creating new one                                  |
| `storageClass`        | Force specific storage class used by the application                                         |
| `preferredNodeLabel`  | Deploy to node with specified label if exists (soft constraint)                              |
| `requiredNodeLabel`   | Deploy only to node with specified label (hard constraint)                                   |
| `excludeNodeLabel`    | Do not deploy to nodes with specified label (hard constraint)                                |
| `requiredVolumeLabel` | Pin volume to specific node(s). Immutable - requires app redeploy to change                  |
| `backupVolume`        | Enable volume backups to S3-compatible storage                                               |
| `auth`                | Enable OIDC authentication with the selected provider                                         |
| `auth/clientId`       | OIDC client ID                                                                                |
| `auth/clientSecret`   | OIDC client secret (not required by apps using a public/PKCE client)                        |
| `auth/providerUrl`    | Override the OIDC discovery URL                                                               |
| `auth/providerName`   | Name of the OIDC provider, used in the login button label                                     |

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

By default, Longhorn automatically manages volume placement across nodes. Use `requiredVolumeLabel` only when you need to pin volumes to specific nodes (e.g., NAS available on local network).

**Important:** Volume affinity is immutable - once set, the field cannot be changed without recreating the volume. This requires redeploying the application.

```sh
# Pin main app volume to node with NAS
pulumi config set <app>:requiredVolumeLabel kubernetes.io/hostname=nas

# Pin database volume specifically (does not affect app volume)
pulumi config set <app>:db/requiredVolumeLabel kubernetes.io/hostname=nas
```

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

# Expand storage size to 200GB
# Live expansion not supported when using existing volumes, need to detach first
# For local volumes it's not enforced by Kubernetes (used for scheduling only)
pulumi config set ollama:storageSize 200Gi

# Attach existing Longhorn volume to an application.
# Volumes can be cloned or restored from a backup using Longhorn UI.
pulumi config set ollama:fromVolume existing-volume-name

# Enable backups to S3-compatible storage
# Ignored when `longhorn:backupAllVolumes` is enabled
pulumi config set ollama:backupVolume true
```

This approach allows you to safely disable applications without losing data, even during breaking changes.

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

# Clone the volume in Longhorn UI and give it descriptive name, f.e. the app name

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
