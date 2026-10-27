#!/usr/bin/env bash
set -euo pipefail

# Phase 1 (Fedora): install HAProxy, Tailscale, firewalld and SELinux tooling.
# Run as root. This script does not create the proxy user or configure the
# firewall; the next phases do that.
#
# Tested on Fedora 44 Cloud Edition. Fedora Server uses the same packages.

#
# Usage
#

usage() {
    cat <<EOF
Usage: $0 [--no-upgrade]

  --no-upgrade   Skip the initial dnf upgrade
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
    fedora) ;;
    *)
        echo "This script targets Fedora; detected '${ID:-unknown}'." >&2
        exit 1
        ;;
esac

#
# Install packages
#

echo "==> Installing packages"
if $UPGRADE; then
    dnf -y upgrade --refresh
fi
dnf install -y \
    ca-certificates \
    curl \
    firewalld \
    haproxy \
    libselinux-utils \
    openssl \
    policycoreutils \
    sudo

#
# HAProxy runtime directory
#

# Fedora's HAProxy unit does not create /run/haproxy, but the rendered config
# puts the admin/stats socket there. RuntimeDirectory creates and cleans it on
# every service start without a tmpfiles rule.
install -d -m 0755 /etc/systemd/system/haproxy.service.d
cat >/etc/systemd/system/haproxy.service.d/10-public-proxy.conf <<'EOF'
[Service]
RuntimeDirectory=haproxy
RuntimeDirectoryMode=0750
EOF
systemctl daemon-reload

#
# Install Tailscale
#

echo "==> Installing Tailscale"
cat >/etc/yum.repos.d/tailscale.repo <<'EOF'
[tailscale-stable]
name=Tailscale stable
baseurl=https://pkgs.tailscale.com/stable/fedora/$basearch
enabled=1
type=rpm
repo_gpgcheck=1
gpgcheck=1
gpgkey=https://pkgs.tailscale.com/stable/fedora/repo.gpg
EOF
dnf install -y tailscale
systemctl enable --now tailscaled

#
# SELinux
#

if command -v selinuxenabled >/dev/null 2>&1 && selinuxenabled; then
    if getsebool haproxy_connect_any >/dev/null 2>&1; then
        echo "==> Allowing HAProxy outbound connections (SELinux)"
        setsebool -P haproxy_connect_any 1
    else
        echo "WARNING: SELinux boolean haproxy_connect_any was not found." >&2
        echo "If HAProxy cannot bind or connect, check audit2allow." >&2
    fi
fi

#
# Reboot check
#

REBOOT_REQUIRED=false
if [[ -f /var/run/reboot-required ]]; then
    REBOOT_REQUIRED=true
elif command -v dnf >/dev/null 2>&1; then
    # Fedora does not create /var/run/reboot-required. needs-restarting exits
    # non-zero when a reboot is needed for the running kernel or core services.
    if ! dnf -q needs-restarting -r >/dev/null 2>&1; then
        REBOOT_REQUIRED=true
    fi
fi

#
# Summary
#

cat <<EOF

Installed HAProxy, Tailscale and firewalld.
Next: create-user.sh (optional; defaults to the current account)
EOF

#
# Reboot notice
#

if $REBOOT_REQUIRED; then
    cat <<'EOF'

NOTE: A reboot is required to finish the package updates.
Reboot before joining the tailnet or configuring HAProxy, then continue with
create-user.sh.
EOF
fi
