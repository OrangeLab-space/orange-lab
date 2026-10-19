# Multi-Stack Deployment

OrangeLab supports deploying modules as independent Pulumi stacks. This allows you to manage different parts of your infrastructure separately and reducing update time.

All stacks target the **same Kubernetes cluster**. The core stack must be deployed first because it installs CRDs, storage classes, and ingress controllers that module stacks depend on.

Each additional stack is independent and can be destroyed and re-deployed without affecting the rest of the cluster.

## Available Stacks

| Module   | Path                                              | Description                             |
|----------|---------------------------------------------------|-----------------------------------------|
| Apps     | [`stacks/apps/`](./stacks/apps/README.md)         | General-purpose tools and utilities     |
| AI       | [`stacks/ai/`](./stacks/ai/README.md)             | AI workloads, LLMs                      |
| Bitcoin  | [`stacks/bitcoin/`](./stacks/bitcoin/README.md)   | Bitcoin nodes and blockchain tools      |
| Dev      | [`stacks/dev/`](./stacks/dev/README.md)           | Development and debugging utilities     |
| IoT      | [`stacks/iot/`](./stacks/iot/README.md)           | Home automation and IoT platforms       |
| Media    | [`stacks/media/`](./stacks/media/README.md)       | Photo backup, streaming, *arr stack     |

## Prerequisites

Before deploying any module stack, deploy the core stack:

```sh
cd /
pulumi up
```

Core must include:
- [Network](./components/network/NETWORK.md) — routing provider (Tailscale or Traefik)
- [Storage](./components/storage/STORAGE.md) — Longhorn or local-path storage class
- [Data](./components/data/DATA.md) — database operators if apps need them

Each module stack must reference the deployed core stack so it can consume shared
outputs such as the Pocket ID OIDC provider URL:

```sh
# From the core stack directory, list the stack and its Pulumi Cloud URL
cd /
pulumi stack ls
# Use the organization/project/stack path from the URL column
# Example URL: https://app.pulumi.com/example-org/orangelab/lab

cd stacks/<module>

# Use the value printed above
pulumi config set orangelab:coreStackRef example-org/orangelab/lab
```

The value must identify the deployed core stack in
`organization/project/stack` form. The same value can be checked with
`pulumi stack ls` from the core stack directory.

The referenced core stack must already exist and be deployed. Set this value
before deploying applications that depend on core outputs, including applications
configured with `orangelab:coreStackRef`-based OIDC authentication.

## Deploying a Module Stack

### Example: Media Stack

```sh
cd stacks/media

# Initialize the stack
pulumi stack init <stack> # f.e. lab

# Configure shared settings. customDomain can be inherited from the core stack.
pulumi config set orangelab:routingProvider traefik
pulumi config set orangelab:coreStackRef example-org/orangelab/lab

# Enable media applications
pulumi config set jellyfin:enabled true
pulumi config set jellyfin:media/hostPath /mnt/media
pulumi config set radarr:enabled true
pulumi config set sonarr:enabled true

# Deploy current stack (lab-media)
pulumi up

# Undeploy the stack, make sure you use static volumes and fromVolume setting so no data is lost
pulumi destroy
```

### Config Structure

Each module stack has its own `Pulumi.yaml` with default values. Stack-specific overrides go in `Pulumi.<stack>.yaml`:

```
stacks/<module>/
├── Pulumi.yaml              # Project name + shared defaults
├── Pulumi.<stack>.yaml      # Stack-specific overrides
├── index.ts                 # Entry point
└── components/              # Module components
```

Shared and module dependency config keys:

| Key                           | Example                  | Purpose                                  |
|-------------------------------|--------------------------|------------------------------------------|
| `orangelab:routingProvider`   | `traefik` or `tailscale` | Ingress/routing                          |
| `orangelab:customDomain`      | `example.com`            | Traefik domain; inherited from core when omitted |
| `orangelab:coreStackRef`      | `organization/project/stack` | Reference to the deployed core stack and its shared outputs |
| `longhorn:backupAllVolumes`   | `false`                  | Back up all application volumes by default; inherited from the core stack |
| `mariadb-operator:enabled`   | `false`                  | Enable MariaDB for dependent applications |
| `cloudnative-pg:enabled`     | `false`                  | Enable PostgreSQL for dependent applications |

`orangelab:routingProvider` must be configured in every module stack. The
Traefik domain and backup policy are read from the core stack when
`orangelab:coreStackRef` is configured. Set
`longhorn:backupAllVolumes` in a module stack to override the core policy.
Individual applications can override it with their `<app>:backupVolume` setting,
or override schedules and retention with `<app>:storage/snapshot*` and
`<app>:storage/backup*` settings. Components can override the app with
`<app>:<component>/storage/*`. Unset values are inherited from the core stack.

Database operator settings are module dependencies and are included only in
stacks with applications that use them. Keep them disabled unless an
application in that stack uses the corresponding database; enable the operator
in the module stack before enabling that application. MariaDB-backed
applications require `mariadb-operator:enabled: true`, while PostgreSQL-backed
applications require `cloudnative-pg:enabled: true`.

## Migrating a Module from Core Stack

To move a module from the monolithic core stack to its own stack:

1. **Disable the module in core**:
   ```sh
   # In root Pulumi.<stack>.yaml, set all module apps to false
   pulumi config set jellyfin:enabled false
   # ... etc for all apps in the module
   ```

2. **Deploy core without the module**:
   ```sh
   cd /
   pulumi up
   ```

3. **Configure the module stack**:
    ```sh
    cd stacks/<module>
    # initialize new stack
    pulumi stack init lab
    # select stack as active
    pulumi stack select lab

     # Copy shared settings from root Pulumi.lab.yaml
     pulumi config set orangelab:routingProvider traefik
     pulumi config set orangelab:customDomain example.com
     pulumi config set orangelab:coreStackRef example-org/orangelab/lab
     pulumi config set mariadb-operator:enabled true

    # Copy app overrides from root Pulumi.lab.yaml
    # Secrets must be re-set because each stack has its own encryption key
    # Check secrets in old stack: pulumi config --show-secrets
    pulumi config set --secret vaultwarden:adminToken <value>
    pulumi config set --secret vaultwarden:smtp/password <value>
    ```

4. **Deploy the module stack**:
    ```sh
    pulumi up
    ```
