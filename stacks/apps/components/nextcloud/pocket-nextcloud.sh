#!/usr/bin/env bash
set -euo pipefail

#
# Pocket ID client settings for Nextcloud.
# Run from the apps stack directory (stacks/apps).
#
app_name=nextcloud
client_name="Nextcloud"
launch_url=$(pulumi stack output --json | jq -er '.endpoints.nextcloud')
launch_url="${launch_url%/}"
callback_urls=("$launch_url/apps/user_oidc/code")
logout_callback_urls=("$launch_url/apps/user_oidc/backchannel-logout/PocketID")
dark_icon_url=https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/nextcloud.svg
light_icon_url=https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/nextcloud.svg
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
