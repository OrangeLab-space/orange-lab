#!/bin/bash
set -euo pipefail

# Runs as an ExecStartPre for k3s.service. Installed by
# scripts/k3s-server-headscale.sh; not meant to be run on an agent node.
#
# K3s refuses to register a node whose --node-ip is not present on a host
# interface, and tailscaled only assigns that address once it has a netmap.
# On the node running the control plane the two wait for each other, so a
# reboot never converges: k3s needs the address, tailscaled needs the control
# plane, the control plane needs k3s.
#
# The address is already fixed in the k3s unit, so provide it here before k3s
# starts. Tailscaled adopts the same address when its netmap arrives, leaving
# one address on the interface rather than two.
#
# Usage: k3s-node-ip-guard.sh <mesh-address>

ADDRESS=${1:?usage: k3s-node-ip-guard.sh <mesh-address>}
INTERFACE=${INTERFACE:-tailscale0}
WAIT_SECONDS=${WAIT_SECONDS:-60}

if ! [[ $ADDRESS =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
    echo "k3s-node-ip-guard: '$ADDRESS' is not an IPv4 address" >&2
    exit 1
fi

for ((i = 0; i < WAIT_SECONDS; i++)); do
    ip link show "$INTERFACE" >/dev/null 2>&1 && break
    sleep 1
done

if ! ip link show "$INTERFACE" >/dev/null 2>&1; then
    echo "k3s-node-ip-guard: $INTERFACE did not appear within ${WAIT_SECONDS}s, is tailscaled running?" >&2
    exit 1
fi

if ! ip -4 addr show dev "$INTERFACE" | grep -Fq "inet $ADDRESS/32"; then
    ip addr add "$ADDRESS/32" dev "$INTERFACE"
    echo "k3s-node-ip-guard: added $ADDRESS/32 to $INTERFACE"
fi
