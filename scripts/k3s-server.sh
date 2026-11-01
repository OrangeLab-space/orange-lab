#!/bin/bash
set -euo pipefail

# Usage: ./scripts/k3s-server.sh <node-name>
# Run this script where Pulumi is configured (jq required).
# Copy and execute the output on the Kubernetes server.

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
NODE_NAME=${1:-}
if [ -z "$NODE_NAME" ]; then
    echo "Usage: $0 <node-name>" >&2
    exit 1
fi
# shellcheck source=scripts/node-config.sh
source "$SCRIPT_DIR/node-config.sh" "$NODE_NAME"

CLUSTER_CIDR=$(pulumi config get k3s:clusterCidr)
SERVICE_CIDR=$(pulumi config get k3s:serviceCidr)

# shellcheck disable=SC2016 # evaluated on the target node
echo export NODE_IP='$(tailscale ip -4)'
echo "export NODE_NAME='$NODE_NAME'"
# shellcheck disable=SC2016 # evaluated on the target node
echo export LAN_IP='$(hostname -I | cut -d" " -f1)'
echo "export CLUSTER_CIDR=$CLUSTER_CIDR"
echo "export SERVICE_CIDR=$SERVICE_CIDR"
echo
# bind-address listens on every interface so LAN clients can reach the API, while
# advertise-address stays on the tailnet address every node dials. The SAN list
# also carries the LAN IP as a recovery path if tailscaled is unavailable.
#
# The toleration seconds decide when pods on an unreachable node are evicted:
# 40s lease + 40s grace + toleration. A node behind a flaky WAN link drops out
# for a few minutes at a time, so 180s keeps its pods (and the longhorn
# instance-manager) alive through those stalls instead of evicting them every
# few minutes. Upstream default is 300s; 180s keeps failover reasonably quick.
echo "curl -sfL https://get.k3s.io |  sh -s - \
--bind-address=0.0.0.0 \
--advertise-address=\$NODE_IP \
--node-ip=\$NODE_IP \
--tls-san=\$NODE_IP,\$NODE_NAME,\$LAN_IP \
--selinux \
--secrets-encryption \
--cluster-cidr=\$CLUSTER_CIDR \
--service-cidr=\$SERVICE_CIDR \
--flannel-iface=tailscale0 \
--disable=traefik \
--kube-apiserver-arg=default-not-ready-toleration-seconds=180 \
--kube-apiserver-arg=default-unreachable-toleration-seconds=180$NODE_ARGS"
echo
echo systemctl restart k3s.service
echo systemctl enable k3s.service --now
