#!/usr/bin/env bash
set -euo pipefail

# Read-only checks for the public proxy. Run on the VPS after HAProxy is
# configured. The external/public-IP checks are best run from another network;
# a hairpin-NAT router may prevent them from working from the VPS itself.

#
# Usage
#

usage() {
    cat <<EOF
Usage: $0 --domain <domain> --host <hostname> [--host <hostname> ...] [options]

Required:
  --domain <domain>   Custom domain used by the HAProxy config
  --host <hostname>   Public hostname to check; repeat for each host

Options:
  --ipv6              Also check IPv6 listeners and the IPv6 loopback
  --vps-ip <ip>       Also test through the public IPv4 address (may fail behind hairpin NAT)
  --vps-ip6 <ipv6>    Also test through the public IPv6 address (implies --ipv6)
  --config <path>     HAProxy config (default: /etc/haproxy/haproxy.cfg)
  -h, --help          Show this help
EOF
}

#
# Defaults
#

DOMAIN=""
HOSTS=()
VPS_IP=""
VPS_IP6=""
IPV6=false
CONFIG=/etc/haproxy/haproxy.cfg

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
        --host)
            [[ $# -ge 2 && -n "$2" ]] || { echo "Missing value for --host" >&2; exit 2; }
            HOSTS+=("$2")
            shift 2
            ;;
        --ipv6)
            IPV6=true
            shift
            ;;
        --vps-ip)
            [[ $# -ge 2 && -n "$2" ]] || { echo "Missing value for --vps-ip" >&2; exit 2; }
            VPS_IP=$2
            shift 2
            ;;
        --vps-ip6)
            [[ $# -ge 2 && -n "$2" ]] || { echo "Missing value for --vps-ip6" >&2; exit 2; }
            VPS_IP6=$2
            IPV6=true
            shift 2
            ;;
        --config)
            [[ $# -ge 2 && -n "$2" ]] || { echo "Missing value for --config" >&2; exit 2; }
            CONFIG=$2
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

if [[ -z "$DOMAIN" || ${#HOSTS[@]} -eq 0 ]]; then
    usage >&2
    exit 2
fi

if [[ -n "$VPS_IP6" && ! "$VPS_IP6" =~ ^[0-9A-Fa-f:]+$ ]]; then
    echo "Invalid IPv6 address '$VPS_IP6'; use the bare address without brackets." >&2
    exit 2
fi

#
# Configuration
#

echo "== Configuration =="
haproxy -c -f "$CONFIG"
echo "OK"

echo

#
# Service
#

echo "== Service =="
systemctl is-active haproxy

#
# IPv6 listeners
#

if $IPV6; then
    echo
    echo "== IPv6 listeners =="
    for port in 80 443; do
        if ss -ltnH | awk -v p=":$port" '$4 == "*" p || $4 == "[::]" p { found = 1 } END { exit !found }'; then
            echo "${port}: IPv6 wildcard listener"
        else
            echo "${port}: no IPv6 wildcard listener"
        fi
    done
fi

echo

#
# Stats page
#

echo "== Stats page (localhost) =="
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8404/stats || echo "unavailable"

#
# Local host checks
#

for host in "${HOSTS[@]}"; do
    echo
    echo "== ${host} (through local HAProxy) =="

    https_code=$(curl -sS -o /dev/null -w '%{http_code}' \
        --resolve "${host}:443:127.0.0.1" "https://${host}/" || true)
    echo "HTTPS: ${https_code:-failed}"

    redirect=$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' \
        --resolve "${host}:80:127.0.0.1" "http://${host}/" || true)
    echo "HTTP:  ${redirect:-failed}"

    echo "Certificate:"
    timeout 10 openssl s_client -connect 127.0.0.1:443 -servername "$host" </dev/null 2>/dev/null \
        | openssl x509 -noout -subject -issuer -ext subjectAltName 2>/dev/null \
        || echo "  unable to read the certificate"

    if $IPV6; then
        https6_code=$(curl -g -6 -sS -o /dev/null -w '%{http_code}' \
            --resolve "${host}:443:[::1]" "https://${host}/" || true)
        echo "HTTPS (IPv6 loopback): ${https6_code:-failed}"

        redirect6=$(curl -g -6 -sS -o /dev/null -w '%{http_code} %{redirect_url}' \
            --resolve "${host}:80:[::1]" "http://${host}/" || true)
        echo "HTTP  (IPv6 loopback): ${redirect6:-failed}"

        echo "Certificate (IPv6 loopback):"
        timeout 10 openssl s_client -connect "[::1]:443" -servername "$host" </dev/null 2>/dev/null \
            | openssl x509 -noout -subject -issuer -ext subjectAltName 2>/dev/null \
            || echo "  unable to read the certificate"
    fi
done

#
# Public IPv4 checks
#

if [[ -n "$VPS_IP" ]]; then
    echo
    echo "== Public IPv4 path (from this host) =="
    for host in "${HOSTS[@]}"; do
        code=$(curl -sS -o /dev/null -w '%{http_code}' \
            --resolve "${host}:443:${VPS_IP}" "https://${host}/" || true)
        echo "${host}: ${code:-failed} (hairpin NAT may fail here; test from outside)"
    done
fi

#
# Public IPv6 checks
#

if [[ -n "$VPS_IP6" ]]; then
    echo
    echo "== Public IPv6 path (from this host) =="
    for host in "${HOSTS[@]}"; do
        code=$(curl -g -6 -sS -o /dev/null -w '%{http_code}' \
            --resolve "${host}:443:[${VPS_IP6}]" "https://${host}/" || true)
        echo "${host}: ${code:-failed} (hairpin NAT may fail here; test from outside)"
    done
fi

echo

#
# Unknown SNI checks
#

echo "== Unknown SNI (outside the configured domain) =="
if timeout 5 openssl s_client -connect 127.0.0.1:443 \
    -servername "unknown.invalid" </dev/null 2>/dev/null \
    | grep -q 'BEGIN CERTIFICATE'; then
    echo "WARNING: a name outside ${DOMAIN} completed a TLS handshake; expected rejection."
else
    echo "OK: a name outside ${DOMAIN} is rejected."
fi

#
# Unknown SNI over IPv6
#

if $IPV6; then
    echo
    echo "== Unknown SNI over IPv6 =="
    if timeout 5 openssl s_client -connect "[::1]:443" \
        -servername "unknown.invalid" </dev/null 2>/dev/null \
        | grep -q 'BEGIN CERTIFICATE'; then
        echo "WARNING: a name outside ${DOMAIN} completed a TLS handshake over IPv6; expected rejection."
    else
        echo "OK: a name outside ${DOMAIN} is rejected over IPv6."
    fi
fi

echo

#
# External check commands
#

echo "For a real external check, run from another network:"
printf '%s\n' "  curl -sS -o /dev/null -w '%{http_code} %{remote_ip}\\n' --resolve <host>:443:<vps-ip> https://<host>/"
echo "  openssl s_client -connect <vps-ip>:443 -servername <host> </dev/null"
if $IPV6; then
    printf '%s\n' "  curl -g -6 -sS -o /dev/null -w '%{http_code} %{remote_ip}\\n' --resolve <host>:443:[<vps-ipv6>] https://<host>/"
    echo "  openssl s_client -connect [<vps-ipv6>]:443 -servername <host> </dev/null"
fi
