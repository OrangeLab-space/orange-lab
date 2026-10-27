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
# No launch URL: this client signs users in to the tailnet but must not add a
# My Apps tile (the Tailscale admin console should not be advertised to everyone
# who has VPN access).
callback_urls=("https://login.tailscale.com/a/oauth_response")

# Client icons (selfh.st), so the client is not left with a broken image.
dark_icon_url=https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/tailscale.svg
light_icon_url=https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/tailscale-light.svg

# Tailscale requires a client secret, so this is a confidential client.
pkce_enabled=true
public_client=false

# Restricted to admin and vpn-users by default (from Pulumi.yaml): tailnet
# membership is the VPN population, the same as Headscale.
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
    --callback-urls "${callback_urls[*]}" \
    --dark-icon-url "$dark_icon_url" \
    --light-icon-url "$light_icon_url" \
    --pkce-enabled "$pkce_enabled" \
    --public-client "$public_client" \
    "${restrict_args[@]}"
