#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat <<EOF
Usage: $0 [options]

Print the npub of a wn-agent connector running in a Kubernetes deployment.

Optional parameters (defaults match the AI stack):
  --namespace <ns>        Kubernetes namespace (default: hermes)
  --deployment <name>     Deployment whose pod runs the connector (default: hermes)
  --home <path>           Connector home (default: /opt/data/marmot-agents/hermes)
  --container <name>      Container holding the wn-agent binary (default: hermes)
  --socket <path>         Control socket (default: <home>/dev/wn-agent.sock)
  --binary <path>         wn-agent binary (default: wn-agent, resolved from PATH)
  --json                  Print the full bootstrap JSON instead of just the npub
  -h, --help              Show this help

The control socket only accepts its owning account, so the request drops to the
socket owner (wn-agent refuses root).
EOF
}

namespace='hermes'
deployment='hermes'
container='hermes'
home='/opt/data/marmot-agents/hermes'
socket=''
binary='wn-agent'
json=false

while (($# > 0)); do
    case "$1" in
        --namespace) namespace="$2"; shift 2 ;;
        --deployment) deployment="$2"; shift 2 ;;
        --container) container="$2"; shift 2 ;;
        --home) home="$2"; shift 2 ;;
        --socket) socket="$2"; shift 2 ;;
        --binary) binary="$2"; shift 2 ;;
        --json) json=true; shift ;;
        -h|--help) usage; exit 0 ;;
        *)
            printf 'Unknown argument: %s\n\n' "$1" >&2
            usage >&2
            exit 2
            ;;
    esac
done

[[ -n $socket ]] || socket="$home/dev/wn-agent.sock"

#
# wn-agent rejects root and the socket only accepts its owner, so read the
# socket's uid inside the container and re-exec the bootstrap request as it.
#
exec_args=(exec "deploy/$deployment")
if [[ -n $container ]]; then
    exec_args+=(-c "$container")
fi

# shellcheck disable=SC2016 # $1/$@ expand inside the container, not here
output=$(kubectl -n "$namespace" "${exec_args[@]}" -- sh -c '
    uid=$(stat -c %u "$1"); shift
    exec setpriv --reuid="$uid" --regid="$uid" --clear-groups "$@"
' sh "$socket" "$binary" bootstrap --home "$home" --socket "$socket" \
    --json --no-create --no-publish-key-package)

if [[ $json == true ]]; then
    printf '%s\n' "$output"
else
    printf '%s\n' "$output" | jq -er '.npub'
fi
