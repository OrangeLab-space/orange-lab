# Jellyfin

|               |                                            |
| ------------- | ------------------------------------------ |
| Homepage      | https://jellyfin.org/                      |
| Source code   | https://github.com/jellyfin/jellyfin       |
| Docker Image  | https://hub.docker.com/r/jellyfin/jellyfin |
| Documentation | https://jellyfin.org/docs/                 |
| SSO Plugin    | https://github.com/K0lin/jellyfin-plugin-sso |
| Endpoints     | `https://jellyfin.<domain>/`               |

Free Software Media System. Streaming movies, TV shows and music.

Jellyfin shares the media storage configured for the [Media stack](../../README.md) with [Radarr](../radarr/radarr.md), [Sonarr](../sonarr/sonarr.md), and [Transmission](../transmission/transmission.md). Configure the shared storage once before enabling applications.

```sh
# Configure Media profile
pulumi config set jellyfin:media jellyfin-media

pulumi config set jellyfin:enabled true
# Required when using media:hostPath
pulumi config set jellyfin:requiredNodeLabel kubernetes.io/hostname=my-host

# Use specified Longhorn volume for Jellyfin application data
pulumi config set jellyfin:fromVolume jellyfin

pulumi up
```

## Post-Installation

After deployment, access Jellyfin at `https://jellyfin.<domain>/` and complete the setup wizard:

1. Create a root user
2. Add media libraries: Movies (`/media/movies`), Shows (`/media/shows`), etc.

### Seerr Integration

Create a dedicated Jellyfin user for Seerr at Dashboard → Users (`https://jellyfin.<domain>/`):

1. Add a user (e.g., `seerr`) with a password
2. Enable "Allow this user to manage the server"
3. Grant access to all libraries

An existing admin user works but a dedicated user is recommended.

## SSO (Pocket ID)

Jellyfin supports OIDC login via [Pocket ID](../../../../components/security/pocket/pocket.md) using the [SSO plugin (K0lin fork)](https://github.com/K0lin/jellyfin-plugin-sso). This is a manual setup - the plugin is configured in the Jellyfin web UI and requires no Pulumi configuration.

> [!WARNING]
> SSO only works in browsers and apps that support [QuickConnect](https://jellyfin.org/docs/general/server/quick-connect). Native Jellyfin apps (Android, iOS, Smart TV) sign in via QuickConnect only: start QuickConnect in the app, then accept the code in the web browser after logging in with Pocket ID.

1. From `stacks/media`, create the OIDC client with Pocket ID's API key:

```sh
cd stacks/media
./components/jellyfin/pocket-jellyfin.sh
```

2. In Jellyfin (**Dashboard -> Plugins -> Repositories**), add the K0lin manifest:
   `https://raw.githubusercontent.com/k0lin/jellyfin-plugin-sso/manifest-release/manifest.json`, install **SSO-Auth** from the catalog and restart.
3. In **Dashboard -> My Plugins -> SSO-Auth**, add an OpenID provider:

| Field                 | Value                                                          |
| --------------------- | -------------------------------------------------------------- |
| Provider name         | `pocketid` (must match the callback URL)                       |
| OID Endpoint          | `https://pocket.<domain>/.well-known/openid-configuration`     |
| Client ID / Secret    | From the script output                                         |
| Enabled               | yes                                                            |
| Enable Authorization  | yes (group membership controls admin status)                   |
| Enable All Folders    | yes                                                            |
| Roles                 | (empty - every user gets access)                               |
| Admin Roles           | `admin`                                                        |
| Role Claim            | `groups`                                                       |
| Scopes                | `groups`                                                       |
| Username claim        | `preferred_username`                                           |
| Avatar URL format     | `@{picture}` (syncs the Pocket ID avatar)                      |
| Disable Pushed Authorization | yes (Pocket ID rejects PAR)                             |
| Scheme Override       | `https` (behind the ingress the plugin otherwise derives `http`) |

4. Restart Jellyfin (**Dashboard -> General -> Restart**) - the config page only renders after a restart.
5. Add a **Sign in with Pocket ID** button under **Dashboard -> General -> Branding**, in the *Login disclaimer* block:

`<form action="https://jellyfin.<domain>/sso/OID/start/pocketid"><button class="raised block emby-button button-submit">Sign in with Pocket ID</button></form>`

And in the *Custom CSS code* block:

`a.raised.emby-button { padding: 0.9em 1em; color: inherit !important; } .disclaimerContainer { display: block; }`

### Provider Configuration via API

Alternative to the plugin's config page (roles left blank = every provisioned user gets access). The OIDC credentials are read from the stack config:

```sh
# Create an API key in Dashboard -> API Keys, then:
export API_KEY=<api-key>
export JELLYFIN_URL=$(pulumi stack output --json | jq -er '.endpoints.jellyfin')
export POCKET_URL=$(pulumi --cwd ../.. stack output --json | jq -er '.security.endpoints.pocket')
export OIDC_CLIENT_ID=$(pulumi config get jellyfin:auth/clientId)
export OIDC_CLIENT_SECRET=$(pulumi config get jellyfin:auth/clientSecret)

curl -sf -X POST "$JELLYFIN_URL/sso/OID/Add/pocketid" \
  -H "Authorization: MediaBrowser Token=\"$API_KEY\"" \
  -H 'Content-Type: application/json' \
  -d '{
    "oidEndpoint": "'"$POCKET_URL"'/.well-known/openid-configuration",
    "oidClientId": "'"$OIDC_CLIENT_ID"'",
    "oidSecret": "'"$OIDC_CLIENT_SECRET"'",
    "enabled": true,
    "enableAuthorization": true,
    "enableAllFolders": true,
    "enabledFolders": [],
    "roles": [],
    "adminRoles": ["admin"],
    "roleClaim": "groups",
    "oidScopes": ["groups"],
    "defaultUsernameClaim": "preferred_username",
    "avatarUrlFormat": "@{picture}",
    "disablePushedAuthorization": true,
    "schemeOverride": "https"
  }'

# Verify:
curl -sf "$JELLYFIN_URL/sso/OID/Get" -H "Authorization: MediaBrowser Token=\"$API_KEY\"" | jq
```

### Notes

- Keep the local `admin` account usable as a fallback login.
- If a Pocket ID username matches an existing Jellyfin account, the plugin overrides that account's permissions on login; `Enable Authorization` makes group membership the source of truth for admin and folder access.
- Existing Jellyfin users can link or unlink their SSO identity at `/SSOViews/linking`.

## Hardware Acceleration

Jellyfin supports hardware transcoding with NVIDIA and AMD GPUs. To enable:

1. Install the appropriate GPU operator from the [Hardware module](../../hardware/HARDWARE.md)
2. Set the GPU type for Jellyfin:

```sh
pulumi config set jellyfin:gpu nvidia
# or
pulumi config set jellyfin:gpu amd
```

3. Enable hardware acceleration in Jellyfin UI at Dashboard → Playback → Transcoding:
    - Set **Hardware acceleration** to `NVIDIA NVENC` or `AMD AMF`

## Permissions/SELinux

The deployment includes an init container that creates necessary directories and sets ownership. However, if you're running SELinux, you may need to set the container context on the host directory:

```sh
semanage fcontext -a -t container_file_t '/mnt/media(/.*)?'
restorecon -R /mnt/media
```

## Uploading Media Files

To upload files directly to the Jellyfin media volume without SSH access to the node, use the provided script:

```sh
# From stacks/media/
cd stacks/media

# Upload a movie
./scripts/jellyfin-upload.sh ~/Downloads/movie.mkv /media/movies/

# Upload multiple TV episodes
./scripts/jellyfin-upload.sh ~/TV/*.mkv /media/shows/
```

The script uses `kubectl cp` to copy files into the running Jellyfin pod. Wildcards in the source path are supported natively by `kubectl cp`.
