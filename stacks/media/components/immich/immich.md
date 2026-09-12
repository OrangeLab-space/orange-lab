# Immich

|                                |                                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------------------- |
| Homepage                       | https://immich.app/                                                                           |
| Source code                    | https://github.com/immich-app/immich                                                          |
| Documentation                  | https://docs.immich.app/                                                                      |
| Environment variables          | https://docs.immich.app/install/environment-variables                                         |
| CLI commands                   | https://docs.immich.app/administration/server-commands                                        |
| cloudnative-vectorchord images | https://github.com/tensorchord/cloudnative-vectorchord/pkgs/container/cloudnative-vectorchord |
| Endpoints                      | `https://immich.<domain>/`                                                                    |

Self-hosted photo and video backup solution. Alternative to Google Photos.

```sh
# Enable Immich
pulumi config set immich:enabled true

# Use restored Longhorn volume for app
pulumi config set immich:fromVolume immich

# (Optional) Increase storage size and DB volume size
pulumi config set immich:storageSize 200Gi
pulumi config set immich:db/storageSize 10Gi

# (Optional) Enable machine-learning with NVidia GPU acceleration
pulumi config set immich:machine-learning/enabled true
pulumi config set immich:machine-learning/gpu nvidia

# (Alternative) Use standard cloudnative-pg images with pgvector extension
pulumi config set immich:db/image ''
pulumi config set immich:db/postInitApplicationSQL "CREATE EXTENSION IF NOT EXISTS earthdistance CASCADE,CREATE EXTENSION IF NOT EXISTS vector CASCADE"

pulumi up
```

After Immich is initialized, save the JWT secret to the config for backup restoration:

```sh
export JWT_SECRET=$(pulumi stack output --show-secrets --json | jq '.media.immich.jwtSecret' -r)
pulumi config set immich:JWT_SECRET $JWT_SECRET --secret

pulumi up
```

## OAuth Authentication (Pocket ID)

Immich uses a generated configuration file for OAuth, machine-learning, and SMTP settings. The file is mounted as a Secret and configured on every deployment. Because Immich treats the file as authoritative, all Immich system settings are read-only in the administration UI; settings not included in the file use Immich defaults. This requires [Pocket ID](../../../../components/security/pocket/pocket.md) to be deployed for OAuth.

### Create the Pocket ID client

Run the helper from the media stack directory after deploying Pocket ID and configuring the core stack's `pocket:apiKey`:

```sh
cd stacks/media

IMMICH_URL=$(pulumi stack output --json | jq -er '.endpoints.immich')

../../scripts/pocket-client.sh \
  --app-name immich \
  --client-name "Immich" \
  --launch-url "$IMMICH_URL" \
  --callback-url "$IMMICH_URL/auth/login" \
  --callback-url "$IMMICH_URL/user-settings" \
  --callback-url app.immich:///oauth-callback \
  --dark-icon-url https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/immich-dark.svg \
  --light-icon-url https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/immich.svg
```

The helper creates all required web and mobile callbacks, prints the OIDC issuer URL, client ID, and client secret, and reuses existing clients without rotating their secrets. Configure the printed client values in Pulumi:

```sh
cd stacks/media

pulumi config set immich:auth pocket
pulumi config set immich:auth/clientId <client-id>
pulumi config set immich:auth/clientSecret <client-secret> --secret
pulumi up
```

### OAuth settings

The generated OAuth settings use scope `openid email profile`, signing algorithm `RS256`, token endpoint authentication `client_secret_post`, auto registration, and auto launch. For mobile login, keep `app.immich:///oauth-callback` registered with Pocket ID.

When **Auto Launch** is enabled, use the following URL to access the regular Immich login page and sign in with a local administrator account:

```text
https://immich.<domain>/auth/login?autoLaunch=0
```

### SMTP settings

SMTP is disabled by default. Configure it in Pulumi before running `pulumi up`:

```sh
cd stacks/media

pulumi config set immich:smtp/enabled true
pulumi config set immich:smtp/host smtp.example.com
pulumi config set immich:smtp/port 587
pulumi config set immich:smtp/secure false
pulumi config set immich:smtp/from "OrangeLab Immich <admin@orangelab.space>"
pulumi config set immich:smtp/username admin@example.com
pulumi config set immich:smtp/password <smtp-password> --secret
pulumi up
```

The `secure` setting defaults to `false` for providers using STARTTLS on port `587`. Providers using implicit TLS can set `immich:smtp/secure true` and override the port to `465`. The generated configuration verifies the server certificate. Port `587` is the default but can be overridden for providers using a different port. The `from` address is used as the sender and reply address. SMTP credentials are included in the Secret-backed config file and are not stored in a ConfigMap.

## Reset Admin Password

If you need to reset the admin password, exec into the Immich server pod and use the `immich-admin` CLI:

```sh
# Exec into the server container
./scripts/exec.sh immich

# Reset the admin password
immich-admin reset-admin-password
```

See [Server Commands](https://docs.immich.app/administration/server-commands) for more CLI commands like `list-users`, `enable-oauth-login`, etc.
