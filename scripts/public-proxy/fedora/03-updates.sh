#!/usr/bin/env bash
set -euo pipefail

# Phase 3 (Fedora): configure automatic updates without reboots.
# Run after 01-install.sh.

#
# Usage
#

usage() {
    cat <<EOF
Usage: $0

  -h, --help   Show this help
EOF
}

#
# Arguments
#

if [[ ${1:-} == "-h" || ${1:-} == "--help" ]]; then
    usage
    exit 0
fi

if (($# > 0)); then
    echo "Unknown option: $1" >&2
    usage >&2
    exit 2
fi

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
# Install automatic update tooling
#

echo "==> Installing automatic update tooling"
if dnf -q info dnf5-plugin-automatic >/dev/null 2>&1; then
    dnf install -y dnf5-plugin-automatic
    AUTO_TIMER=dnf5-automatic.timer
else
    dnf install -y dnf-automatic
    AUTO_TIMER=dnf-automatic.timer
fi

#
# Configure automatic updates
#

install -d -m 0755 /etc/dnf
if [[ ! -f /etc/dnf/automatic.conf ]]; then
    cat >/etc/dnf/automatic.conf <<'EOF'
[commands]
apply_updates = yes
reboot = never
EOF
else
    if grep -q '^apply_updates' /etc/dnf/automatic.conf; then
        sed -i 's/^apply_updates = .*/apply_updates = yes/' /etc/dnf/automatic.conf
    else
        printf '\n[commands]\napply_updates = yes\n' >>/etc/dnf/automatic.conf
    fi
    if grep -q '^reboot' /etc/dnf/automatic.conf; then
        sed -i 's/^reboot = .*/reboot = never/' /etc/dnf/automatic.conf
    else
        printf 'reboot = never\n' >>/etc/dnf/automatic.conf
    fi
fi

#
# Enable timer
#

systemctl enable --now "$AUTO_TIMER"

#
# Summary
#

cat <<EOF

Automatic updates are enabled (${AUTO_TIMER}).
Next: verify the account login; run harden-ssh.sh only for a non-root account.
EOF
