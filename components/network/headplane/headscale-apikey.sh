#!/usr/bin/env bash
#
# Mint a Headscale API key for Headplane and print the command to store it.
#
# Headplane needs a key for server-side operations (handling the OIDC callback,
# acting on Headscale on a signed-in user's behalf). It is created here rather
# than in the Pulumi program so the credential never passes through config
# unset or the stack's plaintext.
#
# The key is only printed — nothing is stored automatically, so you can review
# it before it lands in your Pulumi config.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HEADSCALE_CLI="$SCRIPT_DIR/../headscale/exec-headscale.sh"
STACK="${STACK:-lab}"
EXPIRATION="${EXPIRATION:-90d}"

if [ ! -x "$HEADSCALE_CLI" ]; then
    echo "error: $HEADSCALE_CLI not found or not executable" >&2
    exit 1
fi

echo "Creating a Headscale API key for stack '$STACK' (expires in $EXPIRATION)."
echo

# Headscale prints the new key on its own line and nothing else.
output="$("$HEADSCALE_CLI" apikeys create --expiration "$EXPIRATION")"

api_key="$(printf '%s\n' "$output" | grep -E '^hskey-api-' | head -1)"

if [ -z "$api_key" ]; then
    echo "error: could not find a key in the CLI output:" >&2
    printf '%s\n' "$output" >&2
    exit 1
fi

cat <<EOF

Store it (run from the repository root):

    pulumi config set --stack $STACK headplane:apiKey "$api_key" --secret

Then enable and deploy Headplane:

    pulumi config set --stack $STACK headplane:enabled true
    pulumi up --stack $STACK

EOF
