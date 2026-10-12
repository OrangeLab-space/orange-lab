# Headplane (web UI for Headscale)

|               |                            |
| ------------- | -------------------------- |
| Homepage      | https://github.com/tale/headplane |
| Documentation | https://headplane.tale.dev  |
| Source        | https://github.com/tale/headplane |

Web UI for the [Headscale](headscale.md) control plane. Headplane is a separate
server that talks to Headscale over its gRPC admin API — it is not a Headscale
feature, and it knows nothing about the mesh.

Headscale's own CLI remains the way to administer a node: it runs in the cluster,
is not exposed to the internet, and works whether or not this component is
deployed. Headplane is a convenience for the things the CLI makes tedious —
listing nodes, generating pre-auth keys, revoking sessions.

## Enabling

Headplane needs an API key before it can be deployed. Generate one, which prints
the exact `pulumi config set` command to run:

```sh
./components/network/headplane/headscale-apikey.sh

pulumi config set --stack <stack> headplane:enabled true
pulumi config set --stack <stack> headplane:auth pocket

pulumi up --stack <stack>
```

The script mints a key via `headscale apikeys create` and prints it. It does not
store anything itself, so the credential passes through your terminal rather than
a tool. The key is a Pulumi secret.

Sign-in reuses **Headscale's** OIDC client rather than creating a second one, so
the `sub` claim matches for both and Headplane can link a signed-in user to their
Headscale identity without falling back to email matching. Apply Headplane's
callback URL to that client, then point Headplane at the same credentials:

```sh
./components/network/headscale/pocket-headscale.sh   # adds headplane's callback

pulumi config set --stack <stack> headplane:auth/clientId \
    "$(pulumi config get --stack <stack> headscale:auth/clientId)"
pulumi config set --stack <stack> headplane:auth/clientSecret \
    "$(pulumi config get --stack <stack> headscale:auth/clientSecret --show-secrets)" --secret
```

Requires `headscale:enabled` and the routing provider — Headplane serves no
traffic of its own without Traefik.

## Where it is served

`https://headplane.<customDomain>/admin`

`/admin` is the only path prefix Headplane supports and is not configurable — it
builds its own URLs, including the OIDC redirect URI, from `server.base_url` plus
that prefix.

The hostname is its own, and that is deliberate. Names that carry an explicit
WAN-IP record (the apex, and the control plane's own) are reached through the
public gateway even from inside the mesh, so anything served under one of them is
effectively public. A name of its own resolves through the domain wildcard to a
mesh address instead, which makes this private by construction rather than by
route placement.

## Signing in

Two credentials are involved, and neither replaces the other:

| Credential    | What it does                                                  |
| ------------- | ------------------------------------------------------------- |
| `headplane:auth` | Decides **who may sign in** to this UI                       |
| `headplane:apiKey` | Lets Headplane **act on Headscale** on a user's behalf    |

Without `headplane:auth` the UI is reachable by anyone on the mesh who has a
Headscale API key to paste into the login form.

With it, sign-in goes through Pocket ID and Headplane matches each user to their
Headscale identity. It **shares Headscale's OIDC client**, so the `sub` claim
matches for both and linking is reliable on first login. Without a match,
Headplane falls back to matching on email, and if that fails you get the UI
without ownership features (seeing your own nodes, self-service pre-auth keys).

### Roles come from a Pocket ID custom claim

Headplane has its own roles — `owner`, `admin`, `network_admin`, `it_admin`,
`auditor`, `viewer`, `member` — and they are **not** mapped from Pocket ID group
names. Set a `headplane_role` custom claim on each group instead:

Administration → User Groups → group → **Custom Claims**:

```json
{ "headplane_role": "admin" }
```

```json
{ "headplane_role": "it_admin" }
```

Users in an allowed group with no claim get `default_role`, which this component
sets to `viewer` rather than Headplane's own default of `member` (no access at
all).

Two things to know about Pocket ID claims:

- They are released with the **`profile` scope**, which is why the generated
  config requests `openid profile email groups`. Without `profile` the claim
  never arrives and everyone falls back to `default_role`.
- **A user's own claim wins over a group's, and if several of the user's groups
  set the same claim the winner is undefined.** Give each group its own value,
  and do not rely on a group you did not set the claim on.

The first user to sign in becomes **Owner**. That is Headplane's own bootstrap,
not something this component controls — after the first sign-in, grant everyone
else their role from the Users page.

## Configuration

| Key                   | Description                                                              |
| --------------------- | ------------------------------------------------------------------------ |
| `headplane:image`     | Headplane version, default `ghcr.io/tale/headplane:0.7.1`               |
| `headplane:hostname`  | Subdomain for this UI, default `headplane`. Resolves via the wildcard to a mesh address — do not point it at a WAN-IP record |
| `headplane:storageSize` | Volume for Headplane's own SQLite (users, sessions, linked identities) |
| `headplane:auth`      | Sign in with Pocket ID. Unset = API-key login only                       |
| `headplane:apiKey`    | Headscale API key. Required — set by `headscale-apikey.sh`              |
| `headplane:cookieSecret` | Optional override; generated and stored when unset                    |

There is deliberately no `headplane:network/public`. This UI can re-issue node
credentials and read the tailnet's keys, so it belongs behind the mesh exactly
like the gRPC endpoint Headscale keeps off the internet.

## Limitations

- **Network management and remote Web SSH are unavailable.** Both need read/write
  access to Headscale's own `config.yaml` and the Docker socket, which assume
  both run on one Docker host. This component sets all four `integration.*`
  flags to `false` rather than pointing them at something unreachable. DNS and
  settings editing in the UI are therefore disabled.
- **Roles do not follow Pocket ID groups**, only the custom claim described
  above. A group without the claim gets `viewer`.
- **The API key is long-lived.** `headscale-apikey.sh` defaults to 90 days.
  When it expires Headplane loses its ability to act on Headscale and sign-in
  stops working; run the script again to replace it. `apikeys list` and
  `apikeys expire --id <n>` manage them.
- **No API key rotation path from Pulumi.** The key is an input, not something
  the component creates, so replacing it is a config change plus a redeploy.
