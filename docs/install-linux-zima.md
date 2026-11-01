# Installation - Zimaboard (ZimaOS) Node Configuration

ZimaOS-specific steps for joining a K3s cluster. For general node configuration, see [Installation - Node Configuration](./install-linux.md).

## Prerequisites

### Developer Mode (SSH)

SSH is disabled by default on ZimaOS. Enable it in **Settings → Developer → SSH** and set a password.

### System Configuration

Enable IP forwarding (required by K3s for pod networking):

```sh
echo 'net.ipv4.ip_forward = 1' | sudo tee -a /etc/sysctl.conf
echo 'net.ipv6.conf.all.forwarding = 1' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

See [Tailscale's performance tuning docs](https://tailscale.com/kb/1320/performance-best-practices#ethtool-configuration) for optional network interface optimizations.

### Network

You can switch active network with:

```sh
sudo nmtui
```

### Directories

```sh
sudo mkdir -p /opt/bin
sudo mkdir -p /DATA/k3s
sudo mkdir -p /media/<my-drive>/k3s # replace with folder on your external hard drive
```

## Tailscale

On ZimaOS, Tailscale is installed via the Zima App Store (**Networking -> Tailscale**) rather than on the host directly. It runs as a Docker container, so the `tailscale` CLI is not available on the host.

After installing and authenticating Tailscale through the App Store, find the node's Tailscale IP by inspecting the `tailscale0` interface on the host:

```sh
ifconfig tailscale0
# or
ip addr show tailscale0
```

You will need this IP when running the K3s agent script below.

Tailscale IP can also be found by opening the Tailscale application in ZimaOS dashboard.

## K3s Agent

Run [`scripts/k3s-agent-zima.sh`](../scripts/k3s-agent-zima.sh) on the management node, passing the node name and the Tailscale IP from the previous step:

```sh
./scripts/k3s-agent-zima.sh <node-name> <tailscale-ip>
```

Copy the generated output to the Zimaboard node and execute it.

The script configures K3s to use the `/DATA/k3s` directory (ZimaOS's data partition) and installs the binary to `/opt/bin` with SELinux enabled — these directories were created in the [Prerequisites](#prerequisites) section.

Check that the service is running:

```sh
systemctl status k3s-agent.service
```

On the management node make sure the node joined the cluster (Status=Ready):

```sh
kubectl get node
```

Now you're ready to install Longhorn. It will configure default disk as available for volumes. Go to Longhorn UI, remove the disk and add one pointing to your external hard drive (set path as /media/<my-drive>/longhorn depending what it is on your system).

## Node labels

Zimaboard nodes do not require a dedicated OS label (unlike Alpine nodes). However, they do need labels set to enable Longhorn storage.

See [Node labels](./install-k3s.md#node-labels) for details.
