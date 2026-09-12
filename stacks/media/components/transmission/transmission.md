# Transmission

|               |                                                                  |
| ------------- | ---------------------------------------------------------------- |
| Homepage      | https://transmissionbt.com/                                      |
| Documentation | https://transmission.readthedocs.io/                             |
| Docker Image  | https://docs.linuxserver.io/images/docker-transmission/          |

BitTorrent client. Downloads media files acquired by Radarr and Sonarr.

Transmission mounts the shared media storage configured in the [Media stack README](../../README.md) at `/media`.

```sh
# Configure Media profile
pulumi config set transmission:media jellyfin-media

# Enable Transmission
pulumi config set transmission:enabled true
# Required when using media:hostPath
pulumi config set transmission:requiredNodeLabel kubernetes.io/hostname=<host>

# (Recommended) Use specified Longhorn volume for config
pulumi config set transmission:fromVolume transmission

pulumi up
```

## Arr Stack Integration

```sh
# Show cluster endpoint
pulumi stack output --show-secrets --json | jq -r '.clusterUrls.transmission'

# Show browser URL
pulumi stack output --show-secrets --json | jq -r '.endpoints.transmission'
```

Add Transmission as a download client at **Settings → Download Clients → Add → Transmission**:

- Host: `transmission.transmission`
- Port: `9091`
- Url Base: `/transmission/`
- Click **Test**, then **Save**

Then add a **Remote Path Mapping** at **Settings → Download Clients → Remote Path Mappings**:

- Host: `transmission.transmission`
- Remote Path: `/downloads/complete`
- Local Path: `/media/downloads/complete`

Downloads are saved to `/downloads/complete` inside the container, which maps to the host's media downloads folder.

In case of *Radarr* map `/downloads/complete/radarr` to `/media/downloads/complete/radarr/`
