# Seerr

|               |                                                                  |
| ------------- | ---------------------------------------------------------------- |
| Homepage      | https://docs.seerr.dev/                                          |
| Documentation | https://docs.seerr.dev/                                          |
| Docker Image  | https://github.com/seerr-team/seerr/pkgs/container/seerr         |
| Endpoints     | `https://seerr.<domain>/`                                        |

Media request management. Integrates with Jellyfin for auth and library sync, and Radarr/Sonarr for request fulfillment.

```sh
# Enable Seerr (requires Jellyfin)
pulumi config set seerr:enabled true

pulumi up
```

## Jellyfin Credentials

Seerr has no OIDC support - users log in with a Jellyfin username and password. Jellyfin accounts created via SSO have no password, so an admin sets one for each user (Jellyfin Dashboard -> Users) - SSO login keeps working alongside it. See [Jellyfin SSO](../jellyfin/jellyfin.md#sso-pocket-id).

## Pocket ID Launcher

Seerr itself does not support OIDC, but it can appear in Pocket ID's App Dashboard as a plain launcher icon:

```sh
cd stacks/media
./components/seerr/pocket-seerr.sh
```

## Setup

After deployment, access Seerr at the endpoint URL and complete the setup wizard. Seerr runs in your browser so it needs **external** URLs (not cluster URLs).

Get external URLs:

```sh
# Show URLs
pulumi stack output --show-secrets --json | jq -r '.endpoints.jellyfin'
pulumi stack output --show-secrets --json | jq -r '.endpoints.radarr'
pulumi stack output --show-secrets --json | jq -r '.endpoints.sonarr'
```

### 1. Jellyfin (required)

- URL: external Jellyfin URL (e.g., `https://jellyfin.<domain>`), port 443, SSL enabled
- Username/password: create a dedicated Jellyfin user for Seerr (see [Jellyfin → Seerr Integration](../jellyfin/jellyfin.md#seerr-integration)) or use the admin account
- **Sync Libraries**: enable "Movies" and "Shows", then click "Start Scan"
- Once sync completes, proceed to **Configure Services** below

### 2. Radarr (recommended)

**Prerequisites**: Root folder `/media/movies` must exist in Radarr first (Settings → Media Management → Root Folders) — see [Radarr post-installation](../radarr/radarr.md#post-installation).

- URL: external Radarr URL (e.g., `https://radarr.<domain>`), port 443, SSL enabled
- API key: from Radarr → Settings → General → Security → API Key
- Root folder: `/media/movies`
- Enable scan, mark as default

### 3. Sonarr (recommended)

**Prerequisites**: Root folder `/media/shows` must exist in Sonarr first (Settings → Media Management → Root Folders) — see [Sonarr post-installation](../sonarr/sonarr.md#post-installation).

- URL: external Sonarr URL (e.g., `https://sonarr.<domain>`), port 443, SSL enabled
- API key: from Sonarr → Settings → General → Security → API Key
- Root folder: `/media/shows`
- Enable scan, mark as default
