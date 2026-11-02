---
name: setup-k8s-node
description: Use when adding a Kubernetes agent node to OrangeLab — "add a node", "join a node to the cluster", "setup k8s node", "install k3s agent", "new worker node", or "connect a node to Headscale". Covers node identity and labels, OS preparation, mesh join, firewall, k3s agent, Headscale boot guard, and verification. Not for installing the k3s server, or for upgrading/removing an existing node.
---

# Set Up a Kubernetes Node

Adds an agent node to an existing k3s cluster. The server already exists; this
skill does not create one. It works for Fedora, Alpine, ZimaOS, and cloud
instances, with paths for both Headscale and Tailscale control planes.

## Rules

- **Never print secrets.** The k3s agent token and Headscale preauth key are
  credentials. Pipe generated scripts or transfer keys as files; never paste
  either into a chat, command line, or shell history.
- **Confirm before changing the cluster.** Joining a node, deleting a stale
  Headscale registration, and labelling are cluster changes. Ask first.
- **A node belongs to one control plane.** Headscale and Tailscale overlays do
  not bridge. If the machine was joined elsewhere, treat the move as the
  destructive cutover in [`docs/headscale-migration.md`](/docs/headscale-migration.md).
- **Use placeholders in committed text.** Do not put real hostnames, IPs, or
  machine names into docs, skills, or commit messages.

## 1. Decide identity and labels

Ask the user before touching the node. These choices are not recoverable by
guessing:

| Decision      | Guidance                                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Node name** | Hostname, Kubernetes node name, and Headscale name. Remove any stale Headscale registration first.                                                           |
| **Zone**      | A failure domain, not a location label. Same physical location means the same zone. Leave unset for temporary nodes. Longhorn spreads replicas across zones. |
| **Longhorn**  | Durable storage nodes only. A temporary node holding replicas causes degraded volumes when it leaves. Check free disk space under `/var/lib/longhorn`.       |
| **GPU**       | NFD labels GPUs automatically; do not label manually unless testing scheduling.                                                                              |

A temporary node usually gets **no zone** and **no Longhorn label**.

### GPU nodes

NFD only labels a GPU the node can see. The NVIDIA GPU Operator in this repo
sets `driver.enabled=false`, so it provides the toolkit, device plugin, and GFD
— not the host driver.

- **Cloud:** choose a GPU instance and install the NVIDIA driver on the node;
  verify `nvidia-smi` before joining.
- **Local VM:** pass the GPU through (VFIO) before boot and install the driver
  in the guest. Passthrough is exclusive: the host cannot use the GPU while the
  VM runs.
- **No GPU visible:** leave the node CPU-only and do not fake the label.

Once the PCI device is visible, NFD sets `orangelab/gpu-nvidia=true`; the
operator exposes `nvidia.com/gpu` with 4-way time-slicing.

## 2. Prepare the operating system

Commands below assume root over SSH. On cloud images with a non-root user,
prefix privileged commands with `sudo` and run piped scripts with `sudo bash -s`.

Set the hostname first, then install the mesh client. For Fedora:

```sh
hostnamectl set-hostname <node>
dnf install -y tailscale
# Only for a Longhorn node:
dnf install -y iscsi-initiator-utils
systemctl enable --now tailscaled
# Only for a Longhorn node:
systemctl enable --now iscsid.socket iscsid.service
```

If `iscsid.service` is still inactive, start it once; on Fedora the socket
usually activates it on demand.

Disable swap, as recommended in
[`docs/install-linux.md`](/docs/install-linux.md#recommended-disable-swap):

```sh
swapoff -a
systemctl mask dev-zram0.swap
```

On a Longhorn node, persist the kernel modules Longhorn checks for:

```sh
cat >/etc/modules-load.d/longhorn.conf <<'EOF'
dm_crypt
iscsi_tcp
EOF
modprobe dm_crypt iscsi_tcp
```

Other platforms: follow
[Alpine](/docs/install-linux-alpine.md) or
[Zimaboard](/docs/install-linux-zima.md); Fedora-specific notes are in
[`docs/install-linux-fedora.md`](/docs/install-linux-fedora.md).

## 3. Join the mesh

### Headscale

Read the control-plane hostname from the deployment, not from this skill. Mint a
short-lived preauth key tagged for cluster nodes. Keep it out of output:

```sh
umask 077
./components/network/headscale/exec-headscale.sh preauthkeys create \
    --tags tag:cluster --reusable --expiration 1h -o json \
    | jq -r .key > /tmp/node-authkey
test -s /tmp/node-authkey
scp /tmp/node-authkey root@<node>:/tmp/node-authkey
rm -f /tmp/node-authkey
```

On the node, join and immediately remove the key file:

```sh
ssh root@<node> 'chmod 600 /tmp/node-authkey
    tailscale up --login-server https://<headscale-host> \
        --authkey file:/tmp/node-authkey --hostname <node>
    rm -f /tmp/node-authkey'
```

Verify that the node is online and tagged `tag:cluster`:

```sh
./components/network/headscale/exec-headscale.sh nodes list
ssh root@<node> 'tailscale status; tailscale ip -4'
```

**Reusing a name:** if the old registration is still present, confirm it is
offline and absent from `kubectl get nodes`, then delete it by ID:

```sh
./components/network/headscale/exec-headscale.sh nodes list -o json \
    | jq '.[] | select(.given_name=="<node>") | {id, given_name, online}'
./components/network/headscale/exec-headscale.sh nodes delete -i <id> --force
```

### Tailscale

Omit `--login-server` and use a Tailscale auth key. Disable key expiry for a
server node afterward. Tagged cluster membership is controlled by the key's
tags, not by `tailscale up` flags.

## 4. Configure the host firewall

Run this **after** the mesh join, so `tailscale0` exists. The Fedora script reads
the cluster CIDRs from Pulumi when run in the repo, or from the environment when
run on the node:

```sh
ssh root@<node> 'CLUSTER_CIDR=<cluster-cidr> SERVICE_CIDR=<service-cidr> bash -s' \
    < scripts/firewall-fedora.sh
```

Verify the zone contains the tailnet interface, both cluster CIDRs, and these
ports:

```sh
ssh root@<node> 'firewall-cmd --list-all'
```

Required: `6443/tcp` (API), `10250/tcp` (kubelet), `41641/udp` (Tailscale), and
**`8472/udp` (flannel VXLAN)**. Without `8472/udp` the node still registers and
reports `Ready`, but cross-node pod traffic and ClusterIPs time out. The script
opens it;

On a cloud instance, also open the equivalent ports in the provider's security
group. The mesh encrypts node-to-node traffic, but the host firewall still sees
the VXLAN packets inside `tailscale0`.

## 5. Install the k3s agent

Run from the repo root with the correct stack selected. The script reads the
server address and agent token from Pulumi; piping avoids printing the token:

```sh
pulumi stack select <stack>
./scripts/k3s-agent.sh <node> | ssh root@<node> 'bash -s'
```

The node must already be in `orangelab:nodes`; add it in step 8 before running
this script.

Never run `pulumi config get k3s:agentToken` in an agent session. If the generated
script is written to a file instead, `chmod 600` it and delete it after use.

Check the service and wait for the node:

```sh
ssh root@<node> 'systemctl status k3s-agent --no-pager'
kubectl get nodes -o wide
```

## 6. Install the Headscale boot guard

With a self-hosted Headscale control plane, agents need the same boot guard as
the server. Tailscaled only receives the node's address after Headscale answers,
and Headscale runs inside the cluster k3s is starting; k3s refuses an address
that is not yet on an interface. The guard supplies it before every start:

```sh
./scripts/k3s-node-ip-guard-install.sh k3s-agent | ssh root@<node> 'bash -s'
```

Verify the drop-in contains the node's tailnet address:

```sh
ssh root@<node> 'cat /etc/systemd/system/k3s-agent.service.d/10-tailscale-address.conf'
```

With Tailscale's coordination server, skip this step: the address is back
before k3s starts. See [Boot order](/spec/headscale.md#boot-order).

## 7. Fedora + Tailscale nftables workaround

Recent Tailscale on Fedora defaults to nftables. K3s's network policy controller
then fails with:

```text
iptables-save v1.8.11 (nf_tables): Parsing nftables rule failed
Error: meta sreg is not an immediate
```

The node can still be `Ready`, but network-policy sync aborts every few seconds.
Force Tailscale to iptables mode:

```sh
ssh root@<node> 'mkdir -p /etc/systemd/system/tailscaled.service.d
cat >/etc/systemd/system/tailscaled.service.d/10-firewall-mode.conf <<EOF
[Service]
Environment="TS_DEBUG_FIREWALL_MODE=iptables"
EOF
systemctl daemon-reload
systemctl restart tailscaled'
```

Verify:

```sh
ssh root@<node> 'journalctl -u tailscaled -n 20 | grep "netfilter running in iptables mode"
iptables-save -t filter >/dev/null && echo OK'
```

Restart `k3s-agent` if its network policy controller was already failing. This
is a workaround for the current Tailscale/k3s combination; remove it once
upstream handles the nftables rules.

## 8. Add the node to the core stack config

Add the node's zone, labels and taints to `orangelab:nodes` in the core stack
config **before** running the install script. The installer applies taints and
kubelet-safe labels. After the node is Ready, run
`./scripts/k3s-label-node.sh <node>` to apply the role labels
(`node-role.kubernetes.io/*`; kubelet refuses them on `--node-label`).
Do not label or taint the node manually. If the node is already installed,
re-run the label script after changing role labels, or the installer after
changing taints or kubelet-safe labels.

```yaml
orangelab:nodes:
    <node>:
        zone: <zone>
        labels:
            - node-role.kubernetes.io/longhorn=true
        taints:
            - orangelab/dedicated=<role>:NoSchedule
```

```sh
# After the node is Ready
./scripts/k3s-label-node.sh <node>
```

A workload on a tainted node needs
`<app>:tolerations: orangelab/dedicated=<role>:NoSchedule`; keep
`requiredNodeLabel` to pin it. See
[Configuration](/docs/configuration.md#node-topology-labels-and-taints).

For a temporary node, remove its entry from `orangelab:nodes` so it is not
reapplied by the next install or label run; existing labels and taints are not
removed automatically.

Do not add GPU labels manually; NFD does that.

## 9. Verify

```sh
kubectl get nodes -o wide \
    -L topology.kubernetes.io/zone,node-role.kubernetes.io/longhorn,orangelab/gpu-nvidia
```

For a Headscale join, confirm the node is a cluster device, not a personal one:

```sh
tailscale status | grep <node>   # tagged-devices, not a user
./components/network/headscale/exec-headscale.sh nodes list -o json \
    | jq '.[] | select(.given_name=="<node>") | .tags'
```

The output must contain `tag:cluster`. If it is empty, the node was joined with
a personal key; fix it with `nodes tag` instead of re-registering (see
[`spec/headscale.md`](/spec/headscale.md)).

For a Longhorn node, confirm the node resource, disk, and pods:

```sh
kubectl get nodes.longhorn.io <node> -n longhorn-system
kubectl get pods -n longhorn-system -o wide | grep <node>
```

The node must be `Ready`, `Schedulable`, with a disk that has
`storageAvailable` greater than zero. `KernelModulesLoaded=False` usually means
`dm_crypt` or `iscsi_tcp` is missing; check `lsmod` on the host and see step 2.
On Fedora's usrmerge layout the Longhorn manager can report this falsely because
its container sees an empty `/lib/modules`; the node is still usable when
`Schedulable=True`.

Test pod-to-service traffic from the new node, especially if Longhorn is not
installed:

```sh
kubectl run netcheck --rm -i --restart=Never --image=busybox:1.36 \
    --overrides='{"spec":{"nodeName":"<node>"}}' -- nslookup kubernetes.default
```

If the node has the Headscale boot guard, reboot once and confirm it returns:

```sh
ssh root@<node> systemctl reboot
# wait for SSH, then:
kubectl get node <node> -o wide
kubectl get nodes.longhorn.io <node> -n longhorn-system
```

## Troubleshooting

| Symptom                                     | Check                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------- |
| Pods cannot resolve DNS or reach ClusterIPs | `8472/udp` open; `ip -s link show flannel.1` has RX; see step 4.                |
| DNS/ClusterIP fails with `8472/udp` open    | `tailscaled` drops `no rules matched`; node is under a user, not `tagged-devices`; tag it with `nodes tag`; see `spec/headscale.md`. |
| `iptables-save` nftables error              | Force Tailscale to iptables mode; see step 7.                                   |
| `NotReady` after reboot                     | Check tailscaled, k3s-agent, guard address, and `tailscale ip -4`; see step 6.  |
| Longhorn node missing or `Ready=False`      | Longhorn manager logs; check pod networking.                                    |
| No `orangelab/gpu-nvidia` label             | Check `lspci` and `nvidia-smi` on the node; NFD needs a visible GPU and driver. |
| `KernelModulesLoaded=False`                 | Check host `lsmod`; load `dm_crypt` and `iscsi_tcp`; see step 2.                |
| Headscale shows offline or stale duplicate  | Confirm it is the old registration, then delete by ID; see step 3.              |
| Tailscale address changed after a restart   | Reinstall the boot guard with the current address; see step 6.                  |

## References

- K3s installation: [`docs/install-k3s.md`](/docs/install-k3s.md)
- Node preparation and firewall: [`docs/install-linux.md`](/docs/install-linux.md)
- Fedora specifics: [`docs/install-linux-fedora.md`](/docs/install-linux-fedora.md)
- Headscale invariants and boot order: [`spec/headscale.md`](/spec/headscale.md)
- Longhorn operations: [`spec/longhorn.md`](/spec/longhorn.md)
