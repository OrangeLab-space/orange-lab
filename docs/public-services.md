# Public services

Public access is optional. Applications stay private to the tailnet unless you
opt in, and the recommended setups need public access only for their control
plane, identity provider, and domain verification:

| Setup                     | Must be public                  |
| ------------------------- | ------------------------------- |
| Tailscale (Google/GitHub) | nothing                         |
| Tailscale + Pocket ID     | Pocket ID and Caddy (WebFinger) |
| Headscale + Pocket ID     | Headscale and Pocket ID         |

Pocket ID must be public because sign-in redirects the browser to it. With
Tailscale + Pocket ID, Caddy must also serve the WebFinger document at the public
apex so Tailscale can verify domain ownership. Headscale must be reachable by clients
that are not on the LAN yet. Everything else is a choice.

Under **Traefik**, publish an application with `<app>:network/public: true` and
expose the public gateway with one of the two methods below. Under **Tailscale**,
the same setting enables
[Funnel](../components/network/tailscale/tailscale.md#public-exposure-with-funnel)
instead.

## Publishing an application

```sh
pulumi config set <app>:network/public true
pulumi up
```

With Traefik this adds a second route on the public gateway and labels the
namespace `orangelab.space/public`; the application keeps its normal
`<app>.example.com` name. Turning the setting off removes the public route and
leaves the private one untouched.

With Traefik, every public name needs an explicit `A` record at the WAN IP
(router forward) or the VPS IP (proxy). The private wildcard points at a mesh
address, so it does not cover the public path. Keep these records DNS-only: a
CDN proxy terminates TLS itself and the cluster certificate is no longer the one
clients see.

## Exposing the Traefik public gateway

Public routes terminate on the public gateway at port `10443`; the private
listener stays on `443`. Keeping the listeners separate means a fault or
misconfiguration on the public one cannot be reached through the private one.

Choose one method.

### 1. Router port forward

Forward the WAN ports to a node running the ServiceLB (see
[ServiceLB configuration](../components/network/NETWORK.md#servicelb-configuration)):

```text
WAN 80/tcp  -> <node>:10080  (redirects to HTTPS)
WAN 443/tcp -> <node>:10443
```

Then point every public name at your WAN IP with an explicit `A` record: the
control plane, Pocket ID, the apex and `www` if Caddy is used, and each public
application. Do not enable a CDN or DNS proxy on them.

This is the simplest method. It requires a public IPv4 address (not CGNAT),
permission to forward port `443` (and `80` for the HTTPS redirect), and a
firewall rule allowing them to the ServiceLB node. Internal clients that use the
public name also need NAT loopback (hairpin) on the router; without it, they
resolve the WAN IP and never reach the listener.

### 2. VPS public proxy

If you do not want to publish your home IP, run a small VPS outside the cluster.
It joins the same tailnet and forwards HTTP and TLS passthrough traffic to the
public gateway; DNS points at the VPS, so the home address is never published
and an ISP change is a DNS change. Certificates stay in the cluster.

See [Public proxy on a VPS](./public-proxy.md) for setup, verification and the
optional exit node.

## TCP and UDP ports

`network/public` is the application-level gate. A TCP or UDP port also needs
`public: true` on the port, and only Traefik can publish it:

```ts
ports: [{ name: 'ssh', port: 22, protocol: 'tcp', public: true }];
```

The private LoadBalancer keeps the port's own number; a second public
LoadBalancer publishes it at `<port> + 10000`. `22` becomes `10022`, `8333`
becomes `18333`. The offset puts every public port in one band at or above
10000, so a private port is never forwarded by accident.

```text
WAN 22/tcp   -> <node>:10022
WAN 8333/udp -> <node>:18333
```

- **Router port forward** — forward each WAN port to the offset port on the
  ServiceLB node.
- **VPS proxy** — add
  `--tcp-forward <public-port>=<name>=<node>:<offset-port>` for each upstream
  and open the public port in the VPS firewall.

Raw TCP has no SNI or host filter, so only forward ports that are meant to be
public. Never forward a database, RPC, admin or metrics port.

Under Tailscale a TCP or UDP port is always private: Funnel serves HTTPS only,
so marking one `public` fails the deploy instead of pretending to be reachable.

## See also

- [Network](../components/network/NETWORK.md) — choosing a control plane and
  routing provider.
- [Traefik public exposure](../components/network/traefik/traefik.md#public-exposure)
  — route objects, namespace isolation, and the private/public split.
- [Tailscale Funnel](../components/network/tailscale/tailscale.md#public-exposure-with-funnel)
  — requirements and limitations.
- [Headscale](../components/network/headscale/headscale.md) — public control
  plane and DNS.
- [Caddy](../components/network/caddy/caddy.md) — public apex and WebFinger.
