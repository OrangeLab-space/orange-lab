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