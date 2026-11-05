# Nostr Stack

Nostr-based workspaces and relays.

**Prerequisite**: Core stack must be deployed first (network, storage and data
operators).

## Components

- [Buzz](./components/buzz/buzz.md) — Team workspace where humans and agents share rooms

## Configure Applications

### Buzz

```sh
# Confirm cloudnative-pg from the core stack is installed
pulumi config set cloudnative-pg:enabled true

pulumi config set buzz:enabled true
pulumi config set buzz:ownerPubkey <64-char-hex>
pulumi config set buzz:relayPrivateKey "$(openssl rand -hex 32)" --secret
pulumi config set buzz:gitHookHmacSecret "$(openssl rand -hex 32)" --secret
pulumi config set buzz:s3/accessKey <access-key> --secret
pulumi config set buzz:s3/secretKey <secret-key> --secret

pulumi up
```

See [buzz.md](./components/buzz/buzz.md) for the object-store setup, the first
session and what to back up.
