# Bitcoin Core

|              |                                                                                                |
| ------------ | ---------------------------------------------------------------------------------------------- |
| Homepage     | https://bitcoincore.org/                                                                       |
| Docker image | https://hub.docker.com/r/btcpayserver/bitcoin                                                  |
| Dockerfile   | https://github.com/btcpayserver/dockerfile-deps/blob/master/Bitcoin/29.2/linuxamd64.Dockerfile |

Bitcoin Core is the reference implementation of the Bitcoin protocol. The node uses persistent volume storage mounted at `/data`.

```sh
pulumi config set bitcoin-core:enabled true

# (Recommended) Lock version
pulumi config set bitcoin-core:image btcpayserver/bitcoin:29.2

# Optional configuration
pulumi config set bitcoin-core:commandArgs "bitcoind -datadir=/data -maxuploadtarget=500"
# Set to external IP of your router. Port forwarding needs to be setup for port 8333
pulumi config set bitcoin-core:externalip <public-ip>
# Increase number of peer connections (default 20)
pulumi config set bitcoin-core:maxconnections 50
# Note: Pruned nodes are incompatible with Electrs and Mempool
pulumi config set bitcoin-core:prune 1000  # Prune mode (MB), 0 for full node with txindex

# Rebuild the block index and chain state on the next deployment
pulumi config set bitcoin-core:commandArgs "bitcoind -datadir=/data -reindex"

pulumi up
```

## Custom images

By default `btcpayserver/bitcoin` images are used. You can use custom docker images as well.

Images can use different users for its operations. You can add `runAsUser: 999` to avoid root permissions in the container and `volumeOwnerUserId: 999` to fix volume permissions by running `chown 1000:1000 /data` before start. Ownership is fixed without recursion for speed; set `fixVolumePermissions` to `-R` (or `-Rv` for verbose output) when reusing existing data with wrong owners.

### bitcoin/bitcoin

`bitcoin/bitcoin` runs as UID 1000. Set both values to the same UID so the container can read and write `/data`:

```sh
# set custom image location
pulumi config set bitcoin-core:image bitcoin/bitcoin:29.2

pulumi config set bitcoin-core:runAsUser 1000
pulumi config set bitcoin-core:volumeOwnerUserId 1000

# optional: override the command if the image has a non-standard ENTRYPOINT
# pulumi config set bitcoin-core:command bitcoind
```
