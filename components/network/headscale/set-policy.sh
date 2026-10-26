#!/usr/bin/env bash
set -euo pipefail

# Apply the tailnet access policy, or validate it without applying.
#
# Headscale runs with policy.mode: database, so the policy is stored in the
# volume-backed SQLite database. Applying replaces it atomically after
# validation, with no restart. Run with no arguments to check and apply the
# repository policy; --check validates only.

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
headscale="${script_dir}/exec-headscale.sh"
policy="${script_dir}/headscale-policy.hujson"
check_only=false

usage() {
    cat <<EOF
Usage: $0 [--check] [policy-file]

  --check        Validate the policy against the live users and nodes, but do
                 not apply it.
  policy-file    HuJSON policy to apply (default: headscale-policy.hujson next
                 to this script).

Rollback to allow-all:
  printf '{}\n' | $headscale policy set -f /dev/stdin
EOF
}

while (($# > 0)); do
    case "$1" in
        --check) check_only=true; shift ;;
        -h|--help) usage; exit 0 ;;
        --) shift; break ;;
        -*) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
        *) policy=$1; shift ;;
    esac
done

[[ -r "$policy" ]] || { echo "Policy file not found or unreadable: $policy" >&2; exit 1; }

echo "Checking $policy"
if ! "$headscale" policy check -f /dev/stdin < "$policy"; then
    echo "Policy rejected; nothing was applied." >&2
    exit 1
fi

if $check_only; then
    exit 0
fi

"$headscale" policy set -f /dev/stdin < "$policy"
echo "Applied."
echo "Verify from the proxy: 10443 and public forwards must connect; 22, 443 and"
echo "10250 on a cluster node must not."
