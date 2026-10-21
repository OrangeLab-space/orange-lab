#!/usr/bin/env bash
set -euo pipefail

# Prepare the SSH account used for the public proxy.
# Defaults to root, or the user who invoked sudo. Pass --user to create or reuse
# a dedicated non-root account (recommended). Run as root after the install
# phase. This script does not harden SSH; run harden-ssh.sh only for a non-root
# account after verifying it in a new terminal.

#
# Usage
#

usage() {
    cat <<EOF
Usage: $0 [--user <name>] [--ssh-key <key>]

  --user <name>     Account to create or reuse (default: root, or sudo-invoking user)
  --ssh-key <key>   Add this public key to authorized_keys
  -h, --help        Show this help
EOF
}

#
# Defaults
#

DEFAULT_USER=${SUDO_USER:-root}
PROXY_USER=$DEFAULT_USER
SSH_KEY=""

#
# Arguments
#

while (($# > 0)); do
    case "$1" in
        --user)
            [[ $# -ge 2 && -n "$2" ]] || { echo "Missing value for --user" >&2; exit 2; }
            PROXY_USER=$2
            shift 2
            ;;
        --ssh-key)
            [[ $# -ge 2 && -n "$2" ]] || { echo "Missing value for --ssh-key" >&2; exit 2; }
            SSH_KEY=$2
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

#
# Operating system
#

# shellcheck source=/dev/null
. /etc/os-release

#
# Admin group
#

case "${ID:-}" in
    debian|ubuntu)
        ADMIN_GROUP=sudo
        ;;
    fedora)
        ADMIN_GROUP=wheel
        ;;
    *)
        echo "This script supports Debian/Ubuntu and Fedora; detected '${ID:-unknown}'." >&2
        exit 1
        ;;
esac

#
# Validate the admin group
#

if [[ "$PROXY_USER" != "root" ]] && ! getent group "$ADMIN_GROUP" >/dev/null 2>&1; then
    echo "Admin group '${ADMIN_GROUP}' does not exist; run the install phase first." >&2
    exit 1
fi

#
# Validate the user name
#

if [[ ! "$PROXY_USER" =~ ^[a-z_][a-z0-9_-]*$ ]]; then
    echo "Invalid user name '${PROXY_USER}': use lowercase letters, digits, '_' or '-'." >&2
    exit 2
fi

#
# Create or reuse the account
#

CREATED_USER=false
if [[ "$PROXY_USER" == "root" ]]; then
    echo "Using root. A dedicated non-root account is recommended; see the summary."
elif id -u "$PROXY_USER" >/dev/null 2>&1; then
    PROXY_HOME=$(getent passwd "$PROXY_USER" | cut -d: -f6)
    PROXY_SHELL=$(getent passwd "$PROXY_USER" | cut -d: -f7)
    if [[ -z "$PROXY_HOME" || ! -d "$PROXY_HOME" || "$PROXY_SHELL" == */nologin || "$PROXY_SHELL" == */false ]]; then
        echo "User '${PROXY_USER}' is a system account (shell '${PROXY_SHELL:-unknown}', home '${PROXY_HOME:-none}')." >&2
        echo "Choose another name; omit --user to use the default '${DEFAULT_USER}'." >&2
        exit 1
    fi
    if ! id -nG "$PROXY_USER" | tr ' ' '\n' | grep -qx "$ADMIN_GROUP"; then
        echo "User '${PROXY_USER}' exists but is not in ${ADMIN_GROUP}." >&2
        echo "Choose a new account (omit --user or use another name), or add it with:" >&2
        echo "  usermod -aG ${ADMIN_GROUP} ${PROXY_USER}" >&2
        exit 1
    fi
    echo "Reusing existing admin user '${PROXY_USER}'."
else
    case "${ID:-}" in
        debian|ubuntu)
            adduser --disabled-password --gecos "" "$PROXY_USER"
            ;;
        fedora)
            useradd --create-home --shell /bin/bash "$PROXY_USER"
            ;;
    esac
    usermod -aG "$ADMIN_GROUP" "$PROXY_USER"
    CREATED_USER=true
fi

#
# Sudo access
#

if $CREATED_USER; then
    # The account is key-only (no password), so sudo needs NOPASSWD. This is the
    # same access model as a cloud image's default admin user; root login is
    # disabled later by harden-ssh.sh.
    SUDOERS=/etc/sudoers.d/90-public-proxy
    printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$PROXY_USER" >"$SUDOERS"
    chmod 0440 "$SUDOERS"
    if ! visudo -cf "$SUDOERS" >/dev/null; then
        rm -f "$SUDOERS"
        echo "Generated sudoers rule failed validation; removed it." >&2
        exit 1
    fi
fi

#
# SSH keys
#

PROXY_GROUP=$(id -gn "$PROXY_USER")
PROXY_HOME=$(getent passwd "$PROXY_USER" | cut -d: -f6)
if [[ -z "$PROXY_HOME" ]]; then
    echo "Cannot determine the home directory for '${PROXY_USER}'." >&2
    exit 1
fi
if [[ ! -d "$PROXY_HOME" ]]; then
    echo "Home directory '${PROXY_HOME}' does not exist; create it or choose another user." >&2
    exit 1
fi
AUTH_KEYS="${PROXY_HOME}/.ssh/authorized_keys"

install -d -m 0700 -o "$PROXY_USER" -g "$PROXY_GROUP" "${PROXY_HOME}/.ssh"

# Copy the invoking account's keys. With sudo, that is the admin user's keys;
# as root directly, it is root's. A provider that gives only a non-root sudo
# user does not necessarily put keys in /root.
SOURCE_KEYS=/root/.ssh/authorized_keys
SOURCE_LABEL=root
if [[ -n "${SUDO_USER:-}" && "$SUDO_USER" != "root" ]]; then
    SOURCE_HOME=$(getent passwd "$SUDO_USER" 2>/dev/null | cut -d: -f6) || true
    if [[ -n "$SOURCE_HOME" && -s "${SOURCE_HOME}/.ssh/authorized_keys" ]]; then
        SOURCE_KEYS="${SOURCE_HOME}/.ssh/authorized_keys"
        SOURCE_LABEL=$SUDO_USER
    fi
fi

if [[ -s "$SOURCE_KEYS" && ! -s "$AUTH_KEYS" && $CREATED_USER == true ]]; then
    install -m 0600 -o "$PROXY_USER" -g "$PROXY_GROUP" \
        "$SOURCE_KEYS" "$AUTH_KEYS"
    echo "Copied ${SOURCE_LABEL}'s authorized_keys to ${PROXY_USER}."
elif [[ -s "$AUTH_KEYS" ]]; then
    echo "Keeping the existing authorized_keys for ${PROXY_USER}."
fi

if [[ -n "$SSH_KEY" ]]; then
    touch "$AUTH_KEYS"
    if ! grep -qxF "$SSH_KEY" "$AUTH_KEYS"; then
        printf '%s\n' "$SSH_KEY" >>"$AUTH_KEYS"
        echo "Added the supplied public key to ${PROXY_USER}."
    fi
    chown "$PROXY_USER:$PROXY_GROUP" "$AUTH_KEYS"
    chmod 0600 "$AUTH_KEYS"
fi

if [[ ! -s "$AUTH_KEYS" ]]; then
    if [[ "$PROXY_USER" == "root" ]]; then
        echo "WARNING: root has no authorized_keys; key login is not configured." >&2
        echo "Add one with --ssh-key, or keep the provider console available." >&2
    else
        echo "User '${PROXY_USER}' has no SSH key; add one with --ssh-key before hardening." >&2
        exit 1
    fi
fi

#
# Summary
#

if [[ "$PROXY_USER" == "root" ]]; then
    cat <<EOF

Prepared root. Root access is allowed, but a dedicated non-root account is
recommended:
  bash $0 --user orangelab
Do not run harden-ssh.sh for root; it disables root login.
Next: run the firewall and update phases, then continue.
EOF
else
    cat <<EOF

Prepared ${PROXY_USER}. Verify key login in a NEW terminal before hardening:
  ssh ${PROXY_USER}@<vps-ip>
Next: run the firewall and update phases, then harden-ssh.sh.
EOF
fi
