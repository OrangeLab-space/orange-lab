# Alby Hub

|              |                                                   |
| ------------ | ------------------------------------------------- |
| Homepage     | https://albyhub.com                               |
| Source code  | https://github.com/getAlby/hub                    |
| Docker image | https://github.com/getAlby/hub/pkgs/container/hub |

Alby Hub is a self-custodial Lightning wallet with an embedded LDK node. Apps
connect to it over [NWC](https://nwc.dev/) and it keeps the wallet, channel
state and node data in SQLite on the `albyhub` volume (`WORK_DIR=/data/albyhub`).

## Prerequisites

Requires a Bitcoin node ([`bitcoin-core`](../bitcoin-core/bitcoin-core.md) or
[`bitcoin-knots`](../bitcoin-knots/bitcoin-knots.md)) and
[`electrs`](../electrs/electrs.md). LDK uses Electrs as its chain source and
indexes against it, so enable Electrs first and let it finish indexing.

Alby Hub keeps its data on the `albyhub` Longhorn volume, mounted at `/data`. The
volume is created dynamically by default. For a production wallet, create a
static volume named `albyhub` and attach it, so the data survives
disable/enable cycles:

```sh
pulumi config set albyhub:fromVolume albyhub
```

## Basic configuration

```sh
pulumi config set albyhub:enabled true

# Lock version
pulumi config set albyhub:image ghcr.io/getalby/hub:v1.24.4

# Optional
pulumi config set albyhub:storageSize 5Gi

pulumi up
```

Open `https://albyhub/` and set the unlock password on first run. It protects the
seed and is required after every restart, so keep it somewhere safe — losing it
means losing access to the wallet.

By default the node is private: the UI is reachable on the tailnet and Lightning
port `9735` is not published. Outbound channels and payments work as usual.

To accept inbound channels, and announce the node so others can route to it,
publish the Lightning port. Only `9735` has `exposure: 'public'` — the UI port
stays private, so `network/public` never exposes the wallet:

```sh
pulumi config set albyhub:network/public true
pulumi config set albyhub:LDK_ANNOUNCEMENT_ADDRESSES <public-ip>:9735
pulumi up
```

Forward WAN `9735` to the node's `19735` (`port + 10000`, see
[Public services](../../../../docs/public-services.md#tcp-and-udp-ports)). This
requires the Traefik routing provider; Tailscale Funnel is HTTPS-only and does
not publish raw TCP.

## Lightning address

The Hub does not serve a lightning address itself. Linking an Alby account adds
`<user>@getalby.com`, hosted by Alby. A custom-domain address needs a separate
LNURL-pay server on that domain that creates invoices on the Hub through NWC:

- [Thor](https://github.com/yfaming/thor) — Rust + NWC, config file, no database
  (no official image).
- [LNbits](https://lnbits.com) — NWC funding source and LNURLp extension.
- [BTCPay Server](https://btcpayserver.org) — NWC through its Nostr plugin.

`/.well-known/lnurlp/<name>` is dynamic — it returns a callback that creates an
invoice per payment — so it cannot be served as a static file. NWC communicates
over a Nostr relay; use one you control to avoid a public dependency. Receiving
still needs inbound liquidity, like any other receive path.

## Single sign-on (Pocket ID)

Alby Hub has no native OIDC. Setting `albyhub:auth pocket` protects the route
with the shared Traefik OIDC middleware, so only allowed Pocket ID users reach
the UI. The app still asks for its own unlock password. This requires the
**Traefik** routing provider; with Tailscale the deploy fails instead of leaving
the wallet unprotected.

Deploy once so the endpoint exists, then from `stacks/bitcoin`:

```sh
pulumi config set albyhub:auth/allowedGroups admin,albyhub-users
./components/albyhub/pocket-albyhub.sh
# apply the clientId/clientSecret commands printed by the script, then:
pulumi config set albyhub:auth pocket
pulumi up
```

The groups must already exist in Pocket ID. Without `albyhub:auth` the script
only registers a launcher tile in Pocket ID's App Dashboard and the UI stays
reachable by anyone who can open its URL.
