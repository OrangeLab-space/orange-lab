# Installation - Node Configuration

This document covers general node configuration that should be done before installing K3s.

For Alpine-specific steps, see [Installation - Alpine Linux node configuration](./install-linux-alpine.md).
For Zimaboard (ZimaOS) steps, see [Installation - Zimaboard node configuration](./install-linux-zima.md).

## Tailscale

Start Tailscale service on each node that will be part of your cluster.

```sh
# Recommended for desktops, allows user to control Tailscale client with tray icon
sudo tailscale up --operator=$USER

# Recommended for servers, doesn't require logging in with user credentials
#
# Create auth key:
# https://login.tailscale.com/admin/settings/keys
#
# Disable key expiry for the node after joining:
# Admin Console → Machines → <node> → Disable key expiry
sudo tailscale up --auth-key=<auth-key> \
--advertise-tags orangelab \ # optional when key already has tags
--hostname <host> # override hostname provided by OS

# Advanced option
sudo tailscale up \
--operator=$USER \ # Designate current user as local operator
--reset \ # Reset all settings to their default values
--accept-routes \ # Accept routes from subnet routers
--advertise-exit-node # allow this host to be used as exit node
```

## Firewall

Fedora nodes run firewalld. Run these commands on the k3s server and each worker node (or copy-paste the equivalent [`scripts/firewall-fedora.sh`](../scripts/firewall-fedora.sh)):

```sh
firewall-cmd --permanent --add-source=10.42.0.0/16 # Pods
firewall-cmd --permanent --add-source=10.43.0.0/16 # Services
firewall-cmd --permanent --add-port=6443/tcp # API Server
firewall-cmd --permanent --add-port=10250/tcp # Kubelet metrics
firewall-cmd --permanent --add-port=41641/udp # Tailscale UDP
firewall-cmd --permanent --add-interface=tailscale0 # Pod traffic to tailnet addresses

systemctl reload firewalld
```

Binding `tailscale0` to the zone is required so firewalld allows forwarded pod traffic to tailnet addresses — without it, pods cannot reach other nodes' Tailscale IPs (e.g. metrics-server cannot scrape kubelets on remote nodes, coredns cannot reach Tailscale MagicDNS).

(Optional) Ports used by apps, open them on the node where the app runs:

```sh
firewall-cmd --permanent --add-port=9100/tcp # Prometheus metrics
firewall-cmd --permanent --add-port=45876/tcp # Beszel metrics
firewall-cmd --permanent --add-port=53/tcp  # Technitium DNS Zone transfers, DNSSEC
firewall-cmd --permanent --add-port=53/udp  # Technitium standard DNS queries

systemctl reload firewalld
```

In case of connectivity issues, try disabling the firewall:

```sh
systemctl disable firewalld.service --now
```

## (Recommended) Disable swap

It's recommended to disable swap memory when running Kubernetes as this helps with scheduling and reporting correct amount of resources available.

```sh
sudo swapoff -a
sudo systemctl mask dev-zram0.swap

# confirm swap is disabled
free -h
```

## (Optional) Mount Storage Disk

You can use "Gnome Disks" application or below commands.

Mount additional drives for application storage (used by Longhorn, RustFS, etc.):

```bash
# 1. Identify the disk
lsblk -f

# 2. Format disk with a label (replace <drive-label> and /dev/nvme0n1)
# This creates the label AND the /dev/disk/by-label/<drive-label> symlink
sudo mkfs.ext4 -L <drive-label> /dev/nvme0n1

# 3. Create mount point and mount using label
sudo mkdir -p /mnt/<mount>
sudo mount /dev/disk/by-label/<drive-label> /mnt/<mount>

# 4. Add to fstab for persistence
echo '/dev/disk/by-label/<drive-label> /mnt/<mount> auto nosuid,nodev,x-gvfs-show 0 0' | sudo tee -a /etc/fstab
```

**Security options:** `nosuid` and `nodev` for security hardening; `x-gvfs-show` to show in file manager. Add `nofail` for USB/removable drives.

**Example:**

```bash
lsblk
sudo mkfs.ext4 -L 4TBDrive /dev/nvme0n1
sudo mkdir -p /mnt/4TBDrive
sudo mount /dev/disk/by-label/4TBDrive /mnt/4TBDrive
echo '/dev/disk/by-label/4TBDrive /mnt/4TBDrive auto nosuid,nodev,x-gvfs-show 0 0' | sudo tee -a /etc/fstab
```

## (Optional) Disable suspend

### Server

```sh
# Disable all sleep modes
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
```

### Laptop

#### Ignore lid close

To disable suspend mode when laptop lid is closed while on AC power, edit `/etc/systemd/logind.conf` and uncomment these lines

```conf
HandleLidSwitch=suspend
HandleLidSwitchExternalPower=ignore
HandleLidSwitchDocked=ignore
```

If the file doesn't exist, copy it `cp /usr/lib/systemd/logind.conf /etc/systemd/` then edit.

Restart service with `sudo systemctl reload systemd-logind.service`

#### Don't suspend when on AC power

Turn off suspend mode when on AC power. The setting in Gnome UI (Settings -> Power -> Automatic Suspend -> "When Plugged In") only applies when you're logged in, but not on login screen. You can check current settings with:

```sh
# Check current settings
sudo -u gdm dbus-run-session gsettings list-recursively org.gnome.settings-daemon.plugins.power | grep sleep

# Output example: org.gnome.settings-daemon.plugins.power sleep-inactive-ac-timeout 900

# Disable suspend mode on AC power:
sudo -u gdm dbus-run-session gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-timeout 0
```
