#!/usr/bin/env bash
set -euo pipefail

# Render the HAProxy config and reload the service.
#
# Run as root (or with sudo) on the VPS. The template lives next to this
# script. The config is validated before it replaces the live one.

#
# Usage
#

usage() {
    cat <<EOF
Usage: $0 --domain <domain> --upstream <name>=<address:port> [options]

Required:
  --domain <domain>              Custom domain, e.g. example.com
  --upstream <name>=<addr:port>  Traefik public-gateway node, e.g.
                                 node-a=<tailnet-ip>:10443
                                 Repeat for each node.

Options:
  --ipv6              Also listen on IPv6 (requires a public IPv6 address)
  --template <path>   Config template (default: haproxy.cfg.template next to this script)
  --config <path>     Destination config (default: /etc/haproxy/haproxy.cfg)
  --no-reload         Write the config but do not reload HAProxy
  -h, --help          Show this help

The domain must be a bare name (no scheme, no leading dot). Upstreams are
tailnet addresses of nodes running the Traefik public gateway on 10443. IPv6 is
off by default; only enable it when the VPS has a public IPv6 address and the
user wants AAAA records.
EOF
}

#
# Defaults
#

DOMAIN=""
UPSTREAMS=()
IPV6=false
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
TEMPLATE="${SCRIPT_DIR}/haproxy.cfg.template"
CONFIG=/etc/haproxy/haproxy.cfg
RELOAD=true

#
# Arguments
#

while (($# > 0)); do
    case "$1" in
        --domain)
            [[ $# -ge 2 && -n "$2" ]] || { echo "Missing value for --domain" >&2; exit 2; }
            DOMAIN=$2
            shift 2
            ;;
        --upstream)
            [[ $# -ge 2 && -n "$2" ]] || { echo "Missing value for --upstream" >&2; exit 2; }
            UPSTREAMS+=("$2")
            shift 2
            ;;
        --ipv6)
            IPV6=true
            shift
            ;;
        --template)
            [[ $# -ge 2 && -n "$2" ]] || { echo "Missing value for --template" >&2; exit 2; }
            TEMPLATE=$2
            shift 2
            ;;
        --config)
            [[ $# -ge 2 && -n "$2" ]] || { echo "Missing value for --config" >&2; exit 2; }
            CONFIG=$2
            shift 2
            ;;
        --no-reload)
            RELOAD=false
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

if [[ -z "$DOMAIN" ]]; then
    echo "--domain is required." >&2
    exit 2
fi

if [[ ! "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; then
    echo "Invalid domain: '$DOMAIN'. Use a bare name such as example.com." >&2
    exit 2
fi

if [[ ${#UPSTREAMS[@]} -eq 0 ]]; then
    echo "At least one --upstream is required." >&2
    exit 2
fi

if [[ ! -r "$TEMPLATE" ]]; then
    echo "Template not found: $TEMPLATE" >&2
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

#
# Listener settings
#

HTTP_BIND=":80"
HTTPS_BIND=":443"
if $IPV6; then
    if ! command -v ip >/dev/null 2>&1 || ! has_public_ipv6; then
        echo "IPv6 was requested, but this host has no public IPv6 address and default route." >&2
        echo "Check the provider's IPv6 configuration, or rerun without --ipv6." >&2
        exit 1
    fi
    HTTP_BIND="[::]:80 v4v6"
    HTTPS_BIND="[::]:443 v4v6"
fi

#
# Upstreams
#

SERVERS=""
for entry in "${UPSTREAMS[@]}"; do
    if [[ "$entry" != *=* ]]; then
        echo "Invalid upstream '$entry': expected name=address:port" >&2
        exit 2
    fi
    name=${entry%%=*}
    address=${entry#*=}
    if [[ ! "$name" =~ ^[A-Za-z0-9_.-]+$ ]]; then
        echo "Invalid upstream name '$name'." >&2
        exit 2
    fi
    if [[ "$address" != *:* ]]; then
        echo "Invalid upstream address '$address': expected address:port" >&2
        exit 2
    fi
    SERVERS+="    server ${name} ${address} check"$'\n'
done

#
# Render the configuration
#

TMP_CONFIG=$(mktemp)
trap 'rm -f "$TMP_CONFIG"' EXIT

while IFS= read -r line || [[ -n "$line" ]]; do
    # Replace the literal template placeholders, not a shell expansion.
    # shellcheck disable=SC2016
    line=${line//'${DOMAIN}'/$DOMAIN}
    # shellcheck disable=SC2016
    line=${line//'${HTTP_BIND}'/$HTTP_BIND}
    # shellcheck disable=SC2016
    line=${line//'${HTTPS_BIND}'/$HTTPS_BIND}
    if [[ "$line" == "__SERVERS__" ]]; then
        printf '%s' "$SERVERS"
    else
        printf '%s\n' "$line"
    fi
done <"$TEMPLATE" >"$TMP_CONFIG"

#
# Validate and install
#

echo "==> Validating rendered config"
haproxy -c -f "$TMP_CONFIG"

if [[ -f "$CONFIG" ]]; then
    BACKUP="${CONFIG}.bak.$(date +%Y%m%d%H%M%S)"
    cp -a "$CONFIG" "$BACKUP"
    echo "Backed up the previous config to $BACKUP"
fi

install -m 0644 -o root -g root "$TMP_CONFIG" "$CONFIG"
echo "Wrote $CONFIG"

#
# SELinux
#

if command -v selinuxenabled >/dev/null 2>&1 && selinuxenabled; then
    if command -v getsebool >/dev/null 2>&1 && getsebool haproxy_connect_any >/dev/null 2>&1; then
        if ! getsebool haproxy_connect_any | grep -q 'on$'; then
            echo "WARNING: SELinux may block HAProxy. Run: setsebool -P haproxy_connect_any 1" >&2
        fi
    fi
fi

#
# Reload HAProxy
#

if $RELOAD; then
    if systemctl is-active --quiet haproxy; then
        systemctl reload haproxy
    else
        systemctl enable --now haproxy
    fi
    systemctl is-active --quiet haproxy
    echo "HAProxy is active."
else
    echo "Skipped reload; run 'systemctl reload haproxy' when ready."
fi

#
# Summary
#

cat <<EOF

Configured domain: ${DOMAIN}
Upstreams: ${UPSTREAMS[*]}
IPv6: $([[ "$HTTP_BIND" == *v4v6* ]] && echo "dual-stack (public AAAA records can be added)" || echo "IPv4 only")
Stats: http://127.0.0.1:8404/stats (use an SSH tunnel)
Next: sudo $SCRIPT_DIR/verify.sh --domain ${DOMAIN} --host <hostname>
EOF
