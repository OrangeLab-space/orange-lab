#!/usr/bin/env bash
set -euo pipefail

#
# Pocket ID client settings for the Matter Server dashboard.
# Run from the iot stack directory (stacks/iot).
#
app_name=matter
client_name="Matter Server"
launch_url=$(pulumi stack output --json | jq -er '.endpoints.matterDashboard')
launch_url="${launch_url%/}"
callback_urls=("$launch_url/")
logout_callback_urls=()
dark_icon_url=https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/matter.svg
light_icon_url=https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/matter-light.svg
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
