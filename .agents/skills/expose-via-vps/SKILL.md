---
name: expose-via-vps
description: Use when the user wants to expose OrangeLab services through a cloud VPS instead of their home IP, or asks to "setup public proxy", "public proxy connection/credential info", "hide my public IP", "reverse proxy on a VPS", "move public services off my router", or "add an exit node". Sets up a passthrough HAProxy on a VPS joined to Headscale or Tailscale, verifies it, and hands off the DNS cutover.
---

# Expose Services via a VPS

Replaces a router port forward with a small VPS outside the cluster. The VPS
joins the same tailnet as the cluster and forwards TLS to the Traefik public
gateway by SNI, plus any explicitly configured raw TCP ports. Certificates,
routing, and the apex stay in the cluster; the VPS is disposable. The tailnet
can use Headscale or Tailscale; the HAProxy and host layers are identical.

Read [`docs/public-proxy.md`](/docs/public-proxy.md) for the user-facing guide
and [`spec/public-proxy.md`](/spec/public-proxy.md) for invariants and failure
modes before starting.

## Mode of operation

- **Execute over SSH**, but treat the VPS as production: confirm before
  changing SSH authentication, enabling the firewall, installing packages, or
  enabling an exit node.
- **Never change DNS.** Verify the proxy, then hand the user the records to
  switch.
- **Never put cluster credentials on the VPS.** No kubeconfig, Pulumi state,
  DNS tokens, or certificates.
- **Never print secrets.** Headscale pre-auth keys, Tailscale auth keys, SSH
  private keys, and provider credentials stay out of responses and shell
  history.
- **Stop and ask** before any cluster change. A missing public route is a
  cluster config issue, not something to work around on the VPS.

## Inputs to collect

### Detect the control plane first

Do not ask the user to identify the control plane when it can be determined
from the installation. Use read-only checks from the repository and the local
tailnet client:

```sh
# If the local Tailscale client is available, inspect its configured control URL.
tailscale debug prefs | jq -r '.ControlURL'

# From the active Pulumi stack, corroborate the installation flags.
pulumi config get tailscale:enabled
pulumi config get headscale:enabled
```

Interpret the results as follows:

- a control URL containing the installation's Headscale hostname, or
  `headscale:enabled=true` with `tailscale:enabled=false`, means **Headscale**;
- the default Tailscale control URL, or
  `tailscale:enabled=true` with `headscale:enabled=false`, means **Tailscale**;
- if the checks disagree or neither control plane can be determined, stop and
  report the conflict instead of asking the user to guess or mixing them.

Report the detected control plane to the user and confirm that the VPS will
join that same tailnet. Only ask the user to decide unresolved setup choices;
do not ask which control plane is in use.

Ask the user for, and verify where possible:

1. SSH target: host, port, user, and how to authenticate. State whether it is
   `root` or a sudo user.
2. Preferred admin account: use the account from the VPS dashboard. Pass
   `--user` to create a dedicated non-root account (recommended); omit it to
   use root or the sudo-invoking user. Root is allowed. If the VPS is used for
   other things, keep the existing account and skip `harden-ssh.sh`.
3. OS and version (Ubuntu, Debian, Fedora, other), and whether it is a fresh
   server image.
4. Provider port restrictions: SSH port, whether inbound `80`/`443` can be
   opened, and whether IPv6 firewall rules are separate. Treat opening the
   provider firewall as a post-setup, pre-cutover handoff unless a supported
   provider API is explicitly available; it is not required for host
   preparation or tailnet setup.
5. Custom domain and the currently public route inventory. Derive this from
   namespaces labelled `orangelab.space/public=true` and the routes attached to
   `traefik-gateway-public`; confirm the actual hostnames, including aliases and
   custom app hostnames. Do not ask the user to select `network/public` settings
   as part of proxy setup: those are cluster-side exposure decisions that must
   already be in place. DNS cutover decides which existing public hostnames move
   to the VPS.
6. Control-plane auth after detection: for Headscale, mint a single-use tagged
   pre-auth key with `tag:proxy`; for Tailscale, ask the user to create or
   provide a tagged auth key. Tailscale requires `tag:proxy` in `tagOwners`
   first. Use `--user <numeric-id>` only for a Headscale key that explicitly
   needs a personal owner.
7. VPS/control-plane node name. Default `proxy`; `proxy-<location>` is a good
   choice if there are several proxies. This is the name for `ssh <user>@proxy`
   over the tailnet and the name shown in the exit-node list, not the VPS OS
   hostname (which can stay provider-generated).
8. Whether the provider gives the VPS a public IPv6 address, and whether the
   user wants IPv6. IPv6 is optional; the provider may not support it.
9. Whether the VPS should also be an exit node.
10. DNS provider, current TTLs, and whether records can be DNS-only (no
    CDN/proxy).
11. **Headscale only:** home IPv4 for the control pin and fallback, and whether
    the home `443` forward will stay. The address can be only somewhat static,
    but the user must be able to update the pin manually when it changes.
    Tailscale needs neither a pin nor the home forward for control.

Do not join the tailnet until the control plane is detected and the account,
node name, IPv6 decision, exit-node decision, and DNS details are confirmed.
Confirm that the provider can open `80`/`443` before external verification and
DNS handoff. If the provider blocks those ports and cannot open them, stop.

**Always ask for the node name before joining.** The default is `proxy`; use
`proxy-<location>` if the user has several proxies. The point is a short name
that works as `ssh <user>@proxy` over the tailnet. Use it as the control-plane
name and the exit-node name; do not silently use the provider-generated OS
hostname. If that name already belongs to an offline node, do not silently
create a duplicate or delete the old node. Stop and get explicit approval to
retire/reconcile the old node before minting the new join key.

**Ask about IPv6 before configuring HAProxy:** "Does the provider give this
VPS a public IPv6 address, and do you want IPv6? It is optional; if not, we
keep IPv4 only and publish no AAAA records." Verify rather than trusting the
answer: `ip -6 addr show scope global`, `ip -6 route show default`, and
`curl -6`. A Tailscale `fd7a:` address is not public IPv6. Do not enable IPv6
just because the kernel has an IPv6 stack. If the provider lacks it, do not add
AAAA records or approve `::/0`; otherwise keep IPv4 only.

**Ask the exit-node question explicitly before changing anything:** "Should
this VPS also be an exit node? It is off by default, adds bandwidth use, and
requires approving `0.0.0.0/0` (plus `::/0` only if IPv6 is enabled) in
Headscale or the Tailscale admin console." Do not infer a yes from the
public-proxy request. If the user says no, skip section 7 entirely. If yes, use
`--ipv6` on the exit-node script only when IPv6 was enabled for the proxy.

Inspect the cluster (read-only):

```sh
pulumi config get orangelab:customDomain
pulumi config | grep ':network/public'
kubectl get nodes -l svccontroller.k3s.cattle.io/enablelb=true
kubectl get nodes -o wide
kubectl get pods -n kube-system -o wide | grep svclb-traefik
kubectl get ns -l orangelab.space/public=true --show-labels
kubectl get httproute -A -o custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name,PARENTS:.spec.parentRefs[*].name,HOSTS:.spec.hostnames[*]'
```

Never use `pulumi config --show-secrets`. `InternalIP` in
`kubectl get nodes -o wide` is the node's tailnet address. Prefer at least two
upstreams; a single node is still workable for a small deployment.

The public route inventory is the set of hostnames on routes attached to
`traefik-gateway-public`, not the app config key or a guessed `<app>.<domain>`
name. An app may use a custom hostname such as `login.<domain>`, and an apex or
`www` alias may be represented by the same route. Confirm this inventory with
the user before setup. Do not change an app's `network/public` setting during
proxy setup; if a desired route is absent, stop and discuss the cluster-side
configuration separately.

## 1. Inspect access

```sh
ssh -o BatchMode=yes -p <port> <user>@<host> \
  'id -u; hostname; . /etc/os-release; echo "$ID $VERSION_ID $PRETTY_NAME"; \
   command -v apt-get dnf ufw firewall-cmd; \
   sudo -n true && echo sudo-ok || echo sudo-needs-password'
```

- `0` means root. If the user wants a dedicated non-root account, pass
  `--user` to `create-user.sh`; otherwise it prepares root or the
  sudo-invoking account.
- Non-zero with `sudo-ok` means an existing admin user. Use its name as
  `<proxy-user>` when passing `--user`; `create-user.sh` reuses it only if it
  has a home, is in the admin group, and already has a key. If it uses a
  password for sudo, ask the user to run the privileged phases.
- `sudo-needs-password` means the agent cannot run privileged commands
  non-interactively; ask the user to run them or to grant NOPASSWD.
- No key-based access: stop. Ask the user to add a key or use the provider
  console. Do not disable password or root login.

Confirm the OS and choose the phase directory:

- `ID=ubuntu` or `ID=debian` — baseline path, `ubuntu/`; tested on Ubuntu
  26.04 LTS and Debian 13 Trixie Cloud Micro.
- `ID=fedora` — tested on Fedora 44, `fedora/`. Uses firewalld, SELinux and
  DNF automatic updates; the phase scripts handle their Fedora defaults.
- Anything else — stop and use the manual checklist in `docs/public-proxy.md`.
  Do not run the Ubuntu or Fedora phase scripts on another distribution.

On Debian Cloud Micro, check `/etc/hosts` before the sudo phases. If
`127.0.1.1` names `debian` instead of the provider-generated hostname, set it
to `$(hostname)` so `sudo` stops printing resolver warnings. The UFW unit is
oneshot: use `ufw status verbose`, not `systemctl is-active ufw`, to confirm
the firewall.

Also confirm a static public IPv4. If the user wants IPv6, confirm a **public**
IPv6 address and default route now (`ip -6 addr show scope global`,
`ip -6 route show default`, `curl -6`); a Tailscale `fd7a:` address does not
count. If there is no public IPv6, do not plan AAAA records.

## 2. Copy the scripts

From the repository root:

```sh
ssh -p <port> <user>@<host> \
  'if [ -d /tmp/public-proxy ]; then rm -rf /tmp/public-proxy || sudo rm -rf /tmp/public-proxy; fi'
scp -P <port> -r scripts/public-proxy <user>@<host>:/tmp/
```

If the SSH user is not root, run the scripts with `sudo` and copy them to a
directory that user can read. The scripts are then under
`/tmp/public-proxy/`.

## 3. Prepare and harden the host

Run the phases in order. There is no dispatcher: run one script, check its
output, then continue. Stop on a failure, fix that phase, and rerun it before
moving on.

To create a dedicated non-root account, when logged in as root:

```sh
ssh -p <port> <user>@<host> 'bash /tmp/public-proxy/<os>/01-install.sh'
ssh -p <port> <user>@<host> 'bash /tmp/public-proxy/create-user.sh --user <proxy-user>'
ssh -p <port> <user>@<host> 'bash /tmp/public-proxy/<os>/02-firewall.sh'
ssh -p <port> <user>@<host> 'bash /tmp/public-proxy/<os>/03-updates.sh'
```

Replace `<os>` with `ubuntu` for Debian/Ubuntu or `fedora` for Fedora.
`create-user.sh` defaults to root or the sudo-invoking user; `--user <proxy-user>`
creates or reuses a dedicated non-root account. Prefer a non-root name such as
`orangelab`; do not use `proxy`, because Ubuntu ships a `proxy` system account.

If the user chose an existing account from the VPS dashboard, omit `--user` so
`create-user.sh` prepares that account; if it is root or the VPS has other
uses, also skip `harden-ssh.sh`. Run the phase scripts with the existing account
and keep access key-only, with the provider console as the fallback. Root is
allowed.

For a non-root sudo user, prefix each command with `sudo`:

```sh
ssh -p <port> <user>@<host> 'sudo bash /tmp/public-proxy/<os>/01-install.sh'
```

Use the same form for the other three phases.

On Fedora, `01-install.sh` installs firewalld and enables
`haproxy_connect_any`; it also adds the HAProxy `RuntimeDirectory` drop-in
(Fedora's unit does not create `/run/haproxy`) and reports a pending reboot
using `dnf needs-restarting -r`. `02-firewall.sh` removes the default
public-zone `mdns` and `ssh` service entries before opening the detected SSH
port. `03-updates.sh` installs/chooses `dnf5-plugin-automatic` with
`dnf5-automatic.timer` (Fedora 41+) or `dnf-automatic` with
`dnf-automatic.timer`. Record which timer it chose and report any SELinux
warnings.

If the invoking account has no `authorized_keys`, pass the user's **public**
key to `create-user.sh`:

```sh
ssh -p <port> <user>@<host> \
  'sudo bash /tmp/public-proxy/create-user.sh --user <proxy-user> \
  --ssh-key "<public-key>"'
```

Ask the user for the public key; never generate or print a private key.

If using a non-root account, verify it from a separate connection:

```sh
ssh -p <port> <proxy-user>@<host> 'id -u; sudo -n true'
```

If the user chose root, skip this verification and the hardening step below.

Only then harden SSH. Skip this if the user chose root; `harden-ssh.sh` disables
root login:

```sh
ssh -p <port> <proxy-user>@<host> \
  'sudo bash /tmp/public-proxy/harden-ssh.sh <proxy-user>'
```

On Fedora, this also runs `restorecon` on the drop-in. If `sshd -T` still shows
the old values, check that `/etc/ssh/sshd_config` includes
`/etc/ssh/sshd_config.d/*.conf`.

Warn the user to keep a session open and to use the provider console if a new
login fails.

After the tailnet is up, you can offer to close public SSH and allow it only on
`tailscale0`. Do this only with explicit confirmation; the provider console is
the fallback if the tailnet or control plane is down.

Before external verification and DNS handoff, have the user confirm that the
provider's cloud firewall allows the SSH port, `80/tcp`, `443/tcp`, every
configured `--tcp-port`, and `41641/udp`. If IPv6 is enabled, confirm the same
`80`/`443` and TCP rules apply to IPv6; many providers have separate IPv4 and
IPv6 firewall rules. This is separate from UFW and is normally a
provider-dashboard action. Do not block the automated host preparation, package
installation, tailnet join, or local verification while this handoff is
pending. `41641/udp` improves direct tailnet connectivity; the control plane may
use a relay when it is unavailable, but it should be opened before final
verification.

## 4. Join the tailnet

Use the node name agreed with the user (default `proxy`). It becomes the
control-plane node name and the label shown in the exit-node list.

### Headscale

Create a single-use tagged key without printing it:

```sh
./components/network/headscale/exec-headscale.sh preauthkeys create \
  --tags tag:proxy --expiration 1h > /tmp/opencode/proxy-authkey
chmod 600 /tmp/opencode/proxy-authkey
```

`tag:proxy` is the only identity. Do not add a shared tag: the access policy
scopes `tag:proxy` by port, and another tag would widen what the proxy can
reach.

A tags-only key needs no `--user`; the node is owned by `tagged-devices`, not a
person. Use `--user <numeric-user-id>` only when the Headscale version cannot
mint tagged keys or the user explicitly wants personal ownership. `--user`
takes the numeric ID, not the username; the user must already exist from an
OIDC sign-in or be created as a local Headscale user.

### Tailscale

Define `tag:proxy` in the tailnet policy's `tagOwners` first. Ask the user to
generate a tagged auth key in the Tailscale admin console (Settings → Keys) and
place it in `/tmp/opencode/proxy-authkey`, or use the Tailscale API. Set a short
expiry and exclude it from shell history. Do not create a Headscale pre-auth key
for a Tailscale tailnet.

### Join and verify

Copy the key and pass the file to `tailscale up --auth-key file:...`. Do not use
`TS_AUTHKEY`; `sudo` may strip it, and the join then falls back to interactive
login. Prefer tags on the auth key; do not rely on `--advertise-tags` to add
them.

```sh
scp -P <port> -p /tmp/opencode/proxy-authkey <proxy-user>@<host>:/tmp/proxy-authkey

# Headscale
ssh -p <port> <proxy-user>@<host> \
  'sudo tailscale up --login-server https://<headscale-host> \
     --hostname <node-name> --auth-key file:/tmp/proxy-authkey; \
   rc=$?; shred -u /tmp/proxy-authkey 2>/dev/null || rm -f /tmp/proxy-authkey; exit $rc'

# Tailscale: omit --login-server
ssh -p <port> <proxy-user>@<host> \
  'sudo tailscale up --hostname <node-name> \
     --auth-key file:/tmp/proxy-authkey; \
   rc=$?; shred -u /tmp/proxy-authkey 2>/dev/null || rm -f /tmp/proxy-authkey; exit $rc'

rm -f /tmp/opencode/proxy-authkey
```

Verify on the VPS:

```sh
sudo tailscale status
sudo tailscale ip -4
sudo tailscale ping <tailnet-ip>   # prefer "direct", not "via DERP"
getent hosts <traefik-node>        # optional, if MagicDNS is configured
curl -sS -o /dev/null -w '%{http_code}\n' \
  --resolve <host>:10443:<tailnet-ip> https://<host>:10443/
```

A timeout means the tailnet, ACL, or node firewall is wrong. A `404` means the
app is not public or the route has not reconciled.

Confirm the tag:

- **Headscale:** `./components/network/headscale/exec-headscale.sh nodes list`
  should show the node under `tagged-devices` with the selected tags (at least
  `tag:proxy`).
- **Tailscale:** check the machine in the admin console, or confirm
  `Self.Tags` contains every selected tag in `tailscale status --json` (at
  least `tag:proxy`).

If public `headscale` DNS will point at this VPS, pin the VPS's own control
path to the home IPv4 before the cutover. The home `443` forward must stay
available. This is Headscale-only; Tailscale needs no pin:

```sh
ssh -p <port> <proxy-user>@<host> \
  "echo '<home-ipv4> <headscale-host> # public-proxy control bootstrap' | \
   sudo tee -a /etc/hosts"
ssh -p <port> <proxy-user>@<host> \
  "getent hosts <headscale-host>; sudo systemctl restart tailscaled"
```

`getent` must show the home IPv4, and `tailscale status` must come back online.
If the home IP changes later, update this pin. If the user does not want a home
path, leave `headscale` DNS at home or use a separate control endpoint.

If the control plane uses ACLs, restrict this node to the Traefik nodes on
`10443` (and later the DNS port). Do not grant full tailnet access. On
Tailscale, the eventual exit-node grant is separate: add `autogroup:internet`
when enabling it.

## 5. Configure HAProxy

```sh
ssh -p <port> <proxy-user>@<host> \
  'sudo bash /tmp/public-proxy/configure-haproxy.sh \
   --domain <domain> \
   --upstream <node-a>=<tailnet-ip-a>:10443 \
   --upstream <node-b>=<tailnet-ip-b>:10443'
```

Add `--ipv6` only if the user opted in and the host has a public IPv6 address
and default route. The script refuses the flag when it cannot find one. Without
it, HAProxy stays IPv4 only. The upstreams remain IPv4 tailnet addresses either
way.

Raw TCP is separate from HTTP and SNI. Add one `--tcp-forward
<listen-port>=<name>=<addr:port>` per upstream. The cluster side must publish
the port at `<port> + 10000` when it is marked `public`:

```sh
ssh -p <port> <proxy-user>@<host> \
  'sudo bash /tmp/public-proxy/configure-haproxy.sh \
   --domain <domain> \
   --upstream <node-a>=<tailnet-ip-a>:10443 \
   --upstream <node-b>=<tailnet-ip-b>:10443 \
   --tcp-forward 8333=bitcoin-p2p=<tailnet-ip-a>:18333 \
   --tcp-forward 8333=bitcoin-p2p=<tailnet-ip-b>:18333'
```

Open the same listener with the firewall phase, for example
`--tcp-port 8333`, and in the provider cloud firewall. There is no catch-all
TCP listener; only add ports that are intentionally public. Never forward a
database, RPC, admin, or metrics port.

The script renders the config, validates it with `haproxy -c`, backs up the
previous file, and reloads. Do not hand-edit the live config without keeping the
template and script in sync.

Check:

```sh
sudo systemctl status haproxy
sudo journalctl -u haproxy -n 50 --no-pager
```

The stats page is `127.0.0.1:8404/stats`, reachable only through an SSH tunnel.
The root path on port 8404 is not configured and may return `503`; use
`http://localhost:8404/stats` (or `/stats;csv`) instead.

## 6. Verify before DNS

On the VPS:

```sh
sudo bash /tmp/public-proxy/verify.sh \
  --domain <domain> \
  --host <host> \
  --host <apex>
```

If IPv6 was enabled, add `--ipv6 --vps-ip6 <vps-ipv6>`. This checks the
dual-stack listeners, `[::1]`, and the public IPv6 path when run on the VPS.

On Fedora, also check:

```sh
getenforce
getsebool haproxy_connect_any
sudo firewall-cmd --list-all-zones
```

On Debian/Ubuntu, check UFW with `sudo ufw status verbose`. The UFW unit is
oneshot, so `systemctl is-active ufw` is not a reliable health check.

From the agent's machine, which is outside the VPS:

```sh
curl -sS -o /dev/null -w '%{http_code} %{remote_ip}\n' \
  --resolve <host>:443:<vps-ip> https://<host>/
curl -sSI --resolve <host>:80:<vps-ip> http://<host>/
timeout 10 openssl s_client -connect <vps-ip>:443 -servername <host> </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -ext subjectAltName
```

If IPv6 was enabled, repeat from an IPv6-capable network:

```sh
curl -g -6 -sS -o /dev/null -w '%{http_code} %{remote_ip}\n' \
  --resolve <host>:443:[<vps-ipv6>] https://<host>/
timeout 10 openssl s_client -connect [<vps-ipv6>]:443 -servername <host> </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -ext subjectAltName
```

For each raw TCP forward, test the public listener and the upstream from the
VPS:

```sh
nc -vz <vps-ip> <public-port>
ssh <proxy-user>@<vps-ip> 'nc -vz <tailnet-ip> <port+10000>'
```

Confirm:

- every host returns the expected response, not a proxy error;
- the certificate is the cluster wildcard, not a VPS certificate;
- HTTP redirects to HTTPS;
- a name outside the configured domain is rejected; an unconfigured subdomain
  is forwarded and gets Traefik's `404`;
- the apex still serves Caddy's `/.well-known` content;
- Traefik sees the VPS tailnet IP as the client (known limitation).

A `404` for a hostname is usually a missing public route or a Host mismatch.
Do not continue to DNS until every hostname passes the IPv4 checks. If IPv6 is
enabled but has not been verified from an IPv6-capable external network, this
does not block the A-record cutover: leave AAAA records absent and add them only
after the IPv6 path passes.

## 7. Optional exit node

Only if the user explicitly said yes. If the answer was no, skip this section;
do not enable it by default.

```sh
ssh -p <port> <proxy-user>@<host> 'sudo bash /tmp/public-proxy/exit-node.sh'
```

IPv4 is the default. Add `--ipv6` only if IPv6 was enabled for the proxy and
the provider routes a public IPv6 address. The script then enables IPv6
forwarding and, on Fedora, adds the IPv6 masquerade rule:

```sh
ssh -p <port> <proxy-user>@<host> \
  'sudo bash /tmp/public-proxy/exit-node.sh --ipv6'
```

On Fedora, the script configures firewalld (`tailscale0` in `trusted`,
masquerade, and IPv6 masquerade with `--ipv6`) and restarts `tailscaled`. Verify
with `sudo firewall-cmd --zone=trusted --list-all`, `sudo nft list ruleset` and
`tailscale status`. If clients get no traffic, the firewalld forward chain is
the first suspect.

### Approve in Headscale

Approve `0.0.0.0/0` always; approve `::/0` only after running with `--ipv6`:

```sh
./components/network/headscale/exec-headscale.sh nodes list-routes
./components/network/headscale/exec-headscale.sh nodes approve-routes \
  --identifier <node-id> --routes 0.0.0.0/0
# Add ,::/0 only when the VPS has working public IPv6:
./components/network/headscale/exec-headscale.sh nodes approve-routes \
  --identifier <node-id> --routes 0.0.0.0/0,::/0
```

Headscale may advertise `::/0` even when IPv6 forwarding is off. Leave it
unapproved unless IPv6 is actually configured and tested.

### Approve in Tailscale

Allow the machine as an exit node in the Tailscale admin console. If the tailnet
uses a custom policy, add a grant whose destination is `autogroup:internet`.
Granting access to the proxy device itself is not enough. The script runs
`tailscale up` on Tailscale; for a manual setup, run it once after
`tailscale set --advertise-exit-node`.

A client shows the exit node only after the node exists, advertises the route,
and the control plane approves it. For Headscale, an unapproved route keeps it
out of the client list; for Tailscale, check the machine's exit-node setting and
the policy grant.

Verify from a client:

```sh
tailscale set --exit-node <node-name>
curl -s https://ifconfig.me    # VPS public IPv4
curl -6 -s https://ifconfig.co # only if IPv6 was enabled
tailscale set --exit-node=
```

Before deleting the VPS, stop advertising and switch clients back.

## 8. Hand off DNS

Do not change DNS yourself. Give the user a table with **one row per record**,
using the actual public hostnames, not placeholders:

| Type   | Name            | Value        | TTL     | Notes                          |
| ------ | --------------- | ------------ | ------- | ------------------------------ |
| `A`    | `@` (apex)      | `<vps-ipv4>` | `<ttl>` | always                         |
| `AAAA` | `@` (apex)      | `<vps-ipv6>` | `<ttl>` | only after external IPv6 check |
| `A`    | `www`           | `<vps-ipv4>` | `<ttl>` | if `www` is public             |
| `AAAA` | `www`           | `<vps-ipv6>` | `<ttl>` | public and IPv6 verified       |
| `A`    | `headscale`     | `<vps-ipv4>` | `<ttl>` | Headscale only, after pin      |
| `AAAA` | `headscale`     | `<vps-ipv6>` | `<ttl>` | pin and IPv6 verified          |
| `A`    | `<public-host>` | `<vps-ipv4>` | `<ttl>` | one per public hostname        |
| `AAAA` | `<public-host>` | `<vps-ipv6>` | `<ttl>` | only after IPv6 check          |

**Tailscale:** no control bootstrap record or `/etc/hosts` pin is needed. The
VPS uses Tailscale's SaaS control plane; the home `443` forward is not part of
the control path but is still needed if home is the manual DNS fallback.

**Headscale bootstrap:** the VPS's
`sudo tailscale debug prefs | jq -r .ControlURL` is normally
`https://headscale.<domain>`. If that name resolves to the VPS, a reboot cannot
fetch the control key because HAProxy needs Tailscale and Tailscale needs
Headscale. Confirm the VPS has the
`/etc/hosts` pin to the home IPv4 (section 4) and the home `443` forward is
still available before including the Headscale record. If the home path is not
kept, leave Headscale DNS at home or use a separate control endpoint.

Include these manual steps:

- check each record's current TTL; only if it is above 300 seconds, lower it to
  300 at least one old TTL before cutover (if it is already 300 or lower, skip);
- **Headscale only:** confirm the VPS control pin resolves to the home IPv4 and
  `tailscaled` is online before moving `headscale`;
- set the A record to `<vps-ipv4>` for every public host;
- set A records independently of IPv6; an external IPv6 failure does not block
  the IPv4 cutover;
- add AAAA records only after an external IPv6 check passes; use the VPS
  **global** IPv6 address, never the Tailscale `fd7a:` address;
- if the provider has no public IPv6, add no AAAA and remove stale AAAA;
- if a wildcard is shared with private/tailnet names, do not add a wildcard AAAA;
  list explicit AAAA records for public hosts only;
- if using Cloudflare or another CDN, set the records to DNS-only; if not, skip;
- leave the private wildcard record alone;
- flush Technitium and the local resolver. A local router or resolver may keep
  returning the old A record until its cached TTL expires;
- verify authoritative/public A/AAAA answers. Use `dig @<authoritative-nameserver>`
  and `curl --resolve` when local DNS is stale;
- verify IPv4 HTTPS after the A cutover, then verify IPv6 HTTPS before adding
  AAAA records;
- Keep the home `443` forward if home is the manual DNS fallback. Headscale
  also needs it for control; do not remove it while Headscale DNS points at the
  VPS. Tailscale does not need it for control, but the fallback cannot serve
  without it.

DNS pointing at the VPS is not automatic failover. A normal HAProxy restart
causes a short interruption and should recover without a DNS change, but a VPS
outage makes every hostname pointing at it unavailable. Recovery is manual:
move all affected A records back to the home address (and handle AAAA records
consistently), wait for the 300-second TTL, and verify from outside. For
Headscale, the home `443` forward and the VPS `/etc/hosts` control pin are what
allow the proxy to reconnect after a reboot; they do not make public traffic
fail over automatically.

If the VPS fails, tell the user to move the affected records back to the home
addresses (or another proxy on the same control plane with an independent
control path), wait for the 300-second TTL, and verify from outside. For
Headscale, update the VPS pin before moving DNS back if the home IP changed;
Tailscale has no pin.

If the home IP changes while the VPS is up, this is a Headscale concern: the
proxy may keep working until `tailscaled` reconnects; then HAProxy gets no
upstream. Tell the user to edit the marked `/etc/hosts` line (not append a
duplicate), verify with `getent hosts`, and restart `tailscaled`. If it has
already logged out, use public SSH or the provider console. If the VPS is down,
use the DNS fallback first. Tailscale's control path is independent of the home
IP. Before cutover, the public A/AAAA records also still point home.

The apex and `www` move too if they are public; their content remains Caddy in
the cluster. Do not claim the cutover is complete; the user performs it.

## Hand-off summary

Report, without secrets:

```
VPS:            <ip>
OS:             <ubuntu/debian/fedora> (tested)
SSH:            <user>@<ip> (key)
Control plane:  <Headscale or Tailscale>
Node:           <name> (tailnet <ip>, tags: tag:proxy)
Control pin:    <headscale-host> -> <home-ipv4> (Headscale only)
HAProxy:        443 -> <upstream-a>, <upstream-b>
TCP forwards:   <none | <public-port> -> <name>=<upstream-a>:<port+10000>, ...>
IPv6:           <enabled/approved | disabled; provider has no IPv6>
Stats:          ssh -L 8404:127.0.0.1:8404 <user>@<ip>
                http://localhost:8404/stats
Exit node:      <enabled/approved (IPv4 only or dual-stack) | not enabled>
Hosts verified: <list>
DNS to add:     <A/AAAA table with actual values>
```

Also report the known limitations: client IP is the VPS tailnet IP, no HTTP/3,
no edge HTTP logs/WAF, no plain DNS/53, and no `3443/tcp` or DoT/DoH yet.

## Stop conditions

Stop and discuss when:

- the VPS has no public IPv4 or sits behind provider NAT;
- the provider firewall blocks `80`/`443` and cannot be opened;
- the user needs IPv6 but the provider gives the VPS no public IPv6 address;
- the OS is not Ubuntu/Debian/Fedora and the user does not want to use the
  manual checklist;
- a Fedora phase fails in a way that needs a script change; record the failure
  and update the script instead of working around it on the host;
- there is no key-based SSH access and no console fallback;
- the VPS and the Traefik nodes would use different control planes;
- Tailscale is selected but `tag:proxy` is not defined in `tagOwners`, or no
  tagged auth key can be created;
- Headscale is selected, the version cannot mint tagged pre-auth keys, and no
  Headscale user exists to own the key;
- the Traefik public gateway is unreachable over the tailnet after checking the
  ServiceLB node, firewall, and ACL;
- the DNS provider cannot turn off CDN/proxy mode;
- the planned cutover moves the Headscale hostname the VPS uses, and there is
  no independent control path; the proxy will lock itself out on reboot;
- the user needs real client IPs (that requires a Traefik/PROXY-protocol change,
  not a VPS tweak);
- any cluster resource needs changing.

## Do not

- terminate TLS at the VPS or copy certificates there;
- add a catch-all SNI backend or a catch-all TCP frontend;
- expose HAProxy stats or the admin socket publicly;
- expose plain DNS/53;
- invent a personal owner for the proxy when a tagged `tag:proxy` key is
  available;
- enable IPv6 by default, add AAAA records when the provider has no public
  IPv6, or approve `::/0` without working IPv6;
- enable an exit node unless requested;
- mix Headscale and Tailscale nodes in one proxy path;
- add a Headscale `/etc/hosts` control pin for a Tailscale deployment;
- delete the home `443` forward while Headscale DNS points at the VPS; it is
  the control bootstrap and the manual fallback;
- run `pulumi up` or modify cluster resources without explicit approval.
