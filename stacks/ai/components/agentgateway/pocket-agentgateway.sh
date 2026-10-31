#!/usr/bin/env bash
set -euo pipefail

#
# Pocket ID client settings for the Agentgateway dashboard.
# Run from the ai stack directory (stacks/ai).
#
app_name=agentgateway
client_name="Agentgateway"
launch_url=$(pulumi stack output --json | jq -er '.endpoints.private.agentgateway')
launch_url="${launch_url%/}"
callback_urls=("$launch_url/oidc/callback")
logout_callback_urls=("$launch_url/oidc/callback")
dark_icon_url=https://agentgateway.dev/agw-mark-color.svg
light_icon_url=https://agentgateway.dev/agw-mark-color.svg
pkce_enabled=false

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
    --restrict-access "$allowed_groups"
