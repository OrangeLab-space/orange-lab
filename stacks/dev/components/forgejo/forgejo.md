# Forgejo

|               |                                                                                |
| ------------- | ------------------------------------------------------------------------------ |
| Homepage      | https://forgejo.org/                                                           |
| Source code   | https://codeberg.org/forgejo/forgejo                                           |
| Documentation | https://forgejo.org/docs/latest/                                               |
|               | https://pocket-id.org/docs/client-examples/forgejo                             |
| Configuration | https://forgejo.org/docs/latest/admin/config-cheat-sheet/                      |
| Helm chart    | https://code.forgejo.org/forgejo-helm/forgejo-helm                             |
| Helm values   | https://code.forgejo.org/forgejo-helm/forgejo-helm/raw/branch/main/values.yaml |
| Endpoints     | `https://forgejo.<domain>/` · `ssh://git@forgejo.<domain>:2222`                |

Forgejo is a self-hosted lightweight software forge: Git hosting, pull requests, issues, a package registry and Actions. It is a community-run fork of Gitea, easy to run and low maintenance.

## Deployment

```sh
cd stacks/dev

# Enable Forgejo
pulumi config set forgejo:enabled true

# (Recommended) Public hostname (default: forgejo)
pulumi config set forgejo:hostname git
# (Recommended) Storage for repositories and SQLite (default: 10Gi)
pulumi config set forgejo:storageSize 50Gi

# Admin account, created on first start and kept in sync on every deploy.
# Forgejo does not allow 'admin' as username.
pulumi config set forgejo:adminUsername gitea_admin
# (Recommended) Admin email, also links your SSO sign-in to the admin account
pulumi config set forgejo:adminEmail forgejo@example.com
# (Required) Admin password, also used to match restored backups
ADMIN_PASSWORD=$(openssl rand -base64 32)
pulumi config set forgejo:adminPassword "$ADMIN_PASSWORD" --secret

# (Optional) Redis for cache, session and queue, recommended only for large instances
pulumi config set forgejo:redis/enabled true

# (Optional) Outbound email for notifications and password resets
pulumi config set forgejo:smtp/enabled true
pulumi config set forgejo:smtp/host smtp.example.com
pulumi config set forgejo:smtp/port 587
pulumi config set forgejo:smtp/secure starttls # none | starttls | smtps
pulumi config set forgejo:smtp/from noreply@example.com
pulumi config set forgejo:smtp/username your-smtp-username
pulumi config set forgejo:smtp/password your-smtp-password --secret

pulumi up
```

Uses SQLite on a persistent volume by default, with cache, session and queue stored locally. For large instances, enable Redis to offload them with `forgejo:redis/enabled`.

## Database

SQLite is the default. To use PostgreSQL instead, enable the CloudNativePG operator in the core stack and set the dependency in this stack:

```sh
# in the core stack
pulumi config set cloudnative-pg:enabled true
pulumi up

# in stacks/dev
pulumi config set cloudnative-pg:enabled true
pulumi config set forgejo:db/type postgres
pulumi config set forgejo:db/storageSize 5Gi
pulumi up
```

Forgejo creates the PostgreSQL schema automatically on first start. Switching an existing instance from SQLite starts with an empty database; there is no built-in restore command, so migrate the data out-of-band or start fresh. The SQLite file is left in place, so setting `forgejo:db/type` back to `sqlite` brings the previous instance back.

## OIDC Authentication (Pocket ID)

The core stack must have Pocket ID enabled and deployed before configuring OAuth. Run the helper after Forgejo is deployed:

```sh
cd stacks/dev
./components/forgejo/pocket-forgejo.sh
```

The helper creates or refreshes the Pocket ID client and prints the client configuration commands. Existing clients are reused without rotating their secret.

Run the printed commands, then deploy again:

```sh
pulumi config set forgejo:auth pocket
pulumi config set forgejo:auth/clientId <client-id>
pulumi config set forgejo:auth/clientSecret <client-secret> --secret

pulumi up
```

### Sign-in and accounts

- **Automatic accounts** - on first sign-in Forgejo creates the account from your identity provider; there is no registration form. The username comes from the `nickname` claim, falling back to `preferred_username`.
- **Admin linking** - if `forgejo:adminEmail` matches your identity provider email, the sign-in is linked to the existing admin account.
- **Administrators** - members of the app's admin group (`forgejo-admin`, overridable with `forgejo:auth/adminGroup`) become Forgejo administrators. The Pocket ID client is restricted to `admin`, `forgejo-users` and `forgejo-admin`; non-admin members get a normal account.
- **Profile pictures** - synced from the identity provider on each sign-in.
- **Reserved username** - Forgejo reserves the name `admin`.

### SSO-only mode

While OIDC is enabled, Forgejo is SSO-only: local username/password sign-in and self-registration are disabled. To regain local admin access, remove `forgejo:auth` (`pulumi config rm forgejo:auth`) and deploy again.

## SSH access

Forgejo's built-in SSH server is exposed on port `2222`:

```sh
ssh -T -p 2222 git@forgejo.<domain>
```

Add your public keys under **Settings → SSH / GPG keys** to push and pull over SSH. The port must be reachable from where you connect; `2222` avoids clashing with the node's own SSH daemon.

## Mirroring between two forges

A repository can stay where it is on another forge and still be worked on here.
The `mirrorSync` job keeps the two copies in step on a schedule, pulling the
upstream's branches and — optionally — pushing Forgejo's own back out, which is
what lets an upstream keep accepting pull requests on one branch while
development happens here.

Nothing exists until the feature is switched on: `mirrorSync/enabled` defaults to
`false`, and while it is false the deployment creates no CronJob, no ConfigMap
and no Secret. There is no job to trigger, pause or clean up.

### The repository

Both directions work on the same local copy, so it is named once:

```sh
pulumi config set forgejo:mirrorSync/enabled true
pulumi config set forgejo:mirrorSync/repository example/project
```

- `repository` - the repository on this Forgejo instance, as `owner/name`.

Everything else belongs to one direction. `schedule` (`*/30 * * * *`) and `image`
have working defaults in the stack's `Pulumi.yaml` and only need setting to
change them.

### Pulling the upstream's branches

```sh
pulumi config set forgejo:mirrorSync/pullUrl https://github.com/example/project.git
pulumi config set forgejo:mirrorSync/pullToken <token> --secret
```

- `pullUrl` - the remote to copy from. Fetched anonymously, so a public upstream
  needs no credential.
- `pullToken` - a Forgejo token with `write:repository` on `repository`, used to
  push the fetched branches into the local copy. Mint it in **Settings →
  Applications** for an account that can already write to the repository.
- `pullUpstreamToken` - (optional) only for a _private_ upstream.
- `pullBranches` (default `main`) - the branches the upstream owns,
  comma-separated. Branches you develop in Forgejo travel the other way; listing
  them here would fight that direction.

The job is fast-forward only. If a branch has moved on both sides it prints
`DIVERGED`, leaves the local branch untouched and exits non-zero, so the failed
job is the signal that a human has to reconcile — it will never discard commits
that exist only in Forgejo or only upstream. Runs do not overlap
(`concurrencyPolicy: Forbid`), so a slow run cannot race the next one.

### Pushing the other way

Forgejo's own branches can be pushed back out to a remote, which is what keeps a
public repository current while development happens here. The `push*` keys add a
second stage to the same job, running after the pull has finished:

```sh
pulumi config set forgejo:mirrorSync/pushUrl https://github.com/example/project.git
pulumi config set forgejo:mirrorSync/pushBranches develop
pulumi config set forgejo:mirrorSync/pushToken <token> --secret
```

- `pushUrl` - the remote to push to, and the switch for the whole direction:
  left unset, the push part of the sync is ignored — no stage, no credential, no
  settings file — and the other two `push` keys are never read.
- `pushBranches` - the branches Forgejo owns, comma-separated. Required
  alongside `pushUrl`, with no default: which branches a repository develops in
  Forgejo is that repository's decision, not the component's.
- `pushToken` - a token on that remote that may write to the repository.

The push names an explicit refspec and never forces: a branch it was not asked
about is untouched, and a branch that is ahead on the remote is reported as
`DIVERGED` instead of being rewound. A forge-side push mirror copies every ref
instead (`git push --mirror`) and so deletes whatever its branch filter
excludes, which on a repository whose default branch is filtered out is a delete
request on every run.

If you would rather drive the same copy from outside the cluster, the script the
job runs is `components/forgejo/mirror-sync.sh`: give it a settings file with
`SOURCE_URL`, `TARGET_URL` and `BRANCHES`, and `TARGET_TOKEN` in the environment
(plus `SOURCE_TOKEN` when the source needs one), and it prints one line per
branch.

## Admin access

The admin account is created on first start from `forgejo:adminUsername` and `forgejo:adminPassword`. The password is kept in sync on every deploy (`keepUpdated`), so changing `forgejo:adminPassword` and running `pulumi up` resets the admin password. Keep the configured value stable when restoring from backup so the restored instance stays accessible.
