# Caddy (apex)

|               |                               |
| ------------- | ----------------------------- |
| Homepage      | https://caddyserver.com/      |
| Documentation | https://caddyserver.com/docs/ |

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

| Path                      | Response                                                          |
| ------------------------- | ----------------------------------------------------------------- |
| `/.well-known/webfinger`  | WebFinger document naming the OIDC issuer (see below)             |
| `/.well-known/nostr.json` | NIP-05 map (see below), when `caddy:nip05/pubkeys` is set         |
| `/robots.txt`             | `Disallow: /` — the apex is not a site yet, keep it out of search |
| everything else           | `302` to `caddy:rootRedirect`, or `404` when that is unset        |

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

### NIP-05

[NIP-05](https://github.com/nostr-protocol/nips/blob/master/05.md) maps a
human-readable `name@example.com` handle to a Nostr public key. Clients fetch:

```sh
curl "https://example.com/.well-known/nostr.json?name=alice"
```

```json
{
    "names": { "alice": "…64 hex characters…" },
    "relays": { "…64 hex characters…": ["wss://relay.example.com"] }
}
```

The document is static: `?name=` is ignored and the whole map is returned, which
NIP-05 permits. `names` values must be lowercase hex, so `npub1…` is accepted in
config and converted to hex at deploy time.

`_` is a reserved name meaning the domain itself: `_@example.com` is displayed
as just `example.com`, and clients resolving a bare domain request
`?name=_`. Every other key is a normal handle prefix. None of them are
mailboxes — NIP-05 only points at public keys.

NIP-05 attests control of the domain, not ownership of the key: events are still
verified against the key's signature, and losing the domain lets someone else
publish the handle.

`relays` is optional. A name's own list in `caddy:nip05/relays` replaces
`caddy:nip05/defaultRelays`; an empty list gives that name no hints.

```sh
# name -> npub1… or 64-character hex
pulumi config set --path 'caddy:nip05/pubkeys.alice' npub1...

# Optional: used for every name that has no entry of its own
pulumi config set --path 'caddy:nip05/defaultRelays[0]' wss://relay.example.com

# Optional: this name's relays (replaces the defaults); [] opts out
pulumi config set --path 'caddy:nip05/relays.alice[0]' wss://relay.example.com
```

The same values as YAML in `Pulumi.<stack>.yaml`:

```yaml
config:
    caddy:nip05/pubkeys:
        alice: npub1...
        bob: npub1...
    caddy:nip05/relays:
        bob:
            - wss://relay.example.com
    caddy:nip05/defaultRelays:
        - wss://relay.damus.io
```

`www.example.com` serves the same document, but identifiers should use the apex
domain, since clients fetch whatever domain the identifier names. The document
sets `Access-Control-Allow-Origin: *` so browser-based clients can read it.

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
# only the .well-known documents and robots.txt, and everything else gets a 404.
pulumi config set caddy:rootRedirect https://example.com

# (Optional) NIP-05 names, as npub1… or 64-character hex.
pulumi config set --path 'caddy:nip05/pubkeys.alice' npub1...

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
curl -s https://example.com/.well-known/nostr.json | jq .   # when NIP-05 is set
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
