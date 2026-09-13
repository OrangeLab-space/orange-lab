#!/usr/bin/env bash
set -euo pipefail

#
# Pocket ID client settings for Technitium DNS.
# Run from the core stack directory (repository root).
#
app_name=technitium
client_name="Technitium DNS"
launch_url=$(pulumi stack output --json | jq -er '.network.endpoints.technitium')
launch_url="${launch_url%/}"
callback_urls=("$launch_url/sso/callback")
logout_callback_urls=()
dark_icon_url=https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/technitium.svg
light_icon_url=https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/technitium-light.svg
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
