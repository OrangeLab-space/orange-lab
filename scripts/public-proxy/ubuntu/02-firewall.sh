#!/usr/bin/env bash
set -euo pipefail

# Phase 2 (Ubuntu/Debian): configure UFW for the public proxy.
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
    debian|ubuntu) ;;
    *)
        echo "This script targets Debian/Ubuntu; detected '${ID:-unknown}'." >&2
        exit 1
        ;;
esac

if ! command -v ufw >/dev/null 2>&1; then
    echo "ufw is not installed; run ubuntu/01-install.sh first." >&2
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
# Configure UFW
#

echo "==> Configuring UFW (SSH port ${SSH_PORT})"
# Exit-node forwarding needs the forward policy to accept; Tailscale adds its
# own NAT rules. The host still has no public forwarding rules.
sed -i 's/^DEFAULT_FORWARD_POLICY=.*/DEFAULT_FORWARD_POLICY="ACCEPT"/' /etc/default/ufw

ufw default deny incoming
ufw default allow outgoing
ufw allow "${SSH_PORT}/tcp"
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 41641/udp
ufw allow from 100.64.0.0/10
ufw allow in on tailscale0 2>/dev/null || true
ufw --force enable
ufw status verbose

#
# Summary
#

cat <<EOF

UFW is configured. Open the same ports in the provider's cloud firewall.
Next: ubuntu/03-updates.sh
EOF
