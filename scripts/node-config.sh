#!/bin/bash
set -euo pipefail

# Shared node label/taint extraction for the k3s install scripts.
# Usage: source node-config.sh <node-name>
# Sets NODE_ROLE_LABELS to the role labels kubelet cannot set, and NODE_ARGS to
# the --node-label/--node-taint flags the installer can use.

NODE_NAME=${1:-}
if [ -z "$NODE_NAME" ]; then
    echo "Usage: source node-config.sh <node-name>" >&2
    exit 1
fi

command -v jq >/dev/null || {
    echo 'jq is required' >&2
    exit 1
}

NODE_CONFIG=$(pulumi config --json | jq -c --arg node "$NODE_NAME" '
    (."orangelab:nodes" // {}) as $config
    | ($config.objectValue // ($config.value // "{}" | fromjson)) as $nodes
    | $nodes[$node] // empty
')

if [ -z "$NODE_CONFIG" ]; then
    echo "Node '$NODE_NAME' is not defined in orangelab:nodes" >&2
    exit 1
fi

NODE_LABELS=$(echo "$NODE_CONFIG" | jq -r '
    ([if .zone then "topology.kubernetes.io/zone=\(.zone)" else empty end]
    + (.labels // []))
    | .[]')
NODE_TAINTS=$(echo "$NODE_CONFIG" | jq -r '(.taints // [])[]')

NODE_ARGS=""
NODE_ROLE_LABELS=""
while IFS= read -r label; do
    [ -n "$label" ] || continue
    # kubelet refuses node-role labels on --node-label: the kubernetes.io
    # namespace is reserved. k3s-label-node.sh applies them through the API.
    case "$label" in
    node-role.kubernetes.io/*)
        NODE_ROLE_LABELS+="$label"$'\n'
        continue
        ;;
    esac
    NODE_ARGS+=" --node-label=$label"
done <<< "$NODE_LABELS"

while IFS= read -r taint; do
    [ -n "$taint" ] || continue
    NODE_ARGS+=" --node-taint=$taint"
done <<< "$NODE_TAINTS"
