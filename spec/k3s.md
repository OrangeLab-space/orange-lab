# K3s node configuration — operating notes

Agent-facing notes for node topology, labels and taints. User-facing setup is in
[`docs/install-k3s.md`](../docs/install-k3s.md) and
[`docs/configuration.md`](../docs/configuration.md#node-topology-labels-and-taints).

## Source of truth

Node topology, labels and taints live in `orangelab:nodes` in the core stack
config. The map key is also the node's identity: every installer passes
`--node-name=<key>`, so a node registers under its config key instead of
whatever the OS reports as hostname (ZimaOS and DHCP-configured hosts often
report an IP address). The labels and taints are applied in two steps:

1. The `scripts/k3s-server.sh` and `scripts/k3s-agent.sh` installers (plus the
   Alpine/Zima wrappers) read the map through `scripts/node-config.sh` and pass
   taints and kubelet-safe labels to k3s as `--node-taint` / `--node-label`.
2. After the node is Ready, `scripts/k3s-label-node.sh <node>` applies the
   node's `node-role.kubernetes.io/*` labels through the Kubernetes API.

kubelet rejects `node-role.kubernetes.io/*` labels on `--node-label` because the
`kubernetes.io` namespace is reserved; a node must not assign itself a role.
The API step sets them, which keeps the ROLES column in `kubectl get nodes` and
Headlamp working. Do not pass role labels to the installer.

Taints and kubelet-safe labels stay in the installer so they are present before
the node becomes schedulable. kubelet re-applies its flags on every start, so an
API edit to an installer-managed label or taint is not persistent. The label
script intentionally handles only role labels.

- Do not edit `/etc/rancher/k3s/config.yaml`: a k3s uninstall wipes it.
- Do not add a Pulumi resource or dynamic provider that patches nodes. The
  install and label scripts are the single application path.
- The node must be in `orangelab:nodes` before the installer runs. A missing
  entry fails with `Node '<node>' is not defined in orangelab:nodes`; a defined
  but empty entry installs with no extra labels/taints.
- Re-run `scripts/k3s-label-node.sh <node>` after changing role labels. Re-run
  the installer after changing taints or kubelet-safe labels, so the kubelet
  flags match. Removing an entry does not remove labels or taints from an
  already-installed node.

## Debugging a failed agent start

When `k3s-agent` is crash-looping after an install:

```sh
systemctl status k3s-agent
journalctl -u k3s-agent -n 100 | grep -E "failed to validate kubelet flags|Error"
systemctl cat k3s-agent
```

The journal logs the kubelet command line. Compare it with the last working
start; a newly added flag that kubelet rejects is the usual regression. A
`node-role.kubernetes.io/*` label in `--node-label` is the common cause because
the `kubernetes.io` namespace is reserved.

Remove the offending flag from the unit, then:

```sh
systemctl daemon-reload
systemctl restart k3s-agent
```

A hand-edited unit is a recovery step only; the next installer run overwrites
it. Fix `orangelab:nodes` or `node-config.sh` so the generated unit is correct,
then re-run the installer.

## Changing the installers

The installers are bootstrap-critical: a bad flag prevents the agent from
starting and takes the node out of the cluster. Before rolling out a change:

1. Run the generator for every node in `orangelab:nodes`, not just the target:
   `scripts/k3s-server.sh <node>` / `scripts/k3s-agent.sh <node>` (plus the
   Alpine/Zima wrappers).
2. Check the printed flags: no `--node-label=node-role.kubernetes.io/*`, taints
   present, zone and custom labels correct.
3. Roll out one node at a time, starting with a non-critical node, and verify
   `kubectl get node <node>` is `Ready` before the next.

Run `shellcheck` on the changed scripts after changing `node-config.sh` or the
installers.

## Taints, labels and tolerations

- Labels/affinity **pull** a workload onto a node.
- Taints **repel** every pod without a matching toleration.
- Tolerations **permit** a pod through a taint; they do not pin it.

To reserve a node for one workload class, pair the taint + toleration (exclusion
and admission) with the label that already identifies the node — zone, NFD GPU
label, or hostname. A dedicated label is unnecessary when another target label
exists.

Use values when one key distinguishes roles:

- taint `orangelab/dedicated=<role>:NoSchedule`
- app toleration `orangelab/dedicated=<role>:NoSchedule` (`Equal`)
- infrastructure toleration `orangelab/dedicated:NoSchedule` (`Exists`, any value)

A key-only taint (`orangelab/dedicated:NoSchedule`) is enough for a single
reserved node; values let you scope app tolerations to a role.

Label/taint keys follow Kubernetes qualified-name rules. `orangelab.space/<key>`
is the idiomatic fully-qualified form; the repo uses the existing
`orangelab/<key>` prefix. Keep one convention; migrate all keys together if that
changes.

## Applying tolerations

`<app>:tolerations` is read by the library's container, database and
init-container helpers. It is **not** injected into Helm charts, custom
resources, or raw Jobs/Pods created by a component. Pass it explicitly to chart
values, resource profiles and pod specs:

- Helm chart: `tolerations: this.app.nodes.getTolerations()` in the values.
- Raw Job/DaemonSet: `tolerations` on the pod spec.
- Controller-created pods: the chart/profile field (e.g. KubeAI resource
  profiles).

A missing toleration on one of these shows up as `0/N nodes are available: ...
had untolerated taint(s)`, even though the app-level config is set.

## Changing a taint value

Update the taint in `orangelab:nodes` and re-run the node's install script
(`scripts/k3s-server.sh <node>` or `scripts/k3s-agent.sh <node>`). kubelet
re-applies the installer's taints on every start, so a `kubectl taint` or
`kubectl patch` change is not persistent.

If you must repair a taint manually, note that
`kubectl taint node <node> key=old:NoSchedule-` removes all taints with that key
and effect, not just the matching value.

Then update the app tolerations and any infrastructure tolerations that must run
on the node (Longhorn, NFD, Beszel, node-exporter, Prometheus).

## SELinux and host paths

On SELinux nodes a root container still gets `permission denied` writing a
hostPath when the file label does not match. Pods created by `Application` with
local storage get `seLinuxOptions: { type: 'spc_t' }` automatically. Raw Jobs,
Helm-chart pods and controller-created pods that mount a hostPath or node-local
PVC must set it themselves:

```yaml
securityContext:
    seLinuxOptions:
        type: spc_t
```

KubeAI's model loader Job failed with `mkdir /model/blobs: permission denied`
on Fedora until the loader and model server pods used `spc_t`.

## Secrets

`scripts/k3s-agent.sh` output and `/etc/systemd/system/k3s-*.service` contain
the cluster token. Do not paste them into chat, issues or commits.
