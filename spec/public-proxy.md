# Public proxy on a VPS — operating notes

Agent-facing reference for [`docs/public-proxy.md`](../docs/public-proxy.md)
and the `expose-via-vps` skill. Written to be true across installations; read
site-specific values from `pulumi config`, the cluster, and the user.

## What it is

A VPS **outside the cluster** joins the same tailnet as the cluster and
forwards public HTTP(S) traffic to Traefik's public gateway on `10443`, routed
by TLS SNI. It can also forward explicitly configured raw TCP ports to a
cluster ServiceLB. The tailnet can use self-hosted Headscale or Tailscale SaaS.
HAProxy does not terminate TLS, hold certificates, or know about applications.

```
Internet → VPS HAProxy :80/:443 → tailnet → Traefik public gateway :10443 → app
Internet → VPS HAProxy :<tcp>  → tailnet → ServiceLB node :<port + 10000> → app
```

This is the alternative to forwarding WAN `443` to a node on the user's router.
Public DNS points at the VPS, so the home IP is not published and the provider
can be changed with DNS alone.

## Control plane

**One tailnet, one control plane.** The VPS and every cluster node that serves
the Traefik public gateway must be members of the same Headscale or Tailscale
tailnet. A VPS on Tailscale cannot reach cluster nodes on Headscale, and the
reverse is also true. Do not mix the two in one proxy path.

| Area               | Headscale                                             | Tailscale                                        |
| ------------------ | ----------------------------------------------------- | ------------------------------------------------ |
| Auth key           | `preauthkeys create`, tags-only by default            | Admin console or API auth key                    |
| Tags               | `tag:proxy`; no `tagOwners` required for a tagged PAK | Every selected tag must exist in `tagOwners`     |
| Join               | `--login-server https://headscale...`                 | Default Tailscale control plane                  |
| Exit-node approval | `headscale nodes approve-routes`                      | Admin console; ACL grant to `autogroup:internet` |
| Control path       | Public `headscale` hostname and optional home pin     | Tailscale SaaS; no pin or home bootstrap         |

The scripts under `scripts/public-proxy/` are shared. Only the key, join,
approval, control-path, and optional Headscale control DNS record differ.

## Invariants

**TLS is passthrough.** Do not terminate at the proxy and do not copy
certificates or a DNS API token to it. The client must see the cluster's
wildcard certificate; that is what makes the VPS disposable.

**The apex stays on Caddy in the cluster.** HAProxy forwards the apex SNI to
Traefik, which routes to Caddy. Caddy keeps serving `/.well-known/webfinger`
and future `.well-known` files. Do not move the apex or `.well-known` to the
VPS. The proxy does not bypass the public gateway: if the apex is not a public
route (`caddy:network/public true`), it stays private and the public listener
returns `404`.

**Unknown SNI is rejected.** The default backend has no servers. Never add a
catch-all backend; an accidental one turns the VPS into an open TLS proxy.
The ACL deliberately admits every subdomain of the configured domain; those
are forwarded to Traefik, which returns `404` unless the hostname has a public
route. Rejection applies to names **outside** the domain.

**Raw TCP is explicit and port-scoped.** A raw TCP frontend is added only with
`--tcp-forward <listen-port>=<name>=<addr:port>` and is admitted by port, not
hostname. There is no catch-all TCP listener. Cluster-side, a port marked
`public` is published at `<port> + 10000`; the proxy targets that offset. Open
the listener with `--tcp-port` and in the provider firewall. Never forward a
database, RPC, admin, or metrics port. TCP passthrough has no SNI, certificate,
or host-based policy.

**Two layers decide public access.** HAProxy admits the domain (apex plus
subdomains). Traefik's public gateway still only admits routes from namespaces
labelled `orangelab.space/public`. Keep both; do not widen the Traefik gateway
to compensate for an HAProxy ACL mistake.

**No plain DNS/53.** If Technitium is used as a resolver, the encrypted path is
DoT (`853/tcp`) or DoH. If it is authoritative for a public zone, public `53`
is required by delegation and is a separate design with rate limiting and DDoS
protection. Never expose an open recursive resolver.

**Stats and admin stay on localhost.** HAProxy stats bind `127.0.0.1:8404`.
The stats page is `/stats`; the root path may return `503` and is not a health
check. The admin socket is local. Neither is public.

**The VPS holds no cluster credentials.** No kubeconfig, no Pulumi state, no
DNS tokens, no certificates. The only tailnet credential is the node key in
`/var/lib/tailscale/tailscaled.state`.

**Tailnet addresses are pinned in HAProxy.** Server lines are static; HAProxy
does not re-resolve them on every connection. If a node rejoins with a new
tailnet address, update the config and reload. `kubectl get nodes -o wide`
reports the tailnet address as `InternalIP`.

**IPv6 is optional and provider-gated.** IPv4 is the default. Do not enable
dual-stack, publish AAAA records, or approve `::/0` unless the VPS has a public
IPv6 address and default route and the user opts in. When enabled,
`configure-haproxy.sh --ipv6` binds `[::]:80`/`[::]:443` and any configured TCP
listeners with `v4v6`; the tailnet upstreams can stay IPv4, so no Traefik change
is needed. Without IPv6, keep the binds IPv4 only and remove stale AAAA records.

**Exit-node routes are approved in the control plane.** `tailscale set
--advertise-exit-node` only advertises. Until an administrator approves
`0.0.0.0/0`, clients cannot use IPv4 exit-node traffic. Approve `::/0` only when
the VPS has working public IPv6 and `exit-node.sh --ipv6` was used; Tailscale
may advertise `::/0` even when IPv6 forwarding is off.

- **Headscale:** approve with `nodes approve-routes`; check
  `nodes list-routes`.
- **Tailscale:** allow the machine as an exit node in the admin console. If a
  custom policy is active, add a grant to `autogroup:internet`; granting access
  to the proxy device itself is not enough.

**Node names are user-chosen.** Always ask; default `proxy`, or
`proxy-<location>` if there are several proxies. This is the control-plane name
used for `ssh <user>@proxy` over the tailnet and the name clients show in the
exit-node list, not the VPS OS hostname. It is set with
`tailscale up --hostname`. Renaming is control-plane-specific: Headscale uses
`nodes rename <new> --identifier <id>`, Tailscale uses the admin console. Route
approvals are by node ID and survive the rename.

**The proxy is a tagged service node.** Use `tag:proxy` only. The node has a
tag identity, not a personal owner; Headscale shows it under `tagged-devices`.
Do not add cluster or service tags: the policy grants `tag:proxy` its own
port-scoped access, and a shared tag would widen that.

- **Headscale:** mint a tags-only pre-auth key with `--tags tag:proxy`. In the
  tested v0.29.5, this needs no `tagOwners` entry for those tags; the key
  carries its own tag authorization. Use `--user <numeric-id>` only for a
  version that cannot mint tagged keys, or when personal ownership is
  explicitly wanted.
- **Tailscale:** define `tag:proxy` in `tagOwners` first, then create a tagged
  auth key in the admin console or API. Prefer the key's tags; do not rely on
  `--advertise-tags` as a substitute.

**A Headscale policy must scope the proxy, not merely admit it.** The supplied
[`headscale-policy.hujson`](../components/network/headscale/headscale-policy.hujson)
grants `tag:proxy` only `tag:lb` on `tcp:10443`, the public `+10000` offsets, and
53 for the Technitium resolver, so the proxy cannot reach private ports on
cluster nodes. It also grants members `tcp:22` to `tag:proxy`, which is what
keeps `ssh <user>@proxy` working over the tailnet; keep that in sync with the
hardened SSH port. Add every new `--tcp-forward` upstream to the proxy grant;
otherwise the forward times out once the policy exists. Exit-node use is a
separate grant (`dst: autogroup:internet`, `via: tag:proxy`). A node re-joined
with a user key becomes personal and falls outside the proxy grant. On
Tailscale, define `tag:proxy` in `tagOwners` and add the same port-scoped grants
to the tailnet policy.

**Headscale control path must not depend on itself.** The VPS's `ControlURL`
is normally `https://headscale.<domain>`. If that hostname resolves to the VPS,
a reboot or reconnect cannot fetch the control key: Tailscale needs Headscale
to bring up the tailnet, and HAProxy needs the tailnet to reach Headscale. A
simulated cutover produced `fetch control key ... EOF` and `tailscale status`
reported logged out. Before moving the Headscale record, keep the home `443`
forward and pin the VPS's view of the hostname to the home IPv4 in `/etc/hosts`;
then public DNS can point at the VPS. Verify with `getent hosts` and a
`tailscaled` restart. If the home IP is only somewhat static, update the pin
manually when it changes. Leaving Headscale DNS at home, or using a separate
bootstrap control endpoint, is the alternative.

**Tailscale control path is external.** Tailscale SaaS is the control plane.
There is no `headscale.<domain>` record, `/etc/hosts` pin, or home `443`
bootstrap dependency. Do not copy the Headscale control-pin steps into a
Tailscale deployment.

**Home fallback is manual.** If the VPS fails, move the affected A/AAAA records
back to the home addresses, wait for the 300-second TTL, and verify from
outside. Raw TCP forwards do not follow DNS: move the public listener and any
advertised external address (for example Bitcoin's `externalip`) back too. A second proxy is a valid fallback only if it already has its own
independent control path. With Headscale, also keep the home `443` forward
while its control hostname points at the VPS and update the `/etc/hosts` pin if
the home IP changes. With Tailscale, the control path is independent of the
home IP, but the home `443` forward is still needed if home is the manual DNS
fallback.

**A stale control pin is the Headscale home-IP failure mode.** An existing
tailnet connection may keep serving traffic after the home IP changes, but the
next `tailscaled` reconnect, reboot, or Headscale restart fails against the old
address, and HAProxy then has no upstream. Edit the marked `/etc/hosts` line to
the new home IPv4 (do not append a duplicate), verify with `getent hosts`, and
restart `tailscaled`. If the VPS is down, switch DNS home first; if it is up but
logged out, public SSH or the provider console is the recovery path. Before
DNS cutover, the public A/AAAA records also still point home and must be
updated.

**DNS cutover is the user's step.** Verify the proxy with `--resolve` first.
Never change DNS as part of installing the proxy.

An IPv4 A-record cutover does not depend on external IPv6 verification. If the
VPS has IPv6 configured but the external IPv6 path has not been tested, move A
records and leave AAAA records absent. Add AAAA records only after an
IPv6-capable external check passes.

## Verification

Run these before DNS cutover. The public guide keeps the short path; this is the
full matrix for diagnosing a failure.

**Local listener and upstream.** On the VPS:

```sh
# HTTP/HTTPS through the local HAProxy
# Add --ipv6 and --vps-ip6 <vps-ipv6> when dual-stack is enabled
sudo bash /tmp/public-proxy/verify.sh \
  --domain example.com \
  --host app.example.com \
  --host example.com
```

`verify.sh` checks the rendered config, HAProxy service, listeners, stats page,
HTTP redirect, HTTPS response, and certificate. On failure, check
`systemctl status haproxy` and `journalctl -u haproxy -n 50 --no-pager`. A `404`
from Traefik means the app is not public or the route has not reconciled; a
timeout means Tailscale, the ACL, a node firewall, or the upstream is wrong.

**External IPv4.** Run from a network outside both the home and the VPS:

```sh
# Expect the VPS IP, a redirect to HTTPS, and the cluster wildcard certificate
curl -sS -o /dev/null -w '%{http_code} %{remote_ip}\n' \
  --resolve app.example.com:443:<vps-ip> https://app.example.com/
curl -sSI --resolve app.example.com:80:<vps-ip> http://app.example.com/
openssl s_client -connect <vps-ip>:443 -servername app.example.com </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -ext subjectAltName
```

Expect a permanent redirect from HTTP to HTTPS, the cluster wildcard
certificate, and a `remote_ip` equal to the VPS. A name **outside** the
configured domain must be rejected. An unconfigured subdomain inside the domain
is forwarded to Traefik and gets its `404`. Traefik and the app see the VPS
tailnet IP as the client; that is the current limitation, not a fault.

**External IPv6.** Only after enabling IPv6, run from an IPv6-capable network:

```sh
curl -g -6 -sS -o /dev/null -w '%{http_code} %{remote_ip}\n' \
  --resolve app.example.com:443:[<vps-ipv6>] https://app.example.com/
openssl s_client -connect [<vps-ipv6>]:443 -servername app.example.com </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -ext subjectAltName
```

An external IPv6 check gates AAAA records only. The IPv4 A-record cutover does
not depend on it; leave AAAA absent until this passes.

**Raw TCP.** For each `--tcp-forward`, check the public listener and the
cluster-side offset:

```sh
nc -vz <vps-ip> <public-port>
ssh <proxy-user>@<vps-ip> 'nc -vz <tailnet-ip> <port+10000>'
```

HAProxy stats must show the backend `UP`, and HAProxy logs should show the
frontend and backend names. A Bitcoin node should log
`AddLocal(<vps-ip>:<public-port>,4)` when its `externalip` matches the proxy.

## OS support

The scripts are split by phase and, where needed, by distribution. There is no
dispatcher and no shared library: each phase is a standalone script.

- `ubuntu/01-install.sh`, `02-firewall.sh`, `03-updates.sh` — Ubuntu/Debian,
  tested on Ubuntu 26.04 LTS and Debian 13 Trixie Cloud Micro. `apt`, UFW,
  unattended-upgrades, the Debian/Ubuntu Tailscale repository. This is the
  baseline path.
- `fedora/01-install.sh`, `02-firewall.sh`, `03-updates.sh` — Fedora 44 (tested
  on Cloud Edition; Server expected to match). `dnf`, firewalld, SELinux, DNF
  automatic updates, the `wheel` group, and the Fedora Tailscale repository.
- `create-user.sh` — shared; defaults to root or the sudo-invoking user. Pass
  `--user <name>` to create or reuse a dedicated non-root account; `orangelab`
  is the suggested name. Do not use `proxy`: Ubuntu ships a `proxy` system user
  (uid 13, `nologin`), so a name collision must fail rather than reuse it. New
  non-root accounts get passwordless sudo; existing accounts must already be in
  the `sudo`/`wheel` group.
- `harden-ssh.sh`, `configure-haproxy.sh`, `verify.sh`, `exit-node.sh` — shared.

Ubuntu 26.04 LTS with HAProxy 3.2 was the first end-to-end validation of the
public path, including a real certificate and public-IP checks. Debian 13
Trixie Cloud Micro then passed the same flow with HAProxy 3.0, UFW, a reboot, a
dual-stack exit node and SSH hardening. Fedora 44 Cloud Edition followed with
firewalld, SELinux, DNF automatic updates and a dual-stack exit node. Debian
and Ubuntu remain the baseline.

Do not add a distribution by guessing: add a directory with the same three
phase scripts, test it on a disposable VPS, and update the docs and skill.
Other systemd distributions use the manual checklist in the user docs and the
shared scripts.

Debian specifics:

- Debian Cloud Micro may ship only root and no `curl`, `sudo` or UFW. The
  install phase supplies them; when creating a non-root account,
  `create-user.sh` copies root's `authorized_keys`, and `harden-ssh.sh` disables
  root login. With the default root account, skip `harden-ssh.sh`.
- Cloud-init may set `127.0.1.1 debian` while `hostname` is provider-generated,
  which makes every `sudo` print `unable to resolve host ...`. Set the line to
  the actual hostname; it is cosmetic but noisy.
- The UFW systemd unit is oneshot. `systemctl is-active ufw` can be `inactive`
  after boot while `ufw status` is active; use `ufw status verbose` for checks.
- `02-firewall.sh` sets `DEFAULT_FORWARD_POLICY=ACCEPT`; the exit-node script
  relies on that for forwarded IPv4/IPv6 traffic. UFW reports routed traffic as
  disabled until `exit-node.sh --ipv6` enables forwarding.
- Debian's SSH unit is `ssh`; `harden-ssh.sh` reloads it and verifies
  `sshd -T` reports root and password login disabled.

Fedora specifics:

- SELinux: `fedora/01-install.sh` enables `haproxy_connect_any`; HAProxy needs
  it to bind and connect. `configure-haproxy.sh` warns when it is off.
- HAProxy runtime directory: Fedora's unit does not create `/run/haproxy`, but
  the rendered config puts the admin/stats socket there. `01-install.sh` adds
  `/etc/systemd/system/haproxy.service.d/10-public-proxy.conf` with
  `RuntimeDirectory=haproxy`; without it HAProxy fails at boot with
  `cannot bind UNIX socket ... /run/haproxy/admin.sock`.
- Reboot detection: Fedora does not create `/var/run/reboot-required`.
  `01-install.sh` uses `dnf needs-restarting -r` (exit 1 means reboot needed)
  and prints the reboot note before the tailnet join.
- firewalld: `fedora/02-firewall.sh` removes the default public-zone `mdns` and
  `ssh` services, opens the detected SSH port, `80`, `443`, `41641/udp` and
  trusts the tailnet source ranges. Removing `ssh` matters when `--ssh-port`
  is not 22, otherwise the service keeps 22 open. `exit-node.sh` adds
  `tailscale0` to `trusted`, enables masquerade, and with `--ipv6` adds
  `rule family=ipv6 masquerade`, reloads firewalld and restarts `tailscaled`.
  Without that, firewalld's forward chain drops exit-node traffic.
- `harden-ssh.sh` runs `restorecon` on the drop-in when SELinux is enabled.
- The SSH service is `sshd`, not `ssh`; the hardening script tries both.
- Fedora 41+ uses `dnf5-plugin-automatic` / `dnf5-automatic.timer`; older
  releases use `dnf-automatic` / `dnf-automatic.timer`. Both read
  `/etc/dnf/automatic.conf`. Fedora 44 installs the dnf5 timer and starts it.

## Exit node

- Requires `net.ipv4.ip_forward=1`. IPv6 also requires
  `net.ipv6.conf.all.forwarding=1`, a public IPv6 address and default route, and
  `exit-node.sh --ipv6`; it is not enabled by default.
- **Headscale:** approve `0.0.0.0/0` with
  `headscale nodes approve-routes --identifier <id> --routes 0.0.0.0/0`
  through `components/network/headscale/exec-headscale.sh`. Add `::/0` to the
  same command only when IPv6 is enabled and tested. Check
  `headscale nodes list-routes` before and after.
- **Tailscale:** allow the node as an exit node in the admin console. With a
  custom policy, also grant `autogroup:internet`; otherwise clients cannot use
  it even though the route is advertised. The script runs `tailscale up` on
  Tailscale; for a manual setup, run it once after
  `tailscale set --advertise-exit-node`.
- Switch clients back (`tailscale set --exit-node=`) and stop advertising
  before deleting the node.
- Datacenter IPs are often blocked by streaming and banking services. An exit
  node is not a residential-IP replacement.
- All exit-node traffic counts against the VPS bandwidth quota.

## DNS cutover traps

- **TTL is cache lifetime, not a default.** If a record's current TTL is above
  300 seconds, lower it to 300 at least one old TTL before cutover. If it is
  already 300 or lower, no change is needed.
- **Stale AAAA records** send dual-stack clients to a dead path. Remove them
  unless the VPS has working IPv6. When IPv6 is enabled, add AAAA only for
  public hostnames; do not add a wildcard AAAA shared with private/tailnet names.
- **CDN/proxy mode** (for example Cloudflare orange cloud) terminates TLS and
  breaks passthrough. Use DNS-only records when that toggle exists; providers
  without a CDN/proxy feature have nothing to change.
- **Technitium caches for the full TTL.** Flush the zone there, and flush the
  local resolver. `dig` bypasses the local resolver; `curl` does not.
- **Headscale control:** keep the home `443` forward while `headscale` DNS
  points at the VPS. It is the control bootstrap. If the home path is not kept,
  leave `headscale` DNS at home or use a separate control endpoint.
- **Manual fallback:** both control planes need the home `443` forward if you
  want DNS fallback to home to keep serving. Tailscale does not need it for
  control.

## Failure modes

**HAProxy closes the connection / no server available.** The upstream is down
or unreachable: wrong tailnet address, Traefik ServiceLB not running on that node,
node firewall blocking `10443`, or the node is not on the tailnet. Confirm from
the VPS with `curl --resolve <host>:10443:<tailnet-ip> https://<host>:10443/`.

**TLS handshake fails.** The SNI ACL did not match, the upstream is not TLS on
`10443`, or the client is using a name outside the configured domain. Check
with `openssl s_client -connect <vps-ip>:443 -servername <host>`.

**`404` from Traefik.** The application is not `network/public`, the public
route has not reconciled, or the Host does not match the route. Check
`kubectl get httproute -A | grep <app>` and the namespace label.

**A name outside the domain is accepted.** The ACL is too broad. It must be the
exact apex plus a dot-suffixed suffix (`.example.com`), never a bare
`example.com` suffix match, which would also match `badexample.com`.

**HAProxy will not start.** Run `haproxy -c -f /etc/haproxy/haproxy.cfg`. Common
causes: invalid config, another process on `80`/`443`, missing `/run/haproxy`,
or the config not readable by the `haproxy` user.

**HAProxy returns 503 for a short time after boot.** HAProxy can start before
Tailscale has re-established the tailnet route. The TCP health check marks the
upstream down, then recovers with an `UP` log line. Check
`journalctl -u haproxy`; investigate only if it stays down after `tailscaled`
is running and the tailnet path works.

**IPv6 clients fail while IPv4 works.** Either the provider has no public IPv6,
HAProxy was configured without `--ipv6` (binds stay IPv4 only), the host or
cloud firewall blocks IPv6 `80`/`443`, or DNS has missing/stale AAAA records.
Check `ip -6 addr`, `ip -6 route`, `ss -ltnp`, and `curl -6`; do not add AAAA
until the IPv6 path passes. If the provider does not route IPv6, remove AAAA
records and keep IPv4 only.

**HAProxy cannot bind or connect on Fedora.** SELinux is blocking it. Check
`getenforce` and `getsebool haproxy_connect_any`; enable with
`setsebool -P haproxy_connect_any 1`. Port binding alone may work, but outbound
connections to `10443` also need the boolean.

**Exit node carries no traffic.** The route is not approved, IP forwarding is
off, the client did not select the node, or a policy blocks it. For Headscale,
check `nodes list-routes`; for Tailscale, check the admin console exit-node
setting and any `autogroup:internet` grant. Also check `tailscale status` and
the client selection. IPv6 traffic also needs `exit-node.sh --ipv6`, IPv6
forwarding, and an approved `::/0`; approving `::/0` alone does not make an
IPv4-only VPS carry IPv6.

**Exit node is missing from the client list.** The node must exist, advertise
an exit-node route, and have at least `0.0.0.0/0` approved (plus `::/0` only
when IPv6 is enabled). A deleted node or an unapproved route does not appear.
For Headscale, check `nodes list -o json` and
`available_routes`/`approved_routes`; for Tailscale, check the machine's
exit-node setting. Clients may also need to refresh their netmap.

**MOTD says `*** System restart required ***`.** `01-install.sh` upgraded the
kernel. Reboot before joining the tailnet; the install phase warns when
`/var/run/reboot-required` exists. UFW/firewalld, Tailscale and HAProxy are
enabled services and survive the reboot.

**UFW status says `disabled (routed)`.** That reflects `ip_forward=0`, not
`DEFAULT_FORWARD_POLICY`; the normal proxy path does not need forwarding.
`exit-node.sh` enables it and `--disable` turns it back off. If in doubt, check
`iptables -S FORWARD` for `-P FORWARD ACCEPT`.

**Exit node carries no traffic on Fedora.** firewalld's forward chain runs
before Tailscale's. Confirm `tailscale0` is in the `trusted` zone, masquerade is
on, and the IPv6 masquerade rule exists. Reload firewalld and restart
`tailscaled` so its nftables rules are re-added.

**sshd ignores the hardening drop-in on Fedora.** SELinux may not label the new
file. Run `restorecon -RF /etc/ssh/sshd_config.d`, then `sshd -T`; if the values
still do not change, ensure `/etc/ssh/sshd_config` includes the drop-in
directory.

**`tailscale up` prints a login URL instead of joining.** The client did not use
the pre-auth key. `sudo` may strip `TS_AUTHKEY`; write the key to a mode-600
file and pass `--auth-key file:/path`, then remove the file. A key that was
already consumed also falls back to interactive login.

**Tailscale auth key creates an untagged node.** Define every selected tag in
`tagOwners` first, then create the key with those tags. Tags on an auth key are
the reliable path; `--advertise-tags` is not a substitute for a tagged key.

**DNS still reaches the old address.** TTL, Technitium cache, local resolver,
router cache, stale AAAA, or a cached answer. Verify against the authoritative
nameserver, use `curl --resolve` for the new VPS, and wait for cached TTLs to
expire before judging normal DNS clients.

**The stats tunnel returns `503`.** Open `/stats`, not `/`, at
`http://localhost:8404/stats`. The root path is intentionally not configured.

**A forwarded TCP port is unreachable.** Confirm the port has a `--tcp-forward`
block, the cluster publishes it at `<port> + 10000`, the ServiceLB node accepts
it over the tailnet, and both UFW/firewalld and the provider firewall allow the
public port. Test the VPS listener with `nc -vz <vps-ip> <port>` from outside.
Raw TCP has no SNI fallback, so a hostname cannot select a backend.

**The VPS is logged out after the Headscale DNS cutover or a reboot.** This is
Headscale-specific. `sudo tailscale debug prefs | jq -r .ControlURL` points at
a hostname that resolves back to the VPS. `tailscaled` cannot fetch the
control key through HAProxy because the upstream tailnet is down. Restore the
`/etc/hosts` pin to the home IPv4 (or another independent control path), then
restart `tailscaled`. Rolling back public DNS alone is not enough if the VPS
still resolves the name to itself; fix the VPS resolver first. Keep the home
`443` forward, otherwise the pin has no path. Tailscale has no equivalent pin.

**DNS breaks on the VPS after joining.** The control plane's MagicDNS is
unreachable or not configured. Re-run `tailscale up` with `--accept-dns=false`,
or fix DNS in Headscale or the Tailscale admin console. HAProxy does not depend
on DNS at runtime because upstreams are pinned tailnet addresses; only package
updates and manual lookups need working resolver access.

**High latency or low throughput.** `tailscale ping <tailnet-ip>` reports
`via DERP` instead of `direct`. Check that `41641/udp` is open and that the
nodes are not stuck behind symmetric NAT. Public traffic should use direct
connections; DERP is a fallback with bandwidth and latency overhead.

**Client IP is the VPS tailnet IP.** Expected. HAProxy passes TCP through, so it
cannot add `X-Forwarded-For`, and Traefik does not trust a proxy header it never
receives. This is the known limitation, not a misconfiguration.

## TODO

- **Real client IP at Traefik.** Options: HAProxy `send-proxy-v2` to a dedicated
  Traefik entrypoint configured with `proxyProtocol.trustedIPs`; or terminate
  TLS at the proxy and forward `X-Forwarded-For`. Both require a Traefik
  component change. Until then, Traefik and applications see the VPS tailnet IP.
- **`3443/tcp`.** Add it with `--tcp-forward 3443=traefik-tls=<node>:3443` when
  a TLSRoute needs it. Traefik's TLS listener on `3443` terminates and routes.
- **Encrypted DNS.** DoT `853/tcp` is a passthrough frontend to Technitium.
  DoH needs a dedicated hostname/SNI route. Plain `53` is out of scope.
- **Fedora Server validation.** Fedora 44 Cloud Edition passed the full flow:
  install, account creation, firewalld, DNF automatic updates, reboot, tailnet
  join, HAProxy dual-stack, SELinux, SSH hardening and a dual-stack exit node.
  Fedora Server shares the packages but should be rechecked before claiming it
  behaves identically.
- **RHEL family.** Add a `rhel/` directory if needed; it shares the
  dnf/firewalld/SELinux shape with Fedora, uses the RHEL Tailscale repository,
  and needs HAProxy from AppStream. Test before documenting it as supported.
- **Other distributions.** Add a distro script only with a tested VPS; otherwise
  use the manual checklist.

## Tooling choice

HAProxy is used because the role is a stable SNI passthrough: it is packaged by
the distribution, has active TCP health checks and a local stats page, and
needs no custom build. Caddy would only be attractive if it terminated TLS;
its layer4 support is a third-party, explicitly experimental plugin and a
custom binary. Traefik standalone would duplicate the cluster ingress and
invite coupling. nginx `stream` would work too but adds nothing here.
