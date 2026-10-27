#!/usr/bin/env bash
set -euo pipefail

# Disable root login and password authentication after the non-root user has
# been verified. Run as root.
#
# This is a separate step on purpose: disabling root login before the new
# account works is the easiest way to lock yourself out of a VPS.

#
# Usage
#

usage() {
    cat <<EOF
Usage: $0 [user]

  user    Non-root user that must have a working authorized_keys
          (default: orangelab)

Run only after logging in as that user in a second terminal. Keep the current
session open until a new login succeeds.
EOF
}

#
# Arguments
#

if [[ ${1:-} == "-h" || ${1:-} == "--help" ]]; then
    usage
    exit 0
fi

#
# Validation
#

if [[ $(id -u) -ne 0 ]]; then
    echo "Run this script as root (or with sudo)." >&2
    exit 1
fi

USER_NAME=${1:-orangelab}

if [[ "$USER_NAME" == "root" ]]; then
    echo "Refusing to harden around root: pass a non-root user." >&2
    exit 1
fi

if ! id -u "$USER_NAME" >/dev/null 2>&1; then
    echo "User '$USER_NAME' does not exist." >&2
    exit 1
fi

USER_HOME=$(getent passwd "$USER_NAME" | cut -d: -f6)
AUTH_KEYS="${USER_HOME}/.ssh/authorized_keys"

if [[ ! -s "$AUTH_KEYS" ]]; then
    echo "Refusing to disable root login: '$USER_NAME' has no authorized_keys." >&2
    exit 1
fi

#
# Write the SSH drop-in
#

DROP_IN=/etc/ssh/sshd_config.d/99-public-proxy.conf

install -d -m 0755 /etc/ssh/sshd_config.d

cat >"$DROP_IN" <<EOF
# Managed by OrangeLab scripts/public-proxy/harden-ssh.sh
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
EOF

#
# SELinux
#

# Fedora/RHEL: make sure the drop-in has a label sshd can read. This is a no-op
# on Debian/Ubuntu and on systems with SELinux disabled.
if command -v selinuxenabled >/dev/null 2>&1 && selinuxenabled; then
    if command -v restorecon >/dev/null 2>&1; then
        restorecon -RF /etc/ssh/sshd_config.d 2>/dev/null || true
    fi
fi

#
# Validate SSH configuration
#

if ! sshd -t; then
    echo "sshd configuration test failed; removing the drop-in." >&2
    rm -f "$DROP_IN"
    exit 1
fi

EFFECTIVE_ROOT=$(sshd -T | awk '$1 == "permitrootlogin" { value = $2 } END { if (value != "") print value }') || true
EFFECTIVE_PASS=$(sshd -T | awk '$1 == "passwordauthentication" { value = $2 } END { if (value != "") print value }') || true
if [[ "$EFFECTIVE_ROOT" != "no" || "$EFFECTIVE_PASS" != "no" ]]; then
    echo "The drop-in is not effective (PermitRootLogin=$EFFECTIVE_ROOT, PasswordAuthentication=$EFFECTIVE_PASS)." >&2
    echo "Ensure /etc/ssh/sshd_config includes /etc/ssh/sshd_config.d/*.conf before other settings." >&2
    rm -f "$DROP_IN"
    exit 1
fi

#
# Reload SSH
#

systemctl reload ssh 2>/dev/null || systemctl reload sshd

#
# Summary
#

echo "SSH hardening applied: root login and password authentication are disabled."
echo "Keep this session open and verify a new login as '$USER_NAME' before closing it."
echo "If the new login fails, use the provider's console and remove $DROP_IN."
