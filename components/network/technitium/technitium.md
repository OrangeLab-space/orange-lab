# Technitium DNS

| Resource              | Link                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| Homepage              | https://technitium.com/dns/                                                                         |
| Source code           | https://github.com/TechnitiumSoftware/DnsServer                                                     |
| Documentation         | https://technitium.com/help/                                                                        |
|                       | https://pocket-id.org/docs/client-examples/technitium-dns                                           |
| Environment variables | https://raw.githubusercontent.com/TechnitiumSoftware/DnsServer/master/DockerEnvironmentVariables.md |
| Endpoint              | https://dns.<domain>                                                                                |

Technitium DNS Server is an open source authoritative as well as recursive DNS server that can be used for self hosting a DNS server for privacy & security.

## Features

- Authoritative and recursive DNS server
- Built-in ad blocking (similar to Pi-hole)
- DNS-over-TLS (DoT) and DNS-over-HTTPS (DoH) support
- Web-based management interface
- Custom DNS zones and conditional forwarding

## Prerequisites

Before deploying Technitium:

1. **Configure systemd-resolved** to free up port 53:

```sh
sudo mkdir -p /etc/systemd/resolved.conf.d/
sudo tee /etc/systemd/resolved.conf.d/dns.conf <<EOF
[Resolve]
DNS=1.1.1.1 # default to CloudFlare DNS instead of ISP DNS assigned by DHCP
DNSStubListener=no # release DNS port
EOF
sudo systemctl restart systemd-resolved

# Verify port 53 is free (should not show 127.0.0.53:53)
ss -tlnp | grep ':53'
```

2. **Label the node** that will run Technitium DNS through ServiceLB:

```sh
kubectl label node <node> svccontroller.k3s.cattle.io/enablelb=true
```

This is required to ensure Technitium runs on a specific node with port 53 available. Without this label, the deployment may fail on any node where port 53 is already in use.

## Quick start

```sh
# Required
pulumi config set technitium:enabled true

# (Optional) Hostname for web UI access (default: dns)
pulumi config set technitium:hostname dns

# (Optional) Storage size for configuration (default: 5Gi)
pulumi config set technitium:storageSize 5Gi

pulumi up

# (Recommended) Set admin password for web console (auto-generated if not set)
export ADMIN_PASSWORD=$(pulumi stack output --json --show-secrets | jq -r '.technitiumUsers.admin')
pulumi config set technitium:adminPassword $ADMIN_PASSWORD --secret
```

## Configuration

**Environment Variables vs. Web UI:**
Once Technitium has initialized and saved its configuration to the persistent volume, subsequent environment variable changes are ignored. The application prioritizes the stored configuration over env vars to prevent accidental configuration drift on pod restarts. To change settings like forwarders or domain, use the web UI at `https://dns.<domain>` or delete the persistent volume to re-initialize from scratch.

```sh
# (Optional) DNS forwarders - comma-separated list of IP:port
# More info https://blog.technitium.com/2018/06/configuring-dns-server-for-privacy.html
# Examples:
#   "1.1.1.1,8.8.8.8" - CloudFlare and Google via UDP (with protocol=Udp)
#   "1.1.1.1:853,9.9.9.9:853" - CloudFlare and Quad9 via TLS (with protocol=Tls)
#   "<nextdns_id>.dns.nextdns.io" - NextDNS (requires account)
#   "" - Set to empty to use root DNS servers recursion
pulumi config set technitium:DNS_SERVER_FORWARDERS "<hostname>-<nextdns_id>.dns.nextdns.io"

# (Optional) Forwarder protocol - Udp, Tcp, Tls, Https, HttpsJson (default: Tls)
# Only applies when DNS_SERVER_FORWARDERS is set
pulumi config set technitium:DNS_SERVER_FORWARDER_PROTOCOL Tls
```

Settings in the UI (use after initial deployment):

- Settings -> Proxy & Forwarders -> Forwarders (same as `DNS_SERVER_FORWARDERS`)
- Settings -> Proxy & Forwarders -> Forwarder protocol (same as `DNS_SERVER_FORWARDER_PROTOCOL`)
- Logging -> Enable Logging To -> Both File and Console (output logs to Kubernetes as well, check with `./scripts/logs.sh technitium`)
- Settings -> General -> Enable DNSSEC validation (disable when errors show up in the logs)
- Administration -> SSO Providers (same as [SSO](#sso) below)

## SSO

Technitium supports Single Sign-On via OpenID Connect using [Pocket ID](../../security/pocket/pocket.md), documented in the [Technitium example](https://pocket-id.org/docs/client-examples/technitium-dns). Requires Technitium DNS Server 15.2+ and the [security module](../../security/pocket/pocket.md) (Pocket ID) enabled in this stack.

1. Follow the [Pocket ID](../../security/pocket/pocket.md) instructions, then run the generic Pocket ID client script from the repository root (where the core stack lives) to create the OIDC client:

```sh
./components/network/technitium/pocket-technitium.sh

# Configure the printed values
pulumi config set technitium:auth pocket
pulumi config set technitium:auth/clientId <client-id>
pulumi config set technitium:auth/clientSecret <client-secret> --secret
pulumi up
```

2. Create the user groups in Pocket ID (**Groups -> Create group**) with these exact names - they are mapped in the component and referenced by the `groups` claim; users not in any of them cannot log in:

| Pocket ID group          | Technitium group      |
| ------------------------ | --------------------- |
| `technitium_admins`      | `Administrators`      |
| `technitium_dns_admins`  | `DNS Administrators`  |
| `technitium_dhcp_admins` | `DHCP Administrators` |

Groups that don't apply to your setup stay uncreated; only names that actually exist matter.

> **Important:** the `groups` claim contains the Pocket ID group's **Name** field (machine name), not the optional friendly/display name. For a group displayed as `Admins` with the name `admin`, use `admin:...` in the group map. Use the group's name exactly, case-sensitive.

The group map can be customized (e.g. to reuse existing role groups) with:

```sh
pulumi config set technitium:auth/groupMap 'admin:Administrators'
```

Failed logins with "Access denied" mean the Pocket ID user is not a member of any group listed in the group map. The signup error "SSO authentication succeeded but new user sign up is restricted only to members of mapped groups" additionally appears when the **Scopes** field is missing `groups` - without it the token carries no `groups` claim at all and every user is rejected regardless of membership.

Like the other bootstrap environment variables, SSO is only applied when Technitium initialises from scratch (no config on the volume). Existing installations must configure it instead in the web UI as follows.

### Web UI configuration (Administration -> SSO Providers)

Get the client secret from the stack config first - it is only stored in Pulumi, not readable from the cluster:

```sh
pulumi config get technitium:auth/clientSecret --show-secrets
```

Then enable SSO and fill in these exact fields:

| Field                              | Value                                                               |
| ---------------------------------- | ------------------------------------------------------------------- |
| Enable SSO                         | on                                                                  |
| Authority                          | `https://login.<domain>`                                            |
| Client ID                          | from `pulumi config get technitium:auth/clientId`                   |
| Client Secret                      | from the command above                                              |
| Metadata Address                   | `https://login.<domain>/.well-known/openid-configuration`           |
| Scopes                             | `openid profile email groups` (includes `groups` for the group map) |
| Allow Signup                       | on (auto-provisions accounts on first SSO login)                    |
| Allow Signup Only for Mapped Users | on (only users in a mapped group can log in)                        |
| Group Map                          | `admin:Administrators` (or matching `technitium:auth/groupMap`)     |

Saving restarts the web service; a **Login with SSO** button then appears on the login page.

## Tailscale DNS Configuration

To use Technitium for all DNS queries across your Tailnet:

1. Open [Tailscale Admin Console](https://login.tailscale.com/admin/dns)
2. Navigate to **Nameservers** section
3. Click **Add nameserver** → **Custom**
4. Enter your node's IP address (e.g., `100.x.x.x` - Tailscale IP of host running Technitium)
5. Enable **"Use with Exit node"** option
6. Enable **"Override local DNS"** to use Technitium for all queries, even outside Tailnet
