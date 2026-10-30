# Longhorn — how it actually behaves

Notes on Longhorn's behaviour in this cluster, written after repeated
misdiagnosis. Most of these contradict a plausible assumption, which is why
they are recorded. For a general Longhorn guide see
[troubleshooting.md](../docs/troubleshooting.md).

## Volumes outlive their application

Removing an application — `<app>:enabled false` followed by `pulumi up` —
deletes the PVC. The **Longhorn volume survives**, detached, with its data
intact. Re-enabling the application brings the data back.

So an application that looks empty after being disabled is usually not empty.
Before restoring from a backup, check whether the data is still there:

```sh
kubectl get volumes.longhorn.io -n longhorn-system <app>
# state=detached, robustness=unknown, actualSize still non-zero
```

`robustness: unknown` on a detached volume is normal and is **not** a warning
sign. It means Longhorn cannot evaluate redundancy for a volume nothing is
using. Several volumes in this cluster sit this way permanently, as the resting
state of disabled applications.

### The corollary that matters

Deleting a PVC does not delete data, but it does orphan the volume. Orphaned
volumes still consume the full replica allocation on disk — `frigate-media`
holds a 50 GB volume times its replica count whether or not Frigate is enabled.

## Expanding a static volume

A `fromVolume` volume is bound by name: the PV has `spec.volumeName` set, so
Kubernetes never runs the resizer. Two consequences, both of which only appear
when you try to grow one:

- The PVC cannot be resized. The API server rejects the update with
  `only dynamically provisioned pvc can be resized`: the StorageClass must also
  support resize. Changing `storageSize` with the app running fails the deploy.
- Patching the Longhorn volume while it is **attached** is rejected by
  `mutator.longhorn.io`: the webhook looks up `longhorn-<volume>`, which does
  not exist for static volumes. PV and PVC are matched by name, which is all
  mounting needs, but the webhook still checks the SC for an attached volume.
  Detached volumes skip the check.

So the procedure is: disable the app (detach), patch `spec.size`, re-enable.
Re-enabling creates a new PV/PVC at the configured `storageSize`; the data
survives because the PV's reclaim policy is `Retain` and the Longhorn volume is
independent of the claim.

`spec.size` is bytes as a quoted number (`"268435456000"` for 250Gi), not
`"250Gi"` — the CRD field is `int64` with a `,string` tag. The block device
grows immediately; the filesystem is grown by the CSI while the volume is
mounted, so `df` inside the pod is the proof. `dmesg` in the engine-image pod
is not.

Creating the `longhorn-<volume>` StorageClasses would allow online size patches
and give the resizer a path, but it is not required for mounting. That is a
separate change, not part of the resize procedure.

## `strict-local` volumes are pinned to one node

A volume with `dataLocality: strict-local` stores its only replica on the node
in `spec.nodeID`. That node must also be the node the PV is pinned to
(`<app>:requiredVolumeLabel`), or the replica is unschedulable and the pod stays
in `FailedAttachVolume` with `volume ... detached state with some un-schedulable
replicas`. Repin the volume's `nodeID` to match the PV before investigating the
attach path.

## Volume placement is a property of the volume, not the PV

Replica placement for a static volume does **not** come from the PV, the
`longhorn-<volume>` StorageClass, or the app's Pulumi settings. It lives on the
`volumes.longhorn.io` object:

- `spec.nodeSelector` — Longhorn **node tags** the node must have.
- `spec.diskSelector` — Longhorn **disk tags** the disk must have.

Both are tag lists and multiple tags are ANDed: `["ssd", "fast"]` requires a
disk with both tags, not either. These are Longhorn tags set in _Node → Edit
Node and Disks_, not Kubernetes labels: `kubernetes.io/hostname` is irrelevant
here. The PV's `nodeAffinity` (`<app>:requiredVolumeLabel`) is a different
constraint — it decides where the volume may _attach_, not where replicas are
stored.

Two tag levels are worth keeping:

- **Specific** (`bitcoin`, `jellyfin`): restrict the volume to disks with that
  tag. Predictable; if only one disk carries the tag, there is no rebuild
  target when it goes away.
- **Category** (`hdd`, `ssd`, `usb`): allow any disk in the class, so a rebuild
  can move to another disk of the same kind.

A tag can be on several disks; the volume treats all of them as candidates. Use
a specific tag only for a volume that genuinely belongs on those disks.

### Inspect and change

```sh
kubectl -n longhorn-system get volumes.longhorn.io <volume> \
  -o jsonpath='{.spec.nodeSelector}{"\n"}{.spec.diskSelector}{"\n"}'

kubectl -n longhorn-system patch volumes.longhorn.io <volume> --type merge \
  -p '{"spec":{"diskSelector":["<tag>"]}}'
```

Longhorn 1.13 has no UI action for editing these on an existing volume, but the
fields are mutable and the patch is accepted while attached. It applies to
**new replica scheduling only**: existing replicas are not detached, evicted or
moved. On a healthy single-replica volume the change is a no-op until that
replica fails or is removed.

StorageClass parameters have the same limit: Longhorn applies them at volume
creation and does not propagate later edits to existing volumes. A `fromVolume`
volume already exists, so its PV `volumeAttributes` and static StorageClass
cannot set placement at all.

### Moving data to another disk

There is no "move replica" operation. Either rebuild in place or clone.

**Rebuild in place** keeps the volume, PV and PVC:

1. Set the target selector.
2. Raise `spec.numberOfReplicas` by one (UI: _Update Replicas Count_).
3. Wait for the new replica to reach `running` on the target disk.
4. Delete the replica on the old disk.
5. Lower the replica count back.

This needs room for one extra full copy while the rebuild runs. Delete the old
replica only after the new one is healthy; deleting it first starts a
replacement rebuild.

**Clone** creates a new volume:

1. Clone the volume in the Longhorn UI and check the _Node Tag_ / _Disk Tag_
   fields in the clone dialog. They are prefilled from the source volume but
   can be changed.
2. Point `<app>:fromVolume` (or `<app>:<component>/fromVolume`) at the clone.
3. Deploy, verify, then delete the old volume once the clone is proven.

The source can stay attached during a UI clone; it is a full copy, not a
snapshot reference. Switching `fromVolume` changes the PV's `volumeHandle`;
expect the workload to restart, and the old volume is retained.

A UI **restore from backup** starts with empty Node/Disk Tag fields — set them
explicitly. A CSI/PVC clone uses the destination StorageClass's parameters, not
the source volume's.

Do not evict a shared disk to move one volume: eviction rebuilds every replica
on the disk, and volumes whose tag exists only on that disk have nowhere to go.
Move the individual volume instead.

## Use `replicas.longhorn.io`, not `engines.longhorn.io`

These are not interchangeable, and the second badly under-reports:

```sh
kubectl get replicas.longhorn.io -n longhorn-system --no-headers | wc -l   # 79
kubectl get engines.longhorn.io   -n longhorn-system --no-headers | wc -l   # 40
```

An engine is the process serving a volume's I/O; it exists on the node
currently mounting an RWO volume. Replicas are the stored copies. Counting
engines to work out where a volume's data lives gives the wrong answer and can
make healthy volumes look like they have no redundancy.

## Soft anti-affinity permits duplicate replicas

`replica-soft-anti-affinity` is enabled, which means Longhorn **prefers**
spreading replicas across nodes but permits two on one when it has no choice.
That state is reported as `degraded`.

A volume showing `degraded` may have two perfectly healthy running replicas
that simply landed on the same node. Check the actual placement before
concluding data is at risk:

```sh
kubectl get replicas.longhorn.io -n longhorn-system -o json | jq -r \
  '.items[] | select(.metadata.labels.longhornvolume=="<volume>")
        | [.metadata.labels.longhornnode, .status.currentState] | @tsv'
```

## Auto-balance is a deliberate setting

`longhorn:replicaAutoBalance` is set in `Pulumi.yaml`. It is a decision, not a
default — check it before changing it live.

Valid values are `disabled`, `least-effort` and `best-effort`. Note that:

- `best-effort` balances toward the **emptiest** node, which is not always
  where the data should go. It will queue replicas onto a laptop before a
  server if the laptop has more free space.
- Enabling it does not fix a `degraded` volume — Longhorn explicitly refuses to
  auto-balance a volume in a degraded state.
- Set it through `pulumi config set`, not by patching the live setting, or the
  next `pulumi up` silently reverts it.

## Longhorn will not schedule onto a full disk

A disk stops accepting new replicas when free space drops below
`storage-minimal-available-percentage` (10% of capacity by default). The disk
reports `Schedulable=False` while still holding plenty of data and working
correctly for existing volumes.

So a node can look full in one view and idle in another: check
`storageAvailable` per disk rather than summing or assuming:

```sh
kubectl get nodes.longhorn.io -n longhorn-system -o json | jq -r \
  '.items[] | .metadata.name as $n | .status.diskStatus | to_entries[]
   | [$n, .key, (.value.conditions[]|select(.type=="Schedulable").status)] | @tsv'
```

Unused disks on a node are normal. A node with one large disk full and a second
disk empty is a placement problem, not a capacity problem, and no amount of
balancing will fix it while the full disk holds the data.

## Excluding a node from placement

Mark the **node**, not just its disks — the manager logs
`Failed to use node <name>, does not allow scheduling`, which is the reliable
confirmation that it took effect.

There is no `disks.longhorn.io` CRD in Longhorn 1.13 and `GET /v1/disks`
returns `404`. Disk scheduling is only reachable through the REST API:

```sh
kubectl exec -n longhorn-system <longhorn-manager-pod> -c longhorn-manager -- \
  curl -s http://<longhorn-backend-clusterip>:9500/v1/nodes/<node>
```

The Longhorn API is on the `longhorn-backend` Service at port 9500. It is not
listening on the pod's own `localhost`.

## The CSI components are sized by a Setting, not by the chart

`longhorn-manager`, `longhorn-global-manager` and the Helm chart's own workloads
are sized through ordinary chart values (`longhornManager.resources`,
`longhornGlobalManager.resources`). The **CSI components are not** — they are
created by the Longhorn manager, not by a chart template, so their sizing lives
in the `system-managed-csi-components-resource-limits` **Setting**:

```sh
kubectl -n longhorn-system get settings.longhorn.io \
  system-managed-csi-components-resource-limits -o jsonpath='{.value}'
```

It is set from the chart's `defaultSettings` in `components/storage/longhorn/longhorn.ts`,
so it is declarative and survives a `pulumi up` — but it is a Longhorn Setting,
not a pod spec, so a `kubectl patch` of the pod does nothing.

**Changing it restarts the CSI components**, which briefly interrupts volume
provisioning and attach/detach. Running workloads with already-attached volumes
keep running. Set it through the chart values, then deploy.

The engine-image, share-manager, driver-deployer and UI pods are also
manager-created and are **not** covered by that Setting.

## `longhorn-manager` is a DaemonSet

Not a Deployment — one pod per node, including nodes that are down, where its
pod will sit `Terminating` indefinitely. Restart it with
`kubectl rollout restart daemonset/longhorn-manager`.

Restarting it clears transient controller state but **will not** repair a
genuine model inconsistency. If a volume is stuck, restarting the control plane
is a reasonable first move precisely because it is cheap; if it does not help,
the inconsistency is real.

## A volume can be inconsistent while the application works

An attached volume can report `state=attached` with an **empty
`currentEngineNodeID`**, and an engine whose `spec.replicas` is empty. In this
state the application runs normally but Longhorn does not consider the volume
healthy, and will not schedule rebuilds or balance it.

The replica CRs exist, are active, and have no `failedAt` — they are simply not
attached to the engine. The Longhorn API agrees, listing them with `nodeName:
null`.

This is a latent rebuild risk rather than data loss: a node failure during this
state has no working rebuild path. Remedy is a detach/attach cycle, which means
restarting the consuming workload.

## A node reboot rebuilds every replica on that node

Rebooting one storage node makes almost every volume show `degraded` and
`rebuilding` in the UI. This is expected and is **not** a full re-copy of
the cluster.

When a node disappears, engines mark the replicas on it failed. When it
returns, Longhorn waits `replica-replenishment-wait-interval` (900s in
this cluster) for those replicas to become reusable. If they do, the
existing replica data is kept and only the delta is rebuilt; if they do
not, Longhorn creates a new replica and copies the whole volume. A
reboot therefore touches every volume with a replica on the node, but a
short reboot reuses the data.

Check whether a rebuild is reuse or a fresh copy:

```sh
# Reused replicas keep their old creationTimestamp and name.
kubectl -n longhorn-system get replicas.longhorn.io -o json | jq -r \
  '.items[] | [.metadata.creationTimestamp, .metadata.name,
   .metadata.labels.longhornnode, .status.currentState] | @tsv' | sort

kubectl -n longhorn-system logs -l app=longhorn-manager \
  -c longhorn-manager --since=1h \
  | grep -E 'will be reused during rebuilding|Cannot find a reusable failed replicas'
```

Judge the cost by `status.actualSize`, not `spec.size`. Provisioned
sizes are much larger than used data: in one reboot here, 28 volumes
rebuilt but the affected volumes held only ~474 GB actual; the 1 TB
volumes were mostly empty. `actualSize` is the replica's on-disk usage
including snapshots, so it can exceed the filesystem usage that `df`
reports inside the pod. Rebuilds are serialized by
`concurrent-replica-rebuild-per-node-limit` (2), so the queue can take
an hour even when each volume is quick.

`replica-replenishment-wait-interval` is what makes a short reboot
cheap. Do not lower it.

### Planned reboot

Drain first so Longhorn stops the replicas cleanly:

```sh
kubectl cordon <node>
kubectl drain <node> --ignore-daemonsets --delete-emptydir-data
# wait for the drain to complete and the instance-manager pod on
# <node> to be evicted
# reboot
kubectl uncordon <node>
```

`node-drain-policy=always-allow` means the drain is not blocked by the
last replica. Do not evict replicas first: eviction moves the same data
and takes longer. An unplanned reboot or power loss is the case where
the catch-up is unavoidable.

### Boot-time disk race

Longhorn starts before encrypted or separately mounted disks are
available and logs:

```text
Number of node disks 2 and collected disk info 0 are not equal
Cannot find a reusable failed replicas for volume <volume>
```

If the disks become ready before the replenishment wait expires, reuse
still succeeds. If they take longer, Longhorn creates new replicas and
does full copies instead. Check that disk mounts are ready promptly
after boot on any node whose storage is not on the root filesystem.

## Unrelated but easy to confuse

**A stale `--node-ip` looks like a Longhorn problem.** If k3s carries a node
address that no longer exists, pod → ClusterIP traffic times out, Longhorn
cannot attach volumes, and volumes sit `ContainerCreating`. Longhorn is a
symptom. Check that k3s agrees with reality before investigating storage —
see [headscale-migration.md](headscale-migration.md).

**`rebuildRetryCount` is historical.** It is not reset after a successful
rebuild, so a high count on an otherwise healthy replica means nothing.

**SQLite applications are fragile.** A volume that hit 100% may have left the
database damaged, and resizing does not repair it.

## Backup target can flap on slow S3 storage

Longhorn reports:

```text
failed to list system backups in s3://<bucket>@<region>/:
timeout executing: ... longhorn system-backup list ...
```

The target then shows `available=false` and nightly backups stop, even though
RustFS is healthy and normal S3 requests still succeed.

Longhorn 1.13's `system-backup list` sends an S3 `ListObjectsV2` request with
`prefix=/`. RustFS answers that by walking the bucket. On slow storage
(USB/HDD), and with the background scanner running, the walk can exceed
`backup-execution-timeout`, which defaults to 1 minute. The target is marked
unavailable and retried every minute.

The status is intermittent: a single `available=true` does not prove the target
is stable; check `lastSyncedAt` and the manager log over a few minutes.

### Diagnose

```sh
kubectl -n longhorn-system get backuptarget default

kubectl -n longhorn-system get settings.longhorn.io backup-execution-timeout \
  -o custom-columns=NAME:.metadata.name,VALUE:.value

kubectl -n longhorn-system logs -l app=longhorn-manager -c longhorn-manager --since=10m \
  | grep -iE 'backup store|system-backup|timeout'

# RustFS writes most logs to a file, not stdout
kubectl -n rustfs exec deploy/rustfs -- \
  sh -c 'grep -iE "inflight_slow|walk_dir" /logs/rustfs.log | tail -20'
```

Look for `GET /<bucket>?delimiter=%2F&list-type=2&prefix=%2F` and `walk_dir`
on the RustFS data path. If those appear, it is the slow listing, not bad
credentials, DNS or a dead RustFS.

### Restart RustFS first

Restarting the single RustFS pod clears the stuck walk and has restored the
target without changing configuration:

```sh
kubectl -n rustfs rollout restart deployment/rustfs
kubectl -n rustfs rollout status deployment/rustfs

# Wait for the next backup-target reconcile (up to a minute)
kubectl -n longhorn-system get backuptarget default
```

`available=true` and a fresh `lastSyncedAt` mean the listing succeeded. The first
call after a cold restart can still take close to the 1-minute Longhorn timeout.

### If it keeps recurring

These are live changes; Pulumi will revert them on the next `pulumi up` unless
the same values are added to the component config:

```sh
# Longhorn: allow the system-backup listing to take up to 10 minutes
kubectl -n longhorn-system patch settings.longhorn.io backup-execution-timeout \
  --type merge -p '{"value":"10"}'

# RustFS: widen the walk budget for slow storage
kubectl -n rustfs set env deployment/rustfs \
  RUSTFS_DRIVE_TIMEOUT_PROFILE=high_latency

kubectl -n rustfs rollout status deployment/rustfs
```

If the scanner is competing for I/O, disabling it removes the background
full-bucket walk; the trade-off is stale usage/scanner data:

```sh
kubectl -n rustfs set env deployment/rustfs RUSTFS_ENABLE_SCANNER=false
kubectl -n rustfs rollout status deployment/rustfs
```

The durable fix is faster storage (SSD/NVMe) or fewer objects (prune old
backups). Do not delete the backup target, credential secret or bucket to
"reset" it; the target recovers once the listing completes.
