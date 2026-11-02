#!/bin/bash
set -euo pipefail

# Usage: ./scripts/k3s-agent-alpine.sh <node-name>
# Run this script where Pulumi is configured (jq required).
# Copy and execute the output on the Alpine Kubernetes agent.

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
NODE_NAME=${1:-}
if [ -z "$NODE_NAME" ]; then
    echo "Usage: $0 <node-name>" >&2
    exit 1
fi
# shellcheck source=scripts/node-config.sh
source "$SCRIPT_DIR/node-config.sh" "$NODE_NAME"

echo \# Prerequisite: Complete all steps in docs/install-linux-alpine.md first.
echo

K3S_URL=https://$(pulumi config get k3s:serverIp):6443
K3S_TOKEN=$(pulumi config get k3s:agentToken)

echo "export K3S_URL=$K3S_URL"
# shellcheck disable=SC2016 # evaluated on the target node
echo export NODE_IP='$(tailscale ip -4)'
echo "export K3S_TOKEN=$K3S_TOKEN"
echo
echo "curl -sfL https://get.k3s.io |  sh -s - \
--server \$K3S_URL \
--token \$K3S_TOKEN \
--bind-address=0.0.0.0 \
--flannel-iface=tailscale0 \
--node-ip=\$NODE_IP$NODE_ARGS"
echo
echo rc-service k3s-agent start
echo rc-update add k3s-agent default
echo
echo "# After the node is Ready, apply its role labels (Pulumi and kubectl required):"
echo "# $SCRIPT_DIR/k3s-label-node.sh $NODE_NAME"
