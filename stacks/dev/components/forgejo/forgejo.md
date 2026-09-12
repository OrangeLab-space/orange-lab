# Forgejo

|               |                                                                       |
| ------------- | --------------------------------------------------------------------- |
| Homepage      | https://forgejo.org/                                                  |
| Source code   | https://codeberg.org/forgejo/forgejo                                  |
| Documentation | https://forgejo.org/docs/latest/                                      |
|               | https://pocket-id.org/docs/client-examples/forgejo                    |
| Configuration | https://forgejo.org/docs/latest/admin/config-cheat-sheet/             |
| Helm chart    | https://code.forgejo.org/forgejo-helm/forgejo-helm                    |
| Helm values   | https://code.forgejo.org/forgejo-helm/forgejo-helm/raw/branch/main/values.yaml |
| Endpoints     | `https://forgejo.<domain>/` · `ssh://git@forgejo.<domain>:2222`        |

Forgejo is a self-hosted lightweight software forge: Git hosting, pull requests, issues, a package registry and Actions. It is a community-run fork of Gitea, easy to run and low maintenance.

## Deployment

```sh
cd stacks/dev

# Enable Forgejo
pulumi config set forgejo:enabled true

# (Recommended) Public hostname (default: forgejo)
pulumi config set forgejo:hostname git
# (Recommended) Storage for repositories and SQLite (default: 10Gi)
pulumi config set forgejo:storageSize 50Gi

# Admin account, created on first start and kept in sync on every deploy.
# Forgejo does not allow 'admin' as username.
pulumi config set forgejo:adminUsername gitea_admin
# (Recommended) Admin email, also links your SSO sign-in to the admin account
pulumi config set forgejo:adminEmail forgejo@example.com
# (Required) Admin password, also used to match restored backups
ADMIN_PASSWORD=$(openssl rand -base64 32)
pulumi config set forgejo:adminPassword "$ADMIN_PASSWORD" --secret

# (Optional) Outbound email for notifications and password resets
pulumi config set forgejo:smtp/enabled true
pulumi config set forgejo:smtp/host smtp.example.com
pulumi config set forgejo:smtp/port 587
pulumi config set forgejo:smtp/secure starttls # none | starttls | smtps
pulumi config set forgejo:smtp/from noreply@example.com
pulumi config set forgejo:smtp/username your-smtp-username
pulumi config set forgejo:smtp/password your-smtp-password --secret

pulumi up
```

Uses SQLite on a persistent volume by default, with Redis for cache, session and queue.

## Database

SQLite is the default. To use PostgreSQL instead, enable the CloudNativePG operator in the core stack and set the dependency in this stack:

```sh
# in the core stack
pulumi config set cloudnative-pg:enabled true
pulumi up

# in stacks/dev
pulumi config set cloudnative-pg:enabled true
pulumi config set forgejo:db/type postgres
pulumi config set forgejo:db/storageSize 5Gi
pulumi up
```

Forgejo creates the PostgreSQL schema automatically on first start. Switching an existing instance from SQLite starts with an empty database; there is no built-in restore command, so migrate the data out-of-band or start fresh. The SQLite file is left in place, so setting `forgejo:db/type` back to `sqlite` brings the previous instance back.

## OIDC Authentication (Pocket ID)

The core stack must have Pocket ID enabled and deployed before configuring OAuth. Run the helper after Forgejo is deployed:

```sh
cd stacks/dev

FORGEJO_URL=$(pulumi stack output --json | jq -er '.endpoints.forgejo')

../../scripts/pocket-client.sh \
  --app-name forgejo \
  --client-name Forgejo \
  --launch-url "$FORGEJO_URL" \
  --callback-url "$FORGEJO_URL/user/oauth2/SSO/callback" \
  --dark-icon-url https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/forgejo.svg \
  --light-icon-url https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/forgejo-light.svg
```

The helper creates or refreshes the Pocket ID client and prints the client configuration commands. Existing clients are reused without rotating their secret.

Run the printed commands, then deploy again:

```sh
pulumi config set forgejo:auth pocket
pulumi config set forgejo:auth/clientId <client-id>
pulumi config set forgejo:auth/clientSecret <client-secret> --secret

pulumi up
```

On first sign-in, Forgejo creates the account automatically from your identity provider, with no registration form; the username comes from the `nickname` claim, falling back to `preferred_username`. If `forgejo:adminEmail` matches your identity provider email, the sign-in is linked to the existing admin account, and members of the Pocket ID `admin` group become Forgejo administrators. Profile pictures are synced from the identity provider on each sign-in. Forgejo reserves the username `admin`. While OIDC is enabled, Forgejo is SSO-only: local username/password sign-in and self-registration are disabled. To regain local admin access, remove `forgejo:auth` (`pulumi config rm forgejo:auth`) and deploy again.

## SSH access

Forgejo's built-in SSH server is exposed on port `2222`:

```sh
ssh -T -p 2222 git@forgejo.<domain>
```

Add your public keys under **Settings → SSH / GPG keys** to push and pull over SSH. The port must be reachable from where you connect; `2222` avoids clashing with the node's own SSH daemon.

## Admin access

The admin account is created on first start from `forgejo:adminUsername` and `forgejo:adminPassword`. The password is kept in sync on every deploy (`keepUpdated`), so changing `forgejo:adminPassword` and running `pulumi up` resets the admin password. Keep the configured value stable when restoring from backup so the restored instance stays accessible.
