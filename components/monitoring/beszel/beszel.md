# Beszel

|               |                                                   |
| ------------- | ------------------------------------------------- |
| Homepage      | https://beszel.dev/                               |
| Endpoints     | `https://beszel.<domain>/`                        |
|               | `https://beszel.<domain>/_/`                      |
| Documentation | https://pocket-id.org/docs/client-examples/beszel |

A lightweight alternative to Prometheus.

First deploy Beszel hub with:

```sh
pulumi config set beszel:enabled true
pulumi up
```

Once the hub is deployed, go to `beszel.<domain>` endpoint and create an admin account.

To deploy agents you need to find the generated public key. Click `Add system`, then copy the `Public key` field. Close the popup and do not add any systems yet.

You can automatically add all agents by enabling universal token (Settings -> Token & Fingerprints -> Universal token).

```sh
# replace <KEY> with the copied value "ssh-ed25519 ..."
pulumi config set beszel:hubKey <KEY>
# copy universal token from UI so agents can automatically register
pulumi config set beszel:TOKEN <TOKEN> --secret
pulumi up
```

Make sure to allow traffic to agents on port `45876`:

```sh
firewall-cmd --permanent --add-port=45876/tcp
```

## SSO

Beszel supports OAuth login via [Pocket ID](../../security/pocket/pocket.md), following the [Beszel example](https://pocket-id.org/docs/client-examples/beszel). Beszel keeps its OAuth configuration in PocketBase and has no environment variables for it, so the provider is configured in the superuser interface while the component only handles the client provisioning and disabling password login.

> **Important:** configure the OAuth provider in the superuser interface (next section) **before** `pulumi up` with the auth config below - once `beszel:auth` is set, password login is disabled and only users that can log in via OAuth retain access.

1. Run the generic Pocket ID client script from the repository root (where the core stack lives) to create the OIDC client:

```sh
./components/monitoring/beszel/pocket-beszel.sh

# Configure the printed values
pulumi config set beszel:auth pocket
pulumi config set beszel:auth/clientId <client-id>
pulumi config set beszel:auth/clientSecret <client-secret> --secret
```

2. Configure the OAuth provider in the Beszel superuser interface at `beszel.<domain>/_/#/settings` following the [Beszel example](https://pocket-id.org/docs/client-examples/beszel) (Settings -> Application -> disable "Hide collection create and edit controls" -> Collections > `users` -> Options -> OAuth2 -> enable and add the `oidc` provider):
    - **Client ID / Client Secret**: from `pulumi config get beszel:auth/clientId` and `pulumi config get beszel:auth/clientSecret --show-secrets`
    - **Display Name**: `Pocket ID`
    - **Auth URL**: `https://login.<domain>/authorize`
    - **Token URL**: `https://login.<domain>/api/oidc/token`
    - **User Info URL**: `https://login.<domain>/api/oidc/userinfo`
    - **Support PKCE**: on
    - Set **Fetch user info from** to **User info URL**

    Save, then re-enable **Hide collection create and edit controls** in the settings page.

3. Enable verified emails in Pocket ID (**Application Configuration** -> **Emails Verified**); Beszel requires a verified email to create new OAuth users. If a first login fails with `email: cannot be blank`, the user's email is not marked verified in Pocket ID.
4. Run `pulumi up` - this applies the auth config and sets `DISABLE_PASSWORD_AUTH=true` on the hub. Users log in with the **Pocket ID** button on the login page; the password login screen is no longer shown.

Automatic user creation on first login is already enabled by the component (`USER_CREATION=true`). Systems are shared with all users (`SHARE_ALL_SYSTEMS=true`), so new SSO users see every host immediately; without it, systems created by one user stay invisible to others unless shared per-system in PocketBase.

Superuser login (`beszel.<domain>/_/`) is a separate account type in PocketBase and only supports password authentication - a PocketBase superuser cannot log in with OAuth, so keep the original admin password. Its role-to-user distinction applies to hub users only: granting a hub user the `admin` role does not give access to `/_/`.
