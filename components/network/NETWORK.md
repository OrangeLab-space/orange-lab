# Network

Network infrastructure including ingress, routing, and DNS.

Routing options:

- Tailscale - uses `<tsnet>.ts.net` domains managed by Tailscale
- Traefik - use for custom domain support

## Routing provider

```yaml
orangelab:
  routingProvider: tailscale # tailscale | traefik
```

- `tailscale` — serves `<app>.<tailnet>.ts.net`. Needs `tailscale:tailnet`, no
  domain of your own.
- `traefik` — serves `<app>.example.com`. Needs `orangelab:customDomain`,
  `cert-manager` and a DNS record per service.

Only Traefik can serve your own domain names, so it is required for options 2–4.
Both providers also expose TCP endpoints as a LoadBalancer on the cluster network.

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
  node attribute in the tailnet policy, and is limited to ports 443, 8443 and
  10000.

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
- **[Technitium](./technitium/technitium.md)** - DNS server and ad-blocker
- **[Zot](./zot/zot.md)** - OCI registry and pull-through image cache
