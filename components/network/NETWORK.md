# Network

Network infrastructure including ingress, routing, DNS, and public exposure.

## Choosing a setup

Two independent decisions: **`orangelab:routingProvider`** decides how a service
is addressed, and **`<app>:network/public`** decides whether it is reachable from
outside the tailnet. Mesh VPN control planes:

- [Tailscale](./tailscale/tailscale.md) - hosted, no administration
- [Headscale](./headscale/headscale.md) - self-hosted, sign in with Pocket ID
  instead of Google/Microsoft/GitHub, or with its own local users

The combinations in practice:

| #   | Setup                           | Services at              | Public at             | Own domain             | Third-party dependencies           |
| --- | ------------------------------- | ------------------------ | --------------------- | ---------------------- | ---------------------------------- |
| 1   | Tailscale                       | `<app>.<tailnet>.ts.net` | same name, via Funnel | **no** — `ts.net` only | Tailscale + Google/GitHub login    |
| 2   | Tailscale + Traefik             | `<app>.example.com`      | via Traefik           | yes                    | Tailscale (+ Google, or Pocket ID) |
| 3   | Tailscale + Traefik + Pocket ID | `<app>.example.com`      | via Traefik           | yes                    | Tailscale only                     |
| 4   | Headscale + Pocket ID           | `<app>.vpn.example.com`  | `<app>.example.com`   | yes                    | **none** (recommended default)     |

The **Own domain** column is the one that decides most setups. Having no domain of
your own costs you certificates, identity and your public name all at once —
see option 1 below.

### 1. Tailscale only — smallest, but you give up your domain

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
- **Con** — logging in needs a Tailscale account, so on the free plan this is
  Google, Microsoft or GitHub. No self-hosted identity option.
- **Con** — public exposure via Funnel is limited to ports 443, 8443 and 10000,
  HTTPS only, and relays through Tailscale. See [Funnel](#public-exposure).

### 2. Tailscale + Traefik — custom domain

Traefik routes services at `<app>.example.com` with cert-manager-issued
certificates. The Tailscale client stays on every node for node-to-node traffic;
it is just no longer what serves your applications.

- **Pro** — real domain you control. A wildcard certificate covers any new app
  without touching DNS, so adding services is a config change.
- **Pro** — works with any router. No MagicDNS involvement, so nothing depends on
  a client-side resolver.
- **Con** — needs an A record per service hostname pointing at a node that can
  reach the public gateway, plus a port forward. Tailscale remains a dependency
  for the cluster's own connectivity.
- **Con** — still Tailscale login unless you add Pocket ID (option 3).

### 3. Tailscale + Traefik + Pocket ID

Identical to option 2, with [Pocket ID](../security/pocket/pocket.md) as the
identity provider instead of Tailscale's hosted login.

Pocket ID must be enabled **and** made public at `pocket.example.com` — Tailscale
verifies your domain by fetching WebFinger at `example.com`, which only works if
the apex is publicly reachable. See [Caddy](./caddy/caddy.md).

- **Pro** — your own identity provider. Accounts, groups and passkeys are yours.
- **Con** — one more moving part, and the apex has to be public so Tailscale
  can verify the domain.
- **Con** — still depends on Tailscale's control plane for connectivity.

### 4. Headscale + Pocket ID — no external dependencies

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

**Headscale + Pocket ID (option 4)** is the right default in general. It removes
every vendor from the critical path: names, reachability and identity are all
yours, and the only external requirement is DNS you already own.

The cost is that **both Headscale and Pocket ID have to be exposed publicly** —
the control plane and the OIDC provider — which puts an identity provider and an
SSH access path on the internet. Both need care. See
[Migrating nodes](./headscale/headscale.md#migrating-nodes) before planning a
move.

**Tailscale + Traefik + Pocket ID (option 3)** is the right choice when you
already use Tailscale, or want the VPN control plane to be managed for you. It
keeps a vendor dependency for connectivity, but Pocket ID still removes the
Google/Microsoft/GitHub login — which is usually the part people actually care
about. Real domains, automatic certificates, and no migration.

**Tailscale only (option 1)** only if you have no custom domain and want the
smallest possible setup. You give up your own domain entirely — names,
certificates and identity all sit with Tailscale — and take a Google or GitHub
account dependency.

## Routing provider

```yaml
orangelab:
    routingProvider: tailscale # tailscale | traefik
```

- `tailscale` — serves `<app>.<tailnet>.ts.net`. Needs `tailscale:tailnet`, no
  domain of your own.
- `traefik` — serves `<app>.example.com`. Needs `orangelab:customDomain`,
  `cert-manager` and a DNS record per service.

Only Traefik can serve your own domain names. That single limitation is why
options 2–4 all require it, and it is what decides between option 1 and the
rest. Both providers also expose TCP endpoints as a LoadBalancer on the cluster
network.

Per-application override:

```sh
pulumi config set <app>:routingProvider tailscale
```

## Public exposure

```yaml
<app>:network/public: true
```

Private by default — without this, nothing is reachable from outside the
tailnet. What it does depends on the routing provider:

- **Traefik** — a second route on the public gateway, which only admits routes
  from namespaces labelled `orangelab.space/public`. The router needs one port
  forward (WAN 443 → node 10443). The service is reachable at its regular
  `<app>.example.com` name.
- **Tailscale** — [Funnel](./tailscale/tailscale.md#public-exposure-with-funnel),
  which publishes the same `ts.net` name to the internet. Requires a `funnel`
  node attribute in the tailnet policy, and is limited to ports 443, 8443 and 10000.

## Quick Start

```sh
# Tailscale (default)
pulumi config set orangelab:routingProvider tailscale
pulumi config set tailscale:tailnet <tailnet>.ts.net
pulumi config set tailscale:enabled true
pulumi up

# Traefik (custom domain)
pulumi config set orangelab:routingProvider traefik
pulumi config set orangelab:customDomain example.com
pulumi config set cert-manager:enabled true
pulumi config set traefik:enabled true
```

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
- **[Technitium](./technitium/technitium.md)** - DNS server and ad-blocker
- **[Zot](./zot/zot.md)** - OCI registry and pull-through image cache
