# Public proxy on a VPS

This page is the operator overview. The setup itself is handled by your
agent's public-proxy workflow.

This is the VPS method. For the router port-forward alternative and when public
access is required, see [Public services](./public-services.md).

Start here:

```sh
opencode
```

Then ask:

```text
setup public proxy
```

Use your preferred agent harness if it is not OpenCode. The agent will ask for
the VPS address, SSH account, control plane, and whether you want an exit node
or TCP forwards. It prepares the VPS, joins it to the tailnet, configures
HAProxy, and verifies the path. DNS cutover and cloud-provider firewall changes
remain manual.

If you are not using an agent, the commands below are only an outline, not a
complete runbook; the full operational detail is in
[`spec/public-proxy.md`](../spec/public-proxy.md).

## What it does

A VPS outside the cluster joins the same tailnet as the cluster and forwards
public HTTP(S) by TLS SNI to Traefik's public gateway. It can also forward
explicit raw TCP ports.

```text
Internet -> VPS HAProxy :80/:443 -> tailnet -> Traefik :10443 -> app
```

TLS stays end-to-end. The VPS holds no certificates, kubeconfig, DNS tokens, or
application data. Public DNS points at the VPS, so the home IP is not published.

Use it when:

- you expose services with `<app>:network/public true`;
- you do not want to forward WAN `443` to your router;
- you want a public address that survives a changing home IP.

It is not DDoS protection, and it is not a way to hide outbound traffic. The
optional exit node is separate. Keep media services on the tailnet.

## Requirements

- Ubuntu 26.04 LTS, Debian 13, or Fedora 44 VPS with a static public IPv4.
  Other systemd distributions work manually; see the spec.
- A Headscale or Tailscale auth key. Every Traefik node must be on the same
  tailnet.
- One or more cluster nodes running the Traefik public gateway on `10443`
  (the ServiceLB nodes).
- DNS access and provider firewall access.
- Decide: node name (`proxy` or `proxy-<location>`), tag (`tag:proxy`, plus
  `tag:orangelab` if used), and whether to enable an exit node.
- IPv4 is the default. IPv6 is optional and only after an external check.

## What your agent will do

The commands are examples; the agent fills in the actual values. You do not need
to run them yourself.

### 1. Prepare the host

Copies `scripts/public-proxy` to the VPS and runs the OS phase scripts:

```sh
scp -r scripts/public-proxy <user>@<vps-ip>:/tmp/
ssh <user>@<vps-ip> 'sudo bash /tmp/public-proxy/<os>/01-install.sh'
ssh <user>@<vps-ip> 'sudo bash /tmp/public-proxy/create-user.sh --user orangelab'
ssh <user>@<vps-ip> 'sudo bash /tmp/public-proxy/<os>/02-firewall.sh'
ssh <user>@<vps-ip> 'sudo bash /tmp/public-proxy/<os>/03-updates.sh'
# after verifying the new account in a new terminal
ssh orangelab@<vps-ip> 'sudo bash /tmp/public-proxy/harden-ssh.sh orangelab'
```

This installs HAProxy, Tailscale, the firewall, and automatic updates; creates
the non-root account; opens SSH, `80/tcp`, `443/tcp`, `41641/udp`, and any
requested TCP ports; then verifies the new account and hardens SSH.

### 2. Join the tailnet

Creates a tagged auth key, joins the VPS, and verifies the tailnet path:

```sh
sudo tailscale up --login-server https://<headscale-host> \
  --hostname <node-name> --auth-key file:/run/public-proxy-authkey
sudo tailscale status
```

For Tailscale, the `--login-server` flag is omitted. The agent also checks the
node tag and that the VPS can reach Traefik on `10443` before HAProxy is used.

### 3. Configure HAProxy

Finds the Traefik ServiceLB nodes and renders the passthrough config:

```sh
kubectl get nodes -l svccontroller.k3s.cattle.io/enablelb=true
ssh orangelab@<vps-ip> 'sudo bash /tmp/public-proxy/configure-haproxy.sh \
  --domain example.com \
  --upstream node-a=<tailnet-ip-a>:10443 \
  --upstream node-b=<tailnet-ip-b>:10443'
```

HAProxy accepts only the configured domain and forwards it to Traefik by SNI.
Unknown SNI is rejected. TLS is not terminated at the VPS.

For a raw TCP service, add one forward per upstream:

```sh
# add to the configure-haproxy.sh command above, once per upstream
--tcp-forward 8333=bitcoin-p2p=<tailnet-ip-a>:18333
```

A public TCP port is published at `<port> + 10000`; the proxy forwards the
public port to that offset. Raw TCP has no SNI or host filter, so only add ports
that are meant to be public. Never forward a database, RPC, admin, or metrics
port.

### 4. Verify

On the VPS, checks the local listener, upstream, certificate, and HTTP redirect
before DNS:

```sh
sudo bash /tmp/public-proxy/verify.sh --domain example.com \
  --host app.example.com --host example.com
```

From outside the home and VPS:

```sh
curl -sS -o /dev/null -w '%{http_code} %{remote_ip}\n' \
  --resolve app.example.com:443:<vps-ip> https://app.example.com/
openssl s_client -connect <vps-ip>:443 -servername app.example.com </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -ext subjectAltName
```

Expect the VPS IP and the cluster wildcard certificate. IPv6 is checked
separately before AAAA records are added. Full checks are in the spec.

### 5. Optional: exit node

If requested, advertises the VPS as an exit node:

```sh
ssh orangelab@<vps-ip> 'sudo bash /tmp/public-proxy/exit-node.sh'
```

The route must then be approved in Headscale or Tailscale. IPv4 is the default;
`--ipv6` adds IPv6 forwarding and requires `::/0` approval.

## What you still do manually

### Cloud firewall

Open the same ports in the provider firewall: SSH, `80/tcp`, `443/tcp`,
`41641/udp`, and any public TCP forwards. IPv6 rules may be separate.

### DNS cutover

After your agent verifies the proxy, add these records:

| Type   | Name                             | Value        | Notes                                            |
| ------ | -------------------------------- | ------------ | ------------------------------------------------ |
| `A`    | `@`                              | `<vps-ipv4>` | Apex                                             |
| `A`    | `www`                            | `<vps-ipv4>` | If `www` is public                               |
| `A`    | `headscale`                      | `<vps-ipv4>` | Headscale only; set the control pin first        |
| `A`    | `login`                          | `<vps-ipv4>` | Pocket ID; use `pocket` if that is your hostname |
| `AAAA` | `@`, `www`, `headscale`, `login` | `<vps-ipv6>` | Only after external IPv6 verification            |

Set CDN/proxy records to DNS-only. Leave private/tailnet wildcards untouched.
If the VPS fails, move these records back to home; move raw TCP forwards and
any advertised `externalip` too.

## Where the details live

- [`spec/public-proxy.md`](../spec/public-proxy.md): invariants, OS support,
  DNS traps, verification matrix, failure modes.
- [`.agents/skills/expose-via-vps/SKILL.md`](../.agents/skills/expose-via-vps/SKILL.md):
  the agent's public-proxy instructions.
- `scripts/public-proxy/` and each script's `--help`: exact command options.

## Caveats

- Traefik sees the VPS's tailnet IP, not the real client IP.
- One VPS is a single point of failure.
- HTTP/3 is not carried; clients use HTTP/2.
- Plain DNS `53` is not exposed.
