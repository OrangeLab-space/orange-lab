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

|          | Dynamic                | Static (`fromVolume`)      |
| -------- | ---------------------- | -------------------------- |
| PVC name | `pvc-<random>`         | the volume name            |
| Backups  | **not available**      | available (`enableBackup`) |
| Resize   | Pulumi alone is enough | app must be disabled first |

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

Static volumes must be detached first, for two independent reasons:

- A statically bound PVC (`spec.volumeName` set) cannot be resized: the API
  server says `only dynamically provisioned pvc can be resized`, and requires a
  StorageClass that supports resize.
- Patching the Longhorn volume while it is attached fails because Longhorn's
  mutating webhook looks up the volume's StorageClass, and `longhorn-<volume>`
  does not exist for static volumes. The SC is not needed for mounting — PV and
  PVC are matched by name — but the webhook still checks it for an attached
  volume. Detached volumes skip that check.

Disable the app:

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

Set the size **while the app is disabled** (step 2). Changing `storageSize`
with the app running makes `pulumi up` attempt the forbidden static-PVC resize
and fail.

### 4. Expand the Longhorn volume (static volumes only)

For dynamic volumes the deploy in step 5 expands the volume on its own — skip
to step 5.

For static volumes the volume is attached by name, so Pulumi's new PVC size does
not expand it. Patch the volume directly, **while it is detached**:

```sh
kubectl patch volumes.longhorn.io <volume> -n longhorn-system \
  --type=merge -p '{"spec":{"size":"5368709120"}}'
```

`spec.size` is bytes as a quoted number, not a Gi string — `"5Gi"` is rejected
with `cannot unmarshal number 5Gi into ... int64`. Common values:

| Size    | Bytes          |
| ------- | -------------- |
| `5Gi`   | `5368709120`   |
| `10Gi`  | `10737418240`  |
| `50Gi`  | `53687091200`  |
| `100Gi` | `107374182400` |
| `250Gi` | `268435456000` |
| `500Gi` | `536870912000` |

The Longhorn UI (Volume → Edit → Size) accepts GiB and converts for you.

`<volume>` is the Longhorn volume name, which for static volumes matches the PVC
name. Longhorn expands the block device; the filesystem is grown by the CSI on
the next mount. Confirm the expansion finished:

```sh
kubectl get volumes.longhorn.io <volume> -n longhorn-system \
  -o jsonpath='{.spec.size} {.status.expansionRequired}{"\n"}'
```

`expansionRequired` must become `false`. Do not read the size from the PV/PVC —
only `spec.size` proves the volume grew, and `dmesg` in the engine-image pod is
not a reliable confirmation.

### 5. Apply (dynamic volumes only)

```sh
cd stacks/<module> && pulumi up --yes --stack <stack>
```

This is what performs the expansion for a dynamic volume. Skip it for static
volumes: the PV/PVC no longer exist while the app is disabled, and step 6
recreates them at the new `storageSize`.

### 6. Re-enable and verify (static volumes only)

```sh
pulumi config set <app>:enabled true --cwd stacks/<module> --stack <stack>
cd stacks/<module> && pulumi up --yes --stack <stack>
kubectl get volumes.longhorn.io -n longhorn-system <volume>
kubectl exec -n <app-namespace> deploy/<app> -- df -h /<mount>
```

Re-enabling creates a new PV/PVC at the new `storageSize`. The data survives
because the PV's reclaim policy is `Retain` and the Longhorn volume is
independent of the claim. The CSI grows the filesystem while mounting, so `df`
inside the pod is the proof — it should show the new size. If it still shows the
old size, the volume was not detached when it was patched.

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
- Resize confirmed via `df` inside a mounted pod — the CSI grows the filesystem
  on mount, and `dmesg` in the engine-image pod is not reliable
- App logs checked after re-enabling
- Throwaway debug pods deleted
