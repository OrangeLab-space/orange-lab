# Nextcloud

|               |                                                                          |
| ------------- | ------------------------------------------------------------------------ |
| Homepage      | https://nextcloud.com/                                                   |
| Helm chart    | https://github.com/nextcloud/helm                                        |
| Helm values   | https://github.com/nextcloud/helm/blob/main/charts/nextcloud/values.yaml |
| Endpoints     | `https://nextcloud.<domain>/`                                            |
| Documentation | https://docs.nextcloud.com/                                              |
|               | https://pocket-id.org/docs/client-examples/nextcloud                     |

Nextcloud is a self-hosted productivity platform that lets you store files, collaborate, and run office apps in your own private cloud.

It can also be used to store your contacts, bookmarks, calendar etc. and has a lot of additional modules which can be installed through the deployed website.

## Prerequisites

Requires [`mariadb-operator`](../../../../components/data/mariadb-operator/mariadb-operator.md) enabled in the root stack.

```sh
pulumi config set mariadb-operator:enabled true
pulumi up
```

## Basic configuration

```sh
# Enable Nextcloud
pulumi config set nextcloud:enabled true
# Set hostname (optional, default: nextcloud)
pulumi config set nextcloud:hostname nextcloud
# Set storage size (default: 20Gi)
pulumi config set nextcloud:storageSize 50Gi
# Set storage size for PostgreSQL database (default: 5Gi)
pulumi config set nextcloud:storageSize 10Gi
# (Required) admin password, also used to match restored backups
KEY=$(openssl rand -base64 32)
pulumi config set nextcloud:adminPassword "$KEY" --secret
pulumi up
```

Log in as `admin` and create a new user at:

`https://nextcloud.<domain>/settings/admin`

## Email (SMTP)

Nextcloud can send notifications and password-reset emails through an external SMTP server.

```sh
pulumi config set nextcloud:smtp/enabled true
pulumi config set nextcloud:smtp/host smtp.example.com
pulumi config set nextcloud:smtp/port 587
pulumi config set nextcloud:smtp/secure tls
pulumi config set nextcloud:smtp/from noreply@example.com
pulumi config set nextcloud:smtp/username your-smtp-username
pulumi config set nextcloud:smtp/password your-smtp-password --secret
pulumi up
```

`smtp/from` must be a plain address — it is split into the local part (`mail_from_address`) and domain (`mail_domain`). Use `secure: tls` for STARTTLS on port `587`, or `secure: ssl` for implicit TLS on port `465`.

## OAuth Authentication (Pocket ID)

Requires [Pocket ID](../../../../components/security/pocket/pocket.md) deployed in the core stack with `pocket:apiKey` configured.

### Recommended: automated setup

1. Create the Pocket ID client from the apps stack directory:

```sh
cd stacks/apps

NEXTCLOUD_URL=$(pulumi stack output --json | jq -er '.endpoints.nextcloud')
ENDSESSION_ENDPOINT=$(curl -fsSL "$DISCOVERY_URL" | jq -er '.end_session_endpoint')

../../scripts/pocket-client.sh \
  --app-name nextcloud \
  --client-name Nextcloud \
  --launch-url "$NEXTCLOUD_URL" \
  --callback-url "$NEXTCLOUD_URL/apps/user_oidc/code" \
  --logout-callback-url "$NEXTCLOUD_URL/apps/user_oidc/backchannel-logout/PocketID" \
  --dark-icon-url https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/nextcloud.svg \
  --light-icon-url https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/nextcloud.svg
```

The helper creates or reuses the client and prints the required Pulumi configuration. Keep the client non-public with PKCE enabled.

2. Run the printed configuration commands, then deploy. The Helm hook installs `user_oidc` and registers the provider automatically:

```sh
pulumi config set nextcloud:auth pocket
pulumi config set nextcloud:auth/clientId <client-id>
pulumi config set nextcloud:auth/clientSecret <client-secret> --secret
# Optional: override the default ^nextcloud-.*$ group sync filter.
# All users can still log in; only matching groups are synchronized.
pulumi config set nextcloud:groupProvisioningWhitelist '^nextcloud-.*$'
pulumi up
```

3. Log in at `https://nextcloud.<domain>/` with the `Login with PocketID` button. Keep **Enable Self-Account Editing** disabled in Pocket ID so `preferred_username` remains controlled by the identity provider.

Pocket ID group provisioning is limited to groups whose names start with
`nextcloud-`. All Pocket ID users can still log in. The local Nextcloud `admin`
group is kept separate from OIDC groups; add users to it locally when they need
Nextcloud super-admin access.

When SSO is enabled, the built-in login form is hidden (`hide_login_form`). The login page shows "The Nextcloud login form is disabled." with a `Login with PocketID` button instead. To reach the local admin login, open `https://nextcloud.<domain>/login?direct=1`.

The deployment enables Nextcloud's local remote-server access for OIDC discovery because the Pocket ID hostname resolves to the local cluster address.

### Manual fallback

If the hook ever fails to register the provider (check with `./occ user_oidc:provider` via `./scripts/exec.sh nextcloud`), run the registration by hand from the apps stack directory:

```sh
cd stacks/apps

CLIENT_ID=$(pulumi config get nextcloud:auth/clientId)
CLIENT_SECRET=$(pulumi config get nextcloud:auth/clientSecret)
NEXTCLOUD_OIDC_GROUP_WHITELIST_REGEX=$(pulumi config get nextcloud:groupProvisioningWhitelist)
DISCOVERY_URL=$(pulumi --cwd ../.. stack output --json | jq -er '.security.oidcProviderUrl')
NEXTCLOUD_URL=$(pulumi stack output --json | jq -er '.endpoints.nextcloud')
ENDSESSION_ENDPOINT=$(curl -fsSL "$DISCOVERY_URL" | jq -er '.end_session_endpoint')
POD=$(kubectl get pod -l app.kubernetes.io/name=nextcloud -n nextcloud -o jsonpath='{.items[0].metadata.name}')

kubectl -n nextcloud exec "$POD" -- php occ user_oidc:provider PocketID \
    --clientid="$CLIENT_ID" \
    --clientsecret="$CLIENT_SECRET" \
    --discoveryuri="$DISCOVERY_URL" \
    --endsessionendpointuri="$ENDSESSION_ENDPOINT" \
    --postlogouturi="$NEXTCLOUD_URL/apps/user_oidc/backchannel-logout/PocketID" \
    --scope='openid email profile groups' \
    --mapping-uid='preferred_username' \
    --mapping-display-name='name' \
    --mapping-email='email' \
    --mapping-avatar='picture' \
    --unique-uid=1 \
    --send-id-token-hint=0 \
    --group-provisioning=1 \
    --group-whitelist-regex="$NEXTCLOUD_OIDC_GROUP_WHITELIST_REGEX"
```

## Storage

Nextcloud uses a persistent volume for file storage. You can expand the volume as needed. To keep data but disable the app:

```sh
pulumi config set nextcloud:storageOnly true

# Keep the database engine running (use this for DB maintanance)
pulumi config set nextcloud:db/enabled true
pulumi up
```

## Access

After deployment, access Nextcloud at:

```sh
https://nextcloud.<domain>/
```

Login with the admin user. The password can be retrieved with:

```sh
pulumi stack output --show-secrets --json | jq '.apps.nextcloud.users.admin' -r
```

## NextCloud as UnifiedPush Provider

UnifiedPush lets Nextcloud notify a phone when calendar or contact data changes, so the phone does not need to poll the server frequently. This reduces unnecessary requests while keeping calendars and contacts up to date more quickly.

1. In Nextcloud, install **DAV Push** and **UnifiedPush Provider** from the Apps page.
2. On the phone, install **NextPush** and **DAVx5**. DAVx5 is required for CalDAV and CardDAV push notifications.
3. Follow the [NextPush setup procedure](https://unifiedpush.org/users/distributors/nextpush/) to connect the phone to Nextcloud.

Redis is provisioned and configured automatically by this component.

## Database

Nextcloud uses a MariaDB database to store its data, which is managed by the MariaDB Operator.

`nextcloud:adminPassword` is required at deployment and must be generated by you before running `pulumi up`. It is stored in the database and `config/config.php`, so keeping it stable ensures the application can connect to the database with the correct credentials after a restore.

```sh
# Get the nextcloud user password from Pulumi stack output
pulumi stack output --show-secrets --json | jq '.apps.nextcloud.db.password' -r

# Set password for the nextcloud user
pulumi config set nextcloud:db/password YourNextcloudDbPassword --secret

# Set password for the mariadb root user
./scripts/mariadb-password.sh nextcloud

pulumi up
```

## Upgrade

After updating Nextcloud it could enter _maintanace mode_.

In that case run the upgrade inside the container:

```sh
# enter the container
./scripts/exec.sh nextcloud

./occ upgrade

# Optional
./occ maintenance:mode --off
```

## Resetting admin password

If you lose the admin password, you can reset it. This is also helpful after restoring from backup and new password has been generated.

1.  Get a shell inside the Nextcloud container using the `exec.sh` script.

    ```sh
    ./scripts/exec.sh nextcloud
    ```

2.  Once inside the container's shell, run the `occ` command to reset the password for the `admin` user. Replace `YourNewPassword` with a strong password.

    ```sh
    ./occ user:resetpassword admin
    YourNewPassword
    ```

3.  Exit the container shell.

4.  (Recommended) Update the password in Pulumi config to match the one stored by Nextcloud. This keeps restores working with the same credentials.

    ```sh
    pulumi config set nextcloud:adminPassword YourNewPassword --secret
    ```

## Rclone Backup

Rclone can sync Nextcloud files to a local backup destination using WebDAV.

### Setup

1.  Create an app password in Nextcloud at **Settings → Security → Devices & sessions → Create new app password**.

2.  Configure the rclone remote:

    ```sh
    rclone config
    ```

    The resulting config (view with `rclone config show`) should look like:

    ```ini
    [nextcloud]
    type = webdav
    url = https://nextcloud.<domain>/remote.php/dav/files/<user>
    vendor = nextcloud
    user = <user>
    pass = <encoded-password>
    ```

3.  Sync Nextcloud files to local storage:

    ```sh
    rclone sync nextcloud:/ /mnt/my-drive/NextCloud/ -v -n
    ```

    Remove `-n` (dry-run) once you've verified the output.

---

For more advanced configuration, see the [Nextcloud Helm chart documentation](https://github.com/nextcloud/helm) and [Nextcloud admin docs](https://docs.nextcloud.com/server/latest/).
