# Network

Network infrastructure including ingress, routing, DNS, the mesh VPN control
plane, and optional public access.

## Quick start

Start with Tailscale, or use Traefik for a custom domain. Headscale + Pocket ID
builds on the Traefik block. The trade-offs are in
[Choosing a setup](#choosing-a-setup).

```sh
# Tailscale (default): services at <app>.<tailnet>.ts.net
pulumi config set orangelab:routingProvider tailscale
pulumi config set tailscale:tailnet <tailnet>.ts.net
pulumi config set tailscale:oauthClientId <oauth-client-id>
pulumi config set tailscale:oauthClientSecret <oauth-client-secret> --secret
pulumi config set tailscale:enabled true
pulumi up

# Traefik (custom domain): services at <app>.example.com
pulumi config set orangelab:routingProvider traefik
pulumi config set orangelab:customDomain example.com
pulumi config set cert-manager:enabled true
pulumi config set traefik:enabled true
pulumi up

# Headscale + Pocket ID: run the Traefik settings above, then:
pulumi config set tailscale:enabled false
pulumi config set pocket:enabled true
pulumi config set pocket:hostname login
pulumi config set pocket:network/public true
pulumi config set pocket:encryptionKey "$(openssl rand -base64 32)" --secret
pulumi up

# headscale:baseDomain defaults to vpn.internal; keep it outside customDomain.
pulumi config set headscale:enabled true
pulumi config set headscale:network/public true
pulumi up

# After Headscale is up: create the Pocket ID client and wire it in.
./components/network/headscale/pocket-headscale.sh
pulumi config set headscale:auth pocket
pulumi config set headscale:auth/clientId <client-id>
pulumi config set headscale:auth/clientSecret <client-secret> --secret
pulumi up
```

Both Pocket ID and Headscale are public services; add their DNS records and
expose the gateway as described in
[Public services](../../docs/public-services.md). See the
[Headscale quick start](./headscale/headscale.md#quick-start) for prerequisites
and signing in.

## Choosing a setup

Two independent decisions: **`orangelab:routingProvider`** decides how a service
is addressed, and **`<app>:network/public`** decides whether it is reachable from
outside the tailnet. Public access is optional: the recommended setups require
it only for their control-plane and identity pieces, and applications stay
private unless you opt in. Mesh VPN control planes:

- [Tailscale](./tailscale/tailscale.md) - hosted, no administration
- [Headscale](./headscale/headscale.md) - self-hosted, paired with Pocket ID for
  sign-in instead of Google/Microsoft/GitHub

The main options are Tailscale and Headscale + Pocket ID. Tailscale + Pocket ID
is the hybrid: Tailscale keeps the control plane, Pocket ID replaces its hosted
login.

| #   | Setup                 | Services at              | Public apps at        | Own domain             | Third-party dependencies        |
| --- | --------------------- | ------------------------ | --------------------- | ---------------------- | ------------------------------- |
| 1   | Tailscale             | `<app>.<tailnet>.ts.net` | same name, via Funnel | **no** — `ts.net` only | Tailscale + Google/GitHub login |
| 2   | Tailscale + Pocket ID | `<app>.example.com`      | `<app>.example.com`   | yes                    | Tailscale                       |
| 3   | Headscale + Pocket ID | `<app>.example.com`      | `<app>.example.com`   | yes                    | **none** (recommended default)  |

The **Own domain** column is the one that decides most setups. Having no domain of
your own costs you certificates, identity and your public name all at once —
see option 1 below.

### 1. Tailscale — smallest, but you give up your domain

The Tailscale operator routes every service at `<app>.<tailnet>.ts.net`, and
that is the only name it will ever serve.

- **Con** — **services are reachable only at `<app>.<tailnet>.ts.net`**, never at
  a domain you own. This is the real cost. Without your own domain there is no
  ACME for it (cert-manager has nothing to issue), no own-domain identity
  (Pocket ID's WebFinger check needs a public apex you control), and Funnel
  publishes the `ts.net` name rather than yours.
- **Pro** — least to set up. No DNS records, no certificate issuance, no
  reverse proxy, no port forwards.
- **Con** — dependency on Tailscale's control plane for names and reachability.
- **Con** — logging in uses Tailscale's hosted login, which on the free plan is
  Google, Microsoft or GitHub. For your own identity provider, use the hybrid
  (option 2).
- **Con** — public exposure via Funnel is limited to ports 443, 8443 and 10000,
  HTTPS only, and relays through Tailscale. See
  [Funnel](./tailscale/tailscale.md#public-exposure-with-funnel).

### 2. Tailscale + Pocket ID — hosted control plane, own identity

Tailscale still provides names and connectivity, but users sign in through
[Pocket ID](../security/pocket/pocket.md) instead of Google, Microsoft or
GitHub. This is the hybrid option: less to run than Headscale, without the
hosted-login dependency.

It needs Traefik and a custom domain, so services are served at
`<app>.example.com` with cert-manager-issued certificates. Pocket ID must be
public at `pocket.example.com`; Tailscale verifies your domain by fetching
WebFinger at `example.com`, so the apex has to be public too. See
[Caddy](./caddy/caddy.md).

- **Pro** — real domain you control. A wildcard certificate covers any new app
  without touching DNS, so adding services is a config change.
- **Pro** — works with any router. No MagicDNS involvement, so nothing depends on
  a client-side resolver.
- **Pro** — your own identity provider. Accounts, groups and passkeys are yours.
- **Con** — one more moving part than plain Tailscale, and the apex has to be
  public so Tailscale can verify the domain.
- **Con** — still depends on Tailscale's control plane for connectivity.

### 3. Headscale + Pocket ID — no external dependencies

Self-hosted control plane. Set `headscale:baseDomain` and Headscale hands out
**host** names under it, `<node>.vpn.example.com`. No per-app configuration.

This option needs both Headscale and Pocket ID **enabled and public** — the
control plane at `headscale.example.com` and the identity provider at
`pocket.example.com`.

- **Pro** — **no third-party dependency for names, reachability or identity.**
  The only external requirement is DNS you already own. Maximum sovereignty.
- **Pro** — real domain, so services are addressable and certifiable normally.
- **Pro** — no Google, Microsoft or GitHub account is ever required.
- **Con** — most work to set up: migrate every node, and re-point service DNS
  records. Node migration is a destructive cutover, not a toggle.

### Recommendation

**Headscale + Pocket ID (option 3)** is the right default in general. It removes
every vendor from the critical path: names, reachability and identity are all
yours, and the only external requirement is DNS you already own.

The cost is that **both Headscale and Pocket ID have to be exposed publicly** —
the control plane and the OIDC provider — which puts an identity provider and an
SSH access path on the internet. Both need care. See
[Public services](../../docs/public-services.md) for exposing them, and
[Migrating nodes](../../docs/headscale-migration.md) before planning a move.

**Tailscale + Pocket ID (option 2)** is the hybrid: keep Tailscale's hosted
control plane when you do not want to run one, but replace the
Google/Microsoft/GitHub login with Pocket ID. It needs Traefik, a custom domain
and a public apex for WebFinger, but it avoids the control-plane migration.

**Tailscale (option 1)** only if you have no custom domain and want the smallest
possible setup. You give up your own domain entirely — names, certificates and
identity all sit with Tailscale — and take a Google or GitHub account
dependency.

## Routing provider

```yaml
orangelab:
    routingProvider: tailscale # tailscale | traefik
```

- `tailscale` — serves `<app>.<tailnet>.ts.net`. Needs `tailscale:tailnet`, no
  domain of your own.
- `traefik` — serves `<app>.example.com`. Needs `orangelab:customDomain`,
  `cert-manager` and a wildcard DNS record for the domain; public names need
  explicit records.

Only Traefik can serve your own domain names. That single limitation is why
options 2 and 3 require it, and it is what decides between option 1 and the
rest. Both providers also expose TCP endpoints as a LoadBalancer, private by
default; only Traefik can publish them publicly — see
[TCP and UDP ports](../../docs/public-services.md#tcp-and-udp-ports).

Per-application override:

```sh
pulumi config set <app>:routingProvider tailscale
```

## Public services

Public access is optional. Applications are private by default; set
`<app>:network/public: true` only when one must be reachable from the internet.

The recommended setups need public access only for their control-plane, identity
and domain-verification pieces; plain Tailscale needs none.

- **Headscale** — clients that are not on the LAN yet must reach the control
  plane to join.
- **Pocket ID** — sign-in redirects the browser to it, so it must be reachable
  from outside.
- **Caddy** — with Tailscale + Pocket ID, the apex serves the WebFinger document
  that proves domain ownership.

Under **Traefik**, public routes use the public gateway, which you expose with a
router port forward or a VPS proxy. Under **Tailscale**, `network/public` enables
[Funnel](./tailscale/tailscale.md#public-exposure-with-funnel) on the existing
`ts.net` name instead.

See [Public services](../../docs/public-services.md) for publishing
applications, both gateway methods, DNS records and the TCP/UDP port offset.

## ServiceLB Configuration

When using Traefik, k3s ServiceLB creates endpoints on port 80/443 on each node. To limit which nodes run the load balancer:

```sh
kubectl label node <node> svccontroller.k3s.cattle.io/enablelb=true
```

Adding the first label switches ServiceLB to whitelist-only mode. Without this label, all nodes in the cluster act as load balancer.

## Components

- **[Tailscale Operator](./tailscale/tailscale.md)** - Ingress with Tailscale authentication and `.ts.net` domains
- **[Traefik](./traefik/traefik.md)** - Ingress controller for custom domains with automatic TLS
- **[Caddy](./caddy/caddy.md)** - Serves the bare custom domain (WebFinger, redirects)
- **[Cert-manager](./cert-manager/cert-manager.md)** - Automated certificate management (required for Traefik)
- **[Headscale](./headscale/headscale.md)** - Self-hosted Tailscale control plane
- **[Headplane](./headplane/headplane.md)** - Web UI for Headscale, mesh-only
- **[Technitium](./technitium/technitium.md)** - DNS server and ad-blocker
- **[Zot](./zot/zot.md)** - OCI registry and pull-through image cache
