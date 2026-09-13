#!/usr/bin/env bash
set -euo pipefail

#
# Pocket ID client settings for Zot Registry.
# Run from the core stack directory (repository root).
#
app_name=zot
client_name="Zot Registry"
launch_url=$(pulumi stack output --json | jq -er '.network.endpoints.zot')
launch_url="${launch_url%/}"
callback_urls=("$launch_url/zot/auth/callback/oidc")
logout_callback_urls=()
dark_icon_url=https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/zot-registry.svg
light_icon_url=https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/zot-registry-light.svg
pkce_enabled=false

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
    --pkce-enabled "$pkce_enabled"
