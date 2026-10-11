#!/bin/bash
set -euo pipefail

# Run this script where Pulumi is configured.
# Copy and execute the output on each Kubernetes agent.

K3S_URL=https://$(pulumi config get k3s:serverIp):6443
K3S_TOKEN=$(pulumi config get k3s:agentToken)

echo export K3S_URL=$K3S_URL
echo export NODE_IP='$(tailscale ip -4)'
echo export K3S_TOKEN=$K3S_TOKEN
echo
echo "curl -sfL https://get.k3s.io |  sh -s - \
--server \$K3S_URL \
--token \$K3S_TOKEN \
--bind-address=0.0.0.0 \
--flannel-iface=tailscale0 \
--node-ip=\$NODE_IP \
--selinux"
echo
echo systemctl restart k3s-agent.service
echo systemctl enable k3s-agent.service --now
