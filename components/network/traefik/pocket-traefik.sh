#!/usr/bin/env bash
set -euo pipefail

#
# Pocket ID client settings for the Traefik dashboard.
# Run from the core stack directory (repository root).
#
app_name=traefik
client_name="Traefik Dashboard"
launch_url=$(pulumi stack output --json | jq -er '.network.endpoints.traefik')
launch_url="${launch_url%/}"
callback_urls=("$launch_url/oidc/callback")
logout_callback_urls=("$launch_url/oidc/callback")
dark_icon_url=https://cdn.jsdelivr.net/gh/selfhst/icons@main/png/traefik.png
light_icon_url=https://cdn.jsdelivr.net/gh/selfhst/icons@main/png/traefik.png
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
