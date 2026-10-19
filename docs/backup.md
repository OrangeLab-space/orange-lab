# Backup and Restore

Longhorn provides automated snapshots and backups of persistent volumes to S3-compatible storage (RustFS). This guide explains how to set up, configure, and use this functionality.

Longhorn jobs:

- **Snapshots**: Taken hourly for all volumes (configurable with `longhorn:snapshotCron`)
- **Incremental Backups**: Run daily at 00:15 (configurable with `longhorn:backupCron`)
- **Retention**: `longhorn:snapshotRetain` and `longhorn:backupRetain` (default 10)
- If a volume has no changes since the last backup, no data is transferred

**Note:** Snapshots are disabled by default to save storage space. You can enable them with `longhorn:snapshotEnabled` to be able to revert storage to previous state. It's recommneded however to enable daily backups instead as a snapshot is also taked during backup operation.

## Setup S3 storage (RustFS)

Make sure RustFS is installed and functioning before enabling backups. See [RustFS installation instructions](/components/storage/rustfs/rustfs.md) for details.

```sh
# S3 bucket that will be used for backups. Default: backup-longhorn
pulumi config set longhorn:backupBucket backup-longhorn

# Enable backup functionality in Longhorn. RustFS has to be running.
pulumi config set longhorn:backupEnabled true
```

If the target later becomes unavailable with a `system-backup list` timeout, see
[Backup target unavailable](./troubleshooting.md#backup-target-unavailable).

## Managing Volume Backups

You can configure which volumes to back up through two main approaches:

### Option 1: Back up all volumes by default

Enable automatic backups for all volumes in the cluster, with the ability to exclude specific volumes:

```sh
# Enable backup functionality
pulumi config set longhorn:backupEnabled true

# Back up all volumes by default
pulumi config set longhorn:backupAllVolumes true

# Optional: Exclude specific volumes from backup
pulumi config set <app>:<component>/storage/backupEnabled false

pulumi up
```

### Option 2: Back up only specific volumes

Only back up volumes that are explicitly configured for backup:

```sh
# Enable backup functionality
pulumi config set longhorn:backupEnabled true

# Don't back up volumes by default (this is the default setting)
pulumi config set longhorn:backupAllVolumes false

# Enable backup for a specific app or component
pulumi config set <app>:storage/backupEnabled true
pulumi config set <app>:<component>/storage/backupEnabled true

pulumi up
```

For legacy participation, `<app>:<component>/backupVolume` (or
`<app>:backupVolume` for the main volume) overrides
`longhorn:backupAllVolumes`. New `storage/*` settings take precedence.

### Per-app and per-component schedules and retention

App-level `storage/*` settings are defaults. Component-level settings use the
volume/component name from `addStorage()` and override the app defaults:

```sh
# App-wide defaults
pulumi config set nextcloud:storage/snapshotEnabled true
pulumi config set nextcloud:storage/snapshotCron '0 */6 * * *'
pulumi config set nextcloud:storage/snapshotRetain 28
pulumi config set nextcloud:storage/backupEnabled true
pulumi config set nextcloud:storage/backupCron '0 2 * * *'
pulumi config set nextcloud:storage/backupRetain 14

# Component overrides
pulumi config set nextcloud:data/storage/backupEnabled false
pulumi config set nextcloud:db/storage/backupCron '0 3 * * *'
pulumi config set nextcloud:db/storage/backupRetain 30
pulumi config set nextcloud:db/storage/backupFullInterval 30
pulumi config set nextcloud:db/storage/snapshotCron '0 */6 * * *'
```

- Each setting is resolved independently: component `storage/*`, then app-level
  `storage/*`, then the global `longhorn:*` value.
- Component keys use the component/volume name, e.g. `nextcloud:data/...` or
  `nextcloud:db/...`.
- App-level `storage/backupEnabled` and `storage/snapshotEnabled` are defaults
  for components that do not set their own.
- `storage/backupEnabled` and `storage/snapshotEnabled` override the global
  enablement settings and the legacy `backupVolume` participation switch.
- If `storage/backupEnabled` is unset, `backupCron`, `backupRetain`, and
  `backupFullInterval` use the global enabled state; the custom schedule applies
  only when backups are enabled for the volume.
- Components with their own `storage/*` settings get their own Longhorn
  `RecurringJob`; `storage/backupEnabled=false` or `storage/snapshotEnabled=false`
  disables that component. Components without overrides use the app-level job or
  the global backup group.
- The S3 backup target must still exist; `storage/backupEnabled` controls
  scheduling and participation, not the target configuration.
- `backupFullInterval` is the number of incremental backups between full
  backups, not days.
- Trim remains global (`longhorn:trimEnabled` / `longhorn:trimCron`).
- `backupVolume` remains supported for compatibility; prefer
  `storage/backupEnabled` for new configuration.

## Restoring from Backup

To restore a volume from a backup, follow these steps:

1. Restore the volume through the Longhorn UI first
    - Name the volume after the application (e.g., "ollama")
2. Use the `fromVolume` parameter to attach the existing volume:

```sh
pulumi config set <app>:fromVolume "my-restored-volume"
pulumi up
```

This approach gives you better volume naming and allows you to verify the restore before attaching it to your application.
