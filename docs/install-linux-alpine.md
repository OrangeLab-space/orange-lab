# Installation - Alpine Linux Node Configuration

Alpine-specific steps for joining a K3s cluster. For general node configuration (Tailscale auth, swap reasoning, SSH key setup), see [Installation - Node Configuration](./install-linux.md).

## OS Installation

Download Alpine Standard ISO from https://alpinelinux.org/downloads/ (x86_64) and flash to USB using Fedora Media Writer or:

```sh
sudo dd if=alpine-standard-*.iso of=/dev/sdX bs=4M conv=fsync
```

Boot from USB, login as `root` (no password), then run the interactive installer:

```sh
setup-alpine
```

- **Disk mode**: `sys` (traditional disk install)
- **SSH**: enabled by default during setup
  - **Important**: When asked about root SSH access, you have two valid options:
    1. **`yes`** (simplest): Allow root password login, then use `ssh-copy-id` to set up key-based auth (recommended)
    2. **`prohibit-password`**: Only key-based auth for root — **you MUST create a regular user** or you'll be locked out
- **Swap**: setup-alpine may create a swap partition — see [Disable swap](#disable-swap) to remove

Remove USB and reboot after installation completes.

## System Setup

```sh
apk update && apk upgrade
apk add nano curl iptables ip6tables dbus
rc-update add dbus default
rc-service dbus start
```

### (Recommended) SSH key setup

If you chose `yes` for root SSH access during setup (allowing password login), copy your SSH key from the management node:

```sh
ssh-copy-id -i ~/.ssh/orangelab root@<node>
```

After the key is copied, revert root to `prohibit-password` for security:

```sh
nano /etc/ssh/sshd_config
# Change: PermitRootLogin yes  →  PermitRootLogin prohibit-password
rc-service sshd reload
```

For full details, see [SSH connection](./install-ssh.md).

### cgroups (required)

K3s requires memory cgroup. Alpine does not enable it by default.

Enable the cgroups service:

```sh
rc-update add cgroups default
```

Edit kernel parameters:

```sh
nano /etc/update-extlinux.conf
# Append: cgroup_memory=1 cgroup_enable=memory to default_kernel_opts
update-extlinux
reboot
```

Verify after reboot: `cat /proc/cgroups | grep memory`

### Shared mount (required for Longhorn)

Longhorn requires the root filesystem to be mounted as shared. Alpine does not set this default.

```sh
mount --make-shared /
mkdir -p /etc/local.d
echo '#!/bin/sh
mount --make-shared /' > /etc/local.d/shared-mount.start
chmod +x /etc/local.d/shared-mount.start
rc-update add local default
```

Verify: `mount | grep '/ type shared'`

### Disable swap

```sh
swapoff -a
nano /etc/fstab
# Comment out or remove the swap line
```

Verify: `free -h` — swap line should show 0 used.

## Tailscale

Install and start Tailscale (community repo required):

```sh
setup-apkrepos -c -1
apk add tailscale tailscale-openrc
rc-update add tailscale default
rc-service tailscale start
```

For Tailscale authentication options (auth key, tags, hostname), see [Tailscale](./install-linux.md#tailscale).

### Tailscale network dependency

Tailscale may fail to start at boot on WiFi nodes where DHCP takes longer. The `supervise-daemon` gives up after retries before the network is ready. Edit `/etc/init.d/tailscale`:

```sh
nano /etc/init.d/tailscale
```

Add after the existing variable definitions:

```sh
: ${respawn_max:=0}
```

This sets unlimited retries so Tailscale keeps trying until the network is available.

## K3s Agent

Before running the install script, add the node to `orangelab:nodes` (including `orangelab/alpine=true`). Then run `scripts/k3s-agent-alpine.sh <node-name>` on the management node and copy the output to the Alpine node.

### Node labels

The `orangelab/alpine=true` label in `orangelab:nodes` lets workloads identify this OS. See [Node topology, labels and taints](./configuration.md#node-topology-labels-and-taints).

### K3s agent Tailscale dependency

When Tailscale restarts (auto-updates ~monthly), the `tailscale0` interface is recreated which can break flannel networking. This is a [known issue](https://github.com/k3s-io/k3s/issues/12436) fixed in K3s 2026-06 release cycle.

To work around the issue on older K3s versions, edit `/etc/init.d/k3s-agent` and add `need tailscale` to the `depend()` function:

```sh
nano /etc/init.d/k3s-agent
```

Change:

```sh
depend() {
    after network-online
    want cgroups
}
```

To:

```sh
depend() {
    after network-online
    want cgroups
    need tailscale
}
```
