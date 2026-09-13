# Longhorn

|                         |                                                                     |
| ----------------------- | ------------------------------------------------------------------- |
| Homepage                | https://longhorn.io/                                                |
| Helm chart              | https://github.com/longhorn/longhorn/tree/master/chart              |
| Default values          | https://github.com/longhorn/longhorn/blob/master/chart/values.yaml  |
| StorageClass parameters | https://longhorn.io/docs/1.8.0/references/storage-class-parameters/ |
| Endpoints               | `https://longhorn.<domain>/`                                        |

Longhorn adds permanent storage that is replicated across multiple nodes. It also supports snapshots and backups of data volumes. The nodes need to be labeled with `node-role.kubernetes.io/longhorn=true` - you need at least one. Volumes stored at `/var/lib/longhorn/`.

## Prerequisites (Bluefin)

Rebase to developer mode image as it includes iSCSI drivers:

```sh
ujust devmode
```

Answer no to question about flatpaks.

## Installation

Enable iSCSI service before deploying Longhorn.

```sh
# Enable iSCSI on each Longhorn node
systemctl enable iscsid.service --now
systemctl enable iscsid.socket --now

# Add tag to storage nodes that will be used by Longhorn
kubectl label nodes <node-name> node-role.kubernetes.io/longhorn=true

# Enable module
pulumi config set longhorn:enabled true

# Set replicaCount to 3 if you have 3+ storage nodes
pulumi config set longhorn:replicaCount 3

# increase size of storage from default 50Gi to 100Gi
pulumi config set longhorn:storageSize 100Gi

# Enable replica auto-balancing for better distribution across nodes
# "disabled" - (default) minimises traffic between nodes, manage per volume in UI
# "least-effort" - balance so replicas have at least single node redundancy
# "best-effort" - continuously spread replicas evenly across all nodes
pulumi config set longhorn:replicaAutoBalance best-effort

# Set data locality - creates a local replica on the pod's node
# "disabled" - (default) no local replica, allow running with remote volume
# "best-effort" - creates a local replica when possible (better performance but requires migrating volume to local node before start)
pulumi config set longhorn:dataLocality best-effort

pulumi up
```

## SSO (Pocket ID)

Longhorn has no user management; by default its external endpoint is reachable without authentication. OIDC protection currently requires the Traefik routing provider. Once configured, the UI requires Pocket ID sign-in and is limited to the Pocket ID `admin` group (see [Pocket ID](../../security/pocket/pocket.md)). From the repository root (core stack directory):

```sh
./components/storage/longhorn/pocket-longhorn.sh

# Configure the OIDC client
pulumi config set longhorn:auth pocket
pulumi config set longhorn:auth/clientId <client-id>
pulumi config set longhorn:auth/clientSecret <client-secret> --secret
pulumi up
```

Restrict the Pocket ID OIDC client to the groups that should access Longhorn. Group access is managed in Pocket ID under **Settings -> OIDC Clients**.

## Using Extra Disks

By default, Longhorn stores data at `/var/lib/longhorn/` (root disk). To use a dedicated storage drive:

1. Mount the disk (see [Node Configuration](/docs/install-linux.md#optional-mount-storage-disk))
2. Create Longhorn subdirectory: `sudo mkdir -p /mnt/<mount>/longhorn`
3. Open Longhorn UI → **Node** tab → Select node → **Edit Disks**
4. Click **Add Disk**
5. **Path:** `/mnt/<mount>/longhorn`
6. **Enable Scheduling:** ✅
8. Click **Save**

## Troubleshooting

There is an issue with Longhorn getting into a loop when auto-balancing is enabled and some nodes have scheduling disabled. Try removing all replicas but 1 and enable scheduling on that node.

## Backups

Longhorn supports automated backups to S3-compatible storage (MinIO). For detailed instructions on setting up and using backups, see [Backup Guide](/docs/backup.md).

## Disable Longhorn

Longhorn requires Linux and works best with multiple nodes for replication.

For single-node deployments, non-Linux platforms (Windows, macOS), or systems with limited resources, see the [Disabling Longhorn Guide](/docs/longhorn-disable.md) for detailed instructions.

## Uninstall

https://artifacthub.io/packages/helm/longhorn/longhorn#uninstallation

Before you uninstall Longhorn you need to remove all apps/storage using Longhorn volumes.

```sh
# Disable uninstall protection
kubectl -n longhorn-system patch -p '{"value": "true"}' --type=merge lhs deleting-confirmation-flag

pulumi config set longhorn:enabled false
pulumi up
```
