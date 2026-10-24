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
# Required only with network/public=true; 8333/tcp must reach the node through your router or VPS proxy.
pulumi config set bitcoin-knots:externalip <public-ip>
# Increase number of peer connections (default 20)
pulumi config set bitcoin-knots:maxconnections 50
# Note: Pruned nodes are incompatible with Electrs and Mempool
pulumi config set bitcoin-knots:prune 1000  # Prune mode (MB), 0 for full node with txindex

# Rebuild the block index and chain state on the next deployment
pulumi config set bitcoin-knots:commandArgs "bitcoind -datadir=/data -reindex"

pulumi up
```

## P2P exposure

`listen=true` is the default: the node accepts inbound P2P. Electrs and Mempool
need it. Clearnet, Tor and I2P can be combined; the main cases are:

| Case                 | Settings                                                                                | Result                                               |
| -------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Clearnet private     | default                                                                                 | Clearnet sync; private P2P LB; no anonymity network. |
| Clearnet public      | `network/public=true`, `externalip=<public-ip>`                                         | Public P2P on `18333`; no anonymity network.         |
| Clearnet + Tor       | `network/public=true`, `network/tor=true`, `externalip=<public-ip>`                     | Public clearnet + onion.                             |
| Clearnet + I2P       | `network/public=true`, `network/i2p=true`, `externalip=<public-ip>`                     | Public clearnet + I2P.                               |
| Clearnet + Tor + I2P | `network/public=true`, `network/tor=true`, `network/i2p=true`, `externalip=<public-ip>` | Public clearnet + onion + I2P.                       |
| Tor-only             | `network/tor=true`, `runAsUser=<uid>`                                                   | Onion inbound/outbound; no P2P LB.                   |
| I2P-only             | `network/i2p=true`                                                                      | I2P inbound/outbound; no P2P LB.                     |
| Tor + I2P            | `network/tor=true`, `network/i2p=true`, `runAsUser=<uid>`                               | Onion + I2P inbound/outbound; no P2P LB.             |

All rows assume `listen=true`. Without `network/public=true`, automatic
outbound is restricted to the enabled anonymity networks; with neither
enabled, it remains clearnet.

`externalip` is required only with `network/public=true`, and must be a
clearnet IPv4/IPv6 address. It is ignored otherwise. The onion and I2P
addresses are added automatically; never set `externalip` to either.

For the public cases, forward `WAN 8333/tcp` to a ServiceLB node on `18333`. See
[Public services](../../../../docs/public-services.md#tcp-and-udp-ports) for
the forwarding details and the VPS alternative. With a VPS proxy, add
`--tcp-forward 8333=bitcoin-p2p=<node-tailnet-ip>:18333` for each node and open
`8333/tcp` with the proxy firewall phase. Set `externalip` to the VPS address
only after that path is verified.

### Tor-only

Tor-only assumes the node already synced on clearnet and has onion peers in
`peers.dat`. With `onlynet=onion`, Bitcoin disables DNS seeding because the
built-in seeds are clearnet, so a fresh node cannot bootstrap in Tor-only mode.

Recommended sequence:

1. Sync on clearnet (the default private case).
2. Switch to Tor-only:

```sh
pulumi config set bitcoin-knots:listen true
pulumi config set bitcoin-knots:network/public false
pulumi config set bitcoin-knots:network/tor true
# Use the UID that owns /data and keep volumeOwnerUserId in sync.
pulumi config set bitcoin-knots:runAsUser 999
pulumi config set bitcoin-knots:volumeOwnerUserId 999
pulumi up
```

With `network/tor=true`, the node creates an onion service for P2P
(`listenonion=1`), sends outbound traffic through `proxy=127.0.0.1:9050`, and
restricts automatic outbound connections to `.onion` peers with
`onlynet=onion`. The P2P port stays on the ClusterIP for Electrs, without a
LoadBalancer.

Read the onion address after the first Tor deployment:

```sh
cd stacks/bitcoin
./scripts/bitcoin-cli.sh getnetworkinfo
```

The address is in `localaddresses`. Bitcoin stores the private key in
`/data/onion_v3_private_key`; back up `/data` to keep the same address.

`runAsUser` is required with `network/tor=true`: Bitcoin and the Tor sidecar
must share the UID so Bitcoin can read the Tor control cookie. Use the same UID
as `volumeOwnerUserId`. If `/data` is already owned by another UID, use that
UID or set `fixVolumePermissions: '-R'` for the first deployment so the volume
is chowned recursively.

`listen=false` is an advanced outbound-only override. It cannot be combined
with `network/tor=true` and is incompatible with Electrs/Mempool.

### I2P

Bitcoin's I2P support uses the `i2pd` sidecar and SAM:

```sh
pulumi config set bitcoin-knots:network/i2p true
pulumi up
```

With `network/i2p=true`, the node connects to `i2psam=127.0.0.1:7656`.
`listen=true` enables inbound I2P (`i2pacceptincoming=1`). When
`network/public=false`, automatic outbound is restricted to I2P
(`onlynet=i2p`) and the P2P port stays on the ClusterIP for Electrs; with
`network/public=true`, clearnet and I2P are both used.

Read the I2P address after the first deployment:

```sh
cd stacks/bitcoin
./scripts/bitcoin-cli.sh getnetworkinfo
```

The address is in `localaddresses`, ends in `.b32.i2p`, and uses port `0`.
Bitcoin stores the persistent key in `/data/i2p_private_key`; back up `/data`
to keep the same address. I2P has no DNS seeds, so a fresh I2P-only node needs
known I2P peers or a clearnet sync first.

`listen=false` disables inbound I2P (`i2pacceptincoming=0`) and uses a
transient I2P address; it is incompatible with Electrs/Mempool. `runAsUser` is
not required for I2P; it is required only when Tor is also enabled.

i2pd participates in I2P transit traffic by default. See the
[i2pd configuration docs](https://docs.i2pd.website/en/latest/user-guide/configuration/)
to limit bandwidth or transit tunnels.

To run Tor and I2P together, set both toggles. Bitcoin then uses
`onlynet=onion` and `onlynet=i2p` when clearnet is private.

### Tor image

The sidecar uses `orangelab:tor/image` from `Pulumi.yaml`. Override it for the
stack, or per node:

```sh
pulumi config set orangelab:tor/image docker.io/dockurr/tor:0.4.9.14
# or
pulumi config set bitcoin-knots:tor/image docker.io/dockurr/tor:0.4.9.14
```

### I2P image

The sidecar uses `orangelab:i2p/image` from `Pulumi.yaml`. Override it for the
stack, or per node:

```sh
pulumi config set orangelab:i2p/image docker.io/purplei2p/i2pd:release-3.0.0.1
# or
pulumi config set bitcoin-knots:i2p/image docker.io/purplei2p/i2pd:release-3.0.0.1
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
