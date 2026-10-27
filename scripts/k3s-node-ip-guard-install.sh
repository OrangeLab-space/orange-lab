#!/bin/bash
set -euo pipefail

# Run this script from the repo and paste the output on the node before
# rebooting it. Only a self-hosted control plane needs it: k3s pins
# --node-ip to the tailnet address, and tailscaled only receives that address
# once Headscale answers. With Tailscale's coordination server the address is
# back before k3s starts, so nothing is needed there.
#
# Usage: k3s-node-ip-guard-install.sh k3s|k3s-agent

UNIT=${1:?usage: k3s-node-ip-guard-install.sh k3s|k3s-agent}
case "$UNIT" in
    k3s|k3s-agent) ;;
    *) echo "unit must be k3s or k3s-agent, got '$UNIT'" >&2 && exit 1 ;;
esac
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

echo "export NODE_IP=\$(tailscale ip -4)"
echo
cat <<'EOF'
# Supply the node's tailnet address before k3s starts, so a reboot does not
# wait for a netmap the control plane may not be serving. See spec/headscale.md.
mkdir -p /usr/local/sbin
cat >/usr/local/sbin/k3s-node-ip-guard <<'GUARD'
EOF
cat "$SCRIPT_DIR/k3s-node-ip-guard.sh"
cat <<EOF
GUARD
chmod 755 /usr/local/sbin/k3s-node-ip-guard

mkdir -p /etc/systemd/system/${UNIT}.service.d
cat >/etc/systemd/system/${UNIT}.service.d/10-tailscale-address.conf <<CONF
[Unit]
Wants=tailscaled.service
After=tailscaled.service

[Service]
ExecStartPre=/usr/local/sbin/k3s-node-ip-guard \$NODE_IP
CONF
systemctl daemon-reload
EOF
