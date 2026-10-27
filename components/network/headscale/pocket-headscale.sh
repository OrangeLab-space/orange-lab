#!/usr/bin/env bash
set -euo pipefail

#
# Pocket ID client settings for Headscale.
# Run from the core stack directory (repository root).
#
# Headscale authenticates users against Pocket ID, so nodes and clients need only
# an OrangeLab account - no Google, Microsoft or GitHub identity.
#
app_name=headscale
client_name="Headscale"

# Headscale's public URL. Derived from config rather than from a stack output,
# because the client must exist before the first deploy - Headscale refuses to
# start without it. The result must match the endpoint Headscale is reached at.
custom_domain=$(pulumi config get orangelab:customDomain)
headscale_url="https://$(pulumi config get "${app_name}:hostname").${custom_domain%/}"
callback_urls=("${headscale_url}/oidc/callback")

# Headscale has no web UI. Headplane (its admin UI) has its own hostname but
# reuses this client, so the `sub` claim matches for both and it can link a
# signed-in user to their Headscale identity without falling back to email.
# Upstream recommends one shared client over two.
#
# No launch URL: this client is shared with vpn-users, so a tile would advertise
# the admin UI to every VPN user. Headplane's callback still has to be
# registered, since it signs in through the same client.
if [[ "$(pulumi config get headplane:enabled 2>/dev/null || echo false)" == "true" ]]; then
    headplane_hostname=$(pulumi config get headplane:hostname)
    headplane_admin_url="https://${headplane_hostname}.${custom_domain%/}/admin"
    callback_urls+=("${headplane_admin_url}/oidc/callback")
fi

# Client icons (selfh.st), so the client is not left with a broken image.
dark_icon_url=https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/headscale.svg
light_icon_url=https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/headscale-light.svg

# Headscale needs the client secret to complete the code exchange.
pkce_enabled=true
public_client=false

# Restricted to admin and vpn-users by default (from Pulumi.yaml).
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