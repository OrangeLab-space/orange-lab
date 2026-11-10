#!/usr/bin/env bash
#
# Run the buzz-relay image's buzz-admin keypair generator via docker or
# podman. Prints generated keys to stdout, so a caller who must keep the
# secret out of a session runs this themselves.
#
# Run from the nostr stack directory: the image comes from `buzz:image`.
#
# Examples:
#   ./scripts/buzz-generate-key.sh                  # relay identity keypair
#   ./scripts/buzz-generate-key.sh generate-key     # same, explicit subcommand

set -euo pipefail

usage() {
    cat <<EOF
Usage: $0 [buzz-admin args...]

Run buzz-admin from the stack's 'buzz:image' through docker or podman with the
given arguments (default: generate-key). Generated keys go to stdout; keep the
secret key side of them out of agent sessions.
EOF
}

if [[ ${1:-} == -h || ${1:-} == --help ]]; then
    usage
    exit 0
fi

image=$(pulumi config get buzz:image 2>/dev/null) || {
    printf 'Cannot read buzz:image; run this from the nostr stack directory.\n' >&2
    exit 1
}

runtime=()
if command -v docker >/dev/null 2>&1; then
    runtime=(docker run --rm -i)
elif command -v podman >/dev/null 2>&1; then
    runtime=(podman run --rm -i)
else
    printf 'docker or podman not found in PATH.\n' >&2
    exit 1
fi

exec "${runtime[@]}" --entrypoint /usr/local/bin/buzz-admin "$image" "${@:-generate-key}"
