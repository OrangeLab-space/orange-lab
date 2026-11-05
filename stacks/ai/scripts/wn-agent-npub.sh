#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat <<EOF
Usage: $0 [options]

Print the npub of every wn-agent connector in a Kubernetes deployment, one
"profile npub" line per profile.

Optional parameters (defaults match the AI stack):
  --namespace <ns>        Kubernetes namespace (default: hermes)
  --deployment <name>     Deployment whose pod runs the connector (default: hermes)
  --container <name>      Container holding the wn-agent binary (default: hermes)
  --home-root <path>      Directory with one connector home per profile
                          (default: /opt/data/marmot-agents)
  --binary <path>         wn-agent binary (default: wn-agent, resolved from PATH)
  -h, --help              Show this help

The first run on a fresh profile creates its identity and publishes its key
package, so the printed npub can be invited straight away. Later runs reuse the
account and repair the published key package.

The control socket only accepts its owning account, so each request drops to the
socket owner (wn-agent refuses root).
EOF
}

namespace='hermes'
deployment='hermes'
container='hermes'
home_root='/opt/data/marmot-agents'
binary='wn-agent'

while (($# > 0)); do
    case "$1" in
        --namespace) namespace="$2"; shift 2 ;;
        --deployment) deployment="$2"; shift 2 ;;
        --container) container="$2"; shift 2 ;;
        --home-root) home_root="$2"; shift 2 ;;
        --binary) binary="$2"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *)
            printf 'Unknown argument: %s\n\n' "$1" >&2
            usage >&2
            exit 2
            ;;
    esac
done

exec_args=(exec "deploy/$deployment")
if [[ -n $container ]]; then
    exec_args+=(-c "$container")
fi

# shellcheck disable=SC2016 # $1 expands inside the container, not here
profiles=$(kubectl -n "$namespace" "${exec_args[@]}" -- sh -c '
    for dir in "$1"/*/; do
        [ -d "$dir" ] && basename "$dir"
    done
' sh "$home_root")

status=0
while read -r profile; do
    [[ -n $profile ]] || continue
    home="$home_root/$profile"
    socket="$home/dev/wn-agent.sock"

    #
    # wn-agent rejects root and the socket only accepts its owner, so read the
    # socket's uid inside the container and re-exec the bootstrap request as it.
    #
    # shellcheck disable=SC2016 # $1/$@ expand inside the container, not here
    if ! output=$(kubectl -n "$namespace" "${exec_args[@]}" -- sh -c '
        uid=$(stat -c %u "$1"); shift
        exec setpriv --reuid="$uid" --regid="$uid" --clear-groups "$@"
    ' sh "$socket" "$binary" bootstrap --home "$home" --socket "$socket" --json); then
        printf '%-12s %s\n' "$profile" 'unavailable (connector not running?)' >&2
        status=1
        continue
    fi

    if ! npub=$(printf '%s\n' "$output" | jq -er '.npub'); then
        printf '%-12s %s\n' "$profile" 'no npub in bootstrap output' >&2
        status=1
        continue
    fi
    printf '%-12s %s\n' "$profile" "$npub"
done <<< "$profiles"

exit "$status"
