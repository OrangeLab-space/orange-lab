# Pulumi backend and state

Pulumi stores the state of every stack in a _backend_: the last known resources,
the update history and the locks used during a deploy. It does not change what
gets deployed, and you can switch later without redeploying.

Two options cover normal use:

| Backend                               | Requires                 | Choose it when                              |
| ------------------------------------- | ------------------------ | ------------------------------------------- |
| [Local filesystem](#local-filesystem) | nothing                  | recommended, single admin, no accounts      |
| [Pulumi Cloud](#pulumi-cloud)         | Pulumi account, internet | quickest start, off-site state, more admins |

**Local is the recommended option** when you want zero dependencies: no account,
no Google/GitHub login, no service in the path. Pulumi Cloud is the quickest
start and the better fit when state must not live on one machine, or when more
than one admin or AI agent deploys.

## Local filesystem

State lives on the admin machine. Pick a directory and log in:

```sh
mkdir -p ~/pulumi-state
pulumi login file://~/pulumi-state
```

Config secrets are encrypted with a passphrase that never leaves the machine:

```sh
# Create once and keep a copy in your password manager
mkdir -p ~/.config/pulumi
openssl rand -base64 32 > ~/.config/pulumi/passphrase
chmod 600 ~/.config/pulumi/passphrase
export PULUMI_CONFIG_PASSPHRASE_FILE="$HOME/.config/pulumi/passphrase"
```

Add the `export` to your shell profile (for example `~/.bashrc.d/pulumi`):
every `pulumi` command needs it, including the ones run by tools and AI agents.

### Backing up

The state exists only on this machine, so back it up.
`scripts/pulumi-state-backup.sh` exports every stack and uploads one dated
archive to RustFS:

```sh
# Run from the repository root, when no deploy is running
./scripts/pulumi-state-backup.sh
# Backed up 7 stacks to pulumi-backup/pulumi-backup/pulumi-state-<timestamp>.tar.gz
```

The archive holds one `pulumi stack export` per stack, plus the `Pulumi.*.yaml`
files (they contain the encryption salt). It does not hold the passphrase, so
keep that in your password manager — without it the archive cannot be decrypted.

Run it daily from cron (non-interactive, so pass the environment explicitly):

```sh
0 3 * * * cd "$HOME/orange-lab" && PULUMI_CONFIG_PASSPHRASE_FILE="$HOME/.config/pulumi/passphrase" ./scripts/pulumi-state-backup.sh >>"$HOME/pulumi-state-backup.log" 2>&1
```

For a manual backup, export each stack to any destination:

```sh
pulumi stack export --file ~/backup/pulumi/lab.json
```

The bucket and credentials are a one-time setup, and the restore steps are in
[spec/pulumi.md](../spec/pulumi.md#backing-up-state).

## Pulumi Cloud

Pulumi holds state, history and the encryption key, so there is no passphrase
and no backup to manage:

```sh
# Browser login, or a token from https://app.pulumi.com/account/tokens
pulumi login
```

Use it when state must survive losing your machine, or when several admins or
agents deploy the same installation.

## Switching backends

`pulumi stack migrate` copies a stack into the backend you are logged into,
re-encrypts its secrets and leaves the source untouched (that copy is your
rollback). Migrate the core stack, then every module stack, in one go:

```sh
# Log into the target backend first
pulumi login file://~/pulumi-state

# Then name the current backend as the source
export SOURCE=https://api.pulumi.com
pulumi stack migrate "$SOURCE" lab --secrets-provider passphrase
```

Moving between Pulumi Cloud and a DIY backend also changes the fully qualified
stack name, so update `orangelab:coreStackRef`. The full procedure, rollback,
failure modes and state backups are in
[spec/pulumi.md](../spec/pulumi.md).

An S3 backend on RustFS is also supported. It depends on the cluster it manages,
so it only works as a later migration target; see
[spec/pulumi.md](../spec/pulumi.md#rustfs-s3).
