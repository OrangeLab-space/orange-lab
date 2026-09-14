#!/bin/bash
set -euo pipefail

# Run this script on each Fedora node (k3s server and agents).
# Copy it to the node or run remotely: ssh root@<node> bash -s < scripts/firewall-fedora.sh

CLUSTER_CIDR=10.42.0.0/16
SERVICE_CIDR=10.43.0.0/16
ZONE=$(firewall-cmd --get-default-zone)

firewall-cmd --permanent --zone=$ZONE --add-source=$CLUSTER_CIDR
firewall-cmd --permanent --zone=$ZONE --add-source=$SERVICE_CIDR
firewall-cmd --permanent --zone=$ZONE --add-port=6443/tcp
firewall-cmd --permanent --zone=$ZONE --add-port=10250/tcp
firewall-cmd --permanent --zone=$ZONE --add-port=41641/udp
firewall-cmd --permanent --zone=$ZONE --add-interface=tailscale0

firewall-cmd --reload
