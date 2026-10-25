#!/bin/bash
set -euo pipefail

# ExecStartPre for k3s.service / k3s-agent.service, installed by
# scripts/k3s-node-ip-guard-install.sh. Supplies the node's tailnet address
# before k3s starts, so a reboot does not wait for a netmap; see
# spec/headscale.md. Usage: k3s-node-ip-guard.sh <tailnet-address>

ADDRESS=${1:?usage: k3s-node-ip-guard.sh <tailnet-address>}
INTERFACE=${INTERFACE:-tailscale0}
WAIT_SECONDS=${WAIT_SECONDS:-60}

[[ $ADDRESS =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { echo "k3s-node-ip-guard: '$ADDRESS' is not an IPv4 address" >&2; exit 1; }
for ((i = 0; i < WAIT_SECONDS; i++)); do ip link show "$INTERFACE" >/dev/null 2>&1 && break; sleep 1; done
ip link show "$INTERFACE" >/dev/null 2>&1 || { echo "k3s-node-ip-guard: $INTERFACE did not appear within ${WAIT_SECONDS}s, is tailscaled running?" >&2; exit 1; }
ip -4 addr show dev "$INTERFACE" | grep -Fq "inet $ADDRESS/32" || { ip addr add "$ADDRESS/32" dev "$INTERFACE"; echo "k3s-node-ip-guard: added $ADDRESS/32 to $INTERFACE"; }
