# Bitcoin Stack

Components related to Bitcoin network nodes and related services.

**Prerequisite**: Core stack must be deployed first (network, storage).

## Components

- [Alby Hub](./components/albyhub/albyhub.md) - Self-custodial Lightning wallet with an embedded LDK node.
- [Bitcoin Knots](./components/bitcoin-knots/bitcoin-knots.md) - A conservative fork of Bitcoin Core focused on stability and improvements.
- [Bitcoin Core](./components/bitcoin-core/bitcoin-core.md) - The reference implementation of the Bitcoin protocol.
- [Electrs](./components/electrs/electrs.md) - Efficient Electrum Server implementation for wallet synchronization.
- [Mempool](./components/mempool/mempool.md) - Full-stack block explorer and visualization tool.

## Migrate from Root Stack

If Bitcoin components were previously deployed in the root stack, migrate their settings before deploying in this stack.

Plain values can just be copied from `Pulumi.<stack>.yaml` to `stacks/bitcoin/Pulumi.<stack>.yaml`.

Secrets use different encryption keys so the values have to be exported first.

Get plaintext values from the root stack:

```sh
# copy all settings from: bitcoin-core,bitcoin-knots,electrs,mempool

# export secrets
pulumi config get --secret mempool:db/rootPassword
```

Then set them in the bitcoin stack:

```sh
cd stacks/bitcoin
# copy all settings from root stack

# set secrets with new stack encryption key
pulumi config set --secret mempool:db/rootPassword <value>
```
