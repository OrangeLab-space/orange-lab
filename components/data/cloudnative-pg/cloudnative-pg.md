# CloudNativePG Operator

|                |                                                                                      |
| -------------- | ------------------------------------------------------------------------------------ |
| Homepage       | https://cloudnative-pg.io/                                                           |
| Helm chart     | https://github.com/cloudnative-pg/charts                                             |
| Helm values    | https://github.com/cloudnative-pg/charts/blob/main/charts/cloudnative-pg/values.yaml |
| Cluster values | https://github.com/cloudnative-pg/charts/blob/main/charts/cluster/values.yaml        |

This component installs the CloudNativePG PostgreSQL operator using its official Helm chart. It manages the installation of CRDs and the operator itself, and supports optional monitoring integration.

## Installation

```sh
# Optional: install CNPG kubectl plugin
brew install kubectl-cnpg

pulumi config set cloudnative-pg:enabled true
```

When setting `<app>:storageOnly` to `true`, the application is removed but the
database keeps running, so its data stays attached and reachable. To shut
PostgreSQL down as well, disable it explicitly:

```sh
pulumi config set <app>:db/enabled false

# Optional: add PostgreSQL replicas, 1 is default (just primary)
pulumi config set n8n:db/instances 3
```

## Manual Backup and Restore

For manual database operations, use the provided scripts in the `scripts/` directory:

**Database Dump:**

```sh
# Create a database dump
./scripts/pg-dump.sh <app-name> [namespace]

# Example: dump n8n database
./scripts/pg-dump.sh n8n
# Creates: n8n.dump
```

**Database Restore:**

```sh
# Restore from a dump file
./scripts/pg-restore.sh <app-name> [namespace]

# Example: restore n8n database
./scripts/pg-restore.sh n8n
# Requires: n8n.dump file to exist
```

## Database image override

Each app using PostgreSQL can override the container image:

```sh
# Full image override (e.g., specific version or variant)
pulumi config set <app>:db/image ghcr.io/cloudnative-pg/postgresql:17-bookworm
```

## Database upgrade

Generally database upgrades are handled automatically by CloudNative-PG.

One case where some manual intevention is needed is when restoring backup containing old version of database.

In that case you need to deploy with downgraded Postgres first, then upgrade.

```sh
pulumi config set <app>:enabled true
# Bookworm variant required for 17 to fix libssl error during upgrade
# https://github.com/cloudnative-pg/cloudnative-pg/issues/7580
pulumi config set <app>:db/image ghcr.io/cloudnative-pg/postgresql:17-bookworm
pulumi up

# upgrade to 18
pulumi config set <app>:db/image ghcr.io/cloudnative-pg/postgresql:18

# upgrade to latest
pulumi config rm <app>:db/image

pulumi up
```

## Uninstall

```sh
pulumi config set cloudnative-pg:enabled false
pulumi up

# Remove all CRDs (required before reinstalling)
kubectl delete crd \
  backups.postgresql.cnpg.io \
  clusterimagecatalogs.postgresql.cnpg.io \
  clusters.postgresql.cnpg.io \
  databases.postgresql.cnpg.io \
  failoverquorums.postgresql.cnpg.io \
  imagecatalogs.postgresql.cnpg.io \
  poolers.postgresql.cnpg.io \
  publications.postgresql.cnpg.io \
  scheduledbackups.postgresql.cnpg.io \
  subscriptions.postgresql.cnpg.io
```
