# Pocket ID

|               |                                                                |
| ------------- | -------------------------------------------------------------- |
| Homepage      | https://pocket-id.org/                                         |
| Source code   | https://github.com/pocket-id/pocket-id                         |
| Documentation | https://pocket-id.org/docs/introduction                        |
| Configuration | https://pocket-id.org/docs/configuration/environment-variables |
| Docker Image  | https://hub.docker.com/r/pocketid/pocket-id                    |
| Endpoints     | `https://pocket.<domain>/`                                     |

OpenID Connect provider with passkey (passwordless) authentication, for signing in to applications in the cluster.

```sh
pulumi config set pocket:enabled true

# (Optional) custom hostname, defaults to pocket (e.g. https://login.<domain>/)
pulumi config set pocket:hostname login

# (Required) encryption key for data at rest
KEY=$(openssl rand -base64 32)
pulumi config set pocket:encryptionKey "$KEY" --secret
pulumi up
```

Changing the hostname later does not require undeploying - just set the new hostname and run `pulumi up`. Passkeys are bound to the origin though, so after the switch users cannot log in with existing passkeys. Re-register them by generating a one-time access link:

```sh
kubectl -n pocket exec deploy/pocket -- /app/pocket-id one-time-access-token <username>
```

## Encryption Key

The key is stored encrypted in the Pulumi stack config, but also save it in a password manager - it is required to decrypt data when restoring a volume backup to a new stack:

```sh
pulumi config get pocket:encryptionKey
```

## Post-Installation

1. Go to `https://pocket.<domain>/setup` (not the root URL) and create the admin account by registering a passkey.
2. Log in at `https://pocket.<domain>/` with that passkey.

If the browser offers a passkey on the login screen before any account exists, it will fail with "key not registered" - that is expected; the first passkey is registered via `/setup`.

## User Passkeys

Admins cannot add passkeys for users - each user registers their own passkey via a login link:

1. In the admin UI go to **Users**, click the **three dots** on the user row and select **Login Code**.
2. Choose an expiration time and click **Generate Link**.
3. Open the link in the browser with your passkey authenticator (iCloud, Bitwarden, YubiKey, ...) to register the passkey.

Alternatively enable signup tokens (**Application Configuration** -> **Enable User Signups** -> **Signup with token**) so users can create accounts themselves. Email-based one-time access links are also available but require an SMTP server configured in the admin UI.

## Using Pocket ID with Applications

There are two ways to connect an application to Pocket ID. In both cases, the
application needs an OIDC client ID and client secret, and its module stack
must reference the deployed core stack.

See the [Pocket ID client examples](https://pocket-id.org/docs/client-examples)
for provider-specific requirements, including the [Nextcloud example](https://pocket-id.org/docs/client-examples/nextcloud).

### Prerequisites

Deploy the core stack first, then configure every application module stack to
reference it:

```sh
# From the core stack directory, list the stack and its Pulumi Cloud URL
cd /
pulumi stack ls
# Use the organization/project/stack path from the URL column
# Example URL: https://app.pulumi.com/example-org/orangelab/lab

cd stacks/<module>

# Use the value printed above
pulumi config set orangelab:coreStackRef example-org/orangelab/lab
```

The application resolves Pocket ID's OIDC discovery URL automatically from the
core stack. Do not configure a provider URL manually unless the application
documentation specifically requires an override.

### (Recommended) Automated setup

The [generic Pocket ID client script](../../../scripts/pocket-client.sh) creates
the OIDC client, generates its secret, and optionally uploads icons. It requires
a Pocket ID API key.

Create an API key at **Settings -> Admin -> API Keys**, then store it in the
core stack:

```sh
pulumi config set pocket:apiKey <api-key> --secret
```

Applications with native OIDC support:

- [Open WebUI](../../../stacks/ai/components/open-webui/open-webui.md)
- [Immich](../../../stacks/media/components/immich/immich.md)
- [DroppedNeedle](../../../stacks/media/components/droppedneedle/droppedneedle.md)
- [Jellyfin](../../../stacks/media/components/jellyfin/jellyfin.md)
- [Vaultwarden](../../../stacks/apps/components/vaultwarden/vaultwarden.md)
- [Nextcloud](../../../stacks/apps/components/nextcloud/nextcloud.md)
- [RustFS](../../storage/rustfs/rustfs.md)
- [Technitium](../network/technitium/technitium.md)
- [Beszel](../../monitoring/beszel/beszel.md)
- [Grafana (Prometheus)](../../monitoring/prometheus/prometheus.md)
- [Forgejo](../../../stacks/dev/components/forgejo/forgejo.md)

Run the script from the application's module stack directory.
The script creates or reuses the OIDC client and prints the Pulumi configuration
required by the application. Run those commands before `pulumi up`.

### Applications without OIDC

Some applications cannot log in through Pocket ID. They can still appear in
Pocket ID's **My Apps** dashboard using a launcher client.

#### Route protection (`protectRoutes`)

Admin tools that have no authentication of their own are protected by the shared
Traefik OIDC middleware. Requires the **Traefik** routing provider (it raises an
error with Tailscale). Restrict the OIDC client to the Pocket ID `admin` group
under **Settings -> OIDC Clients** - Pocket ID then refuses the sign-in for
non-admins and hides the launcher tile from them, so they cannot reach the tool
even by opening its URL directly.

- [Longhorn](../../../components/storage/longhorn/longhorn.md) (no user management)
- [Traefik Dashboard](../../../components/network/traefik/traefik.md)

Run the script and apply the printed `<app>:auth` commands.

#### App Dashboard launcher only

These applications are not protected by Pocket ID; the client is only a launcher
tile. Several have no login of their own, so anyone who can reach their URL can
use them. Do not run the printed `<app>:auth` commands.

- [Matter](../../../stacks/iot/components/matter/matter.md) (no authentication)
- [Seerr](../../../stacks/media/components/seerr/seerr.md) (Jellyfin username/password)
- [Mempool](../../../stacks/bitcoin/components/mempool/mempool.md) (no authentication)
- [InvokeAI](../../../stacks/ai/components/invokeai/invokeai.md) (no authentication)
- [n8n](../../../stacks/ai/components/n8n/n8n.md) (OIDC is Enterprise-only)
- [Home Assistant](../../../stacks/iot/components/home-assistant/home-assistant.md)

### Manual setup

Use this path when the application is not supported by the script or when you
need to configure the Pocket ID client directly.

#### Create the Pocket ID client

Create and customize the client in the Pocket ID admin UI before deploying the application:

1. Open **Settings -> OIDC Clients** and create a client.
2. Set a descriptive display name. The name can be changed later; the client ID is the stable identity.
3. Set the application's callback URL exactly as documented by that application.
4. Set the application's launch URL when you want it to appear in Pocket ID's **My Apps** dashboard.
5. Configure a logout callback URL only when the application documentation requires one.
6. Optionally restrict the client to selected user groups.
7. Optionally upload an icon. [selfh.st/icons](https://selfh.st/icons/) is a useful source for application icons.
8. Copy the client ID and generate/copy the client secret. The secret is shown only once.

#### Configure the application

Configure the application before its first `pulumi up` so OIDC is enabled
during the initial deployment. Store client secrets with Pulumi's `--secret`
flag:

```sh
# Enable OIDC for the application
pulumi config set <app>:auth pocket
pulumi config set <app>:auth/clientId <client-id>
pulumi config set <app>:auth/clientSecret <client-secret> --secret
pulumi up
```

#### Existing application users

When an application already has user data, configure its account or user ID
mapping before enabling automatic account creation so OIDC users match existing
accounts instead of creating duplicates. Follow the application's documentation
for the required mapping settings.

## Backup and Restore

Backups are handled on the Longhorn volume level, see [Longhorn](../../storage/longhorn/longhorn.md). Restoring to a new or existing stack requires the encryption key from above.

To restore a volume (e.g. a clone or a backup restored in the Longhorn UI) into the app, first undeploy the app but keep the volume clone detached, then redeploy pointing at it:

```sh
pulumi config set pocket:enabled false
pulumi up

# create or restore the volume in the Longhorn UI, name it e.g. "pocket", keep it detached

pulumi config set pocket:fromVolume pocket
pulumi config set pocket:enabled true
pulumi up
```

Keep `pocket:fromVolume` set afterwards - it wires the app to the restored (static) volume. The same `pocket:encryptionKey` must be used for the restored data to decrypt.
