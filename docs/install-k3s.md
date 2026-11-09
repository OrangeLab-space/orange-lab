# Installation - Kubernetes nodes (K3S)

This document covers K3s installation and configuration. For general node preparation, see [Installation - Linux node configuration](./install-linux.md).

# Installation - K3S server

Server has to be installed before any other nodes can be added.

Kubernetes server should be installed on a machine that's online 24/7 but it's not required - running everything on a single laptop will work, however the availability of services will be limited.

Installing server will also run an agent node on the same machine.

## K3S server

`k3s-server.sh` executed on _management node_ generates script to install K3S on _server node_:

```sh
# Run where Pulumi is installed
./scripts/k3s-server.sh <server-node>

# Copy the generated script

# Login to server node and paste generated script:
ssh root@<server-node>
```

Check is the service is running:

```sh
systemctl status k3s.service
```

The server should also create two files:

- `/var/lib/rancher/k3s/server/token` - server token, needed by agents to connect
- `/etc/rancher/k3s/k3s.yaml` - kubeconfig file, copy to your `~/.kube/config`

> **Headscale**: before the first reboot, install the boot guard on the server —
> `./scripts/k3s-node-ip-guard-install.sh k3s` — and paste the output there. Use
> `k3s-agent` on agent nodes. Not needed with Tailscale's coordination server.
> If control DNS points at a public VPS proxy, also pin the `headscale` and
> `login` hostnames to the server's LAN address in `/etc/hosts` first, or the
> server cannot reach its own control plane while it restarts.
> See [Headscale](../components/network/headscale/headscale.md#server-reboots).

## Save server configuration

Add the tailscale IP of the server to Pulumi configuration:

```sh
# localhost
pulumi config set k3s:serverIp $(tailscale ip -4)

# Remote host. Find IP with 'tailscale status'
pulumi config set k3s:serverIp <server_ip>
```

Add generated agent token to Pulumi configuration as secret:

```sh
# localhost
export K3S_TOKEN=$(sudo cat /var/lib/rancher/k3s/server/node-token)

 # SSH remote node
export K3S_TOKEN=$(ssh root@<node> cat /var/lib/rancher/k3s/server/node-token)

pulumi config set k3s:agentToken $K3S_TOKEN --secret
```

## Kube config for admin

```sh
# copy kubeconfig from server to your management node
scp <user>@<k8s-server>:/etc/rancher/k3s/k3s.yaml ~/.kube/config

# point it at the server's tailnet address (same value as k3s:serverIp)
kubectl config set-cluster default \
  --server="https://$(pulumi config get k3s:serverIp):6443"
```

The generated file points at `127.0.0.1:6443`, which only works on the server.
Use the **tailnet** address, not the LAN address: the LAN address comes from DHCP
and moves, and a stale one makes `kubectl`, Pulumi and Headlamp hang instead of
failing. Run the last command from the stack folder.

# Installation - K3S agents

Install K3S agent nodes on any additional physical hardware. Server already runs an agent.

## K3S agent

`k3s-agent.sh` executed on _management node_ generates script to install K3S on _agent node_:

> **Alpine nodes**: Use `./scripts/k3s-agent-alpine.sh` instead. See [Alpine Linux node configuration](./install-linux-alpine.md) for preparation steps.
>
> **Zimaboard (ZimaOS) nodes**: Use `./scripts/k3s-agent-zima.sh` instead. See [Zimaboard node configuration](./install-linux-zima.md) for preparation steps.
>
> **Fedora nodes**: The standard script works as-is. See [Fedora node configuration](./install-linux-fedora.md) for package setup.

```sh
# Run where Pulumi is installed
./scripts/k3s-agent.sh <agent-node>

# Copy the generated script

# Login to agent node and paste generated script:
ssh root@<agent-node>
```

Check is the service is running:

```sh
systemctl status k3s-agent.service    # Fedora/Bluefin
rc-service k3s-agent status           # Alpine
```

## Node labels and taints

Node labels and taints are defined in `orangelab:nodes` in the core stack
config. Add the node's zone, labels and taints to the map **before** running
the install script; the installer applies taints and kubelet-safe labels. After
the node is Ready, run `scripts/k3s-label-node.sh <node>` to apply role labels
such as `node-role.kubernetes.io/longhorn=true` through the API (kubelet refuses
them on `--node-label`). See
[Node topology, labels and taints](./configuration.md#node-topology-labels-and-taints).

```yaml
orangelab:nodes:
    <node>:
        zone: <zone>
        labels:
            - node-role.kubernetes.io/longhorn=true
        taints:
            - orangelab/dedicated=<role>:NoSchedule
```

> Note: GPU nodes are automatically detected and labeled by the [Node Feature Discovery](/components/hardware/nfd/nfd.md) component.

> Note: The [Zot](/components/network/zot/zot.md) registry is an optional component that caches upstream images. Configuring nodes to use it as a mirror is a post-install step, described in the Zot docs. It is not part of K3s installation.
