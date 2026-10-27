---
name: pocket-access
description: Use when the user asks about Pocket ID access, groups, sign-in, or the App Dashboard in OrangeLab — e.g. "check my pocket config", "audit pocket", "why can't <user> sign in to <app>", "give <user> access to <app>", "add someone to <app>-users", "is the Pocket ID client set up correctly", or after installing/updating an app. Not for installing an app (use install-app).
---

# Pocket ID Access

Pocket ID is the OIDC provider every app signs in through. This skill covers
auditing the live instance against the repository, diagnosing sign-in problems,
and changing who may reach an app.

Read [spec/pocket.md](/spec/pocket.md) for the operating notes (group model,
scripts, gotchas) and
[components/security/pocket/pocket.md](/components/security/pocket/pocket.md)
for the component itself.

## Security & operational rules

- Never read or print `pocket:apiKey`; the scripts read it themselves. Do not run
  `pulumi config get pocket:apiKey`.
- **Read-only first.** Audit before changing anything.
- **Never delete a group** unless the user explicitly names it with `--delete`.
- Confirm before applying a change — running a wrapper or a group script writes
  to the live instance.

## The model in one screen

| Group | Grants |
|---|---|
| `admin` | Every app; carries `rustfs_policies=consoleAdmin` and `headplane_role=admin` |
| `<app>-users` | Access to one app |
| `<app>-admin` | Access and the app's admin role |
| `vpn-users` | The Headscale/Tailscale mesh |

`admin` opens everything but does **not** imply an app's own admin role — that
comes from `<app>-admin` (or `<app>:auth/adminGroup` / `<app>:auth/groupMap`).

A client's **allowed groups control sign-in and the launcher tile at once**: they
are the same field. You cannot let a group sign in while hiding the tile — hiding
the tile means removing the client's launch URL.

## Workflow

### 1. Audit

```sh
./scripts/pocket-verify.sh                 # whole instance
./scripts/pocket-verify.sh --app immich    # one app's client and its <app>-* groups
./scripts/pocket-verify.sh --json | jq     # machine-readable
```

Read-only. Exits `0` clean, `1` drift, `2` usage or config error.

It compares the live instance with `create-groups.sh --print-spec` (groups,
friendly names, claims, `--all-users` membership, signup defaults) and with the
per-app wrappers plus each stack's `<app>:auth/allowedGroups` (client exists,
`isGroupRestricted` set, allowed groups match, tile present only when the wrapper
passes `--launch-url`).

Groups and clients nothing in the repository declares are reported as **notes**,
not drift — they were added by hand and are never touched.

### 2. Diagnose "user X cannot sign in to Y"

Work down this list; the first is by far the most common.

1. **Is the user in an allowed group?** A restricted client refuses everyone
   outside its allowed groups. Membership is managed by hand in Pocket ID — the
   scripts only set it for the `--all-users` groups.
2. **Is the client restricted at all?** With `isGroupRestricted=false` the
   allowed-group list is ignored and any Pocket ID user can sign in.
3. **Does the app expect a role or claim?** RustFS needs a `rustfs_policies`
   claim and Headplane a `headplane_role` claim; Technitium and Frigate use
   `auth/groupMap`, while Grafana, Forgejo and Home Assistant use an admin group.
4. **Does the app keep its own user list?** Some create the account on first
   sign-in; others need the user to exist locally as well.
5. **Is it a passkey problem rather than a group problem?** Passkeys are bound to
   the origin, so a hostname change forces every user to register again.
6. **Check the app's `<app>.md`** for app-specific requirements.

### 3. Change access

**Membership** — add or remove the user in Pocket ID, either on the user (their
groups) or on the group (its members). The scripts do not manage per-user
membership except for the `--all-users` groups.

**Restrictions** — `<app>:auth/allowedGroups` is declared in the owning
`Pulumi.yaml` (repository root for core components, `stacks/<module>/Pulumi.yaml`
for applications). Change it there, or override it for one stack:

```sh
pulumi config set <app>:auth/allowedGroups admin,<app>-users --cwd <stack-dir>
```

Then re-run the app's wrapper so the client picks it up — `allowedGroups` is read
only by the wrapper, so this needs no `pulumi up`:

```sh
# core component - from the repository root
./components/<module>/<app>/pocket-<app>.sh

# application stack component - from the stack directory
cd stacks/<module>
./components/<app>/pocket-<app>.sh
```

**New groups** — groups are declared in
`components/security/pocket/create-groups.sh` (run from the repository root).
Edit that script so the change is reproducible, then apply it:

```sh
./components/security/pocket/create-groups.sh app-users
```

## Gotchas

- A group created or deleted by hand in Pocket ID is invisible to the repository:
  the audit reports it as a note, and re-running the scripts never removes it.
- A `launchURL` must be a valid URL **or absent** — an empty string is rejected
  with `LaunchURL must be a valid URL`. Omitting it is how a sign-in-only client
  is built; it still works, it just shows no tile.
- The scripts fail fast on a non-2xx response instead of retrying, so the reported
  HTTP status and body point at the real cause.

## Verify

- The audit exits `0`, or every drift it reports is explained and intended
- The user was added to the narrowest group that works, not to `admin`
- `<app>:auth/allowedGroups` matches the client's allowed groups
- No group was deleted or renamed without the user asking for it
