# Pocket ID — operating notes

Agent-facing reference for the `pocket` component and the Pocket ID scripts. For
user-facing setup, backup, and the per-application list, see
[`components/security/pocket/pocket.md`](../components/security/pocket/pocket.md).
Everything here is installation-independent — read hostnames and IPs from
`pulumi config` and the cluster, never from this file.

## What Pocket ID is

An OpenID Connect provider with passkey sign-in, deployed as the core stack's
`security` app and used by every OIDC-capable app in the cluster. Four concepts
matter:

- **Users** — created on first sign-in or in the admin UI; authenticate with a passkey.
- **Groups** — Pocket ID ships none. Every group named in this repo is a
  convention the scripts create and manage.
- **OIDC clients** — one per application: callback URLs, a launch URL, a secret,
  and optionally allowed groups and icons.
- **Application Configuration** — instance-wide settings, including the signup
  **default groups** applied to new users.

Pocket ID is optional; applications run without it, with OIDC disabled.

## The rule that trips people up

**A client's allowed groups control both sign-in and the launcher tile; there is
no separate visibility switch.**

- Unset allowed groups → every user can sign in and sees the **My Apps** tile.
- Set allowed groups → sign-in is limited to those groups, and everyone else
  stops seeing the tile.
- The tile exists only when the client has a **launch URL**. A client with
  callbacks but no launch URL still completes OIDC sign-in but shows no tile (the
  Tailscale and Headscale clients are built this way).

So "let group A sign in but hide the tile from them" is not expressible on a
single client — those are the same field. Hiding a tile means dropping the launch
URL.

## Groups

`admin` opens every app; a `<app>-admin` group delegates one app, and its admin
role where the app maps groups to roles.

| Group | Purpose |
| --- | --- |
| `admin` | Access to every app; carries the `rustfs_policies=consoleAdmin` and `headplane_role=admin` claims |
| `<app>-users` | Access to one app |
| `<app>-admin` | Access to one app, plus its admin role where the app maps groups to roles |
| `vpn-users` | Access to the VPN mesh (Headscale, and the Tailscale tailnet); a new-user default group |

Friendly names are `Category - Module|Stack/App` (`Admins - Media/Jellyfin`) so
they sort in the UI.

- **Default groups** (new users join automatically): `vpn-users`,
  `nextcloud-users`, `vaultwarden-users`.
- **Custom claims** (`rustfs_policies`, `headplane_role`) attach a value to a
  group; the app reads the claim instead of a role mapping. Apps must request the
  `profile` scope. When several of a user's groups set the same key the winner is
  undefined — give each group its own key.
- **Stack cohorts are retired** (`ai-users`, `media-users`, `iot-users`,
  `bitcoin-users`, `dev-users`); access is granted per app.

## Scripts

All are idempotent and never delete unless a delete is named.

| Script | Where | Role |
| --- | --- | --- |
| `create-groups.sh` | `components/security/pocket/` | The instance's group list. Sections: `base`, `app-admins`, `app-users`, `all`. Run from the repo root. |
| `pocket-groups.sh` | `scripts/` | Generic groups: create, friendly name, claims, `--all-users`, `--members-from`, `--default-group`, `--delete`. |
| `pocket-client.sh` | `scripts/` | Generic OIDC client: create/reuse, callbacks, launch URL, icons, `--restrict-access`. |
| `pocket-restrict.sh` | `scripts/` | Restrict an existing client by name **without** the app being deployed. |
| `pocket-verify.sh` | `scripts/` | Read-only audit: diffs the live instance against what the repo declares. |
| `pocket-<app>.sh` | beside each component | Per-app wrapper; sets app specifics and calls `pocket-client.sh`. Run from the app's stack directory. |

```sh
# groups — options apply to the preceding --group
./scripts/pocket-groups.sh \
  --group immich-users --friendly-name "Users - Media/Immich" \
  --group rustfs-users --claim rustfs_policies=readwrite

# delete, only when asked
./scripts/pocket-groups.sh --delete media-users

# migrate membership between groups (union, non-destructive)
./scripts/pocket-groups.sh --group immich-users --members-from media-users

# restrict a client whose app is not deployed (the wrapper needs an endpoint)
./scripts/pocket-restrict.sh --client-name "Frigate" --groups admin,frigate-admin
```

`pocket-client.sh` options: `--app-name`, `--client-name`, `--launch-url` (omit
for no tile), `--callback-urls`, `--logout-callback-urls`,
`--dark-icon-url`/`--light-icon-url`, `--pkce-enabled`, `--public-client`,
`--restrict-access <groups>`.

### Checking drift

`pocket-verify.sh` is a read-only audit: it diffs the live instance against
everything the repository declares and exits non-zero on drift, so an agent can
answer "is this user's Pocket ID set up correctly?" without hand-rolled curl
calls.

```sh
./scripts/pocket-verify.sh                 # whole instance
./scripts/pocket-verify.sh --app immich    # one app's client and its <app>-* groups
./scripts/pocket-verify.sh --json | jq     # machine-readable
```

It checks:

- **Groups** against `create-groups.sh --print-spec`, which emits the expected
  spec as JSON without contacting Pocket ID — so the group list still lives in
  exactly one place. Checks existence, friendly name, custom claims, `--all-users`
  membership, and the signup default groups.
- **Clients** against the per-app wrappers plus each stack's
  `<app>:auth/allowedGroups`: the client exists, `isGroupRestricted` is set, the
  allowed groups match, and a launch URL is present only when the wrapper passes
  `--launch-url`.

Groups and clients that nothing in the repository declares are reported as
**notes**, not drift — they are assumed to be added by hand, and nothing ever
deletes or rewrites them.

Exit codes: `0` no drift, `1` drift detected, `2` usage or config error.

## When sign-in to a single app breaks

A single app's broken sign-in is usually that app, not Pocket ID.

1. Run `./scripts/pocket-verify.sh --app <app>`. If it is clean, the client, its
   groups and its restrictions match the repository — Pocket ID is doing its
   part, so keep going.
2. Read the app's own log for the failing URL. A 5xx from the app's SSO *start*
   URL happens before Pocket ID is contacted at all.
3. Only then suspect Pocket ID itself.

**Known case — Jellyfin.** `/sso/OID/start/pocketid` answered
`Error processing request` (HTTP 500) on every attempt: two versions of the
`SSO-Auth` plugin sat side by side in `/data/plugins/` (one folder per version,
same manifest GUID), and the Jellyfin major upgrade made the newer build's ABI
acceptable, so *both* registered the same route
(`AmbiguousMatchException: The request matched multiple endpoints`). Jellyfin
loads every plugin folder and never deduplicates by GUID. `pocket-verify.sh` was
clean throughout — an app-side failure is not Pocket drift. Removing the stale
folder and restarting the deployment fixed it; see
[Jellyfin](../stacks/media/components/jellyfin/jellyfin.md).

## Adding OIDC to an application — playbook

1. **Ask the access model.** One of: `admin` only (admin/infra tool);
   `admin,<app>-users` (user-facing); `admin,<app>-admin` (admin-only,
   delegable); or unrestricted.
2. **Create the group(s).** Add them to `create-groups.sh` (`app-users` /
   `app-admins`) and run it. A wrapper fails if a group it names does not exist.
3. **Provide a wrapper.** Add or copy a `pocket-<app>.sh` beside the component:
   client name, launch URL, callback(s), icons, and
   `--restrict-access "$(<app>:auth/allowedGroups)"`.
4. **Run the wrapper** from the app's stack directory; it prints the
   `pulumi config set <app>:auth ...` commands.
5. **Apply the config** — `<app>:auth pocket`, `clientId`, `clientSecret --secret`,
   `auth/allowedGroups`, and for role-capable apps `auth/groupMap` /
   `auth/adminGroup`.
6. **`pulumi up`**, then verify the result and the tile with
   `./scripts/pocket-verify.sh --app <app>`.

This is the flow the `install-app` skill drives. For apps with no OIDC of their
own the client is only a launcher tile, and the shared Traefik middleware can
instead protect the route or forward the identity — see the component docs.

## Config keys

| Key | Meaning | Read by |
| --- | --- | --- |
| `<app>:auth` | `pocket` enables OIDC | TypeScript |
| `<app>:auth/clientId`, `clientSecret` | from the wrapper output; the secret is `--secret` | TypeScript |
| `<app>:auth/adminGroup` | group granting the admin role; defaults to `<app>-admin` | TypeScript |
| `<app>:auth/groupMap` | Pocket ID group → app role | TypeScript |
| `<app>:auth/allowedGroups` | comma-separated groups; unset = unrestricted | wrapper only |
| `pocket:apiKey` | core-stack API key the scripts use | scripts |

Because `allowedGroups` is read only by the wrapper, changing it needs a wrapper
re-run, **not** `pulumi up`. Changing the others needs `pulumi up`.

## Invariants and gotchas

- **Restriction needs the *restricted* flag.** Pocket ID v2 enforces allowed user
  groups only when the client's `isGroupRestricted` is true; writing
  `/allowed-user-groups` alone has no effect. The client scripts set it for you.
- **`launchURL` must be a valid URL or absent.** The API rejects an empty string
  (`LaunchURL must be a valid URL`); to have no tile, omit it (the script sends
  `null`).
- **Application Configuration is a full replace.** Setting a default group reads
  the whole config, merges `signupDefaultUserGroupIDs`, and PUTs it back — check
  **Application Configuration** afterwards if anything else was customised.
- **Client secrets are shown once.** Reusing a client never rotates its secret.
- **Wrappers run from the app's stack directory.** `pocket-client.sh` requires
  `$PWD/Pulumi.yaml` and reads `pocket:apiKey` plus the API base URL from the
  **core** stack, so the app stack needs `orangelab:coreStackRef`.
- **Never print `pocket:apiKey`.** Agents must not run `pulumi config get
  pocket:apiKey`; the scripts read it themselves.
- **`--restrict-access ""` never unrestricts.** The wrapper only applies a
  restriction when the group list is non-empty; unrestricting means clearing the
  groups in the UI.
- **Passkeys are origin-bound.** After a hostname change, users must re-register:
  `kubectl -n pocket exec deploy/pocket -- /app/pocket-id one-time-access-token <username>`.
- **Deletion is always explicit.** No script removes a group unless `--delete`
  names it, so re-running is safe and never touches groups a user added by hand.
- **The scripts fail fast.** A non-2xx from Pocket ID is reported with its status
  and response body and the script stops — there is no retry. Retrying hid real
  causes (validation errors, a bad key, a missing endpoint) and could duplicate a
  write. Read the reported error, fix it, re-run.

## Migrating an older instance

Stack cohorts are replaced by per-app `<app>-users`:

1. `pocket-groups.sh --group <app>-users --members-from <cohort>` to keep access.
2. Re-point each client's `allowedGroups` and re-run its wrapper.
3. `pocket-groups.sh --delete <cohort>` to remove the cohort.
