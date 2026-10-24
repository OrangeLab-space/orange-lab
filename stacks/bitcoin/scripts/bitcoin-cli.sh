#!/bin/bash

# Run bitcoin-cli inside the Bitcoin pod with datadir cookie authentication.
#
# Works from any directory and avoids Pulumi secrets, host DNS, and the RPC
# password on the command line. Set BITCOIN_APP=bitcoin-core to override the
# auto-detected node.

set -euo pipefail

APP="${BITCOIN_APP:-}"
if [[ -z "$APP" ]]; then
    for candidate in bitcoin-knots bitcoin-core; do
        if kubectl get namespace "$candidate" >/dev/null 2>&1 &&
            [[ -n "$(kubectl -n "$candidate" get pods \
                -l "app.kubernetes.io/name=$candidate" \
                --field-selector=status.phase=Running \
                -o name 2>/dev/null || true)" ]]; then
            APP="$candidate"
            break
        fi
    done
fi

if [[ -z "$APP" ]]; then
    echo "No running Bitcoin node found. Set BITCOIN_APP=bitcoin-knots or bitcoin-core." >&2
    exit 1
fi

POD=$(kubectl -n "$APP" get pods \
    -l "app.kubernetes.io/name=$APP" \
    --field-selector=status.phase=Running \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)

if [[ -z "$POD" ]]; then
    echo "No running $APP pod found in namespace $APP." >&2
    exit 1
fi

# The main container is first; anonymity sidecars (Tor/I2P) follow.
DATADIR=$(kubectl -n "$APP" get pod "$POD" \
    -o jsonpath='{.spec.containers[0].env[?(@.name=="BITCOIN_DATA")].value}' 2>/dev/null || true)
DATADIR="${DATADIR:-/data}"

if [[ $# -eq 0 ]]; then
    set -- --help
fi

exec kubectl -n "$APP" exec "$POD" -c "$APP" -- bitcoin-cli -datadir="$DATADIR" "$@"
