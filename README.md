# OrangeLab

**Private distributed self-hosting infrastructure.**

<img src="docs/orange-lab-910-512.png" alt="OrangeLab logo" height="250"/>

# Features

- Infrastructure as code and deployment automation ([Pulumi](https://www.pulumi.com/) ↗)
- Lightweight Kubernetes cluster ([K3S](https://k3s.io/) ↗)
- Encrypted networking ([Tailscale](https://tailscale.com/) ↗)
- Distributed replicated storage ([Longhorn](https://longhorn.io/) ↗)
- Daily incremental backups to S3 ([RustFS](https://rustfs.dev/) ↗)
- Custom domain support ([Traefik](https://traefik.io/) ↗)
- SSL certificate provisioning ([Cert-manager](https://cert-manager.io/) ↗)
- GPU support (AMD, NVIDIA) for local AI workloads
- PostgreSQL, MariaDB, and Redis database management

Deploy applications using included Pulumi stacks ([`stacks/`](./stacks/) folder) or create your own by referencing [`@orangelab/pulumi`](./packages/pulumi/README.md).

# Hardware requirements

## Linux

Most Linux systems with kernel 6.11.6+ and SELinux are supported. That includes your own hardware (e.g. laptops, mini PCs, Rasberry Pi and Zimaboard) as well as any cloud instances.

The main requirement is that K3S and Longhorn (including `open-iscsi` and `iscsiadm`) can be installed.

Note: Installation instructions assume your machines are running Bluefin (Developer edition, https://projectbluefin.io/ ↗) based on Fedora Silverblue unless otherwise noted.

## Windows, MacOS

Windows and MacOS support is limited, specifically they cannot be used as Longhorn storage nodes.

See [Disabling Longhorn Guide](./docs/longhorn-disable.md) with instructions on using `local-path-provisioner` instead of Longhorn.

## Memory

Minimum 2-4GB memory required for Longhorn. Recommended 8-16GB+ allows to run most components on a single host. More might be needed for AI workloads.

## GPU

Both NVIDIA and AMD GPUs are supported. See [Hardware module](/components/hardware/HARDWARE.md) for more information.

# Principles and goals

- decentralized - uses your physical machines potentially spread out over geographical locations, minimise dependency on external services and cloud providers
- private by default - uses Tailscale/WireGuard for end to end encrypted communication, making services public has to be explicitly enabled
- OSS - only open source components that can be run locally
- automation - use Pulumi and Helm to automate most tasks and configuration
- easy to use - no deep Kubernetes knowledge required, sensible defaults
- offline mode - continue working (with some limitations) over local network when internet connection lost
- lightweight - can be run on a single laptop using default configuration, focus on consumer hardware
- scalable - distribute workloads across multiple machines, optional use of cloud instances
- self-healing - in case of problems, the system should recover with minimal user intervention
- immutable - no snowflakes, as long as there is at least one Longhorn replica available, components can be destroyed and easily recreated
- simple disaster recovery - all you need to recreate the system from scratch is Longhorn backups and Pulumi configs

# Installation

> [!WARNING]
> This project is under active development. It is recommended to use static Longhorn volumes and `fromVolume` setting so applications can be destroyed and redeployed without data loss.

## Kubernetes Cluster

Configure **Pulumi** then install **Tailscale** and **K3S** on each node you want to add to the cluster:

- [Installation - Admin node](./docs/install-admin.md) - Initial Pulumi and Tailscale setup
- [Installation - Linux node configuration](./docs/install-linux.md) - Configure nodes (firewall, suspend settings)
- [Installation - SSH configuration](./docs/install-ssh.md) (Optional) - Configure SSH keys on nodes for easier access
- [Installation - K3s cluster](./docs/install-k3s.md) - Install Kubernetes cluster and label nodes

## Core components

After setting up the Kubernetes cluster, deploy the required core modules:

1. [Network](./components/network/NETWORK.md) - Routing provider (Tailscale or **Traefik**)
2. [Storage](./components/storage/STORAGE.md) - Distributed storage (**Longhorn**) and optionally backups (S3)
3. [Hardware](./components/hardware/HARDWARE.md) - (Optional) **GPU** support
4. [Data](./components/data/DATA.md) - (Optional) **Databases**

Information about general application configuration and deployment can be found at [Configuration Guide](./docs/configuration.md)

## Application deployment

After core components are deployed, install any applications you need from the list below.

More information about stacks in general at [Multi-Stack Deployment](./docs/stacks.md)

# Available applications

## Core stack

[Network](./components/network/NETWORK.md):

- [`cert-manager`](./components/network/cert-manager/cert-manager.md) - certificate management
- [`tailscale-operator`](./components/network/tailscale/tailscale.md) - ingress support with Tailscale authentication
- [`traefik`](./components/network/traefik/traefik.md) - reverse proxy for custom domain support
- [`technitium`](./components/network/technitium/technitium.md) - DNS server and ad-blocker
- [`zot`](./components/network/zot/zot.md) - OCI registry and pull-through image cache

[Storage](./components/storage/STORAGE.md):

- [`longhorn`](./components/storage/longhorn/longhorn.md) - replicated storage
- [`rustfs`](./components/storage/rustfs/rustfs.md) - S3-compatible storage (Longhorn backup target)

[Hardware](./components/hardware/HARDWARE.md):

- [`nfd`](./components/hardware/nfd/nfd.md) - Node Feature Discovery (GPU autodetection)
- [`amd-gpu-operator`](./components/hardware/amd-gpu-operator/amd-gpu-operator.md) - AMD GPU support
- [`nvidia-gpu-operator`](./components/hardware/nvidia-gpu-operator/nvidia-gpu-operator.md) - NVidia GPU support

[Data](./components/data/DATA.md):

- [`cloudnative-pg`](./components/data/cloudnative-pg/cloudnative-pg.md) - PostgreSQL operator
- [`mariadb-operator`](./components/data/mariadb-operator/mariadb-operator.md) - MariaDB operator

[Monitoring](./components/monitoring/MONITORING.md):

- [`beszel`](./components/monitoring/beszel/beszel.md) - Beszel lightweight monitoring
- [`prometheus`](./components/monitoring/prometheus/prometheus.md) - Prometheus/Grafana monitoring

[Security](./components/security/SECURITY.md):

- [`pocket-id`](./components/security/pocket/pocket.md) - OpenID Connect provider with passkey authentication

## Optional application stacks

[Apps](./stacks/apps/README.md):

- [`nextcloud`](./stacks/apps/components/nextcloud/nextcloud.md) - File sharing, calendars, contacts, tasks
- [`vaultwarden`](./stacks/apps/components/vaultwarden/vaultwarden.md) - Bitwarden-compatible password manager

[AI](./stacks/ai/README.md):

- [`invokeai`](./stacks/ai/components/invokeai/invokeai.md) - generative AI plaform, community edition
- [`n8n`](./stacks/ai/components/n8n/n8n.md) - AI workflow automation
- [`ollama`](./stacks/ai/components/ollama/ollama.md) - local large language models
- [`open-webui`](./stacks/ai/components/open-webui/open-webui.md) - Open WebUI frontend
- [`kubeai`](./stacks/ai/components/kubeai/kubeai.md) - (Experimental) Private AI SDK for Kubernetes with OpenAI-compatible API
- [`automatic1111`](./stacks/ai/components/automatic1111/automatic1111.md) - (Deprecated) Stable Diffusion WebUI.
- [`sdnext`](./stacks/ai/components/sdnext/sdnext.md) - (Deprecated) Stable Diffusion WebUI.

[Bitcoin](./stacks/bitcoin/README.md):

- [`bitcoin-core`](./stacks/bitcoin/components/bitcoin-core/bitcoin-core.md) - Bitcoin Core node
- [`bitcoin-knots`](./stacks/bitcoin/components/bitcoin-knots/bitcoin-knots.md) - Bitcoin Knots node
- [`electrs`](./stacks/bitcoin/components/electrs/electrs.md) - Electrs (Electrum) server implementation
- [`mempool`](./stacks/bitcoin/components/mempool/mempool.md) - Blockchain explorer

[Dev](./stacks/dev/README.md):

- [`debug`](./stacks/dev/components/debug/debug.md) - (Experimental) Troubleshooting utilities and volume access tools
- [`forgejo`](./stacks/dev/components/forgejo/forgejo.md) - Self-hosted GitHub alternative

[IoT](./stacks/iot/README.md):

- [`home-assistant`](./stacks/iot/components/home-assistant/home-assistant.md) - sensor and home automation platform

[Media](./stacks/media/README.md):

- [`droppedneedle`](./stacks/media/components/droppedneedle/droppedneedle.md) - Self-hosted music discovery, requests, and native library engine
- [`immich`](./stacks/media/components/immich/immich.md) - Self-hosted photo and video backup solution
- [`jellyfin`](./stacks/media/components/jellyfin/jellyfin.md) - Streaming movies, TV shows and music
- [`lidarr`](./stacks/media/components/lidarr/lidarr.md) - Music collection manager
- [`prowlarr`](./stacks/media/components/prowlarr/prowlarr.md) - Indexer manager for the \*arr ecosystem
- [`radarr`](./stacks/media/components/radarr/radarr.md) - Movie collection manager
- [`seerr`](./stacks/media/components/seerr/seerr.md) - Media discovery
- [`slskd`](./stacks/media/components/slskd/slskd.md) - Soulseek download client for DroppedNeedle
- [`sonarr`](./stacks/media/components/sonarr/sonarr.md) - TV show collection manager
- [`transmission`](./stacks/media/components/transmission/transmission.md) - BitTorrent download client

# Documentation

- [![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/QC-Labs/orange-lab) ↗ - AI generated documentation and good place to ask questions
- [Installation - Admin node](./docs/install-admin.md) - Initial Pulumi and Tailscale setup
- [Installation - Linux node configuration](./docs/install-linux.md) - Configure nodes (firewall, suspend settings)
- [Installation - Alpine Linux](./docs/install-linux-alpine.md) - Node configuration for Alpine Linux
- [Installation - Zimaboard (ZimaOS)](./docs/install-linux-zima.md) - Node configuration for ZimaOS
- [Installation - SSH configuration](./docs/install-ssh.md) - Configure SSH keys on nodes for easier access
- [Installation - K3s cluster](./docs/install-k3s.md) - Install Kubernetes cluster and label nodes
- [Backup and Restore](./docs/backup.md) - Using Longhorn backups with S3 storage
- [Configuration Guide](./docs/configuration.md) - Application configuration and deployment
- [Disabling Longhorn](./docs/longhorn-disable.md) - Running OrangeLab without distributed storage
- [Multi-Stack Deployment](./docs/stacks.md) - Deploy applications as independent Pulumi stacks
- [Troubleshooting](./docs/troubleshooting.md) - Common issues and solutions
- [Upgrade Guide](./docs/upgrade.md) - Upgrading your OrangeLab installation
