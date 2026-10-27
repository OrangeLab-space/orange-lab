#!/usr/bin/env bash
set -euo pipefail

# Enable or disable advertising this VPS as a Headscale/Tailscale exit node.
# Run as root. Route approval happens in Headscale or the Tailscale admin
# console; this script only prepares the host and advertises the route.

#
# Usage
#

usage() {
    cat <<EOF
Usage: $0 [--ipv6] [--disable]

Without options, enables IPv4 forwarding and advertises the exit node. IPv6 is
optional: use --ipv6 only when the VPS has a public IPv6 address and the user
wants dual-stack exit-node traffic. --disable stops advertising it.

On Fedora/RHEL, this also configures firewalld (trusted tailscale0, masquerade,
and IPv6 masquerade with --ipv6) and restarts tailscaled so its nftables rules
are re-added. --disable removes those firewalld rules again.

After enabling, approve the route in the control plane:
  Headscale (IPv4 only):
    ./components/network/headscale/exec-headscale.sh nodes approve-routes \
      --identifier <id> --routes 0.0.0.0/0
  Headscale (IPv4 + IPv6, only with --ipv6):
    ./components/network/headscale/exec-headscale.sh nodes approve-routes \
      --identifier <id> --routes 0.0.0.0/0,::/0
  Tailscale:
    Machines -> <node-name> -> Edit exit node -> Use as exit node.

The script detects the control plane from the Tailscale control URL. If it
cannot, it prints both approval paths.
EOF
}

#
# Defaults
#

DISABLE=false
IPV6=false

#
# Arguments
#

while (($# > 0)); do
    case "$1" in
        --ipv6)
            IPV6=true
            shift
            ;;
        --disable)
            DISABLE=true
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
done

#
# Validation
#

if [[ $(id -u) -ne 0 ]]; then
    echo "Run this script as root (or with sudo)." >&2
    exit 1
fi

if ! command -v tailscale >/dev/null 2>&1; then
    echo "Tailscale is not installed. Run the install phase first." >&2
    exit 1
fi

#
# Helpers
#

has_public_ipv6() {
    # Avoid grep -q: with pipefail, an early exit can surface as SIGPIPE.
    ip -6 route show default 2>/dev/null | grep 'dev ' >/dev/null || return 1
    ip -6 -o addr show scope global 2>/dev/null \
        | grep -v 'tailscale0' \
        | grep -E 'inet6 [23][0-9a-fA-F]{3}:' >/dev/null
}

firewalld_active() {
    command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1
}

detect_control_plane() {
    local control_url
    control_url=$(tailscale debug prefs 2>/dev/null \
        | sed -n 's/.*"ControlURL":[[:space:]]*"\([^"]*\)".*/\1/p' \
        | head -n1 || true)
    case "$control_url" in
        *controlplane.tailscale.com*|*login.tailscale.com*) echo tailscale ;;
        "") echo unknown ;;
        *) echo headscale ;;
    esac
}

configure_firewalld() {
    if ! firewalld_active; then
        return
    fi

    echo "==> Configuring firewalld for the exit node"
    firewall-cmd --permanent --zone=trusted --add-interface=tailscale0
    firewall-cmd --permanent --add-masquerade
    if $IPV6; then
        firewall-cmd --permanent --add-rich-rule='rule family=ipv6 masquerade'
    else
        firewall-cmd --permanent --remove-rich-rule='rule family=ipv6 masquerade' || true
    fi
    firewall-cmd --reload
    # A firewalld reload can drop Tailscale's nftables rules; restart to re-add.
    systemctl restart tailscaled
}

remove_firewalld() {
    if ! firewalld_active; then
        return
    fi

    # These rules were added by this script; the VPS is dedicated to the proxy.
    echo "==> Removing firewalld exit-node rules"
    firewall-cmd --permanent --zone=trusted --remove-interface=tailscale0 || true
    firewall-cmd --permanent --remove-masquerade || true
    firewall-cmd --permanent --remove-rich-rule='rule family=ipv6 masquerade' || true
    firewall-cmd --reload
    systemctl restart tailscaled
}

#
# Disable
#

if $DISABLE; then
    # Local cleanup must work even if the node was already removed from the control plane.
    tailscale set --advertise-exit-node=false || true
    remove_firewalld
    if [[ "$(detect_control_plane)" == tailscale ]]; then
        tailscale up || true
    fi
    rm -f /etc/sysctl.d/99-tailscale-exit-node.conf
    sysctl -w net.ipv4.ip_forward=0 >/dev/null
    if [[ -e /proc/sys/net/ipv6/conf/all/forwarding ]]; then
        sysctl -w net.ipv6.conf.all.forwarding=0 >/dev/null
    fi
    cat <<'EOF'
Exit-node advertisement and IP forwarding are disabled.

Switch clients back to their normal route:
  tailscale set --exit-node=

The approved route may remain in the control plane; it no longer serves traffic.
EOF
    exit 0
fi

#
# Preconditions
#

if [[ -z "$(tailscale ip -4 2>/dev/null)" ]]; then
    echo "Tailscale is not up. Join the tailnet first." >&2
    exit 1
fi

CONTROL_PLANE=$(detect_control_plane)

#
# IPv6 validation
#

if $IPV6 && ! has_public_ipv6; then
    echo "IPv6 was requested, but this host has no public IPv6 address and default route." >&2
    echo "Check the provider's IPv6 configuration, or rerun without --ipv6." >&2
    exit 1
fi

#
# Enable forwarding
#

{
    echo "# Public proxy exit node: forward traffic from the tailnet to the internet."
    echo "net.ipv4.ip_forward = 1"
    if $IPV6; then
        echo "net.ipv6.conf.all.forwarding = 1"
    else
        echo "net.ipv6.conf.all.forwarding = 0"
    fi
} >/etc/sysctl.d/99-tailscale-exit-node.conf

#
# Advertise the exit node
#

sysctl --system >/dev/null
tailscale set --advertise-exit-node
configure_firewalld

# Tailscale requires an "up" after the advertise flag was set with
# "tailscale set". Headscale does not need the extra call.
if [[ "$CONTROL_PLANE" == tailscale ]]; then
    tailscale up
fi

#
# Approval instructions
#

ROUTES="0.0.0.0/0"
if $IPV6; then
    ROUTES="0.0.0.0/0,::/0"
fi

echo "Exit-node advertisement enabled ($([[ "$ROUTES" == *::/0* ]] && echo "IPv4 + IPv6" || echo "IPv4 only"))."
echo "Control plane: ${CONTROL_PLANE}"
echo
case "$CONTROL_PLANE" in
    headscale)
        cat <<EOF
Approve the route from the repository checkout (not on the VPS):
  ./components/network/headscale/exec-headscale.sh nodes list-routes
  ./components/network/headscale/exec-headscale.sh nodes approve-routes --identifier <id> --routes $ROUTES
EOF
        ;;
    tailscale)
        cat <<'EOF'
Approve the exit node in the Tailscale admin console:
  Machines -> <node-name> -> Edit exit node -> Use as exit node.
If a custom tailnet policy is active, grant autogroup:internet.
EOF
        ;;
    *)
        cat <<EOF
Could not identify the control plane from Tailscale's ControlURL.
If this is Headscale, approve the route from the repository checkout:
  ./components/network/headscale/exec-headscale.sh nodes list-routes
  ./components/network/headscale/exec-headscale.sh nodes approve-routes --identifier <id> --routes $ROUTES
If this is Tailscale, allow the machine as an exit node in the admin console.
If the node does not appear, run: sudo tailscale up
EOF
        ;;
esac

#
# Client verification
#

cat <<'EOF'

Then from a client:
  tailscale set --exit-node <vps-node-name>
  curl -s https://ifconfig.me   # should print the VPS public IP
  tailscale set --exit-node=    # clear

Exit-node traffic counts against the VPS bandwidth quota, and datacenter IPs
are often blocked by streaming or banking services.
EOF

#
# IPv6 note
#

if ! $IPV6; then
    cat <<'EOF'

IPv6 forwarding is off. Tailscale may still list ::/0 as available; leave it
unapproved. If ::/0 was approved earlier, re-approve with only 0.0.0.0/0 to
remove it. Rerun with --ipv6 only after the provider has a public IPv6 address.
EOF
fi
