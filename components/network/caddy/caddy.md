# Caddy (apex)

|               |                                            |
| ------------- | ------------------------------------------ |
| Homepage      | https://caddyserver.com/                   |
| Documentation | https://caddyserver.com/docs/              |

Serves the bare custom domain (`https://example.com`) — the one name that cannot
be a `<hostname>.example.com` subdomain.

It sets `hostname: www` and `apexDomain: true`, so it answers on both `www` and
the apex. `hostname` names a subdomain, while `apexDomain` adds the bare domain
alongside it.

It is reached through the Traefik [public gateway](../traefik/traefik.md), which
terminates TLS with the shared `*.example.com` wildcard certificate, so Caddy
itself only speaks plain HTTP on a ClusterIP Service. Nothing is exposed directly
by Caddy; the only ingress is the apex route.

## What it serves

| Path                            | Response                                                              |
| ------------------------------- | --------------------------------------------------------------------- |
| `/.well-known/webfinger`        | WebFinger document naming the OIDC issuer (see below)                 |
| `/robots.txt`                   | `Disallow: /` — the apex is not a site yet, keep it out of search      |
| everything else                 | `302` to `caddy:rootRedirect`, or `404` when that is unset            |

### WebFinger

OIDC providers such as [Tailscale](https://tailscale.com/kb/1240/sso-custom-oidc)
prove domain ownership by querying the domain, not the provider's hostname:

```sh
curl "https://example.com/.well-known/webfinger?resource=acct:admin@example.com"
```

```json
{
  "subject": "acct:admin@example.com",
  "links": [
    {
      "rel": "http://openid.net/specs/connect/1.0/issuer",
      "href": "https://pocket.example.com"
    }
  ]
}
```

The `href` must match the `issuer` in the OIDC provider's
`/.well-known/openid-configuration` **exactly**. It is derived from Pocket ID's
configured URL rather than configured here, so the two cannot drift. Changing
`pocket:hostname` changes both together.

The response is static: the issuer is fixed, so there is nothing to compute from
the `resource` query parameter and no need to echo it.

## Installation

The apex only works if it is publicly reachable, so it needs the Traefik public
gateway and one of the [public access methods](../../../docs/public-services.md).

```sh
# Required settings
pulumi config set caddy:enabled true
pulumi config set caddy:network/public true

# Required - the acct: URI that OIDC providers query to prove domain control.
# It names your own domain and account, so it has no sensible default.
pulumi config set caddy:webfingerSubject acct:admin@example.com

# (Optional) Where the apex redirects. Unset means no redirect - the apex serves
# only WebFinger and robots.txt, and everything else gets a 404.
pulumi config set caddy:rootRedirect https://example.com

pulumi up
```

Both names need A records pointing at your WAN IP. Disable any proxying or CDN
option your DNS provider offers, so the name resolves to that IP and traffic
reaches Traefik directly — a proxy would terminate TLS itself and break both
WebFinger and certificate validation.

| Record | Value  |
| ------ | ------ |
| `A`    | WAN IP |
| `www`  | WAN IP |

Proxying providers often synthesize `AAAA` answers for names that have no IPv6
record. Those are invented, not records in your zone, so they disappear when you
switch to DNS-only — nothing to delete.

### Verify

```sh
dig +short example.com A @<authoritative-nameserver>       # WAN IP
dig +short example.com AAAA @<authoritative-nameserver>    # empty
curl "https://example.com/.well-known/webfinger?resource=acct:admin@example.com"
curl -sI https://www.example.com/                          # same response as the apex
```

Two caching layers can hide a successful switch, and neither is fixed by waiting
on the authoritative server:

- **Local resolver.** `dig` bypasses it; `curl` does not. Flush with
  `resolvectl flush-caches` before concluding DNS "didn't work".
- **Technitium.** Caches for its full TTL, which can outlast the change
  considerably. Flush the zone there too.

Always check `remote_ip` on a plain `curl`. A `200` can come from an internal or
cached address and proves nothing about the public path.

## Uninstall

```sh
pulumi config set caddy:enabled false
pulumi up
```

The apex then answers with a Traefik 404 until the domain is pointed elsewhere.
