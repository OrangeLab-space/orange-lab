# Troubleshooting

It's easiest to use _Headlamp_ or _k9s_ to connect to cluster. Below are some useful commands when troubleshooting issues.

```sh
# Check logs of the app, namespace optional if same as app name
./scripts/logs.sh <app> [namespace]

# Watch cluster events
./scripts/events.sh

# See all application resources
kubectl get all -n <namespace>
```

Pods can be stopped and will be recreated automatically.

You can shut down the application resources, then recreate them. Note that if storage is removed then configuration will be lost and some data might need to be downloaded again (for example LLM models)

## HTTPS endpoint

In case of issues connecting to the HTTPS endpoint, try connecting to the Kubernetes service directly, bypassing the Ingress and Tailscale `ts-*` proxy pod:

```sh
# Find cluster IP address and port of the service
kubectl get svc -n <app>

# Test connection or use browser (note services do not use HTTPS, only Ingress)
curl http://<ip>:<port>/
nc -zv <ip> <port>
```

If that works, then Tailscale Ingress needs to be looked at. Try stopping the `ts-*` proxy pod, it will be recreated. Remember that first time you access an endpoint, the HTTPS certificate is provisioned and that can take up to a minute.

Make sure there is no leftover entry for a service at https://login.tailscale.com/admin/machines. If there is a conflicting entry, remove it before enabling the app again (specifically the Ingress resource managed by Tailscale operator).

## Pocket ID sign-in

Pocket ID is the OIDC provider applications sign in through. When someone cannot
sign in, or an app is missing from their **My Apps** dashboard, audit the live
instance against the repository first — it reports exactly which group, client or
launch URL has drifted:

```sh
./scripts/pocket-verify.sh                 # whole instance
./scripts/pocket-verify.sh --app immich    # one application
./scripts/pocket-verify.sh --json | jq     # machine-readable (exits 1 on drift)
```

The most common causes:

- **The user is not in an allowed group.** Sign-in requires membership of one of
  the app's `allowedGroups`; the client audit lists what each one allows. Group
  membership is managed by hand in Pocket ID.
- **The client is not restricted.** When `isGroupRestricted` is false the
  allowed-group list is ignored, so every Pocket ID user can sign in.
- **A tile is missing.** A client only appears in **My Apps** when it has a launch
  URL; the VPN clients deliberately have none.
- **A claim or role group is missing.** RustFS needs a `rustfs_policies` claim and
  Headplane a `headplane_role` claim; other apps map groups to roles with
  `auth/groupMap` or an `<app>-admin` group.
- **Passkeys fail after a hostname change.** Passkeys are bound to the origin, so
  every user has to register again.

If only **one** app is affected and the audit is clean, the app is the likelier
culprit: a 5xx from the app's SSO _start_ URL happens before Pocket ID is
contacted, so read that app's log first. Jellyfin, for example, fails this way
when an upgrade leaves an old plugin version next to the new one
([Jellyfin](../stacks/media/components/jellyfin/jellyfin.md)).

`<app>:auth/allowedGroups` is declared in the owning `Pulumi.yaml` (repository
root for core components, `stacks/<module>/Pulumi.yaml` for applications). After
changing it, re-run the app's `pocket-<app>.sh` wrapper — `allowedGroups` is read
only by the wrapper, so no `pulumi up` is needed.

## Longhorn

Longhorn troubleshooting guide - https://github.com/longhorn/longhorn/wiki/Troubleshooting

Cheatsheet with useful commands - https://support.tools/training/longhorn/troubleshooting/

### Checking volume and disk usage

`kubectl get pv` only shows the volume's declared size, which is not its usage. A
volume can be well within its declared size while the node disk behind it fills
up, so check both:

```sh
# Node disk headroom (compare storageAvailable against storageMaximum)
kubectl get nodes.longhorn.io -n longhorn-system -o custom-columns=NAME:.metadata.name,AVAIL:.status.diskStatus.*.storageAvailable

# Volume state and declared size
kubectl get volumes.longhorn.io -n longhorn-system
```

To see what is consuming space, mount the volume in a throwaway pod. The PVC name
is usually the volume name rather than the Pulumi resource name:

```sh
kubectl get pvc -n <app-namespace>

kubectl run volcheck --image=busybox:stable --restart=Never -n <app-namespace> \
  --overrides='{"spec":{"nodeName":"<node>","containers":[{"name":"c","image":"busybox:stable","command":["sh","-c","df -h /data; du -sh /data/* | sort -rh | head"],"volumeMounts":[{"name":"d","mountPath":"/data"}]}],"volumes":[{"name":"d","persistentVolumeClaim":{"claimName":"<pvc-name>"}}]}}'
kubectl logs volcheck -n <app-namespace>
kubectl delete pod volcheck -n <app-namespace>
```

busybox runs as a non-root user while Longhorn volumes are owned by `uid=0`, so
writes fail with `Permission denied` unless the pod sets
`"securityContext":{"runAsUser":0}`. That is a permissions mismatch, not a
read-only filesystem — check `id` before concluding the volume is read-only.

On ZimaOS, `sd[b-d]` style devices are CasaOS NBD images rather than physical
disks, so their presence in `lsblk` output does not indicate failing hardware.

### Volume out of space

Expanding a volume is covered in the
[configuration guide](./configuration.md#storage). Note that Pulumi only updates
the PVC size — it does not expand the Longhorn volume, so a volume attached with
`fromVolume` keeps its original filesystem until the volume itself is expanded.

A volume that reached 100% may have left application data damaged. Resizing does
not repair it, so check the application logs after expanding. SQLite-based
applications are the most common casualty, since a failed write allocation
corrupts the database rather than raising a clean error.

### Replicas not rebuilding

A volume that stays `degraded` after a node returns usually means the replica
cannot rebuild on the target node. Check the manager log for the failure reason:

```sh
kubectl logs -n longhorn-system -l app=longhorn-manager -c longhorn-manager --tail=400 | grep -i 'rebuild\|failed'
```

A high `rebuildRetryCount` on a replica is not necessarily a failure — the
counter is not reset after a successful rebuild, so it reflects historical
attempts rather than the current state. Check the volume's `robustness` field
instead, and allow time for the rebuild: a degraded volume during a rebuild is
expected until the new replica is usable.
