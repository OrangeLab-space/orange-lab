#!/usr/bin/env bash
set -euo pipefail

#
# Pocket ID client settings for Tailscale.
# Run from the core stack directory (repository root).
#
# Signs up a *new* Tailscale tailnet with Pocket ID as the identity provider, so
# nodes do not need a Google, Microsoft or GitHub account.
#
# This client is configured for the Tailscale signup flow. It is deliberately
# not referenced by any Pulumi config key - the credentials belong in the
# Tailscale admin console, not in the stack.
#
app_name=tailscale
client_name="Tailscale"
launch_url=https://login.tailscale.com/admin/machines
callback_urls=("https://login.tailscale.com/a/oauth_response")

# Tailscale requires a client secret, so this is a confidential client.
pkce_enabled=true
public_client=false

# Unrestricted: any Pocket ID user may sign in. Tailscale does no user or group
# provisioning with custom OIDC, so membership of the tailnet is exactly
# membership of Pocket ID.
#
# To restrict to specific groups, set:
#   pulumi config set tailscale:auth/allowedGroups admin,power-user
# and uncomment --restrict-access below.
allowed_groups=$(pulumi config get "${app_name}:auth/allowedGroups" 2>/dev/null || true)

restrict_args=()
if [[ -n "${allowed_groups}" ]]; then
    restrict_args=(--restrict-access "${allowed_groups}")
fi

#
# Shared invocation - identical in every app wrapper.
#
exec "$(git rev-parse --show-toplevel)/scripts/pocket-client.sh" \
    --app-name "$app_name" \
    --client-name "$client_name" \
    --launch-url "$launch_url" \
    --callback-urls "${callback_urls[*]}" \
    --pkce-enabled "$pkce_enabled" \
    --public-client "$public_client" \
    "${restrict_args[@]}"
