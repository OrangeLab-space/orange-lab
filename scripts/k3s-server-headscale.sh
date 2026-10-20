#!/bin/bash
set -euo pipefail

# Run this script where Pulumi is configured. Copy the generated commands to the
# node that runs both the k3s server and Headscale.
#
# Only a self-hosted control plane has this problem: k3s refuses to start until
# the node's mesh address exists, and tailscaled only receives that address once
# Headscale answers - which needs k3s. With Tailscale's coordination server the
# address arrives before the cluster starts, so nothing is needed there.

NODE_IP=$(pulumi config get k3s:serverIp 2>/dev/null || true)
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

if [ -z "$NODE_IP" ]; then
    echo "Set k3s:serverIp first - it is the server node's mesh address." >&2
    exit 1
fi

echo export NODE_IP=$NODE_IP
echo
cat <<'EOF'
# Supply the node's mesh address before k3s starts, so a reboot does not depend
# on the control plane it is starting. See spec/headscale.md.
mkdir -p /usr/local/sbin
cat >/usr/local/sbin/k3s-node-ip-guard <<'GUARD'
EOF
cat "$SCRIPT_DIR/k3s-node-ip-guard.sh"
cat <<'EOF'
GUARD
chmod 755 /usr/local/sbin/k3s-node-ip-guard

mkdir -p /etc/systemd/system/k3s.service.d
cat >/etc/systemd/system/k3s.service.d/10-tailscale-address.conf <<CONF
[Unit]
Wants=tailscaled.service
After=tailscaled.service

[Service]
ExecStartPre=/usr/local/sbin/k3s-node-ip-guard $NODE_IP
CONF
systemctl daemon-reload
EOF
