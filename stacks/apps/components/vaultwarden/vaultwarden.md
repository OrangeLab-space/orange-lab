# Vaultwarden

|               |                                                                                 |
| ------------- | ------------------------------------------------------------------------------- |
| Homepage      | https://github.com/dani-garcia/vaultwarden                                      |
| Source code   | https://github.com/dani-garcia/vaultwarden                                      |
| Documentation | https://github.com/dani-garcia/vaultwarden/wiki                                 |
| Helm chart    | https://github.com/guerzon/vaultwarden                                          |
| Helm values   | https://github.com/guerzon/vaultwarden/blob/main/charts/vaultwarden/values.yaml |
| Endpoints     | `https://vaultwarden.<domain>/`                                                 |
|               | `https://vaultwarden.<domain>/admin`                                            |

Unofficial Bitwarden-compatible server written in Rust. Lightweight alternative to the official Bitwarden server for self-hosted password management. Compatible with official Bitwarden clients - set server URL to `https://vaultwarden.<domain>/` in client settings.

## Deployment

```sh
pulumi config set vaultwarden:enabled true

# (Optional) SMTP configuration
pulumi config set vaultwarden:smtp/enabled true
pulumi config set vaultwarden:smtp/host smtp.example.com
pulumi config set vaultwarden:smtp/from noreply@example.com
pulumi config set vaultwarden:smtp/port 587
pulumi config set vaultwarden:smtp/secure starttls # none | starttls | smtps
pulumi config set vaultwarden:smtp/username your-smtp-username
pulumi config set vaultwarden:smtp/password your-smtp-password --secret

# (Optional) Allow anyone to sign-up (use admin panel invite when false)
pulumi config set vaultwarden:signupsAllowed false
# (Optional) Verify new accounts using email
pulumi config set vaultwarden:signupsVerify true

pulumi up
```

## OAuth Authentication (Pocket ID)

The core stack must have Pocket ID enabled and deployed before configuring OAuth. Run the helper after Vaultwarden is deployed:

```sh
cd stacks/apps

VAULTWARDEN_URL=$(pulumi stack output --json | jq -er '.endpoints.vaultwarden')

../../scripts/pocket-client.sh \
  --app-name vaultwarden \
  --client-name Vaultwarden \
  --launch-url "$VAULTWARDEN_URL" \
  --callback-url "$VAULTWARDEN_URL/identity/connect/oidc-signin" \
  --dark-icon-url https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/vaultwarden.svg \
  --light-icon-url https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/vaultwarden-light.svg
```

The helper creates or refreshes the Pocket ID client with PKCE enabled and prints the client configuration commands. Existing clients are reused without rotating their secret.

Run the printed commands, then deploy again:

```sh
pulumi config set vaultwarden:auth pocket
pulumi config set vaultwarden:auth/clientId <client-id>
pulumi config set vaultwarden:auth/clientSecret <client-secret> --secret

pulumi up
```

The Vaultwarden integration uses the `email profile groups offline_access` scopes, matches SSO signups by email, and resolves the OIDC provider URL from the core stack.

In Pocket ID, enable **Emails Verified** under **Application Configuration**, then verify each user email under **Users**. Vaultwarden requires the provider to return a verified email address.

## Admin access

On first deployment, an admin token is automatically generated and hashed using Argon2. The plain token is exported in stack outputs.

After first deployment, save the admin token to the Pulumi config:

```sh
export ADMIN_TOKEN=$(pulumi stack output --show-secrets --json | jq '.apps.vaultwarden.adminToken' -r)
pulumi config set vaultwarden:adminToken $ADMIN_TOKEN --secret

pulumi up
```

This ensures the same token is reused on subsequent deployments, allowing admin console access at `https://vaultwarden.<domain>/admin`.
