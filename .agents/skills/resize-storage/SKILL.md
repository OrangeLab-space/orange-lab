---
name: resize-storage
description: Use when a Longhorn volume has run out of space, or the user asks to expand, grow, or increase storage for an app. Trigger on phrases like "resize the volume", "expand storage", "storageSize", "volume is full", "no space left on device", or reports an app failing because its data volume filled up.
---

# Resize Storage

Expands a Longhorn volume backing an application. See
[docs/configuration.md](/docs/configuration.md#storage) for the `storageSize`
setting itself — this skill covers the operational procedure.

## Dynamic vs static volumes

This determines the whole procedure, so establish it first.

| | Dynamic | Static (`fromVolume`) |
|---|---|---|
| PVC name | `pvc-<random>` | the volume name |
| Backups | **not available** | available (`enableBackup`) |
| Resize | Pulumi alone is enough | app must be disabled first |

Static volumes are the recommended option because they can be backed up —
Longhorn attaches recurring-job labels only to PVCs it attaches by name
(`recurring-job-group.longhorn.io/backup`), never to dynamically provisioned
ones. If the volume is dynamic, say so: without backups a full volume risks
unrecoverable data loss.

Check which you have:

```sh
kubectl get pvc -n <app-namespace>
kubectl get volumes.longhorn.io -n longhorn-system
```

A `pvc-<random>` name means dynamic. Anything else is static, and steps 2, 4 and
6 below apply.

## Workflow

### 1. Confirm which filesystem is full

A full **node disk** and a full **volume** are different problems. Check both:

```sh
kubectl get nodes.longhorn.io -n longhorn-system -o custom-columns=NAME:.metadata.name,AVAIL:.status.diskStatus.*.storageAvailable
```

Report `storageAvailable` vs `storageMaximum` from the Longhorn node CR.
`kubectl get pv` only shows the volume's declared size, which is not its usage.

### 2. Disable the app (static volumes only)

Dynamic volumes expand while attached — skip to step 3.

Static volumes must be detached first, so the app has to be disabled:

```sh
pulumi config set <app>:enabled false --cwd stacks/<module> --stack <stack>
cd stacks/<module> && pulumi up --yes --stack <stack>
```

### 3. Set the new size

```sh
pulumi config set <app>:storageSize 5Gi --cwd stacks/<module> --stack <stack>
```

Apps with multiple volumes use a per-volume prefix, e.g.
`frigate:media/storageSize`. Verify the key in `Pulumi.yaml` or the component
`.ts` — `config.require` fails the deploy when a key is missing.

Set it in `stacks/<module>/Pulumi.yaml` to change the default for all users, or
as stack config when only one deployment needs it. Stack config overrides the
component default.

### 4. Expand the Longhorn volume (static volumes only)

For dynamic volumes the deploy in step 5 expands the volume on its own — skip
to step 5.

For static volumes the volume is attached by name, so Pulumi's new PVC size does
not expand it. Patch the volume directly:

```sh
kubectl patch volumes.longhorn.io <volume> -n longhorn-system \
  --type=merge -p '{"spec":{"size":"5Gi"}}'
```

`<volume>` is the Longhorn volume name, which for static volumes matches the PVC
name. Longhorn expands the filesystem from inside the engine image. Confirm it
landed on the node:

```sh
kubectl exec -n longhorn-system <engine-image-pod-on-node> -- dmesg | grep -i resizing
```

The Longhorn UI (Volume → Edit → Size) does the same thing interactively.

### 5. Apply

```sh
cd stacks/<module> && pulumi up --yes --stack <stack>
```

For dynamic volumes this is what performs the expansion. For static volumes it
aligns the PV/PVC with the size patched in step 4.

### 6. Re-enable and verify (static volumes only)

```sh
pulumi config set <app>:enabled true --cwd stacks/<module> --stack <stack>
cd stacks/<module> && pulumi up --yes --stack <stack>
kubectl get volumes.longhorn.io -n longhorn-system
```

A volume at 100% can leave app data damaged, which the resize does not repair.
Check the app's logs after re-enabling; see the component `<app>.md` for
app-specific recovery.

## Inspecting usage

To see what is consuming space, mount the volume in a throwaway pod. The PVC
name is usually the volume name, not the Pulumi resource name — check
`kubectl get pvc -n <app-namespace>` first.

```sh
kubectl run volcheck --image=busybox:stable --restart=Never -n <app-namespace> \
  --overrides='{"spec":{"nodeName":"<node>","containers":[{"name":"c","image":"busybox:stable","command":["sh","-c","df -h /data; du -sh /data/* | sort -rh | head"],"volumeMounts":[{"name":"d","mountPath":"/data"}]}],"volumes":[{"name":"d","persistentVolumeClaim":{"claimName":"<pvc-name>"}}]}}'
kubectl logs volcheck -n <app-namespace>
kubectl delete pod volcheck -n <app-namespace>
```

busybox images run as a non-root user while Longhorn volumes are owned by
`uid=0`, so writes fail with `Permission denied` unless the pod sets
`"securityContext":{"runAsUser":0}`. That is a permissions mismatch, not a
read-only filesystem — check `id` before concluding the volume is read-only.

## Verify

- Dynamic vs static established before starting — they need different procedures
- Node disk headroom reported before assuming a volume is full
- Longhorn volume `spec.size` matches the intended size — PV/PVC alone are not proof
- Resize confirmed via `dmesg` resize lines or `df` inside a mounted pod
- App logs checked after re-enabling
- Throwaway debug pods deleted