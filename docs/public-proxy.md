# Public proxy on a VPS

Run a small VPS outside the cluster that joins the same tailnet as the cluster
and forwards public HTTP(S) traffic to Traefik. Public DNS points at the VPS, so
your home IP is never published, and moving to another provider is a DNS
change.

The proxy passes TLS through end-to-end. Certificates, routing, and the apex
stay in the cluster; the VPS holds no kubeconfig, DNS tokens, or application
data.

```
Internet ──► VPS (HAProxy :80/:443) ──► tailnet ──► Traefik :10443 ──► app
```

## What stays in the cluster

- **Traefik** still terminates TLS with the wildcard certificate and decides
  which hostnames have public routes. HAProxy only admits your domain and
  rejects names outside it.
- **Caddy** still serves the apex from the cluster, including
  `/.well-known/webfinger` and any future `.well-known` files. The VPS forwards
  the apex SNI like any other hostname; it does not host the apex or hold its
  certificate. The apex must be a public route (`caddy:network/public true`,
  applied with your normal Pulumi workflow) for the proxy to reach it; a
  private apex remains private and returns `404` on the public listener.
- **The control plane** is either self-hosted Headscale in the cluster or
  Tailscale SaaS. The VPS is just another node, and both ends must use the same
  control plane.

## Choose the control plane

The proxy transport is identical, but the VPS and the Traefik nodes must be in
the **same tailnet**. A VPS joined to Tailscale cannot reach nodes joined to
Headscale, and vice versa.

| Area                | Headscale                                            | Tailscale                                                |
| ------------------- | ---------------------------------------------------- | -------------------------------------------------------- |
| Auth key            | `headscale preauthkeys create`                       | Tailscale admin console or API                           |
| Tag identity        | `tag:proxy`; tags-only keys need no `tagOwners` here | `tag:proxy`; define every selected tag in `tagOwners`    |
| Join                | `tailscale up --login-server https://headscale...`   | `tailscale up` with the default Tailscale control plane  |
| Exit-node approval  | `headscale nodes approve-routes`                     | Tailscale admin console; ACL grant if a policy is in use |
| Control path        | Public `headscale` hostname plus optional home pin   | Tailscale SaaS; no control pin or home bootstrap         |
| Node administration | Headscale CLI                                        | Tailscale admin console                                  |

The remaining sections call out the Headscale and Tailscale variants where the
commands differ. Everything else — HAProxy, firewalling, verification and the
public-host DNS records — is shared. The Headscale control record and pin are
separate.

## When to use it

Use it when:

- you expose services with the `traefik` routing provider and
  `<app>:network/public true`;
- you want to stop forwarding WAN `443` to a node on your router;
- you want a public address that survives a changing home IP.

It is not:

- a way to hide outbound traffic — that is the optional exit node, and a
  datacenter IP is not a residential-IP replacement;
- DDoS protection by itself;
- for public media. Keep Jellyfin and other media on the tailnet.

## Requirements

- Ubuntu Server LTS, Debian 13 (Trixie), or Fedora 44, KVM, with a static
  public IPv4. Use a release that Tailscale publishes packages for.
- Public IPv6 is **optional** and depends on the provider. IPv4 is the default;
  only enable IPv6 if the VPS has a public IPv6 address and you want AAAA
  records. If the provider does not route IPv6, keep IPv4 only and do not
  publish AAAA records.
- **1 vCPU / 1 GB / 20–30 GB / 2 TB** is enough for a handful of HTTP services.
  An exit node or high traffic needs more CPU and bandwidth. Start small and
  upgrade on measured pressure.
- SSH access with the account from your VPS dashboard. `create-user.sh` defaults
  to root or the sudo-invoking user; pass `--user orangelab` to create a
  dedicated non-root account (recommended). Root is allowed. If the VPS has
  other uses, keep the existing account and skip `harden-ssh.sh`.
- A control-plane auth key for the VPS: a Headscale pre-auth key (tagged
  `tag:proxy` by default) or a Tailscale auth key. For Tailscale, define every
  selected tag (`tag:proxy`, and `tag:orangelab` if used) in `tagOwners` before
  creating the key.
- One or more cluster nodes running the Traefik public gateway on `10443`.
- DNS control. Check the current TTLs and whether the DNS provider has a
  CDN/proxy toggle.

### Before you start

Confirm or check these before changing the VPS:

- **Control plane:** Headscale or Tailscale. Confirm every cluster node that
  serves Traefik is on that same tailnet; do not mix the two. See
  [Choose the control plane](#choose-the-control-plane).
- **Admin account:** use the account from the VPS dashboard. `create-user.sh`
  defaults to root or the sudo-invoking user; pass `--user orangelab` to create
  a dedicated non-root account (recommended). Root is allowed. See the account
  note in [Prepare the host](#1-prepare-the-host).
- **Node name:** the control-plane name, default `proxy` or
  `proxy-<location>`. This is the name used for `ssh <user>@proxy` over the
  tailnet and in the exit-node list; it does not change the VPS OS hostname.
- **Node tag:** default `tag:proxy`; add `tag:orangelab` if the installation
  uses a shared tag. Tagged keys are the preferred service identity. On
  Tailscale, every selected tag must exist in `tagOwners`; Headscale's tags-only
  keys carry their own authorization in the tested version.
- **Provider ports:** SSH port, inbound `80`/`443`, and whether IPv6 firewall
  rules are separate. Open the same ports in the provider cloud firewall.
- **IPv6:** optional; see below.
- **Exit node:** decide yes/no now. It is not enabled by default.
- **DNS:** current TTLs and CDN/proxy mode.

### Optional: public IPv6

Check whether the provider gave the VPS a **public** IPv6 address and a default
route:

```sh
ip -6 addr show scope global
ip -6 route show default
curl -6 -sS -o /dev/null -w '%{http_code}\n' https://ifconfig.co
```

A Tailscale `fd7a:...` address does not count. If there is no public address or
the IPv6 check fails, stop here for IPv6: use IPv4 only, and do not add AAAA
records.

If IPv6 is available and wanted:

1. Add `--ipv6` to `configure-haproxy.sh` so `80` and `443` bind as
   `[::]:80 v4v6` and `[::]:443 v4v6`.
2. Add `--ipv6` to `verify.sh` (and `--vps-ip6 <vps-ipv6>` for the external
   check).
3. If using the exit node, add `--ipv6` to `exit-node.sh` and approve `::/0`.
4. Add AAAA records at cutover, as described in [Switch DNS](#6-switch-dns).

The public IPv6 leg terminates at HAProxy. The tailnet leg to Traefik can remain
IPv4; no Traefik or cluster change is needed.

### Supported systems

| System                             | Status                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------- |
| Ubuntu Server LTS                  | Tested; `ubuntu/` phase scripts                                            |
| Debian 13 (Trixie)                 | Tested on Cloud Micro; `ubuntu/` phase scripts                             |
| Fedora 44                          | Tested on Cloud Edition; `fedora/` phase scripts; Server expected to match |
| Other systemd distributions        | Manual checklist below                                                     |
| Alpine, Fedora CoreOS, NixOS, Arch | Not supported by these scripts                                             |

The scripts are split by phase, and by distribution where the package manager,
firewall or update tooling differs. There is no dispatcher: run each phase in
order and stop if one fails. `create-user.sh`, `harden-ssh.sh`,
`configure-haproxy.sh`, `verify.sh` and `exit-node.sh` are shared.

Ubuntu and Debian are the baseline path. The `ubuntu/` phases were validated
end-to-end on Ubuntu 26.04 LTS and Debian 13 Trixie Cloud Micro, including a
reboot, UFW, HAProxy dual-stack and a dual-stack exit node. Fedora 44 uses
firewalld, SELinux, DNF automatic updates and the `wheel` group, and its exit
node needs firewalld rules that the Ubuntu path does not. The Fedora phases
have been tested end-to-end on Fedora 44 Cloud Edition, including a reboot;
Fedora Server uses the same packages and should behave the same.

On Debian Cloud Micro, cloud-init can leave `127.0.1.1 debian` in `/etc/hosts`
while the hostname is provider-generated. `sudo` then prints
`unable to resolve host ...` before every command. Set that line to
`127.0.1.1 $(hostname)`; it does not affect the proxy. Also check `ufw status`
rather than `systemctl is-active ufw`: the UFW unit is oneshot, so it can show
inactive after boot while the rules are active.

### Other systemd distributions

The phase scripts are a convenience for the systems above, not a requirement.
On another systemd distribution, do these steps manually, then use
`configure-haproxy.sh`, `verify.sh` and `exit-node.sh` as usual:

1. Install HAProxy 2.4 or newer (validated with 2.6, 3.0 and 3.2), Tailscale,
   and a host firewall.
2. Open SSH, `80/tcp`, `443/tcp` and `41641/udp`; allow the tailnet
   (`100.64.0.0/10` and `fd7a:115c:a1e0::/48`, or the `tailscale0` interface).
   If IPv6 is enabled, open `80`/`443` for IPv6 too.
3. Prepare SSH access for the dashboard account, or pass `--user` to
   `create-user.sh` to create a dedicated non-root sudo user (recommended).
   Root is allowed. Keep root and password login enabled until you verify the
   account you will use.
4. Enable automatic security updates with automatic reboots disabled.
5. On SELinux systems, allow HAProxy to bind and connect:
   `setsebool -P haproxy_connect_any 1`.
6. Run `harden-ssh.sh` only after a non-root account works.

There is no dispatcher script for these systems; follow this checklist.

## 1. Prepare the host

Copy the scripts to the VPS and run the phase scripts for the distribution.

Ubuntu/Debian:

```sh
scp -r scripts/public-proxy root@<vps-ip>:/root/
ssh root@<vps-ip> 'bash /root/public-proxy/ubuntu/01-install.sh'
ssh root@<vps-ip> 'bash /root/public-proxy/create-user.sh --user orangelab'
ssh root@<vps-ip> 'bash /root/public-proxy/ubuntu/02-firewall.sh'
ssh root@<vps-ip> 'bash /root/public-proxy/ubuntu/03-updates.sh'
```

Fedora:

```sh
scp -r scripts/public-proxy root@<vps-ip>:/root/
ssh root@<vps-ip> 'bash /root/public-proxy/fedora/01-install.sh'
ssh root@<vps-ip> 'bash /root/public-proxy/create-user.sh --user orangelab'
ssh root@<vps-ip> 'bash /root/public-proxy/fedora/02-firewall.sh'
ssh root@<vps-ip> 'bash /root/public-proxy/fedora/03-updates.sh'
```

Run the phases in order. Each script is safe to rerun; stop and fix a failure
before continuing. These four phases do **not** disable root login or password
authentication; SSH hardening is a separate step below.

The commands pass `--user orangelab` to create a dedicated non-root account.
Omit `--user` to use root, or the account that invoked `sudo`. If your VPS
dashboard gives you another account, pass its name. If the VPS is also used for
other things, keep the existing account and skip `harden-ssh.sh`; run
`create-user.sh` without `--user` if you want it to verify that account's keys.
Root is allowed; keep the provider console as a fallback. Using the VPS for
other workloads is outside this guide, but you can keep the existing account
and skip the hardening steps rather than disrupting it.

- `01-install.sh` installs HAProxy, Tailscale and the host firewall/update
  packages. The Fedora script also sets the SELinux boolean HAProxy needs,
  creates the HAProxy runtime directory, and checks `dnf needs-restarting` for
  a pending reboot.
- `create-user.sh` prepares the account selected by `--user`, defaulting to root
  or the sudo-invoking user. It creates a missing account, copies the invoking
  account's SSH keys (or adds `--ssh-key`), and gives a newly created account
  passwordless sudo. The account is key-only, so sudo would otherwise be
  unusable. Pass `--user orangelab` for a dedicated non-root account.
- `02-firewall.sh` opens the detected SSH port (22 by default), `80/tcp`,
  `443/tcp` and `41641/udp`, and trusts the tailnet. On Fedora it also removes
  the default public-zone `mdns` and `ssh` service entries so only the chosen
  SSH port stays open.
- `03-updates.sh` enables automatic security updates and disables automatic
  reboots.

If `01-install.sh` reports that a reboot is required (usually because it
installed a new kernel), reboot before joining the tailnet. Fedora detects this
with `dnf needs-restarting -r`; Ubuntu/Debian use the update marker:

```sh
ssh <user>@<vps-ip> 'sudo reboot'
```

Wait for SSH to come back. UFW/firewalld, Tailscale and HAProxy are enabled
services, so the host comes back in the same state.

A newly created account logs in by SSH key and has passwordless sudo; remove
`/etc/sudoers.d/90-public-proxy` and set a password with `passwd` if you prefer
password-based sudo. An existing account is reused only if it has a home, is in
the admin group, and already has an SSH key; otherwise choose a new name or pass
`--ssh-key`.

If your provider uses a non-standard SSH port, add `-P <port>` to `scp` and
`-p <port>` to `ssh` in the commands in this guide.

If the provider gives you a non-root sudo user instead of `root`, copy the
scripts to `/tmp` and run the same phases with `sudo`:

If `/tmp/public-proxy` exists from an earlier attempt, remove it first with
`ssh <user>@<vps-ip> 'sudo rm -rf /tmp/public-proxy'`.

```sh
scp -r scripts/public-proxy <user>@<vps-ip>:/tmp/
ssh <user>@<vps-ip> 'sudo bash /tmp/public-proxy/ubuntu/01-install.sh'
ssh <user>@<vps-ip> 'sudo bash /tmp/public-proxy/create-user.sh --user orangelab'
ssh <user>@<vps-ip> 'sudo bash /tmp/public-proxy/ubuntu/02-firewall.sh'
ssh <user>@<vps-ip> 'sudo bash /tmp/public-proxy/ubuntu/03-updates.sh'
```

The later commands in this guide use `/root/public-proxy`; substitute
`/tmp/public-proxy` if you used the non-root path. `/tmp` is cleared on reboot,
so re-copy the scripts before rerunning phases. On Fedora, use the `fedora/`
scripts instead.

If the invoking account has no `authorized_keys`, pass your public key to
`create-user.sh`:

```sh
ssh root@<vps-ip> 'bash /root/public-proxy/create-user.sh --user orangelab \
  --ssh-key "ssh-ed25519 AAAA... you@example.com"'
```

If you created a non-root account, verify it in a **new terminal**, then harden
SSH. If you are using root, skip both steps:

```sh
ssh orangelab@<vps-ip> 'id -u; sudo -n true'
ssh orangelab@<vps-ip> 'sudo bash /root/public-proxy/harden-ssh.sh orangelab'
```

Keep the first session open until the second works. If you lock yourself out,
use the provider's console and remove
`/etc/ssh/sshd_config.d/99-public-proxy.conf`.

Open the same ports as the firewall phase in the provider's cloud firewall, if
it has one. If you enable IPv6, open `80/tcp` and `443/tcp` for IPv6 there too.

### Optional: SSH over the tailnet only

After key login and the tailnet work, you can stop exposing SSH publicly. This is
optional; keep the provider console as the fallback.

On Debian/Ubuntu:

```sh
sudo ufw delete allow <ssh-port>/tcp
sudo ufw allow in on tailscale0 to any port <ssh-port> proto tcp
```

On Fedora, the firewall phase already trusts the tailnet source; remove the
public SSH port (and the default `ssh` service, if it is enabled):

```sh
sudo firewall-cmd --permanent --remove-port=<ssh-port>/tcp
sudo firewall-cmd --permanent --remove-service=ssh
sudo firewall-cmd --reload
```

Then connect to the VPS's tailnet address (or MagicDNS name) instead of its public
IP. `80/tcp` and `443/tcp` stay public; only SSH moves to the tailnet.

## 2. Join the tailnet

Choose the control-plane node name before creating the key. The default is
`proxy`; use `proxy-<location>` if you run proxies in more than one place.
This is the name used for `ssh <user>@proxy` over the tailnet and in the
exit-node list; it does not change the VPS OS hostname. Pass it as
`--hostname`.

### Headscale

Create a single-use tagged pre-auth key from the repository checkout:

```sh
# Default: the proxy is a service node identified by tag:proxy
./components/network/headscale/exec-headscale.sh preauthkeys create \
  --tags tag:proxy --expiration 1h

# Optional: also mark it with an installation-wide tag
./components/network/headscale/exec-headscale.sh preauthkeys create \
  --tags tag:proxy,tag:orangelab --expiration 1h
```

A tags-only key registers the VPS as a service node owned by
`tagged-devices`, not by a person. Headscale v0.29.5 supports tags-only keys
without a `tagOwners` policy; if you add a policy later, include `tag:proxy`
(and any optional tag) in its rules. If your Headscale version requires a
user-owned key, or you
explicitly want the proxy under a person's account, use
`--user <numeric-user-id>` and omit `--tags`. `--user` takes the numeric ID,
not the username.

### Tailscale

Define every tag you will apply in the tailnet policy before creating the key.
For example (only the default tag is shown; add a `tag:orangelab` entry here if
you select it):

```json
{
    "tagOwners": {
        "tag:proxy": ["group:admin"]
    }
}
```

Use the group or user that should own proxy keys. Then open the Tailscale admin
console, go to **Settings → Keys → Generate auth key**, and select `tag:proxy`
(and `tag:orangelab` if you use it; every selected tag must be defined). Set a
short expiry, such as one hour. Tailscale auth keys are not created with the
Headscale CLI.

### Store and use the key

The console or CLI prints the key once. Put it in a root-only temporary file and
pass that file to `tailscale up --auth-key file:...`. Do not pass the key as an
argument, and do not rely on `sudo` preserving `TS_AUTHKEY`; `sudo` may strip it
and the join silently falls back to interactive login.

```sh
ssh orangelab@<vps-ip>
read -rsp 'Auth key: ' TS_AUTHKEY; echo
printf '%s\n' "$TS_AUTHKEY" | sudo sh -c 'umask 077; cat > /run/public-proxy-authkey'
unset TS_AUTHKEY

# Headscale
sudo tailscale up \
  --login-server https://<headscale-host> \
  --hostname <node-name> \
  --auth-key file:/run/public-proxy-authkey

# Tailscale uses the default control plane; omit --login-server
sudo tailscale up \
  --hostname <node-name> \
  --auth-key file:/run/public-proxy-authkey

sudo rm -f /run/public-proxy-authkey
```

Prefer tags on the auth key; do not rely on `--advertise-tags` to add them. If
`sudo` prompts, use `ssh -t` and run the join interactively. Use a single-use
key where the CLI or console offers it, and delete the local copy after the
node joins.

### Verify the join

```sh
sudo tailscale status
sudo tailscale ip -4
sudo tailscale ping <tailnet-ip>   # prefer "direct", not "via DERP"
getent hosts <traefik-node>     # optional, if MagicDNS is configured
curl -sS -o /dev/null -w '%{http_code}\n' \
  --resolve <host>:10443:<tailnet-ip> https://<host>:10443/
```

Confirm the proxy is tagged:

- **Headscale:** run
  `./components/network/headscale/exec-headscale.sh nodes list`. The node should
  appear under `tagged-devices` with the selected tags (at least `tag:proxy`).
- **Tailscale:** check the machine in the admin console, or inspect
  `tailscale status --json` and confirm `Self.Tags` contains every selected tag
  (at least `tag:proxy`).

The `curl` command checks the public gateway over the tailnet before HAProxy is
involved. A `404` means the app is not public or the route has not reconciled;
a timeout means the tailnet, ACL, or node firewall is wrong.

If you use ACLs, allow this node to reach the Traefik nodes on `10443` and
nothing else. On Tailscale, also add the exit-node grant described in
[Optional: exit node](#5-optional-exit-node) if you enable it. The exit node
needs forwarding, not broader tailnet access.

## 3. Configure HAProxy

Find the nodes that serve the Traefik public gateway:

```sh
kubectl get nodes -l svccontroller.k3s.cattle.io/enablelb=true
kubectl get nodes -o wide
kubectl get pods -n kube-system -o wide | grep svclb-traefik
```

`InternalIP` in `kubectl get nodes -o wide` is the tailnet address. Use at least
two nodes if you have them:

```sh
ssh orangelab@<vps-ip> 'sudo bash /root/public-proxy/configure-haproxy.sh \
  --domain example.com \
  --upstream node-a=<tailnet-ip-a>:10443 \
  --upstream node-b=<tailnet-ip-b>:10443'
```

Add `--ipv6` only if the provider supports a public IPv6 address and you want
dual-stack. The script checks for a public IPv6 address and default route, then
renders `bind [::]:80 v4v6` and `bind [::]:443 v4v6`; without the flag, it stays
IPv4 only. The tailnet upstreams remain IPv4 addresses.

The script renders
[`scripts/public-proxy/haproxy.cfg.template`](../scripts/public-proxy/haproxy.cfg.template),
validates it with `haproxy -c`, backs up the previous config, and reloads.

What the config does:

| Port             | Behaviour                                                                            |
| ---------------- | ------------------------------------------------------------------------------------ |
| `80/tcp`         | Redirects your domain (apex and subdomains) to HTTPS; everything else gets `404`     |
| `443/tcp`        | Reads SNI, forwards your domain to Traefik `10443`, rejects names outside the domain |
| `127.0.0.1:8404` | Read-only HAProxy stats, reachable only through an SSH tunnel                        |

Health checks fail over between upstreams. TLS is never terminated at the VPS.

Inspect it:

```sh
# On the VPS
sudo haproxy -c -f /etc/haproxy/haproxy.cfg
sudo systemctl status haproxy
sudo journalctl -u haproxy -n 50 --no-pager

# From your workstation, then open http://localhost:8404/stats
ssh -L 8404:127.0.0.1:8404 orangelab@<vps-ip>
```

The stats frontend is served at `/stats` (or `/stats;csv`). The root URL
`http://localhost:8404/` is not configured and may return `503`; that does not
indicate an unhealthy proxy.

## 4. Verify before DNS

From the VPS:

```sh
sudo bash /root/public-proxy/verify.sh \
  --domain example.com \
  --host app.example.com \
  --host example.com
```

Add `--ipv6` to also check the IPv6 listeners and `[::1]`. If you enabled IPv6,
pass the VPS address too:

```sh
sudo bash /root/public-proxy/verify.sh \
  --domain example.com \
  --host app.example.com \
  --host example.com \
  --ipv6 --vps-ip6 <vps-ipv6>
```

From a network outside your home and outside the VPS:

```sh
curl -sS -o /dev/null -w '%{http_code} %{remote_ip}\n' \
  --resolve app.example.com:443:<vps-ip> https://app.example.com/

curl -sSI --resolve app.example.com:80:<vps-ip> http://app.example.com/

openssl s_client -connect <vps-ip>:443 -servername app.example.com </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -ext subjectAltName
```

If IPv6 is enabled, repeat from an IPv6-capable network:

```sh
curl -g -6 -sS -o /dev/null -w '%{http_code} %{remote_ip}\n' \
  --resolve app.example.com:443:[<vps-ipv6>] https://app.example.com/

openssl s_client -connect [<vps-ipv6>]:443 -servername app.example.com </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -ext subjectAltName
```

An external IPv6 check is required before publishing AAAA records, but it is
not a prerequisite for an IPv4 A-record cutover. If IPv6 has not been verified,
move the A records and leave AAAA records absent; IPv6-capable clients will use
IPv4. Add AAAA records only after the IPv6 path passes.

Expect:

- the cluster wildcard certificate, not a certificate issued by the VPS;
- a permanent redirect from HTTP to HTTPS;
- a name **outside** the configured domain is rejected, not proxied (an
  unconfigured subdomain is forwarded to Traefik and gets its `404`);
- the expected response for each hostname;
- the response comes from the VPS public IP (`remote_ip`);
- Traefik and the application see the VPS tailnet IP as the client — this is the
  current limitation, not a fault.

Test every hostname you plan to move, including the apex. If the apex is
public, Caddy continues to serve `https://example.com/.well-known/webfinger`
through the proxy exactly as it did before.

## 5. Optional: exit node

Decide this explicitly before you start: the proxy phases do **not** enable an
exit node. Enable it only if other tailnet machines should route internet
traffic through the VPS. It adds bandwidth and CPU use, and a datacenter IP may
be blocked by streaming or banking services.

```sh
ssh orangelab@<vps-ip> 'sudo bash /root/public-proxy/exit-node.sh'
```

IPv4 is the default. Add `--ipv6` only when the VPS has a public IPv6 address
and you want clients to route IPv6 through it:

```sh
ssh orangelab@<vps-ip> 'sudo bash /root/public-proxy/exit-node.sh --ipv6'
```

On Fedora, the script adds `tailscale0` to the firewalld `trusted` zone and
enables masquerade. With `--ipv6` it also adds the IPv6 masquerade rule, reloads
firewalld and restarts `tailscaled` (a firewalld reload can drop Tailscale's
nftables rules). `--disable` removes those rules, stops advertising and turns
IP forwarding back off. If traffic still fails, check
`firewall-cmd --list-all-zones` and `nft list ruleset`.

### Approve in Headscale

Approve the routes from the repository checkout. Approve `0.0.0.0/0` always;
approve `::/0` only if you ran the script with `--ipv6`:

```sh
# IPv4 only (default)
./components/network/headscale/exec-headscale.sh nodes approve-routes \
  --identifier <node-id> --routes 0.0.0.0/0

# IPv4 + IPv6
./components/network/headscale/exec-headscale.sh nodes approve-routes \
  --identifier <node-id> --routes 0.0.0.0/0,::/0
```

Headscale may list `::/0` as available even when IPv6 forwarding is off. Leave
it unapproved unless the VPS has a working public IPv6 path. If it was
previously approved, re-approve with only `0.0.0.0/0` to remove the IPv6 route.

Check the result with:

```sh
./components/network/headscale/exec-headscale.sh nodes list-routes \
  --identifier <node-id>
```

### Approve in Tailscale

Tailscale uses its admin console instead of the Headscale CLI:

1. Open **Machines**, select the proxy, and allow it as an exit node.
2. If you use a custom tailnet policy, add a grant whose destination is
   `autogroup:internet`. Granting access to the proxy device itself is not
   enough; that only permits connections to the proxy.
3. The script already runs `sudo tailscale up` on Tailscale. If the node still
   does not appear, refresh the admin console; for a manual setup, run
   `sudo tailscale up` once after `tailscale set --advertise-exit-node`.

The node appears as an exit node in clients only after it joins, advertises the
route, and the control plane approves it. For Headscale, an unapproved route is
the usual cause; for Tailscale, check the machine's exit-node setting and the
policy grant.

From a client:

```sh
tailscale set --exit-node <node-name>
curl -s https://ifconfig.me   # should print the VPS public IP
curl -6 -s https://ifconfig.co # only if IPv6 was enabled
tailscale set --exit-node=    # switch back
```

Disable advertisement with
`ssh orangelab@<vps-ip> 'sudo bash /root/public-proxy/exit-node.sh --disable'`,
then switch clients back before deleting the node.

## 6. Switch DNS

Do this only after every hostname passes the IPv4 pre-DNS checks. DNS is a
manual step; the setup scripts do not change it. IPv6 verification gates only
AAAA records, not the IPv4 A-record cutover.

### Tailscale control path

With Tailscale, the VPS uses Tailscale's SaaS control plane. There is no
self-hosted control hostname to pin and no `/etc/hosts` bootstrap entry. The
home `443` forward is not part of the proxy's control path; keep it if you want
the manual DNS fallback to home to keep working, or if another service still
needs it.

### Headscale control bootstrap

The VPS's Headscale control URL is `https://headscale.<domain>`. If that name
resolves to the VPS, a reboot or reconnect cannot fetch the control key:
HAProxy needs the tailnet to reach Headscale, and Tailscale needs Headscale to
bring the tailnet up.

With a reasonably stable home IPv4, keep the home `443` forward and pin the
VPS's own view of the name to the home address:

```sh
echo '<home-ipv4> headscale.<domain> # public-proxy control bootstrap' \
  | sudo tee -a /etc/hosts
getent hosts headscale.<domain>   # must show the home IPv4
sudo systemctl restart tailscaled
```

If the marked line already exists, edit it instead of appending a second line.

Then public `headscale` DNS can point at the VPS. The VPS keeps using the home
path for control; HAProxy serves everyone else. If the VPS fails, point DNS
back to home. If the home IP changes, update this pin and the fallback DNS
record manually. If you do not want a home path, leave `headscale` at home or
use a separate control endpoint instead.

For **each public hostname**, create an A record. Add an AAAA record only after
the external IPv6 path passes. `Name` is relative to the zone; use `@` for the
apex.

| Type   | Name        | Value        | When                                  |
| ------ | ----------- | ------------ | ------------------------------------- |
| `A`    | `@` (apex)  | `<vps-ipv4>` | always                                |
| `AAAA` | `@` (apex)  | `<vps-ipv6>` | only after external IPv6 verification |
| `A`    | `www`       | `<vps-ipv4>` | if `www` is public                    |
| `AAAA` | `www`       | `<vps-ipv6>` | public and externally verified IPv6   |
| `A`    | `headscale` | `<vps-ipv4>` | Headscale only, after the control pin |
| `AAAA` | `headscale` | `<vps-ipv6>` | pin and externally verified IPv6      |
| `A`    | `app`       | `<vps-ipv4>` | per public subdomain                  |
| `AAAA` | `app`       | `<vps-ipv6>` | per public host, externally verified  |

For example, for `example.com`, `www.example.com`, `headscale.example.com`
and `app.example.com`. The `headscale` rows apply only when the cluster uses
Headscale; with Tailscale, skip them.

```dns
@          300 IN A    <vps-ipv4>
@          300 IN AAAA <vps-ipv6>    ; only after external IPv6 verification
www        300 IN A    <vps-ipv4>
www        300 IN AAAA <vps-ipv6>    ; only after external IPv6 verification
headscale  300 IN A    <vps-ipv4>
headscale  300 IN AAAA <vps-ipv6>    ; only after external IPv6 verification
app        300 IN A    <vps-ipv4>
app        300 IN AAAA <vps-ipv6>    ; only after external IPv6 verification
```

Rules:

- If the provider does not route a public IPv6 address, do not add AAAA
  records. Delete stale AAAA records so dual-stack clients do not try a dead
  path.
- Use the VPS's **global** IPv6 address for AAAA, never the Tailscale `fd7a:`
  address.
- If a wildcard is shared with private/tailnet names, do not add a wildcard AAAA
  record. Add explicit AAAA records only for the public hostnames.
- A records must point at the VPS after the IPv4 cutover. AAAA records are
  optional and must point at the VPS only after external IPv6 verification; do
  not add an unverified AAAA record.
- If the DNS provider has a CDN/proxy toggle (for example Cloudflare's orange
  cloud), set these names to DNS-only. HAProxy passes TLS through; a CDN would
  terminate it. If you do not use Cloudflare or a CDN, skip this.
- Leave the wildcard record used by private/tailnet names untouched.
- **Headscale only:** the `/etc/hosts` control pin must be in place before
  moving `headscale`.
- Keep the home `443` forward if the home path is your manual fallback.
  Headscale also needs it for control; Tailscale does not, but without it the
  DNS fallback cannot serve. If you do not want a home path, leave `headscale`
  DNS at home for Headscale, or accept that Tailscale has no home fallback.

### Manual cutover checklist

- [ ] Check each record's current TTL. If it is above 300 seconds, lower it to
      300 at least one old TTL before cutover. If it is already 300 or lower,
      no TTL change is needed.
- [ ] **Headscale only:** pin the VPS's control hostname to the current home
      IPv4 and verify it with `getent hosts headscale.<domain>`, then restart
      `tailscaled`.
- [ ] Add one A record per public hostname, pointing at `<vps-ipv4>`.
- [ ] Add AAAA records only for public hostnames and only if IPv6 is enabled.
- [ ] **Headscale only:** add the `headscale` records after the control pin
      works.
- [ ] If using Cloudflare or another CDN, set these records to DNS-only.
- [ ] Leave private/tailnet wildcard records unchanged.
- [ ] Flush Technitium, the local resolver (`resolvectl flush-caches`), and the
      browser if needed. A local router or resolver may continue returning the
      old A record until its cached TTL expires.
- [ ] Verify authoritative A/AAAA answers. Use `dig @<authoritative-nameserver>`
      and `curl --resolve` to test the new VPS while local DNS is stale.
- [ ] Verify IPv4 HTTPS after the A cutover. Verify IPv6 HTTPS separately before
      adding AAAA records:

    ```sh
    dig +short app.example.com A @<authoritative-nameserver>
    dig +short app.example.com AAAA @<authoritative-nameserver>
    curl -4 -sSI https://app.example.com/
    curl -6 -sSI https://app.example.com/
    ```

- [ ] Keep the home forward if you want the manual fallback; Headscale also
      needs it for control.

The apex and `www` records move to the VPS too if they are public. Their
content still comes from Caddy in the cluster.

### Move DNS back to home

If the VPS fails, move the affected records back to the home IPv4 (and IPv6,
if it is public). This is manual disaster recovery, not an automatic failover:

1. Change the A/AAAA records for the moved names to the home addresses, or to
   another proxy on the same control plane with an independent control path.
2. Wait for the 300-second TTL and flush the local resolver.
3. Verify authoritative answers and both HTTPS paths from outside.
4. Keep the home `443` forward available if the home path is the fallback;
   without it the fallback cannot serve. Headscale also needs it for control.
5. **Headscale only:** if the home IP changed while the VPS was down, update
   the VPS's `/etc/hosts` control pin before moving DNS back to the VPS.

The home IP does not need to be truly static, but it must be stable enough that
you can update the pin and fallback records manually when it changes.

### If the home IP changes (Headscale only)

With Tailscale, the VPS control path is Tailscale's SaaS and does not depend on
the home IP. This section applies only to Headscale.

The proxy does not necessarily fail immediately. The existing Tailscale control
connection can survive for a while, so public traffic may keep working. Treat
the next Tailscale reconnect, reboot, or Headscale restart as the failure point:
once `tailscaled` retries the stale pin, it cannot reach Headscale, and HAProxy
loses its upstream.

If the VPS is still reachable on its public SSH port:

1. Edit the marked line in `/etc/hosts`; do not add a second line:

    ```text
    <new-home-ipv4> headscale.<domain> # public-proxy control bootstrap
    ```

2. Verify the new address and restart Tailscale:

    ```sh
    getent hosts headscale.<domain>   # must show the new home IPv4
    sudo systemctl restart tailscaled
    tailscale status
    ```

3. Confirm the proxy is serving again, for example with the pre-DNS check or a
   public request.

If `tailscaled` has already logged out, SSH on the public IP still works because
SSH does not use the tailnet. If public SSH was closed, use the provider
console. If the VPS itself is down, use the DNS fallback above first, then
update the pin when the VPS returns.

Before DNS cutover, the public records still point home, so also update their
A/AAAA values. After cutover, only the VPS control pin depends on the home IP;
the public records point at the VPS.

## 7. Operate

- Update HAProxy and Tailscale with the OS package manager. HAProxy is the
  distribution package, so security updates are normal.
- After a reboot, HAProxy can return `503` until Tailscale reconnects and its
  health check marks the upstream `UP`; this is expected. If it stays down,
  check `tailscaled` and the tailnet route. If `tailscale status` says it is
  logged out:
    - **Headscale:** check the `/etc/hosts` control pin from
      [Switch DNS](#6-switch-dns) and
      `sudo tailscale debug prefs | jq -r .ControlURL`. A control URL that
      resolves back to this VPS is the self-dependency loop.
    - **Tailscale:** check outbound connectivity to the Tailscale control plane;
      there is no local pin to repair.
- Watch `sudo systemctl status haproxy`, `sudo journalctl -u haproxy`, the stats
  page, and the provider's bandwidth graph.
- Upgrade the VPS if CPU stays above ~70%, memory above ~80%, or bandwidth
  above ~80% of the quota.
- Back up `/etc/haproxy/haproxy.cfg`. The Tailscale node key lives in
  `/var/lib/tailscale/tailscaled.state`; a rebuilt VPS rejoins with a new key,
  and the old node is deleted from the control plane.
- To move providers: build the new VPS with this guide, verify with
  `--resolve`, switch DNS, then delete the old node from the control plane.

### Multiple proxies

Run the same setup on each VPS. A proxy admits its configured domain, so
pointing a hostname's A record at a particular VPS is what selects the proxy
for that service; Traefik still decides whether the hostname has a public
route. Use separate domains or per-hostname ACLs if you want a proxy to admit
only a subset. Keep the upstream lists identical unless you are splitting by
cluster as well.

For Headscale, every proxy that uses the public `headscale` hostname needs its
own `/etc/hosts` control pin to the home address (or another control path that
does not depend on itself). For Tailscale, there is no control pin. DNS
fallback to a second proxy only works if that proxy can still reach the control
plane when the first one is down.

## Limitations and TODO

- **Client IP:** Traefik sees the VPS's tailnet IP, not the real client IP.
  **TODO:** send PROXY protocol v2 from HAProxy to a dedicated Traefik entrypoint
  with `proxyProtocol.trustedIPs`, or terminate TLS at the proxy and forward
  `X-Forwarded-For`. Both need a Traefik change and are not implemented.
- **HTTP/3:** not carried; HAProxy forwards TCP `443`, so clients use HTTP/2.
- **`3443/tcp`:** not exposed yet. It is a TLS passthrough to Traefik's `3443`
  listener; add a frontend/backend pair when needed.
- **Edge HTTP features:** no request logs, WAF, or rate limiting at the VPS.
- **Plain DNS `53`:** not exposed. The eventual resolver path is DoT
  (`853/tcp`) or DoH; both are TODO. If Technitium becomes authoritative for a
  public zone, that is a separate design with rate limiting and DDoS protection.
- **Single point of failure:** one VPS carries every moved hostname and is a
  DDoS target. Run separate proxies if isolation matters.

## Troubleshooting

| Symptom                                           | Check                                                                                                                                                                                  |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connection reset or TLS handshake fails (HAProxy) | Upstream tailnet IP/port, Traefik ServiceLB pod on that node, node firewall                                                                                                            |
| `503` from Traefik                                | Public route exists but the application has no ready endpoints                                                                                                                         |
| TLS handshake fails                               | SNI ACL, upstream speaks TLS on `10443`                                                                                                                                                |
| `404` from Traefik                                | App not `network/public`, Host mismatch, route not reconciled                                                                                                                          |
| Unknown subdomain gets `404`                      | Expected: HAProxy admits the domain; Traefik has no public route for that name                                                                                                         |
| A name outside the domain is accepted             | ACL matches too broadly; it must be exact apex + `.example.com`                                                                                                                        |
| HAProxy will not start                            | `haproxy -c`, port `80`/`443` already bound, `/run/haproxy` permissions. On Fedora, rerun `01-install.sh` if `/run/haproxy` is missing; it adds the systemd `RuntimeDirectory` drop-in |
| DNS still reaches the old IP                      | TTL, Technitium cache, local resolver, stale AAAA                                                                                                                                      |
| Proxy returns `503` after the home IP changes     | Headscale only: the VPS control pin is stale; edit `/etc/hosts`, verify with `getent hosts`, restart `tailscaled`                                                                      |
| IPv6 clients fail                                 | Provider has no public IPv6, HAProxy was configured without `--ipv6`, cloud firewall blocks IPv6 `80`/`443`, or AAAA is missing/stale                                                  |
| High latency / low throughput                     | `sudo tailscale ping <tailnet-ip>` shows DERP; check `41641/udp` and NAT                                                                                                               |
| Tailscale breaks DNS on the VPS                   | Join with `--accept-dns=false`, or fix the control-plane DNS; HAProxy already uses pinned tailnet IPs                                                                                  |
| Tailscale key joins an untagged node              | Define every selected tag in `tagOwners`; create a new key with those tags                                                                                                             |
| Exit node carries no traffic                      | Route approved in the control plane, IP forwarding on, client selected the node                                                                                                        |
| Tailscale exit node is not selectable             | Allow it as an exit node in the admin console; with a custom policy, grant `autogroup:internet`                                                                                        |
| Exit node carries no traffic on Fedora            | `tailscale0` in the `trusted` zone, masquerade on, IPv6 masquerade rule if `--ipv6`, then `firewall-cmd --reload` and `systemctl restart tailscaled`                                   |
| HAProxy cannot bind or connect on Fedora          | `getsebool haproxy_connect_any`; enable with `setsebool -P haproxy_connect_any 1`                                                                                                      |
| sshd ignores the hardening drop-in on Fedora      | `restorecon -RF /etc/ssh/sshd_config.d`, then `sshd -T`; ensure the main config includes the directory                                                                                 |
| Automatic updates are not running on Fedora       | `systemctl status dnf5-automatic.timer` (Fedora 41+) or `dnf-automatic.timer`; check `/etc/dnf/automatic.conf`                                                                         |
| A phase script refuses the distribution           | Use the matching `ubuntu/` or `fedora/` phase, or follow the manual checklist above                                                                                                    |
| Client IP is the tailnet IP                       | Expected; see the client-IP TODO above                                                                                                                                                 |
