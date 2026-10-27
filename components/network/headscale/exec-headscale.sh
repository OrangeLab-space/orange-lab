#!/usr/bin/env bash
set -euo pipefail

#
# Run the Headscale CLI against the deployment in the current kubectl context.
#
# Headscale's gRPC admin interface is not exposed outside the cluster, so admin
# tasks (preauth keys, node expiry, policy checks) go through the running pod:
#
#   ./components/network/headscale/exec-headscale.sh nodes list
#   ./components/network/headscale/exec-headscale.sh preauthkeys create --reusable
#
# stdin is attached, so a policy can be piped in:
#   ./components/network/headscale/exec-headscale.sh policy check -f /dev/stdin < policy.hujson
#
# The first argument is the Headscale subcommand; everything after it is passed
# through untouched.
#
namespace=headscale

usage() {
    cat <<EOF
Usage: $0 <headscale-command> [arguments...]

Examples:
  $0 nodes list
  $0 users list
  $0 preauthkeys create --reusable --expiration 24h
  $0 nodes expire --all

Environment:
  NAMESPACE   Namespace running Headscale (default: ${namespace})
  KUBECTL     kubectl binary to use (default: kubectl)
EOF
}

if [[ $# -eq 0 ]]; then
    usage >&2
    exit 2
fi

case "$1" in
    -h | --help)
        usage
        exit 0
        ;;
esac

# Headscale serves the CLI over a unix socket inside the pod, so no host or URL
# argument is needed - unlike the standalone client, which wants --user/--api-key.
kubectl_cmd="${KUBECTL:-kubectl}"

# Prefer a running pod; fall back to any pod so a crash-looping Headscale can
# still be inspected.
pod=$("${kubectl_cmd}" get pods -n "${namespace}" \
    --field-selector=status.phase=Running \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)

if [[ -z "${pod}" ]]; then
    printf 'No running Headscale pod in namespace %s.\n' "${namespace}" >&2
    printf 'Check: %s get pods -n %s\n' "${kubectl_cmd}" "${namespace}" >&2
    exit 1
fi

exec "${kubectl_cmd}" exec -i -n "${namespace}" "${pod}" -- headscale "$@"