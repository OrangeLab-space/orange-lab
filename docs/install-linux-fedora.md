# Installation - Fedora Node Configuration

Fedora-specific steps for joining a K3s cluster. For general node configuration (firewall, swap, suspend settings, storage mounts), see [Installation - Node Configuration](./install-linux.md).

Plain Fedora needs none of the workarounds required by [Alpine](./install-linux-alpine.md) — cgroups v2 with the memory controller, shared mount propagation on `/`, and SELinux are all enabled by default.

## Tailscale

Unlike Bluefin, plain Fedora does not ship Tailscale. It is in the Fedora repositories, so no third-party repository setup is required (unlike Alpine):

```sh
sudo dnf install -y tailscale
sudo systemctl enable --now tailscaled
```

Then authenticate as described in [Tailscale](./install-linux.md#tailscale).

## iSCSI (minimal installs)

Longhorn requires `iscsid` and `iscsiadm`, which Fedora packages as `iscsi-initiator-utils`. This is preinstalled on Fedora Workstation and Bluefin, but missing on minimal and Server installs:

```sh
sudo dnf install -y iscsi-initiator-utils
```

Note the package name differs from `open-iscsi`, which Alpine and Debian use.

## K3s Agent

No Fedora-specific script is needed — use [`scripts/k3s-agent.sh`](../scripts/k3s-agent.sh) as described in [Installation - K3S cluster](./install-k3s.md). SELinux is supported directly, the script passes `--selinux`.