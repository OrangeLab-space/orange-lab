# K3s node configuration — operating notes

Agent-facing notes for node topology, labels and taints. User-facing setup is in
[`docs/install-k3s.md`](../docs/install-k3s.md) and
[`docs/configuration.md`](../docs/configuration.md#node-topology-labels-and-taints).

## Source of truth

Node topology, labels and taints live in `orangelab:nodes` in the core stack
config. They are applied by the `scripts/k3s-server.sh` and
`scripts/k3s-agent.sh` installers (plus the Alpine/Zima wrappers), which read the
map through `scripts/node-config.sh` and pass `--node-label` / `--node-taint` to
the k3s installer.

- Do not edit `/etc/rancher/k3s/config.yaml`: a k3s uninstall wipes it.
- Do not add a Pulumi resource or dynamic provider that patches nodes. The
  install scripts are the single application path.
- The node must be in `orangelab:nodes` before the installer runs. A missing
  entry fails with `Node '<node>' is not defined in orangelab:nodes`; a defined
  but empty entry installs with no extra labels/taints.
- Re-run the installer after changing the map. Removing an entry does not remove
  labels or taints from an already-installed node.

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

`kubectl taint node <node> key=old:NoSchedule-` removes all taints with that key
and effect, not just the matching value. Patch the full taints array instead:

```sh
kubectl patch node <node> --type=merge \
  -p '{"spec":{"taints":[{"key":"key","value":"new","effect":"NoSchedule"}]}}'
```

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
