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
launch_url="https://$(pulumi config get "${app_name}:hostname").${custom_domain%/}"
callback_urls=("${launch_url}/oidc/callback")

# Headplane has its own hostname but deliberately reuses this client, so the `sub`
# claim matches for both and Headplane can link a signed-in user to their Headscale
# identity without falling back to email. Upstream recommends one shared client
# over two. Its redirect URI is under the headplane host, not this one.
if [[ "$(pulumi config get headplane:enabled 2>/dev/null || echo false)" == "true" ]]; then
    headplane_hostname=$(pulumi config get headplane:hostname)
    callback_urls+=("https://${headplane_hostname}.${custom_domain%/}/admin/oidc/callback")
fi

# Headscale needs the client secret to complete the code exchange.
pkce_enabled=true
public_client=false

# Unrestricted by default: any Pocket ID account can join the tailnet.
#
# To restrict to specific groups, set:
#   pulumi config set headscale:auth/allowedGroups admin,power-user
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