#!/bin/bash
set -euo pipefail

# Run this script on each Fedora node (k3s server and agents).
# Copy it to the node or run remotely: ssh root@<node> bash -s < scripts/firewall-fedora.sh
#
# CIDRs are read from Pulumi config so they match the cluster the node joins.
# Override them when running on the node itself, where Pulumi is not available:
#   CLUSTER_CIDR=10.52.0.0/16 SERVICE_CIDR=10.53.0.0/16 bash scripts/firewall-fedora.sh

CLUSTER_CIDR=${CLUSTER_CIDR:-$(pulumi config get k3s:clusterCidr 2>/dev/null || true)}
SERVICE_CIDR=${SERVICE_CIDR:-$(pulumi config get k3s:serviceCidr 2>/dev/null || true)}

if [ -z "$CLUSTER_CIDR" ] || [ -z "$SERVICE_CIDR" ]; then
    echo "Set CLUSTER_CIDR and SERVICE_CIDR, or run where Pulumi config is available." >&2
    exit 1
fi

ZONE=$(firewall-cmd --get-default-zone)

firewall-cmd --permanent --zone=$ZONE --add-source=$CLUSTER_CIDR
firewall-cmd --permanent --zone=$ZONE --add-source=$SERVICE_CIDR
firewall-cmd --permanent --zone=$ZONE --add-port=6443/tcp
firewall-cmd --permanent --zone=$ZONE --add-port=10250/tcp
firewall-cmd --permanent --zone=$ZONE --add-port=41641/udp
firewall-cmd --permanent --zone=$ZONE --add-interface=tailscale0

firewall-cmd --reload
