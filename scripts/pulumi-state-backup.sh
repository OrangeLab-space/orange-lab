#!/usr/bin/env bash
#
# Back up all Pulumi stacks of the current backend to an S3-compatible bucket.
#
# Run from the repository root. The archive contains one state export per stack
# plus the Pulumi.*.yaml files (needed for the encryption salt). Secrets inside
# the exports are encrypted with the stack passphrase, which is not included.
#
# See docs/pulumi.md for bucket/credential setup and restore steps.

set -euo pipefail

usage() {
    cat <<EOF
Usage: $0 [options]

Export every stack in the current Pulumi backend and upload a dated archive
with the RustFS \`rc\` CLI.

Options:
  --alias <name>     rc alias for the backup target (default: $alias_name)
  --bucket <name>    destination bucket (default: $bucket)
  --backend <url>    Pulumi backend URL; defaults to the current login or
                     PULUMI_BACKEND_URL
  -h, --help         Show this help

Environment:
  PULUMI_BACKUP_ALIAS         Default for --alias
  PULUMI_BACKUP_BUCKET        Default for --bucket
  PULUMI_BACKEND_URL          Default for --backend
  PULUMI_CONFIG_PASSPHRASE_FILE
                              Passphrase file; required when unset below
  PULUMI_CONFIG_PASSPHRASE    Passphrase as a value

Archive layout:
  pulumi-state/exports/<project>__<stack>.json
  pulumi-state/config/<path>/Pulumi.<stack>.yaml
  pulumi-state/manifest.json

Restore: see docs/pulumi.md#backing-up-state
EOF
}

alias_name="${PULUMI_BACKUP_ALIAS:-pulumi-backup}"
bucket="${PULUMI_BACKUP_BUCKET:-pulumi-backup}"
backend="${PULUMI_BACKEND_URL:-}"

#
# Parameter parsing
#
while (($# > 0)); do
    case "$1" in
        --alias|--bucket|--backend)
            if [[ $# -lt 2 || "$2" == -* ]]; then
                printf 'Missing value for %s\n\n' "$1" >&2
                usage >&2
                exit 2
            fi
            case "$1" in
                --alias) alias_name="$2" ;;
                --bucket) bucket="$2" ;;
                --backend) backend="$2" ;;
            esac
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            printf 'Unknown parameter: %s\n\n' "$1" >&2
            usage >&2
            exit 2
            ;;
    esac
done

#
# Validation
#
if [[ ! -f Pulumi.yaml ]]; then
    printf 'Run this script from the repository root (Pulumi.yaml not found).\n' >&2
    exit 1
fi

if [[ -z "${PULUMI_CONFIG_PASSPHRASE_FILE:-}" && -z "${PULUMI_CONFIG_PASSPHRASE:-}" ]]; then
    printf 'Set PULUMI_CONFIG_PASSPHRASE_FILE or PULUMI_CONFIG_PASSPHRASE.\n' >&2
    exit 1
fi

for binary in jq pulumi rc; do
    command -v "$binary" >/dev/null 2>&1 ||
        {
            printf '%s not found in PATH.\n' "$binary" >&2
            exit 1
        }
done

if ! rc alias list 2>/dev/null | awk '{print $1}' | grep -qx "$alias_name"; then
    printf "rc alias '%s' not found. Create it first (see docs/pulumi.md).\n" "$alias_name" >&2
    exit 1
fi

if [[ -n "$backend" ]]; then
    export PULUMI_BACKEND_URL="$backend"
fi

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
artifact="$work_dir/pulumi-state"
mkdir -p "$artifact/exports" "$artifact/config"

#
# Export stacks
#
stack_list="$(pulumi stack ls --all -Q --json | jq -r '.[].name')"
if [[ -z "$stack_list" ]]; then
    printf 'No stacks found in the backend.\n' >&2
    exit 1
fi
mapfile -t stacks <<<"$stack_list"

declare -A exported_stacks=()
for stack in "${stacks[@]}"; do
    exported_stacks["${stack##*/}"]=1
done

for stack in "${stacks[@]}"; do
    printf 'Exporting %s\n' "$stack"
    pulumi stack export --stack "$stack" --file "$artifact/exports/${stack//\//__}.json"
done

#
# Copy stack config (contains the encryption salt)
#
while IFS= read -r -d '' file; do
    file="${file#./}"
    stack_name="${file##*/Pulumi.}"
    stack_name="${stack_name%.yaml}"
    if [[ -z "${exported_stacks[$stack_name]:-}" ]]; then
        continue
    fi
    mkdir -p "$artifact/config/$(dirname "$file")"
    cp "$file" "$artifact/config/$file"
done < <(find . -name 'Pulumi.*.yaml' -not -name '*.bak.*' -not -path './node_modules/*' -print0)

printf '%s\n' "${stacks[@]}" | jq -R . | jq -s . >"$work_dir/stacks.json"
cat >"$artifact/manifest.json" <<EOF
{
    "created": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "backend": "${backend:-current login}",
    "stacks": $(cat "$work_dir/stacks.json")
}
EOF

#
# Upload
#
archive="pulumi-state-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
tar -czf "$work_dir/$archive" -C "$work_dir" pulumi-state
rc object copy "$work_dir/$archive" "$alias_name/$bucket/$archive"
rc object stat "$alias_name/$bucket/$archive" >/dev/null

printf 'Backed up %d stacks to %s/%s/%s\n' \
    "${#stacks[@]}" "$alias_name" "$bucket" "$archive"
