#!/usr/bin/env bash
set -euo pipefail

# Phase 2 (Fedora): configure firewalld for the public proxy.
# Opens SSH, HTTP, HTTPS and Tailscale, and trusts the tailnet.
# Run after 01-install.sh and before DNS cutover.

#
# Usage
#

usage() {
    cat <<EOF
Usage: $0 [--ssh-port <port>]

  --ssh-port <port>   SSH port to allow (default: from sshd -T, else 22)
  -h, --help          Show this help
EOF
}

#
# Defaults
#

SSH_PORT=""

#
# Arguments
#

while (($# > 0)); do
    case "$1" in
        --ssh-port)
            [[ $# -ge 2 && -n "$2" ]] || { echo "Missing value for --ssh-port" >&2; exit 2; }
            SSH_PORT=$2
            shift 2
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

if [[ ! -r /etc/os-release ]]; then
    echo "Cannot read /etc/os-release." >&2
    exit 1
fi

# shellcheck source=/dev/null
. /etc/os-release

case "${ID:-}" in
    fedora) ;;
    *)
        echo "This script targets Fedora; detected '${ID:-unknown}'." >&2
        exit 1
        ;;
esac

if ! command -v firewall-cmd >/dev/null 2>&1; then
    echo "firewalld is not installed; run fedora/01-install.sh first." >&2
    exit 1
fi

#
# SSH port
#

if [[ -z "$SSH_PORT" ]]; then
    SSH_PORT=$(sshd -T 2>/dev/null | awk '$1 == "port" { port = $2 } END { if (port != "") print port }') || true
    SSH_PORT=${SSH_PORT:-22}
fi

if [[ ! "$SSH_PORT" =~ ^[0-9]+$ ]]; then
    echo "Invalid SSH port '${SSH_PORT}'." >&2
    exit 2
fi

#
# Configure firewalld
#

echo "==> Configuring firewalld (SSH port ${SSH_PORT})"
systemctl enable --now firewalld

# Fedora's default public zone opens SSH on 22 via the ssh service and enables
# multicast DNS. Add the actual SSH port explicitly and drop the unrelated
# service so a custom --ssh-port does not leave 22 open.
if firewall-cmd --permanent --query-service=ssh >/dev/null 2>&1; then
    firewall-cmd --permanent --remove-service=ssh
fi
if firewall-cmd --permanent --query-service=mdns >/dev/null 2>&1; then
    firewall-cmd --permanent --remove-service=mdns
fi

firewall-cmd --permanent --add-service=http
firewall-cmd --permanent --add-service=https
firewall-cmd --permanent --add-port="${SSH_PORT}/tcp"
firewall-cmd --permanent --add-port=41641/udp
# Permit the tailnet to reach the proxy and SSH. The exit-node interface is
# added by exit-node.sh after the node joins, when tailscale0 exists.
firewall-cmd --permanent --zone=trusted --add-source=100.64.0.0/10
firewall-cmd --permanent --zone=trusted --add-source=fd7a:115c:a1e0::/48
firewall-cmd --reload
firewall-cmd --list-all
firewall-cmd --zone=trusted --list-all

#
# Summary
#

cat <<EOF

firewalld is configured. Open the same ports in the provider's cloud firewall.
Next: fedora/03-updates.sh
EOF
