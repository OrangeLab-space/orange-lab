#!/bin/bash
set -euo pipefail

# Usage: ./scripts/k3s-label-node.sh <node-name>
# Apply the node's role labels (node-role.kubernetes.io/*) from orangelab:nodes.
# kubelet refuses role labels on --node-label, so they have to be applied
# through the API after the node registers. Run this where Pulumi and kubectl
# are configured.

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
NODE_NAME=${1:-}
if [ -z "$NODE_NAME" ]; then
    echo "Usage: $0 <node-name>" >&2
    exit 1
fi
# shellcheck source=scripts/node-config.sh
source "$SCRIPT_DIR/node-config.sh" "$NODE_NAME"

command -v kubectl >/dev/null || {
    echo 'kubectl is required' >&2
    exit 1
}

if ! kubectl get node "$NODE_NAME" >/dev/null; then
    echo "Node '$NODE_NAME' is not available; install it first" >&2
    exit 1
fi

if [ -z "$NODE_ROLE_LABELS" ]; then
    echo "No role labels configured for '$NODE_NAME'"
    exit 0
fi

while IFS= read -r label; do
    [ -n "$label" ] || continue
    kubectl label node "$NODE_NAME" "$label" --overwrite
done <<< "$NODE_ROLE_LABELS"
