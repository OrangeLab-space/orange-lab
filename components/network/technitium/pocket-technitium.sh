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
# Creates the app-owned groups from technitium:auth/groupMap (e.g.
# technitium-admin) and restricts the client to every group the map references
# (shared groups such as admin must already exist and are only validated).
group_map=$(pulumi config get technitium:auth/groupMap 2>/dev/null || echo '{}')
create_groups=$(jq -r --arg prefix "${app_name}-" \
    '[.[] | .[]] | unique | map(select(startswith($prefix))) | join(",")' <<<"${group_map}")
restrict_groups=$(jq -r '[.[] | .[]] | unique | join(",")' <<<"${group_map}")

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
    --create-groups "$create_groups" \
    --restrict-access "$restrict_groups"
