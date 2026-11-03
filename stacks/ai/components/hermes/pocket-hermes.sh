#!/usr/bin/env bash
set -euo pipefail

#
# Pocket ID client settings for Hermes Agent.
# Run from the ai stack directory (stacks/ai).
#
app_name=hermes
client_name="Hermes Agent"
launch_url=$(pulumi stack output --json | jq -er '.endpoints.private.hermes')
launch_url="${launch_url%/}"
callback_urls=("$launch_url/auth/callback")
logout_callback_urls=()
dark_icon_url=https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/hermes-agent.svg
light_icon_url=https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/hermes-agent-light.svg
pkce_enabled=true
# Hermes only supports public (PKCE) clients for its dashboard.
public_client=true

# Pocket ID groups allowed to sign in; unset = unrestricted.
allowed_groups=$(pulumi config get "${app_name}:auth/allowedGroups" 2>/dev/null || true)

#
# Shared invocation - identical in every app wrapper.
#
exec "$(git rev-parse --show-toplevel)/scripts/pocket-client.sh" \
    --app-name "$app_name" \
    --client-name "$client_name" \
    --launch-url "$launch_url" \
    --callback-urls "${callback_urls[*]}" \
    --logout-callback-urls "${logout_callback_urls[*]}" \
    --dark-icon-url "$dark_icon_url" \
    --light-icon-url "$light_icon_url" \
    --pkce-enabled "$pkce_enabled" \
    --public-client "$public_client" \
    --restrict-access "$allowed_groups"
