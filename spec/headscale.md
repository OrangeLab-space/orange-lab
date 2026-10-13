# Headscale — operating notes

Agent-facing reference for the `headscale` component and its companions. For
user-facing setup and configuration, see
[`components/network/headscale/headscale.md`](../components/network/headscale/headscale.md).
For moving an existing cluster, see
[`docs/headscale-migration.md`](../docs/headscale-migration.md).

Everything here is written to be true across installations. It contains no
site-specific addresses, hostnames, or topology — read those from `pulumi config`
and the cluster, not from this file.

## What Headscale is, and is not

A **control plane** for a Tailscale-compatible mesh. It hands out node
addresses, keys, and policy, and it brokers connections. It is *not* a data
path and *not* a routing provider — no traffic is forwarded through it.

**It has no service-exposure equivalent.** Tailscale's `serve` and `funnel` are
provided by the Tailscale operator's `Proxy` CRs. Headscale has no operator and
no such CR. Confirm before assuming a Headscale deployment can serve anything
itself: check whether the deployment's routing provider actually needs one
(`routingProvider: tailscale` does; `traefik` does not). Several third-party
Headscale operators exist and none of them add service exposure — they cover
control-plane lifecycle only.

## Invariants

Things that will fail loudly and non-obviously if changed.

**`headscale:baseDomain` is required and must not contain the server URL.**
Headscale refuses to start otherwise:

```
configuration error: server_url cannot be part of base_domain in a way that
could make the DERP and headscale server unreachable
```

The rule (`isSafeServerURL`) is that the server hostname must not be a *suffix*
of `base_domain`; it compares labels right-aligned, so a bare apex fails. A
dedicated subdomain of the apex is the shape that works.

This is a **`configtest` failure, not a runtime one** — it would otherwise
surface as a crashloop on first deploy. Always validate generated config with
the vendor's own validator before deploying:

```sh
kubectl exec -n headscale deploy/headscale -- headscale configtest -c /etc/headscale/config.yaml
```

**`headscale:network/public` must be `true`.** Clients completing an OIDC
redirect leave the LAN. An unreachable issuer produces a login button that
cannot work while the control plane itself answers, so this failure looks like
the app being broken rather than the provider being unreachable.

**`override_local_dns` must stay `false`.** Overriding it points cluster nodes
at public resolvers and breaks internal name resolution cluster-wide.

**`trusted_proxies` must cover the cluster CIDR**, or every client is logged
with the proxy's address rather than its own.

**The volume is irreplaceable.** Two files on it cannot be regenerated:
the noise key (its loss forces every node to re-authenticate) and the database
(loss of all users, nodes, and pre-auth keys). Treat it like any other
application volume and include it in backups.

**Pin the control plane with `headscale:requiredNodeLabel`.** The component
takes a node selector, and the volume follows the pod. Without a pin the pod
lands wherever the scheduler puts it, which may be a node you are about to take
offline. Note the trade: pinning means the control plane cannot be recovered
from the node it is pinned to, so make sure that node is the most stable one
available.

## Configuration that shapes generated config

```yaml
headscale:enabled: false
headscale:image: headscale/headscale:<version>
headscale:hostname: headscale
headscale:baseDomain: vpn.internal      # default, see below
headscale:storageSize: 1Gi
headscale:network/public: true
headscale:requiredNodeLabel: kubernetes.io/hostname=<node>
headscale:auth: pocket                   # optional
headscale:auth/allowedGroups:            # deliberately absent
```

**Defaults are not inert.** `config.get` falls back to `Pulumi.yaml`, so a
default on `auth/allowedGroups` silently restricts sign-in even though it looks
like documentation. Leave access-restricting keys absent rather than defaulted,
unless the component guards an admin surface that genuinely warrants one.

**`baseDomain` defaults to `vpn.internal`, and must stay outside
`customDomain`.** The mesh namespace and the app namespace have to be disjoint.
When `baseDomain` sits *inside* the app domain — `vpn.orangelab.space` under a
`*.orangelab.space` wildcard — that one wildcard answers for every node name and
every pod DNS lookup, because kubelet resolves short names against the search
domain first (`options ndots:5`). Symptoms are silent: `ssh` lands on the
address the wildcard returns, and pods resolve public names to an internal
load balancer. `vpn.internal` is reserved for private use by RFC 8375, is never
delegated in public DNS, and so cannot collide with any wildcard.

## Operating

The gRPC admin API is deliberately not exposed outside the cluster. Use the
wrapper, which execs into the pod:

```sh
./components/network/headscale/exec-headscale.sh nodes list
./components/network/headscale/exec-headscale.sh users list
./components/network/headscale/exec-headscale.sh preauthkeys create --user <id> --reusable
```

**The image is distroless.** No `sh`, `ls`, or `wget`. Invoke the binary
directly. Any helper that pipes through a shell will fail.

**`preauthkeys create --user` takes a numeric ID, not a username**, and fails
with a strconv parse error that explains neither the cause nor the fix. Users
are created only on first OIDC login, so *someone must have signed in through a
browser* before any key can be minted. A fresh deployment cannot mint a key.

**`preauthkeys expire` takes `--id`**, not `--prefix`, despite the key listing
displaying prefixes.

**The image entrypoint is the binary itself**, so `serve` is an *argument*
(`commandArgs`), not a command. Setting `command` overwrites the entrypoint and
yields `executable file not found`.

**API keys** (`headscale apikeys create`) are what an admin UI needs, not nodes.
They are separate from pre-auth keys.

## Identity

**OIDC users are created by the provider on first sign-in.** There is no
provisioning step and no sync. Tailnet membership is therefore exactly the
provider's membership — which is why `<app>:auth/allowedGroups` is the only
control over who may join.

**Local users exist nowhere else** in a deployment and are not group-filtered.
They live only in the database, so they are lost with it.

**Users are keyed on `iss` + `sub`.** Switching identity providers locks
existing users out until `provider_identifier` is corrected in the database.
Treat an identity-provider change as a migration.

**The client secret is read from a file, not the config document** (`client_secret_path`),
which keeps it in a Secret rather than a ConfigMap. The library's
`addConfigVolume` projects regular and secret files into one directory, so this
needs no library support.

**WebFinger.** Providers that verify domain ownership by fetching WebFinger at
the apex need an apex that answers `/.well-known/webfinger` with an issuer that
matches the provider's discovery document *exactly*. The apex component derives
that issuer from the security stack's exported provider base URL rather than
taking it as configuration, so the two cannot drift.

## An admin UI

A web UI for this API is a separate component. Two constraints are worth knowing
before adding one:

- **It needs a Headscale API key**, minted out of band and stored as a secret.
  The key is long-lived and is an input, not something the component manages.
- **It must be mesh-only.** It can re-issue node credentials and read keys.

**Give it its own hostname, and serve it under a path prefix.** Served under
another component's hostname it inherits that name's reachability — and names
carrying an explicit WAN-IP record are reached through the public gateway *even
from inside the mesh*, because the name points outward. Being on the mesh does
not make a publicly-resolved name private.

Where the upstream app supports only one prefix, that prefix is not negotiable
and the generated `base_url` must match the route exactly, or the OIDC redirect
mismatch appears only at sign-in.

## Relaying

The embedded DERP relay is **off by default** (`derp/enabled`). It needs no port
of its own: the relay is mounted at `/derp` on the same listener as the control
plane, and it advertises this instance's own hostname and port, so clients reach
it through the routing provider like any other app. `derp.server.ipv4`/`ipv6` are
*additive* addresses for when DNS is broken, not the primary target — so a busy
`443/tcp` does not block it.

The one thing it does need is `3478/udp`, forwarded to the node, because STUN is
raw UDP that no reverse proxy carries. Headscale refuses to start without it
whenever the relay is enabled, so the component always emits `stun_listen_addr`
alongside `enabled: true`.

Two things worth being precise about: the relay carries only opaque,
end-to-end-encrypted WireGuard packets between two of your own nodes, so
authentication and policy never leave the cluster — what is exposed is node
addresses and topology, as connection metadata. And it has no redundancy, so
enabling it trades a third-party dependency for a single point of failure. The
public map stays loaded as a fallback for exactly that reason; do not clear
`derp.urls` at the same time.

The embedded server cannot serve the captive-portal check; it has no
`/generate_204` on port 80.

### Diagnosing a relay that is measured but never used

Work outside-in; each step rules out a layer. Clients report the symptom
precisely — the relay appears in `netcheck` with a good latency and is still
never selected.

1. **`tailscale debug derp-map`** — is `RegionID` non-zero? `0` means "no region"
   and is the single most common cause. Clients then report
   `Nearest DERP: [none]` while still listing the region's latency, which reads
   like a network fault but is not one.
2. **`tailscale netcheck`** — is `UDP: true`? If false, no UDP reaches the client
   at all and region choice is irrelevant.
3. **`kubectl get pod -n kube-system -o wide | grep svclb-headscale`** — the
   ServiceLB pod holds the STUN `hostPort` and only runs on nodes labelled
   `svccontroller.k3s.cattle.io/enablelb=true`. If the router forward targets a
   different node, the forward lands on nothing. Check the label on the node the
   forward points at, not just that the label exists somewhere.
4. Only then look at the router.

Two traps, both of which cost real time here:

- **A generic STUN probe proves nothing.** Headscale's embedded STUN server only
  answers requests carrying Tailscale's `SOFTWARE` and `FINGERPRINT` attributes;
  everything else is dropped without a reply. A hand-rolled probe times out
  against a perfectly healthy relay. Use `tailscale netcheck`, or a probe that
  signs itself as Tailscale.
- **`stun server started` is not evidence the listener works.** It logs at bind
  time, before any request is served. Never conclude the listener is dead from
  log absence, and never conclude it is alive from that line alone.

`3478/tcp` returning *refused* while `3478/udp` times out is the expected
signature of a correct forward with no UDP listener behind it — the TCP RST is
active rejection, so the packet is arriving. It is not evidence the forward is
missing.

## Migration constraints

A node belongs to exactly one control plane and the two overlays do not bridge.
Moving a node is a destructive cutover, not a trial, and the full procedure plus
its ordering constraints are in
[`docs/headscale-migration.md`](../docs/headscale-migration.md). The constraints
that most often shape planning:

- **The control plane moves first**, because every agent's `--server` points at
  it.
- **Addresses are not preserved.** There is no pre-assignment; the allocator is
  sequential. Repoint DNS instead of planning around address preservation.
- **DNS is the last step**, once every node has moved. A node still on the old
  control plane cannot reach the new address.
- **MagicDNS resolves host names only.** It never resolved service hostnames, so
  it is not a fallback for them.

## Failure modes seen in practice

**A stale node address breaks the cluster, not just the node.** With a
`--node-ip` that no longer resolves, the networking layer stops programming the
node, so pod-to-ClusterIP traffic times out and storage cannot attach volumes.
Workloads that depend on the control plane then cannot start — including the
control plane itself, which the node needs in order to rejoin. The service
manager reports the process as active throughout. **Verify with `kubectl get
nodes` and a real pod request, never with a process check.**

**The control plane can be its own recovery problem.** If it is pinned to a node
that has gone away, bringing it back means bringing that node back, not
debugging the control plane.

**A node's LAN address cannot be discovered from inside the cluster.** Kubelet
reports the mesh address as `InternalIP`, host-network pods inherit the same,
and the storage layer has no address field. If a node is unreachable, its LAN
address has to come from the machine itself or from a DHCP lease list, captured
*in advance*.

**A wildcard DNS record is a single point of silent failure.** If it points at a
node's address, every hostname under it fails at once when that address changes,
with no obvious cause and no useful error.

**In-cluster registries can depend on names that resolve outside the cluster.**
Where a registry mirror is addressed by a public name, image pulls break the
moment that name stops resolving to a live address — a hidden dependency created
by DNS rather than by the network.

**Substring matching on node state is unsafe.** A filter matching `Ready` also
matches `NotReady`. Match the exact value.

**An empty query result with a zero exit code is not evidence of absence.** It
usually means the object did not exist at the moment you asked. Establish the
control case before believing an empty result.
