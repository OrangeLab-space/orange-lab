#!/usr/bin/env bash
set -euo pipefail

#
# Pocket ID client settings for Home Assistant.
# Run from the iot stack directory (stacks/iot).
#
app_name=home-assistant
client_name="Home Assistant"
launch_url=$(pulumi stack output --json | jq -er '.endpoints.homeAssistant')
launch_url="${launch_url%/}"
callback_urls=("$launch_url/auth/oidc/callback")
logout_callback_urls=()
dark_icon_url=https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/home-assistant.png
light_icon_url=https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/home-assistant.png
pkce_enabled=true
public_client=true

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
    --public-client "$public_client"
