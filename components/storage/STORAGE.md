# Storage

Distributed storage and S3-compatible object storage for the cluster.

## Platform Support

Longhorn only runs on Linux. For MacOS/Windows or single-node setups, use local storage instead. See [single node guide](/docs/single-node.md).

## Quick Start

```sh
# Add storage nodes to orangelab:nodes with node-role.kubernetes.io/longhorn=true
# See docs/configuration.md#node-topology-labels-and-taints

# Enable Longhorn
pulumi config set longhorn:enabled true
pulumi up

# Enable Longhorn backups
# Requires S3 storage (f.e. RustFs)
pulumi config set longhorn:backupEnabled true
pulumi up

```

## Components

- **[Longhorn](./longhorn/longhorn.md)** - Replicated block storage for Kubernetes workloads. Required for storage nodes.
- **[RustFS](./rustfs/rustfs.md)** - S3-compatible object storage for Longhorn backups.
