# DroppedNeedle

|               |                                                                         |
| ------------- | ----------------------------------------------------------------------- |
| Homepage      | https://www.droppedneedle.com/                                          |
| Source code   | https://github.com/HabiRabbu/DroppedNeedle                              |
| Documentation | https://droppedneedle.com/docs                                          |
| Configuration | https://droppedneedle.com/docs/configuration                            |
| Docker Image  | https://hub.docker.com/r/droppedneedle/droppedneedle                 |
| Endpoints     | `https://droppedneedle.<domain>/`                                       |

Self-hosted music request, discovery, and library management app. It scans, tags, fingerprints, and organises your music library natively, and drives downloads through slskd (Soulseek). Gives a Spotify-like UI for your music library. Listen through web or mobile apps with OpenSubsonic and Jellyfin APIs compatibility.

DroppedNeedle depends on [slskd](../slskd/slskd.md) for downloads and integrates with [Jellyfin](../jellyfin/jellyfin.md). Configure shared media storage in the [Media stack README](../../README.md) before enabling this component.

```sh
# Configure Media profile
pulumi config set droppedneedle:media jellyfin-media

# Enable DroppedNeedle (requires slskd)
pulumi config set droppedneedle:enabled true

# Required when using media:hostPath
pulumi config set droppedneedle:requiredNodeLabel kubernetes.io/hostname=<host>

# (Recommended) Use specified Longhorn volume for config
pulumi config set droppedneedle:fromVolume droppedneedle

pulumi up
```

## SSO (Pocket ID)

DroppedNeedle supports OIDC login via [Pocket ID](../../../../components/security/pocket/pocket.md). Keep the local admin account as a password fallback - both login methods stay available per user.

1. From `stacks/media`, create the OIDC client with Pocket ID's API key:

```sh
cd stacks/media
./components/droppedneedle/pocket-droppedneedle.sh
```

```sh
# Values for DroppedNeedle Settings -> Security:
# Issuer URL (Pocket ID base URL) and Redirect URL:
 pulumi --cwd ../.. stack output --json | jq -er '.security.endpoints.pocket' # -> Issuer URL
 pulumi stack output --json | jq -er '.endpoints.droppedneedle'              # -> Redirect URL + /api/v1/auth/oidc/callback
```

2. In DroppedNeedle **Settings -> Security**, enter:
   - **Issuer URL**: the Pocket ID base URL from the first output (e.g. `https://login.<domain>`)
   - **Client ID / Secret**: from the script output
   - **Redirect URL**: `<droppedneedle URL>/api/v1/auth/oidc/callback` from the second output (the same URL registered with Pocket ID)
3. Save - an SSO button appears on the login page.

Users who sign in via OIDC are created automatically on first login with the `User` role; an admin can promote them at **Settings -> Users**. OIDC users can add a password from their profile to also log in with a username.

## Post-Installation

After deployment, access DroppedNeedle at the endpoint URL and complete these steps:

### 1. Admin Account

On first launch, create an admin account (username and password; email optional). Save the password in your password manager.

### 2. Library and Scan

Go to **Settings → Library**, add your library path, and scan:

- **Path**: `/media/music` (replace the default `/music`)
- Click **Save**, then **Scan**

DroppedNeedle walks your music folder, identifies files, and populates the library. Files that can't be confidently identified go into a manual-review queue. Downloaded files are imported into this path using atomic moves from the `SLSKD_DOWNLOADS_PATH` (default `/media/slskd-downloads`).

(Optional) Add an **AcoustID API key** on the same page to enable Tier-3 fingerprint identification for files without MusicBrainz tags. Get a key at [acoustid.org/api-key](https://acoustid.org/api-key).

### 3. Download Client — slskd

At **Settings → Download Client**, add your slskd server:

- **URL**: `http://slskd.slskd:5030`
- **API Key**: retrieve the auto-generated key with `pulumi stack output --show-secrets --json | jq -r '.apps.slskd.apiKey'`
- Click **Test**, then **Save**

### 4. (Optional) Connect Apps

Enable OpenSubsonic and/or Jellyfin APIs at **Settings → Connect Apps** and create per-app passwords so mobile clients can stream your library. Each user manages their own connections.

### 5. (Optional) Jellyfin

Connect Jellyfin at **Settings → Jellyfin** for both login (Jellyfin users can sign into DroppedNeedle) and playback. First prepare Jellyfin:

- Create a **DroppedNeedle** account in Jellyfin → Administration → Users
- Create an API key in Jellyfin → Administration → API Keys

Then in DroppedNeedle:

- **URL**: `http://jellyfin.jellyfin:8096`
- **API Key**: the key you created above
- Click **Test**, then **Save**

### 6. (Optional) YouTube

Add an API key at **Settings → YouTube** to enable auto-generated preview links for albums not in your library. Instructions are on the page.

### 7. (Optional) Scrobbling

**ListenBrainz (recommended, open source)** — no admin setup needed. Each user goes to **Profile → Scrobbling & Discovery** and pastes their token from [listenbrainz.org/profile](https://listenbrainz.org/profile).

**Last.fm (optional)** — requires admin setup. Register an app at [last.fm/api/account/create](https://www.last.fm/api/account/create), then add the app key and shared secret at **Settings → Last.fm**. Each user can then connect their Last.fm account from **Profile → Scrobbling & Discovery**.

### 8. (Optional) Spotify

Add client ID and secret at **Settings → Spotify** for playlist import. Each user can then import and sync their Spotify playlists.

### 9. (Optional) Live Events

Add Ticketmaster and Skiddle API keys (both free) at **Settings → Live Events**. Each user picks the cities they want to watch from their profile.
