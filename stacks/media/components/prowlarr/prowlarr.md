# Prowlarr

|               |                                                                  |
| ------------- | ---------------------------------------------------------------- |
| Homepage      | https://prowlarr.com/                                            |
| Documentation | https://wiki.servarr.com/en/prowlarr                               |
| Docker Image  | https://docs.linuxserver.io/images/docker-prowlarr/              |

Indexer manager/proxy for the *arr ecosystem. Configured once and syncs indexers to [Radarr](../radarr/radarr.md) and [Sonarr](../sonarr/sonarr.md) automatically.

```sh
# Enable Prowlarr
pulumi config set prowlarr:enabled true

# (Recommended) Use specified Longhorn volume for config
pulumi config set prowlarr:fromVolume prowlarr

pulumi up
```

## Post-Installation

After deployment, access Prowlarr at the endpoint URL and complete these steps in order.

**Get URLs from stack outputs:**

```sh
# Show cluster endpoints
pulumi stack output --show-secrets --json | jq -r '.clusterUrls.prowlarr'
pulumi stack output --show-secrets --json | jq -r '.clusterUrls.radarr'
pulumi stack output --show-secrets --json | jq -r '.clusterUrls.sonarr'
```

1. **Authentication** — on first access, complete the setup modal (or later via Settings → General → Security): set Authentication to Forms and create an admin user
2. **Add indexers** — Indexers → Add Indexer → search and add your trackers (public and/or private)
3. **Connect Radarr** — Settings → Apps → Add Application → Radarr:
   - Prowlarr Server: use the Prowlarr cluster URL from above (e.g., `http://prowlarr.prowlarr:9696`)
   - Radarr Server: use the Radarr cluster URL from above (e.g., `http://radarr.radarr:7878`)
   - API Key: from Radarr → Settings → General → Security → API Key
4. **Connect Sonarr** — Settings → Apps → Add Application → Sonarr:
   - Prowlarr Server: use the Prowlarr cluster URL from above
   - Sonarr Server: use the Sonarr cluster URL from above (e.g., `http://sonarr.sonarr:8989`)
   - API Key: from Sonarr → Settings → General → Security → API Key

Once connected, Prowlarr automatically syncs indexers to Radarr and Sonarr. No need to configure indexers separately in each app.
