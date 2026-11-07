# MariaDB Operator

|             |                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| Homepage    | https://mariadb-operator.github.io/mariadb-operator/                                                      |
| Helm values | https://github.com/mariadb-operator/mariadb-operator/blob/main/deploy/charts/mariadb-operator/values.yaml |
| Dockerfile  | https://github.com/MariaDB/mariadb-docker/blob/master/main/Dockerfile                                     |

The MariaDB Operator manages MariaDB/MySQL databases on Kubernetes using CRDs. It provisions and manages clusters, users, and databases declaratively.

## Installation

```sh
pulumi config set mariadb-operator:enabled true
```

### Override root password

After the first deploy of application using MariaDB it is recommended to set the root password in Pulumi config file.

This will help with restoring volumes from backups later as it makes sure the password matches the one stored in the database.

If this is not done then you'll need to reset the password (see next section).

```sh
./scripts/mariadb-password.sh <app>
```

### Resetting root password

```sh
# Shut down the application, leaving the database running
pulumi config set <app>:storageOnly=true

# Disable MariaDB authentication (allows logging in as root without password)
pulumi config set <app>:db/disableAuth=true
pulumi up

# log into the MariaDB container
kubectl exec -it <app>-db-0 -n <app> -- mariadb -u root
```

Update root password using MariaDB CLI:

```sh
# Initialize grant tables
FLUSH PRIVILEGES;

# Reset password, make sure it matches the `rootPassword` value in `<app>-db-secret`
ALTER USER 'root'@'%' IDENTIFIED BY '<root-password>';
ALTER USER 'root'@'localhost' IDENTIFIED BY '<root-password>';
FLUSH PRIVILEGES;
```

Exit with CTRL-D. Cleanup and re-enable database authentication:

```sh
# Enable MariaDB authentication
pulumi config rm <app>:db/disableAuth
pulumi up

# Remove temporary config keys to start the apps using the database
pulumi config rm <app>:storageOnly
pulumi up
```
