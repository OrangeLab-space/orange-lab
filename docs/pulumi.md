# Pulumi backend and state

Pulumi keeps the state of every stack in a _backend_. The backend decides where
state, history and lock files live, and what has to be reachable before you can
run `pulumi up`. It does not change what gets deployed.

Three options are supported, in order of increasing independence:

| Backend                               | Depends on               | Backups  | Use when                                       |
| ------------------------------------- | ------------------------ | -------- | ---------------------------------------------- |
| [Pulumi Cloud](#pulumi-cloud)         | Pulumi account, internet | optional | default, easiest setup                         |
| [Local filesystem](#local-filesystem) | nothing                  | required | no external services, single admin machine     |
| [RustFS](#rustfs-s3)                  | the cluster it manages   | required | no Pulumi dependency, after RustFS is deployed |

All three store the same state, and you can [move between them](#migrating-between-backends)
without redeploying anything.

## What lives in a backend

Every stack has a checkpoint (the last known state of every resource), the
history of previous updates, and a lock object while an operation runs. Stack
config secrets are stored there too, but only as ciphertext: they are encrypted
by the stack's _secrets provider_, which is a separate choice from the backend.

- Pulumi Cloud stacks default to the `service` provider, where Pulumi holds the
  key. It only works with the Cloud backend.
- DIY backends (local, RustFS) use `passphrase`, where the CLI encrypts with a
  passphrase that never leaves your machine. The salt is kept in
  `Pulumi.<stack>.yaml`, so that file is needed to decrypt.

`pulumi stack migrate` re-encrypts config and state secrets into the target
backend's provider, so the secrets provider follows the backend when you move.

## Stack names

A stack's fully qualified name includes its backend's organization:

| Backend       | Example                      |
| ------------- | ---------------------------- |
| Pulumi Cloud  | `example-org/orangelab/lab`  |
| local, RustFS | `organization/orangelab/lab` |

DIY backends always use the literal organization `organization`. Print the name
with `pulumi stack ls -Q` from the stack directory.

This matters for `orangelab:coreStackRef`: module stacks must reference the core
stack by name **in the backend you are currently using**. A reference to
`example-org/orangelab/lab` only resolves on Pulumi Cloud, and
`organization/orangelab/lab` only on a DIY backend. Update it after changing
backends.

## Pulumi Cloud

Stores state, history and secrets, and holds the encryption key.

```sh
# Browser login, or paste a token from https://app.pulumi.com/account/tokens
pulumi login

pulumi stack init lab
```

Nothing else to run: no backups, no passphrase, locking and history are handled
for you.

**Failure modes**

- Pulumi or the internet is down: `pulumi` commands fail, the running cluster is
  not affected.
- Token lost or revoked: create a new token and log in again. State is
  unaffected.
- Account unavailable, free tier changes, or you no longer want the dependency:
  [migrate](#migrating-between-backends) to a DIY backend while the account
  still works, because the `service` secrets provider needs Pulumi to decrypt.

## Local filesystem

State lives on the admin machine. No account, no network, nothing else to
install.

```sh
pulumi login --local
```

`--local` is shorthand for `file://~`, so the backend root is your home
directory and state is written under `~/.pulumi`:

| Path                  | Contents                     |
| --------------------- | ---------------------------- |
| `~/.pulumi/meta.yaml` | backend metadata             |
| `~/.pulumi/stacks/`   | current checkpoint per stack |
| `~/.pulumi/history/`  | previous updates             |
| `~/.pulumi/locks/`    | locks for running operations |

`~/.pulumi` is also the CLI home (`credentials.json`, `plugins/`, `logs/`), so
checkpoints sit next to tool data. For a backup unit that is a single directory,
use an explicit path as the backend root — state then lands in `<path>/.pulumi/`:

```sh
mkdir -p ~/pulumi-state       # the backend root must exist
pulumi login file://~/pulumi-state
```

With that layout stacks are in `~/pulumi-state/.pulumi/stacks/` and history in
`~/pulumi-state/.pulumi/history/`. Use an absolute path or `~/…`; a relative
path resolves against the current directory. Both forms are the same backend
type — switching between them is a [migration](#migrating-between-backends), not
a login detail.

Do not put the state directory under a dotfile manager: `Pulumi.*.yaml` belongs
in version control, checkpoints and history do not.

### Passphrase

Secrets are encrypted with a passphrase. Put it in a file outside the repo and
point every session at it:

```sh
# Create once, store a copy in your password manager
mkdir -p ~/.config/pulumi
openssl rand -base64 32 > ~/.config/pulumi/passphrase
chmod 600 ~/.config/pulumi/passphrase

export PULUMI_CONFIG_PASSPHRASE_FILE=~/.config/pulumi/passphrase
```

`pulumi stack init` and `pulumi stack migrate --secrets-provider passphrase`
use this passphrase; if the variable is unset, they prompt for it.

Pulumi defines no fixed location for the file; only the variable matters. This
guide keeps it in `~/.config/pulumi/` because that is outside the state
directory (a state backup should not carry the key next to the ciphertext it
protects) and outside `~/.pulumi` (the CLI home, and the state root with
`--local`), which is often copied or managed by dotfile tooling.

Make the variable persistent for interactive shells — for example in
`~/.bashrc.d/pulumi` when `~/.bashrc` sources that directory:

```sh
export PULUMI_CONFIG_PASSPHRASE_FILE="$HOME/.config/pulumi/passphrase"
```

Check it in a new shell with `echo "$PULUMI_CONFIG_PASSPHRASE_FILE"`. Scripts,
CI jobs and AI agents need the variable in their own environment: `.bashrc` is
not read by non-interactive shells, so export it where the process starts, or
pass it per command:

```sh
PULUMI_CONFIG_PASSPHRASE_FILE=~/.config/pulumi/passphrase pulumi preview
```

The file is a secret, not configuration to commit. If your dotfiles live in a
repository, track the exported path (for example the `~/.bashrc.d/pulumi` file)
and keep the passphrase in your password manager — or add it to the dotfiles
with the manager's encryption support.

Every `pulumi` command now needs it, including commands run by tools or AI
agents — launch them with the variable set (for example from your shell
profile). Never commit the passphrase. Losing it, or losing the
`encryptionsalt` line in `Pulumi.<stack>.yaml`, makes the encrypted config and
the secrets in state unrecoverable.

### Backups

The state exists only on this machine, so back it up.

The portable format is one export per stack:

```sh
# Run in the stack's directory; pick any destination
pulumi stack export --file ~/backup/pulumi/lab.json
```

`pulumi stack import --file` restores it into _any_ backend, which also makes it
the way to move state by hand when `pulumi stack migrate` is unavailable. To
automate the exports into RustFS, see [Backing up state](#backing-up-state).

A folder snapshot keeps history as well and is faster to restore. Copy
`~/.pulumi/meta.yaml`, `~/.pulumi/stacks/` and `~/.pulumi/history/` (or the
whole dedicated `file://` directory if you chose one), the repository's
`Pulumi.*.yaml` files, and the passphrase file. Do not back up
`~/.pulumi/plugins` or `~/.pulumi/logs` (regenerable), and treat
`~/.pulumi/credentials.json` as a secret (it holds a Pulumi Cloud token if you
still log in there).

**Failure modes**

- Laptop lost or disk failure: state is gone. The cluster keeps running, but
  Pulumi can no longer manage it. Restore the snapshot (or import an export); if
  there is no backup, recreate the stack and `pulumi import` resources, or
  rebuild.
- State copied to a second machine: two divergent copies. Pick one and do not
  alternate between them; move state with `pulumi stack migrate`, not `cp`.
- `~/.pulumi` deleted: same as losing the laptop.
- Passphrase or `Pulumi.<stack>.yaml` lost: encrypted values cannot be
  recovered.
- Locking only covers the local filesystem, so two machines can update the same
  stack at once.

## RustFS (S3)

State is stored in a bucket on [RustFS](../components/storage/rustfs/rustfs.md).
It survives losing the admin machine, but depends on the cluster being up. This
is the only option with no Pulumi or other third-party dependency.

### Prerequisites

- RustFS deployed and reachable from the admin node over the tailnet
  (`https://s3.<domain>`, S3 port 9000). The API is not published to the
  internet while `rustfs:network/public` stays unset.
- A dedicated bucket and S3 user for Pulumi state.
- The same passphrase setup as the [local backend](#passphrase).

### One-time setup

Use `rc` with the RustFS root credentials against the S3 API endpoint (not the
console hostname). Then let the repository's provisioning script create the
bucket, user and a bucket-scoped policy; it writes the credentials to a 600
file and does not print the password.

```sh
# One-time root alias (skip if it already exists)
rc alias set rustfs https://s3.<domain> <root-user> <root-password>

./scripts/rustfs-provision.sh --user pulumi --bucket pulumi-state \
  --output ~/.config/pulumi/state.env

# For the current shell; add the same source line to ~/.bashrc.d/pulumi
. ~/.config/pulumi/state.env

pulumi login 's3://pulumi-state?endpoint=s3.<domain>&s3ForcePathStyle=true&region=us-east-1'
```

The script creates bucket `pulumi-state`, user `pulumi` and policy
`pulumi-policy`. The env file is a secret: keep it out of the repo, back it up
in your password manager, and do not commit it. The CLI creates the `.pulumi/`
prefix on first use; stacks, history and locks live under it.

### Chicken-and-egg

RustFS is deployed by the core stack, and the core stack needs a backend, so
RustFS cannot be the backend for the deployment that creates it. Bootstrap in
two phases:

1. Deploy with the local (or Cloud) backend, then enable RustFS:

    ```sh
    pulumi config set rustfs:enabled true
    pulumi up
    ```

2. Create the bucket and user as above, then
   [migrate](#migrating-between-backends) the core stack and every module stack
   to the RustFS backend.

Keep the local copy of state afterwards. It is the way back in when RustFS is
unavailable, and the base for backups.

### Failure modes

- **RustFS or its node is down.** No `pulumi` command can read or write state
  until it is back; deploys are blocked, the running cluster is not. A reboot is
  enough. If it does not return, restore a backup into a local backend and work
  there.
- **Updating the state host.** A `pulumi up` that restarts RustFS, Traefik, the
  Gateway or cert-manager can lose its own state endpoint mid-update and fail.
  Re-running `pulumi up` usually converges, and `pulumi cancel` clears a lock
  left behind. For planned maintenance of those components, move state to a
  local backend first (export → `pulumi stack import`), then migrate back.
- **`pulumi destroy` on the core stack.** It deletes RustFS, which holds the
  state being written. Export the stacks, import them into a local backend, and
  destroy from there. Or do not destroy the core stack at all.
- **Bucket or disk lost.** Every stack is gone. Restore the latest exports
  (`pulumi stack import --file`) into a new bucket or a local backend. Keep a
  copy off the RustFS disk: if that disk also holds the Longhorn backups, one
  disk failure takes both.
- **Admin machine off the tailnet, or DNS for the endpoint broken.** Same as
  RustFS down: no state access.
- **Leftover lock** after a killed update. `pulumi cancel` in the stack
  directory clears it; if it does not, delete the lock object under
  `.pulumi/locks/` in the bucket.

## Migrating between backends

`pulumi stack migrate` copies one stack into the backend you are logged into,
re-encrypts secrets with the target provider, and leaves the source stack
untouched — that untouched copy is your rollback until you delete it.

Requirements: Pulumi CLI v3.254.0 or newer, the source backend still reachable
(for Pulumi Cloud: a working token), and the passphrase when either side uses
one. The target project name comes from `Pulumi.yaml` in the current directory,
so run each command from that stack's directory.

1. Freeze changes: nobody else runs `pulumi up` during the move.
2. Export every stack as insurance (see [Backups](#backups)).
3. Log into the target backend.
4. Migrate the core stack, then each module stack.
5. Update `orangelab:coreStackRef` in every module stack, if the organization
   changed (Cloud ↔ DIY).
6. Verify.

```sh
export SOURCE=https://api.pulumi.com   # or file://~/pulumi-state, or s3://...
export PULUMI_CONFIG_PASSPHRASE_FILE=~/.config/pulumi/passphrase

mkdir -p ~/pulumi-state
pulumi login file://~/pulumi-state   # or: pulumi login --local

# Core stack, from the repository root
pulumi stack migrate "$SOURCE" lab --secrets-provider passphrase

# Each module stack, from its directory
cd stacks/ai && pulumi stack migrate "$SOURCE" lab-ai --secrets-provider passphrase
cd ../apps && pulumi stack migrate "$SOURCE" lab-apps --secrets-provider passphrase
cd ../bitcoin && pulumi stack migrate "$SOURCE" lab-bitcoin --secrets-provider passphrase
cd ../dev && pulumi stack migrate "$SOURCE" lab-dev --secrets-provider passphrase
cd ../iot && pulumi stack migrate "$SOURCE" lab-iot --secrets-provider passphrase
cd ../media && pulumi stack migrate "$SOURCE" lab-media --secrets-provider passphrase
```

`--secrets-provider passphrase` is required when leaving Pulumi Cloud, because
the `service` provider cannot encrypt for a DIY backend. It is also correct for
DIY-to-DIY moves — use the same passphrase on both sides. The command rewrites
`Pulumi.<stack>.yaml` and saves the previous version as
`Pulumi.<stack>.yaml.bak.<timestamp>`.

The source URL for Pulumi Cloud is the API backend, `https://api.pulumi.com` —
not the `https://app.pulumi.com/<org>` address that `pulumi whoami -v` prints.
The web address is treated as a self-hosted instance and login fails.

Migration copies the latest checkpoint and the configuration. Update history
does not move: the target stack starts with no updates until its first
`pulumi up`, while the source backend keeps the full history.

If `PULUMI_BACKEND_URL` is set in your environment it overrides `pulumi login`,
so unset it before switching backends. `pulumi whoami -v` prints the backend
actually in use.

If the CLI cannot authenticate to the source backend, export
`PULUMI_ACCESS_TOKEN` for the duration of the migration.

Then point module stacks at the core stack in the new backend:

```sh
# In each module stack directory
pulumi config set orangelab:coreStackRef organization/orangelab/lab
```

Verify:

```sh
pulumi stack ls -Q      # organization/... name and resource count
pulumi preview          # in the core stack, then one module stack
pulumi config           # same keys, values redacted
```

**Rollback.** The source backend still holds the last pre-migration update. To
go back, log into it, restore `Pulumi.<stack>.yaml` from the
`Pulumi.<stack>.yaml.bak.<timestamp>` file the migration wrote (the local file's
secrets provider must match the source again), and revert `coreStackRef` to the
old value. Updates run against the new backend are not in that copy, so do not
roll back later without exporting first.

Moving to RustFS later is the same procedure with
`SOURCE=file://~/pulumi-state` (or `file://~` if you used `--local`) and the
`s3://` login above; `coreStackRef` does not change because both sides use
`organization/...`. The source stacks stay intact in their backend after the
move — keep them as a cold backup, and revoke/delete them when you are
confident.

### Migrating one stack at a time

`pulumi stack migrate` works per stack, so a partial migration is fine and is a
good way to try it: migrate one stack, verify it, then continue. The only
constraint is `orangelab:coreStackRef`: a migrated module stack can be previewed
or updated only once the core stack exists in the same backend and its reference
points there. So:

- Migrating a module first is safe; keep it out of `pulumi up` until the core
  stack is migrated and the reference is updated.
- Update `coreStackRef` when you migrate the core stack, not before, so the
  still-Cloud copies of the modules keep working until then.
- A stack is managed by one backend at a time. After a module moves, do not run
  `pulumi up` on its old copy.

The `test` stack is independent of the others and can be migrated (or left
alone) at any point.

## Building a new cluster

State does not run the cluster, so a new cluster never needs old state.

- **Pulumi Cloud**: install the CLI, `pulumi login`, clone the repository,
  `pulumi stack init lab`, deploy.
- **Local**: install the CLI, create the state directory and log in
  (`mkdir -p ~/pulumi-state && pulumi login file://~/pulumi-state`), clone the
  repository, then restore the passphrase, `Pulumi.*.yaml` and the state
  snapshot (or `pulumi stack import --file`) if this rebuilds the same
  installation. Without a backup, create a fresh stack; existing resources
  become unmanaged and are recreated.
- **RustFS**: cannot be first. Bootstrap the core stack with the local backend,
  enable RustFS, then migrate to the S3 backend. After losing the RustFS
  node/disk, restore exports into a new bucket or into a local backend.

Restoring data volumes is independent of the state backend: Longhorn restores
from S3 backups with `fromVolume`, see [Backup and Restore](./backup.md).

## Backing up state

The repository includes `scripts/pulumi-state-backup.sh`, which exports every
stack and uploads a dated archive to RustFS:

```sh
export PULUMI_CONFIG_PASSPHRASE_FILE="$HOME/.config/pulumi/passphrase"
./scripts/pulumi-state-backup.sh
# Backed up 7 stacks to pulumi-backup/pulumi-backup/pulumi-state-<timestamp>.tar.gz
```

It runs from the repository root, uses the current login (override with
`--backend` / `PULUMI_BACKEND_URL`), and accepts `--alias`, `--bucket` and
`--help`. Run it when no deploy is in progress.

The archive contains:

- `pulumi-state/exports/<project>__<stack>.json` — one `pulumi stack export` per
  stack
- `pulumi-state/config/...` — the `Pulumi.*.yaml` files (needed for the
  encryption salt)
- `pulumi-state/manifest.json` — timestamp, backend and stack list

It does **not** contain the passphrase. Without it the secrets in the exports
cannot be decrypted, so keep the passphrase in your password manager (and
dotfiles). The archive itself is safe to store off-machine.

### One-time bucket setup

Create a dedicated bucket and user, separate from the state bucket:

```sh
./scripts/rustfs-provision.sh --user pulumi-backup --bucket pulumi-backup \
  --output ~/.config/rustfs/pulumi-backup.env

. ~/.config/rustfs/pulumi-backup.env
# Alias the backup script uses; it stores this credential in the rc config
rc alias set pulumi-backup https://s3.<domain> \
  "$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY"
```

Schedule it from cron (non-interactive, so pass the environment explicitly):

```sh
0 3 * * * cd "$HOME/dev/orange-lab" && . "$HOME/.config/pulumi/state.env" && PULUMI_CONFIG_PASSPHRASE_FILE="$HOME/.config/pulumi/passphrase" ./scripts/pulumi-state-backup.sh >>"$HOME/pulumi-state-backup.log" 2>&1
```

One archive is about 1 MB. Prune old ones with `rc object remove` (or a bucket
lifecycle rule); the script keeps every run.

### Restoring from a backup

Restore the `Pulumi.*.yaml` files **before** initializing the stacks: they hold
the salt that decrypts the secrets, and `pulumi stack init --secrets-provider
passphrase` keeps the salt from an existing file.

1. Install Pulumi, clone the repository and apply your dotfiles, so
   `Pulumi.*.yaml` and the passphrase are back. If they are not in dotfiles,
   copy them from the archive's `config/` directory.
2. Fetch and unpack the latest archive.
3. Log into the target backend (`pulumi login file://~/pulumi-state`, or the
   `s3://` login above).
4. Restore the core stack first, then each module from its directory:

    ```sh
    # Core, from the repository root
    pulumi stack init lab --secrets-provider passphrase
    pulumi stack import --file ~/restore/pulumi-state/exports/organization__orangelab__lab.json

    # Module, from its directory
    cd stacks/apps
    pulumi stack init lab-apps --secrets-provider passphrase
    pulumi stack import --file ~/restore/pulumi-state/exports/organization__orangelab-apps__lab-apps.json
    ```

5. `pulumi preview` on the core stack and one module to confirm the state
   matches the cluster.

The export file name is the fully qualified stack name with `/` replaced by
`__`; `manifest.json` lists them.

## Backup summary

| Backend      | Back up                                                        | Restore                             |
| ------------ | -------------------------------------------------------------- | ----------------------------------- |
| Pulumi Cloud | nothing required; occasional `pulumi stack export` for safety  | `pulumi stack import --file`        |
| Local        | `scripts/pulumi-state-backup.sh` (exports + configs to RustFS) | restore configs, then init + import |
| RustFS       | the same script; mirror the state bucket separately            | `pulumi stack import --file`        |
