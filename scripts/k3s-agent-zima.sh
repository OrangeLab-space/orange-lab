#!/bin/bash
set -euo pipefail

# Run this script where Pulumi is configured.
# Copy and execute the output on each Kubernetes agent.
#
echo \# Prerequisite: Complete all steps in docs/install-linux-zima.md first.
echo

if [ -z "${1:-}" ]; then
  echo "Usage: $0 <tailscale-ip>" >&2
  exit 1
fi

K3S_URL=https://$(pulumi config get k3s:serverIp):6443
K3S_TOKEN=$(pulumi config get k3s:agentToken)

echo export K3S_URL=$K3S_URL
echo export NODE_IP=$1
echo export K3S_TOKEN=$K3S_TOKEN
echo export K3S_DATA_DIR=/DATA/k3s
echo
echo "curl -sfL https://get.k3s.io | sudo -E INSTALL_K3S_BIN_DIR=/opt/bin sh -s - \
--server \$K3S_URL \
--token \$K3S_TOKEN \
--bind-address=0.0.0.0 \
--flannel-iface=tailscale0 \
--node-ip=\$NODE_IP \
--selinux"
echo
echo sudo systemctl restart k3s-agent.service
echo sudo systemctl enable k3s-agent.service --now
