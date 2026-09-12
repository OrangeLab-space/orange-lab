# Bitcoin Knots

|              |                                                                             |
| ------------ | --------------------------------------------------------------------------- |
| Homepage     | https://bitcoinknots.org/                                                   |
| Docker image | https://github.com/Retropex/docker-bitcoind-prebuilt                        |
| Dockerfile   | https://github.com/Retropex/docker-bitcoind-prebuilt/blob/master/Dockerfile |

Bitcoin Knots is an alternative node implementation based on Bitcoin Core with a focus on stability and customisation. The node uses persistent volume storage mounted at `/data`.

```sh
pulumi config set bitcoin-knots:enabled true

# (Recommended) Lock version
pulumi config set bitcoin-knots:image ghcr.io/retropex/bitcoin:29.3.knots20260507
# (Recommended) Add hash to make sure the image wasn't modified
HASH=skopeo inspect docker://ghcr.io/retropex/bitcoin:29.3.knots20260507 | jq .Digest
pulumi config set bitcoin-knots:image ghcr.io/retropex/bitcoin:29.3.knots20260507@sha256:$HASH

# Optional configuration
pulumi config set bitcoin-knots:commandArgs "bitcoind -datadir=/data"
# Set to external IP of your router. Port forwarding needs to be setup for port 8333
pulumi config set bitcoin-knots:externalip <public-ip>
# Increase number of peer connections (default 20)
pulumi config set bitcoin-knots:maxconnections 50
# Note: Pruned nodes are incompatible with Electrs and Mempool
pulumi config set bitcoin-knots:prune 1000  # Prune mode (MB), 0 for full node with txindex

# Rebuild the block index and chain state on the next deployment
pulumi config set bitcoin-knots:commandArgs "bitcoind -datadir=/data -reindex"

pulumi up
```

## Custom images

By default `ghcr.io/retropex/bitcoin:29.3.knots20260507` images are used. You can other docker images as well.

Images can use different users for its operations. You can use `runAsUser: 999` to avoid root permissions in the container and `volumeOwnerUserId: 999` to fix volume permissions by running `chown 1000:1000 /data` before start. Ownership is fixed without recursion for speed; set `fixVolumePermissions` to `-R` (or `-Rv` for verbose output) when reusing existing data with wrong owners.

### bitcoinknots/bitcoin

`bitcoinknots/bitcoin` image has a hardcoded ENTRYPOINT that uses `/var/lib/bitcoind` and `/etc/bitcoin/bitcoin.conf`, so you need to override the command and set the container user:

```sh
# set custom image location
pulumi config set bitcoin-knots:image bitcoinknots/bitcoin:29.3.knots20260507

# override the hardcoded ENTRYPOINT to use /data
pulumi config set bitcoin-knots:command bitcoind
pulumi config set bitcoin-knots:commandArgs "-datadir=/data"

# the image runs as UID 1000; unlike btcpayserver/bitcoinknots it does not start as root and fix permissions automatically
# set both values to the same UID so the container can read and write /data
pulumi config set bitcoin-knots:runAsUser 1000
pulumi config set bitcoin-knots:volumeOwnerUserId 1000

# (Optional) add all debug logging, use debugexclude to exclude categories
pulumi config set bitcoin-knots:debug 'true'
pulumi config set bitcoin-knots:debugexclude ''
```
