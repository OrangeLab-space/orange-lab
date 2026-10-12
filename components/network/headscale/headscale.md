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
pulumi config set headscale:baseDomain vpn.example.com
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
| `headscale:baseDomain`         | Domain Headscale hands out host names under. Required             |
| `headscale:storageSize`        | Volume for the SQLite database and noise key                      |
| `headscale:image`              | Headscale version                                                 |
| `headscale:network/public`     | Must be `true` — clients off-LAN need to reach the control plane  |
| `headscale:requiredNodeLabel`  | Node selector for the control plane, e.g. `kubernetes.io/hostname=<node>` |
| `headscale:auth/*`             | Optional Pocket ID client — see [Signing in](#signing-in)          |
| `headscale:auth/allowedGroups` | Restricts who may sign in. Unset = unrestricted                   |

`baseDomain` is required — Headscale refuses to start without it — and it hands
out the **host** names clients resolve (`<node>.vpn.example.com`). Apps are not
served under it; they live at `<app>.<customDomain>`.

It must not contain Headscale's own URL — `server_url cannot be part of
base_domain` — or Headscale refuses to start. So `vpn.example.com` works where a
bare `example.com` would not. Verify with `headscale configtest` before deploying.

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

Headscale can relay node traffic when a direct path fails, but **this component
leaves it disabled** — it needs an extra forwarded port pair (`443/tcp` and
`3478/udp`) that does not exist here, so clients fall back to the public DERP
map, which is Tailscale's.

Only the _relay_ touches it: encrypted WireGuard packets between two of your own
nodes. Authentication, node keys and policy never leave the cluster — but node
addresses and topology are visible as DERP connection metadata. Turning it on
removes the third-party dependency at the cost of a single point of failure with
no redundancy; worth doing while Tailscale's relays are still loaded as a
fallback. Verify with `tailscale debug derp headscale`.

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
