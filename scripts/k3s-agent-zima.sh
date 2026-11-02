#!/bin/bash
set -euo pipefail

# Usage: ./scripts/k3s-agent-zima.sh <node-name> <tailscale-ip>
# Run this script where Pulumi is configured (jq required).
# Copy and execute the output on the ZimaOS Kubernetes agent.

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
NODE_NAME=${1:-}
NODE_IP=${2:-}
if [ -z "$NODE_NAME" ] || [ -z "$NODE_IP" ]; then
    echo "Usage: $0 <node-name> <tailscale-ip>" >&2
    exit 1
fi
# shellcheck source=scripts/node-config.sh
source "$SCRIPT_DIR/node-config.sh" "$NODE_NAME"

echo \# Prerequisite: Complete all steps in docs/install-linux-zima.md first.
echo

K3S_URL=https://$(pulumi config get k3s:serverIp):6443
K3S_TOKEN=$(pulumi config get k3s:agentToken)

echo "export K3S_URL=$K3S_URL"
echo "export NODE_IP=$NODE_IP"
echo "export K3S_TOKEN=$K3S_TOKEN"
echo "export K3S_DATA_DIR=/DATA/k3s"
echo
echo "curl -sfL https://get.k3s.io | sudo -E INSTALL_K3S_BIN_DIR=/opt/bin sh -s - \
--server \$K3S_URL \
--token \$K3S_TOKEN \
--bind-address=0.0.0.0 \
--flannel-iface=tailscale0 \
--node-ip=\$NODE_IP \
--selinux$NODE_ARGS"
echo
echo sudo systemctl restart k3s-agent.service
echo sudo systemctl enable k3s-agent.service --now
echo
echo "# After the node is Ready, apply its role labels (Pulumi and kubectl required):"
echo "# $SCRIPT_DIR/k3s-label-node.sh $NODE_NAME"
