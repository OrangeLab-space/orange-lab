# Migrating nodes to Headscale

Moving cluster nodes from Tailscale to a self-hosted Headscale control plane.

This is a **destructive, one-window operation**. Plan it as a maintenance window
and verify each phase before continuing.

## Overview

OrangeLab can run its nodes against either a Tailscale control plane or a
self-hosted Headscale one. Both present the same client, so the migration is
about pointing nodes at a different control plane, not about installing
anything new. See [Networking](../components/network/NETWORK.md) for choosing
between them.

Headscale cannot pre-assign node addresses, so every node comes back with a new
address. Service DNS is repointed at the end rather than addresses being
preserved beforehand.

## Before you start

- Headscale is deployed and reachable. `https://headscale.<domain>/health`
  returns `200`.
- `k3s:serverIp` points at the current control-plane node's tailnet address.
  It is consumed by both the k3s server flags and every agent script, so it
  must be updated before the agents are brought back.
- The apiserver is reachable **without either mesh**, otherwise there is no
  path to use during the migration. See
  [Expose the apiserver](#expose-the-apiserver).
- You know the LAN address of every node. Nothing in the cluster can report it:
  kubelet publishes only the tailnet address, and `hostNetwork` pods still get
  that same address filled in. Record these before starting.

## Key concepts

**A node belongs to one control plane.** There is no "join both". Removing
Tailscale removes the interface that carries the node's identity, so re-joining
elsewhere is a fresh registration with a new address — not a restore. This is
why the migration is all-at-once rather than staged per node.

**The control-plane node must move first.** Every agent's k3s config carries
`--server` pointing at it. Nothing else can rejoin until it is on the new
control plane, and it cannot get there until the agents can reach it. This is
the central constraint of the whole procedure.

**Headscale has no equivalent of `tailscale serve`.** With
`routingProvider: traefik` nothing depends on it, but a cluster using the
Tailscale routing provider would lose that function in the migration.

## Procedure

### 1. Mint a preauth key

```sh
./components/network/headscale/exec-headscale.sh users list
./components/network/headscale/exec-headscale.sh \
    preauthkeys create --user <user-id> --reusable --expiration 24h
```

`--user` takes a numeric ID, not a username. Use `--reusable` so every node can
share one key, and set an expiration so an abandoned migration does not leave a
live credential behind.

Do this **first**: Headscale runs as a pod in the cluster being migrated, so it
must be reachable before you stop anything.

### 2. Cordon and stop the agents

Point your kubeconfig at the control plane's LAN address first:

```sh
kubectl config set-cluster default --server=https://<control-plane-lan-ip>:6443
kubectl get nodes
```

Preferring the mesh is the instinct, but it is unavailable here: once the
control-plane node is on Headscale, a machine still on Tailscale has no route to
it. The two are independent overlays and do not bridge.

```sh
for n in <agent-1> <agent-2>; do kubectl cordon "$n"; done
ssh root@<agent> 'systemctl stop k3s-agent'
```

### 3. Give the control-plane node a valid address

This is the step that is easy to miss. After logging out of Tailscale the k3s node
still carries the old `--node-ip`, which no longer exists.

> With an invalid `--node-ip`, flannel and kube-proxy stop programming the node,
> so **pod → ClusterIP traffic times out**. Longhorn cannot attach volumes, so
> pods stay in `ContainerCreating`, so Headscale cannot start — and Headscale is
> what the node needs in order to join. The node cannot reach the control plane
> it requires.

Assign the LAN address temporarily:

```sh
curl -sfL https://get.k3s.io | sh -s - \
    --bind-address=0.0.0.0 \
    --advertise-address=<lan-ip> --node-ip=<lan-ip> \
    --tls-san=<lan-ip>,<node-name> \
    --selinux --secrets-encryption \
    --cluster-cidr=<cluster-cidr> --service-cidr=<service-cidr> \
    --flannel-iface=<lan-interface> \
    --disable=traefik
systemctl restart k3s
```

This restores pod networking and Longhorn, which lets Headscale start.

> **Verify with `kubectl get nodes`, not `systemctl is-active k3s`.** The
> service reports `active` while the cluster is completely non-functional.

### 4. Join Headscale

Run this **over the LAN, detached**:

```sh
setsid nohup sh -c "tailscale up --login-server https://headscale.<domain> \
    --authkey=<key> --hostname <node> > /tmp/tsup.log 2>&1; \
    echo \$? > /tmp/tsup.done" </dev/null >/dev/null 2>&1 &

tailscale ip -4
```

Two reasons it must be detached: `tailscale logout` removes the address any SSH
session is riding on, killing the command mid-way, and it leaves the node at
`NeedsLogin` with nothing running the follow-up. Over the LAN the address does
not change under you.

Confirm the node registered and that Headscale is serving before continuing:

```sh
./components/network/headscale/exec-headscale.sh nodes list
curl -sk -o /dev/null -w "%{http_code}\n" https://headscale.<domain>/health
```

### 5. Switch the control plane to its new address

```sh
pulumi config set --stack <stack> k3s:serverIp <new-tailnet-ip>
./scripts/k3s-server.sh
```

Copy that script's **output** to the node and run it there. The substitutions
in it are single-quoted deliberately, so they evaluate where the output is
pasted — running the generator on a different machine silently produces that
machine's address and hostname.

Restart k3s. This step restores `--flannel-iface` to the tailnet interface and
puts the new address back in `--advertise-address`/`--node-ip`.

**Expect a brief public outage** if a single node runs the load balancer. Every
`LoadBalancer` service disappears together and returns on its own; no DNS or
router change is involved.

### 6. Verify

```sh
kubectl get nodes
kubectl get volumes.longhorn.io -n longhorn-system \
    --no-headers | awk '{print $4}' | sort | uniq -c
```

Compare the volume count against a baseline taken beforehand. Replicas
temporarily go offline during the restart and must all return.

### 7. Bring the agents back

One at a time, confirming each before starting the next:

```sh
./scripts/k3s-agent.sh      # review its output, then run it on the node
kubectl get nodes
kubectl uncordon <agent>
```

If the generator was produced with `k3s:serverIp` still at the old address,
regenerate it first.

### 8. Repoint DNS

One record changes: the wildcard covering your domain, from the control-plane
node's old tailnet address to its new one.

```sh
dig +short @<resolver> <app>.<domain>
```

If the wildcard covers subdomains at any depth, no other record needs
touching, and names under the mesh domain follow automatically.

> DNS **wildcards** and certificate **wildcards** behave differently. A
> certificate wildcard covers exactly one label, so `*.example.com` cannot
> present a valid certificate for `app.vpn.example.com` even though the name
> resolves. Name resolution and TLS matching are independent, and a route being
> `Accepted` says nothing about which certificate is served.

## Gotchas

**The registry mirror depends on the wildcard resolving to a live address.**
Containerd mirrors `docker.io` to your in-cluster registry, whose _name_
resolves through the wildcard to the control plane's tailnet address. The moment
that node leaves Tailscale, every image pull on it stalls against a black
hole. Repoint DNS, or override the name locally, before rejoining.

**A mutable image tag behind a pull-through cache can serve a stale build.**
`containerd` does not re-pull a tag it already has, so a cached build keeps
running even after the registry advertises a newer one. If an application
suddenly fails against its own database schema, compare the digest it is
actually running with the one the registry currently serves. Pin images by
digest for anything whose schema matters.

**`kubectl cordon` does not stop a kubelet.** A cordoned node still reports
`Ready` and still holds volumes. Stop the agent service if you need it actually
down.
