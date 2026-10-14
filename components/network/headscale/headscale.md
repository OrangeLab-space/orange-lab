# Headscale (self-hosted control plane)

|                  |                                                                 |
| ---------------- | --------------------------------------------------------------- |
| Homepage         | https://headscale.net/                                         |
| Documentation    | https://headscale.net/stable/                                  |
| Source           | https://github.com/juanfont/headscale                          |
| Migration guide  | [Migrating nodes to Headscale](../../../docs/headscale-migration.md) |
| Web UI           | [Headplane](../headplane/headplane.md) — mesh-only admin UI |

Self-hosted Tailscale control plane. Nodes and clients get their addresses, keys
and policy from your own infrastructure, with no third-party coordination server
in the path. Users sign in with [Pocket ID](../../security/pocket/pocket.md) or
with Headscale's own local users.

**Already running Tailscale?** Moving a node is a destructive per-node cutover,
not a toggle. Read the [migration guide](../../../docs/headscale-migration.md)
first.

## Quick start

```sh
# Pocket ID must be deployed and public first: clients complete the OIDC redirect
# through the browser, so an unreachable issuer breaks sign-in.
pulumi config set pocket:enabled true
pulumi config set pocket:hostname login
pulumi config set pocket:network/public true
pulumi config set pocket:encryptionKey "$(openssl rand -base64 32)" --secret
pulumi up

# Headscale must be public too - clients off-LAN have to reach it.
pulumi config set headscale:enabled true
pulumi config set headscale:network/public true
# headscale:baseDomain defaults to vpn.internal - override only to move it
pulumi up

# Then create the Pocket ID client and sign in with it.
./components/network/headscale/pocket-headscale.sh
pulumi config set headscale:auth pocket
pulumi config set headscale:auth/clientId <client-id>
pulumi config set headscale:auth/clientSecret <client-secret> --secret
pulumi up
```

DNS needs an explicit `headscale.<customDomain>` A record pointing at the public
IP, DNS-only — the wildcard points at a mesh address and does not cover the
public path. No extra port forward is needed.

## Configuration

| Key                            | Description                                                       |
| ------------------------------ | ----------------------------------------------------------------- |
| `headscale:hostname`           | Subdomain for the control plane, default `headscale`              |
| `headscale:baseDomain`         | MagicDNS suffix for node names. Default `vpn.internal`         |
| `headscale:storageSize`        | Volume for the SQLite database and noise key                      |
| `headscale:image`              | Headscale version                                                 |
| `headscale:network/public`     | Must be `true` — clients off-LAN need to reach the control plane  |
| `headscale:requiredNodeLabel`  | Node selector for the control plane, e.g. `kubernetes.io/hostname=<node>` |
| `headscale:auth/*`             | Optional Pocket ID client — see [Signing in](#signing-in)          |
| `headscale:auth/allowedGroups` | Restricts who may sign in. Unset = unrestricted                   |
| `headscale:derp/enabled`       | Runs the built-in DERP relay. Default `false`                    |
| `headscale:derp/stunPort`      | STUN port. Default `3478`, must match your forward               |
| `headscale:derp/regionId`      | Relay region ID. Default `900` — **must not be `0`**             |
| `headscale:derp/regionCode`    | Region name shown in `tailscale status`. Default `headscale`     |
| `headscale:derp/externalIp`    | Relay's public IPv4. Required when `derp/enabled`                |
| `headscale:derp/fallback`      | Also load Tailscale's public DERP map. Default `true`            |
| `headscale:overrideLocalDns`   | Push `nameservers` onto every client. Default `false`            |
| `headscale:nameservers`        | Comma-separated resolvers, preferred first. Unset = none         |

`baseDomain` is the **host** name suffix clients resolve (`<node>.vpn.internal`).
Headscale refuses to start without it, so a default is supplied in `Pulumi.yaml`.
Apps are not served under it; they live at `<app>.<customDomain>`.

It must not contain Headscale's own URL — `server_url cannot be part of
base_domain` — or Headscale refuses to start. It must also stay **outside**
`customDomain`: nesting the mesh namespace inside the app domain lets a single
wildcard answer for node names and hijack pod DNS. Verify with
`headscale configtest` before deploying.

To force clients onto your own resolver (e.g. Technitium for ad-blocking), set
`headscale:overrideLocalDns: true` and list it first in `headscale:nameservers`
with a public fallback second. Find your Technitium address with
`kubectl get svc -n technitium technitium-lb -o jsonpath='{.status.loadBalancer.ingress[0].ip}'`.
The list only applies while the tailnet is up — a client with tailscaled down
cannot use either entry, so keep the fallback public.

The control plane should run on a node that stays put — it holds the SQLite
database and the noise key — so pin it with `headscale:requiredNodeLabel` before
there is anything on it to migrate.

## Signing in

### Local users

No identity provider, nothing extra to deploy:

```sh
./components/network/headscale/exec-headscale.sh users create <username>
./components/network/headscale/exec-headscale.sh preauthkeys create --user <username> --reusable
tailscale up --login-server https://headscale.example.com --authkey <key>
```

Web authentication works too — `tailscale up` prints an auth ID an administrator
approves with `auth register`. These users exist nowhere else in this project;
losing them loses the tailnet's user list.

### Pocket ID (OIDC, recommended)

Users are created by the provider on first sign-in, so nothing is created by
hand. Run `pocket-headscale.sh` to create the client, then set `headscale:auth`.

Access is **unrestricted by default** — any Pocket ID account can join the
tailnet, because Headscale does no user or group provisioning. To narrow it, set
the groups *before* running the script:

```sh
pulumi config set headscale:auth/allowedGroups admin,power-user
```

There is deliberately no default in `Pulumi.yaml`. `pulumi config get` falls back
to it, so a default there is not inert — it restricts. This applies to the OIDC
client only; local users are not group-filtered.

## Administration

The gRPC admin API is not exposed outside the cluster, so admin tasks run through
the pod:

```sh
./components/network/headscale/exec-headscale.sh nodes list
./components/network/headscale/exec-headscale.sh users list
./components/network/headscale/exec-headscale.sh nodes expire --all
```

[Headplane](../headplane/headplane.md) is a web UI for the same API. It is
mesh-only, on its own hostname.

## Naming

| Name                         | Resolves to | Reachable from |
| ---------------------------- | ----------- | -------------- |
| `headscale.example.com`      | WAN address | internet       |
| `pocket.example.com`         | WAN address | internet       |
| `<node>.vpn.example.com`     | VPN address | mesh members   |
| `home-assistant.example.com` | VPN address | mesh members   |

Apps are served **only** at `<app>.<customDomain>`. `baseDomain` is a namespace
for host names inside the mesh — nothing is served at the bare `vpn.example.com`,
and no app gets a second name under it.

The private/public split is carried by **which address DNS points at**, not by
the name: names with an explicit WAN-IP record are internet-reachable, everything
else resolves through the wildcard to a mesh address. Those mesh names are plain
DNS records sitting in the VPN range, not MagicDNS entries, so they resolve the
same way from anywhere the address is reachable.

## DERP relay

Headscale can relay node traffic when a direct path fails. It is **off by
default**; clients fall back to the public DERP map, which is Tailscale's.

The relay needs **no port of its own**. It is mounted at `/derp` on the same
listener as the control plane and advertises this instance's own hostname, so
clients reach it through the routing provider like any other app. Only STUN is
separate, and only because it is raw UDP that no reverse proxy carries.

So enabling it needs one thing done outside Pulumi — forward the STUN port to
the node:

```
WAN 3478/udp → <node>:3478     # must match headscale:derp/stunPort
```

```sh
pulumi config set headscale:derp/enabled true
```

Headscale refuses to start without `stun_listen_addr` when the relay is on, so
the component always emits it alongside `enabled: true` — an enabled relay with
no forward fails at startup rather than silently serving nothing.

Two settings are what make a relay actually get *used*, and both fail silently
when wrong:

- **`derp/regionId` must not be `0`.** Headscale leaves it unset by default, and
  clients read `0` as "no region" — they will measure the relay, see it is fast,
  and then never select it. `tailscale netcheck` reports
  `Nearest DERP: [none]` while still listing a latency for it. Use `900`–`999`,
  which Tailscale reserves for self-hosted regions.
- **`derp/externalIp` is required.** Given only a hostname, clients cannot
  confirm the region over UDP and decline it.

The STUN port is served by the cluster's own load balancer, which only opens
`hostPort` on nodes labelled `svccontroller.k3s.cattle.io/enablelb=true`. So the
forward above must point at a node carrying that label, and if Headscale is pinned
with `headscale:requiredNodeLabel`, that node needs the label too — otherwise STUN
answers nowhere and the relay degrades to the silent failure above.

Only the _relay_ touches it: encrypted WireGuard packets between two of your own
nodes. Authentication, node keys and policy never leave the cluster — but node
addresses and topology are visible as DERP connection metadata. Turning it on
removes the third-party dependency at the cost of a single point of failure with
no redundancy; the public map stays loaded as a fallback for that reason.

### Verifying

```sh
tailscale netcheck      # "Nearest DERP" must name your region, not [none]
tailscale status        # relays through your regionCode when direct paths fail
```

If STUN itself is in doubt, note that Headscale's embedded STUN server only answers
requests carrying Tailscale's `SOFTWARE` and `FINGERPRINT` attributes. A generic
STUN probe is silently dropped, so a timeout from one proves nothing — use
`tailscale netcheck` instead.

## Backup and restore

Two things on the app volume are irreplaceable: **`noise_private.key`**, whose
loss forces every node to re-authenticate, and **`db.sqlite`**, whose loss loses
all users, nodes and preauth keys. Back it up like any other application volume —
see [Longhorn](../../storage/longhorn/longhorn.md).

## Limitations

- **No IP pre-assignment.** Addresses are assigned sequentially, so a node that
  rejoins gets a new one and DNS records need updating. Post-move DNS updates are
  the intended path, not a workaround.
- **Embedded DERP is disabled** — see [DERP relay](#derp-relay).
- **No automatic OIDC user provisioning.** Profile claims are synced on each
  login; there is no separate provisioning step.
- **Switching identity providers later is manual.** Users are keyed on `iss` +
  `sub`, so changing provider locks existing users out until their
  `provider_identifier` is updated in the database.
- **No equivalent of `tailscale serve`.** With `routingProvider: traefik` nothing
  depends on it, but a cluster on the Tailscale routing provider would lose it.
