# Zot

|               |                                                               |
| ------------- | ------------------------------------------------------------- |
| Homepage      | https://zotregistry.dev/                                      |
| Source code   | https://github.com/project-zot/zot                            |
| Documentation | https://zotregistry.dev/                                      |
| Docker Image  | https://github.com/project-zot/zot/pkgs/container/zot         |
| Dockerfile    | https://github.com/project-zot/zot/blob/main/build/Dockerfile |
| Endpoints     | `https://registry.<domain>/`                                  |

Zot is an OCI registry that caches upstream container images on demand (pull-through cache) and serves them locally to the cluster. This decouples deployments from upstream registries, avoids rate limits, and lets images be pinned by digest.

Anonymous pulls are allowed. Pushing, and the web UI, require the `admin` user.

Traefik (custom domain) is recommended so the wildcard certificate makes `registry.<domain>` trusted by the cluster nodes.

## Deployment

```sh
cd stacks/core

# (Optional) Admin password for the web UI and pushes - auto-generated if omitted
pulumi config set zot:adminPassword '<password>' --secret

pulumi config set zot:enabled true
pulumi up

# Read the password if it was auto-generated
pulumi stack output --json --show-secrets | jq -r '.network.zotUsers.admin'
```

## Usage

Reference a cached image through the registry instead of the upstream. The `<destination>` path is the upstream alias from the table below, followed by the image path.

```sh
# Pull through the cache (anonymous)
docker pull registry.<domain>/docker/nginx:latest
podman pull registry.<domain>/ghcr/owner/image:tag

# Point an app at a cached image
pulumi config set <app>:image registry.<domain>/ghcr/owner/image:tag
```

The first pull downloads the image from the upstream and caches it, so it must use a tag. Once cached, digest-pinned references (`...@sha256:<digest>`) and signatures stay valid because upstream digests are preserved.

## Upstreams

| Destination | Upstream                                                     |
| ----------- | ------------------------------------------------------------ |
| `/docker`   | `docker.io` (official images can omit the `library/` prefix) |
| `/ghcr`     | `ghcr.io`                                                    |
| `/quay`     | `quay.io`                                                    |
| `/k8s`      | `registry.k8s.io`                                            |
| `/forgejo`  | `code.forgejo.org`                                           |
| `/n8n`      | `docker.n8n.io`                                              |
| `/lscr`     | `lscr.io`                                                    |
| `/nvcr`     | `nvcr.io`                                                    |
| `/mariadb`  | `docker-registry1.mariadb.com`                               |

The list is defined by `zot:registries` in `Pulumi.yaml` (each entry has an upstream `host`, `url`, and local `destination`) and is shared with the K3s mirror script below.

## K3s node mirroring

By default images are cached only when referenced explicitly (see [Usage](#usage)). To transparently cache images on a node, configure K3s containerd to use Zot as a mirror. Because Zot runs on the cluster, do this **after** Zot is deployed (and repeat it for nodes added later, or if the Zot endpoint changes).

Generate `/etc/rancher/k3s/registries.yaml` from the `network.endpoints.zot` output and write it on the node:

```sh
# Run where Pulumi is installed
./scripts/k3s-registries.sh | ssh root@<node> 'mkdir -p /etc/rancher/k3s && tee /etc/rancher/k3s/registries.yaml >/dev/null'

# Restart K3s on the node
systemctl restart k3s.service        # server
systemctl restart k3s-agent.service  # Fedora/Bluefin agent
rc-service k3s-agent restart         # Alpine
```

If Zot is not deployed, the script exits with an error. Each upstream is mapped to its Zot destination (`https://registry.<domain>/v2/<destination>`); containerd still falls back to the upstream registry when Zot is unavailable or the image is uncached, so first-boot pulls keep working.

Verify the generated containerd configuration on the node:

```sh
cat /var/lib/rancher/k3s/agent/etc/containerd/certs.d/docker.io/hosts.toml
```

To revert, remove the file and restart K3s:

```sh
rm /etc/rancher/k3s/registries.yaml
systemctl restart k3s-agent.service
```

Mirroring is per node and covers only the upstreams listed above. Pulls from `registry.<domain>` itself go to Zot directly.

## Authentication

Anonymous users can read any cached image. The `admin` user (password from `zot:adminPassword` or the `network.zotUsers.admin` output) can push images and use the web UI:

```sh
docker login registry.<domain>
```

Because read access is anonymous while pushing is authenticated, the Docker client is challenged for credentials at `/v2/` and requires `docker login` even for public pulls. Containerd and Podman authenticate per request and pull anonymously without login.

## Pushing your own images

Besides caching upstream images, Zot is a normal registry you can push to. Authenticate as `admin`, push, then reference the image by tag or digest:

```sh
docker login registry.<domain>

docker tag myapp registry.<domain>/apps/myapp:1.0
docker push registry.<domain>/apps/myapp:1.0

# Use it for a component/app
pulumi config set <app>:image registry.<domain>/apps/myapp:1.0
```

> Note: read access is currently anonymous for all repositories (`anonymousPolicy: read` on `**`), so pushed images are readable by anyone who can reach the registry. Per-repository policies to make images private are not configured yet; treat Zot as a network-restricted registry, not a secret store.

## SSO

Zot supports OpenID Connect login for the web UI using [Pocket ID](../../security/pocket/pocket.md). The registry API still uses the `admin` password, since CLI clients cannot complete a browser redirect.

1. Enable the [security module](../../security/pocket/pocket.md), then create the OIDC client from the repository root (where the core stack lives):

```sh
./components/network/zot/pocket-zot.sh

# Configure the printed values
pulumi config set zot:auth pocket
pulumi config set zot:auth/clientId <client-id>
pulumi config set zot:auth/clientSecret <client-secret> --secret
pulumi up
```

2. A Pocket ID button then appears on the login page. The optional `zot:auth/providerName` labels the button.

Any Pocket ID user can log in and, because authenticated users get the default policy, can push and edit through the UI. Create the same user in the `admin`/htpasswd config if you also need CLI push.

## Vulnerability scanning

Zot scans cached images for CVEs with its built-in Trivy integration. The scan interval is set with `zot:scanInterval` (default `24h`, minimum `2h`):

```sh
pulumi config set zot:scanInterval 24h
```

On first run zot downloads the Trivy database into the storage volume (`_trivy`), which can take a few minutes; images show a "failed to scan" badge until the download and initial scans finish. The database is refreshed on every interval and persists across restarts.

The "not signed" badge appears for images without cosign/notation signatures, which is expected for most upstream images.
