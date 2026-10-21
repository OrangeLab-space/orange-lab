#!/usr/bin/env bash
set -euo pipefail

# Phase 3 (Ubuntu/Debian): enable unattended security upgrades without reboots.
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
    debian|ubuntu) ;;
    *)
        echo "This script targets Debian/Ubuntu; detected '${ID:-unknown}'." >&2
        exit 1
        ;;
esac

if ! dpkg -s unattended-upgrades >/dev/null 2>&1; then
    echo "unattended-upgrades is not installed; run ubuntu/01-install.sh first." >&2
    exit 1
fi

#
# Configure automatic updates
#

echo "==> Configuring unattended security upgrades"
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF

# Never reboot a public proxy without a maintenance window.
if [[ -f /etc/apt/apt.conf.d/50unattended-upgrades ]]; then
    sed -i 's|^//Unattended-Upgrade::Automatic-Reboot .*|Unattended-Upgrade::Automatic-Reboot "false";|' \
        /etc/apt/apt.conf.d/50unattended-upgrades
fi

#
# Summary
#

cat <<EOF

Unattended security upgrades are enabled.
Next: verify the account login; run harden-ssh.sh only for a non-root account.
EOF
