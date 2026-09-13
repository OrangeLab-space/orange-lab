#!/bin/bash
set -euo pipefail

# Outputs K3s containerd mirror configuration (/etc/rancher/k3s/registries.yaml)
# for the Zot pull-through cache. Run after Zot is deployed, then write the
# output on each node, e.g.:
#
#   ./scripts/k3s-registries.sh | ssh <node> 'sudo tee /etc/rancher/k3s/registries.yaml >/dev/null'
#
# Exits non-zero if the Zot endpoint or the registry list cannot be resolved.
# See components/network/zot/zot.md. The registry list comes from the
# zot:registries Pulumi config; the Zot URL from the network.endpoints.zot export.

ZOT_URL="${ZOT_URL:-}"
if [ -z "$ZOT_URL" ]; then
    STACK_OUTPUT=$(pulumi stack output --json) || {
        echo "error: failed to read Pulumi stack outputs (wrong directory, no stack selected, or stack locked)" >&2
        exit 1
    }
    ZOT_URL=$(echo "$STACK_OUTPUT" | jq -er '.network.endpoints.zot') || {
        echo "error: network.endpoints.zot is not in the stack outputs; is zot:enabled true and deployed in this stack?" >&2
        exit 1
    }
fi

CONFIG_JSON=$(pulumi config get --json zot:registries) || {
    echo "error: failed to read the zot:registries Pulumi config" >&2
    exit 1
}
REGISTRIES=$(echo "$CONFIG_JSON" | jq -c '.objectValue // empty')
if [ -z "$REGISTRIES" ]; then
    echo "error: zot:registries Pulumi config is empty" >&2
    exit 1
fi

echo mirrors:
echo "$REGISTRIES" | jq -r --arg zot "$ZOT_URL" \
    '.[] | "  \(.host):\n    endpoint:\n      - \($zot)/v2/\(.destination)"'
