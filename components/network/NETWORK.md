# Network

Network infrastructure including ingress, routing, and DNS.

Routing options:

- Tailscale - uses `<tsnet>.ts.net` domains managed by Tailscale
- Traefik - use for custom domain support

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

## Routing Provider Override

You can override the global routing provider on a per-application basis:

```sh
# Use Tailscale for a specific app even if Traefik is the global default
pulumi config set <app>:routingProvider tailscale
```

## Components

- **[Tailscale Operator](./tailscale/tailscale.md)** - Ingress with Tailscale authentication and `.ts.net` domains
- **[Traefik](./traefik/traefik.md)** - Ingress controller for custom domains with automatic TLS
- **[Cert-manager](./cert-manager/cert-manager.md)** - Automated certificate management (required for Traefik)
- **[Technitium](./technitium/technitium.md)** - DNS server and ad-blocker
- **[Zot](./zot/zot.md)** - OCI registry and pull-through image cache
