#!/bin/bash
set -euo pipefail

# Usage: ./scripts/firewall-fedora.sh
# Run this script where Pulumi is configured.
# Copy and execute the output on each Fedora node (k3s server and agents).

CLUSTER_CIDR=$(pulumi config get k3s:clusterCidr)
SERVICE_CIDR=$(pulumi config get k3s:serviceCidr)

echo "export CLUSTER_CIDR=$CLUSTER_CIDR"
echo "export SERVICE_CIDR=$SERVICE_CIDR"
# Nodes installed without firewalld have nothing to open; skip instead of failing.
echo 'command -v firewall-cmd >/dev/null || { echo "firewalld is not installed on this node; nothing to apply." >&2; exit 0; }'
# shellcheck disable=SC2016 # evaluated on the target node
echo export ZONE='$(firewall-cmd --get-default-zone)'
echo
echo "firewall-cmd --permanent --zone=\$ZONE --add-source=\$CLUSTER_CIDR"
echo "firewall-cmd --permanent --zone=\$ZONE --add-source=\$SERVICE_CIDR"
echo "firewall-cmd --permanent --zone=\$ZONE --add-port=6443/tcp"
echo "firewall-cmd --permanent --zone=\$ZONE --add-port=10250/tcp"
echo "firewall-cmd --permanent --zone=\$ZONE --add-port=41641/udp"
# Flannel VXLAN runs inside tailscale0. Without this port, nodes register but
# cross-node pod traffic and ClusterIPs time out.
echo "firewall-cmd --permanent --zone=\$ZONE --add-port=8472/udp"
echo "firewall-cmd --permanent --zone=\$ZONE --add-interface=tailscale0"
echo
echo firewall-cmd --reload
