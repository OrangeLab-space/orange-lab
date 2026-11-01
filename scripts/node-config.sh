#!/bin/bash
set -euo pipefail

# Shared node label/taint extraction for the k3s install scripts.
# Usage: source node-config.sh <node-name>
# Sets NODE_ARGS to the --node-label/--node-taint flags for the node.

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

NODE_ARGS=""
while IFS= read -r label; do
    [ -n "$label" ] && NODE_ARGS="$NODE_ARGS --node-label=$label"
done < <(echo "$NODE_CONFIG" | jq -r '
    ([if .zone then "topology.kubernetes.io/zone=\(.zone)" else empty end]
    + (.labels // []))
    | .[]')

while IFS= read -r taint; do
    [ -n "$taint" ] && NODE_ARGS="$NODE_ARGS --node-taint=$taint"
done < <(echo "$NODE_CONFIG" | jq -r '(.taints // [])[]')
