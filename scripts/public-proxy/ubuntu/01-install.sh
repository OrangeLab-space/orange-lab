#!/usr/bin/env bash
set -euo pipefail

# Phase 1 (Ubuntu/Debian): install HAProxy, Tailscale, UFW and update tooling.
# Run as root. This script does not create the proxy user or configure the
# firewall; the next phases do that.

#
# Usage
#

usage() {
    cat <<EOF
Usage: $0 [--no-upgrade]

  --no-upgrade   Skip the initial apt-get upgrade
  -h, --help     Show this help
EOF
}

#
# Defaults
#

UPGRADE=true

#
# Arguments
#

while (($# > 0)); do
    case "$1" in
        --no-upgrade)
            UPGRADE=false
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

if [[ -z "${VERSION_CODENAME:-}" ]]; then
    echo "VERSION_CODENAME is not set; cannot select a Tailscale repository." >&2
    exit 1
fi

#
# Environment
#

export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

#
# Install packages
#

echo "==> Installing packages"
apt-get update
if $UPGRADE; then
    apt-get -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" upgrade
fi
apt-get install -y \
    adduser \
    ca-certificates \
    curl \
    gnupg \
    haproxy \
    openssl \
    sudo \
    ufw \
    unattended-upgrades

#
# Install Tailscale
#

echo "==> Installing Tailscale"
install -d -m 0755 /usr/share/keyrings
curl -fsSL "https://pkgs.tailscale.com/stable/${ID}/${VERSION_CODENAME}.noarmor.gpg" \
    -o /usr/share/keyrings/tailscale-archive-keyring.gpg
curl -fsSL "https://pkgs.tailscale.com/stable/${ID}/${VERSION_CODENAME}.tailscale-keyring.list" \
    -o /etc/apt/sources.list.d/tailscale.list
apt-get update
apt-get install -y tailscale
systemctl enable --now tailscaled

#
# Summary
#

cat <<EOF

Installed HAProxy, Tailscale, UFW and unattended-upgrades.
Next: create-user.sh (optional; defaults to the current account)
EOF

#
# Reboot notice
#

if [[ -f /var/run/reboot-required ]]; then
    cat <<'EOF'

NOTE: A reboot is required to finish the package updates.
Reboot before joining the tailnet or configuring HAProxy, then continue with
create-user.sh.
EOF
fi
