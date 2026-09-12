# Dev Stack

Development and debugging utilities.

**Prerequisite**: Core stack must be deployed first (network, storage).

## Components

- [Debug](./components/debug/debug.md) - (Experimental) Debug pod for inspecting existing Longhorn volumes or exporting data.
- [Forgejo](./components/forgejo/forgejo.md) — Self-hosted lightweight software forge (Git hosting, issues, Actions).

## Configure Applications

### Forgejo

```sh
pulumi config set forgejo:enabled true

# Admin account, created on first start and kept in sync on every deploy.
pulumi config set forgejo:adminEmail forgejo@example.com
ADMIN_PASSWORD=$(openssl rand -base64 32)
pulumi config set forgejo:adminPassword "$ADMIN_PASSWORD" --secret

pulumi up
```

See [Forgejo](./components/forgejo/forgejo.md) for hostname, storage, SMTP, OIDC and SSH options.
