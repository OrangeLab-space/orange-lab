#!/usr/bin/env bash
set -euo pipefail

#
# Pocket ID client settings for Immich.
# Run from the media stack directory (stacks/media).
#
app_name=immich
client_name="Immich"
launch_url=$(pulumi stack output --json | jq -er '.endpoints.immich')
launch_url="${launch_url%/}"
callback_urls=(
    "$launch_url/auth/login"
    "$launch_url/user-settings"
    "app.immich:///oauth-callback"
)
logout_callback_urls=()
dark_icon_url=https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/immich-dark.svg
light_icon_url=https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/immich.svg
pkce_enabled=true

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
