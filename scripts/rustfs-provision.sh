#!/usr/bin/env bash
#
# Create or verify a RustFS bucket, user and policy.
#
# The policy lets the user manage the bucket (s3:* on the bucket and its
# objects). Existing resources are left alone, so the script is safe to re-run.
# Run it with an rc alias that has root/admin credentials.
#
# Examples:
#   ./scripts/rustfs-provision.sh --user pulumi --bucket pulumi-state \
#     --output ~/.config/pulumi/state.env
#   ./scripts/rustfs-provision.sh --user longhorn --bucket backup-longhorn --check
#   ./scripts/rustfs-provision.sh --user pulumi-backup --bucket pulumi-backup --check

set -euo pipefail

usage() {
    cat <<EOF
Usage: $0 --user <name> --bucket <name> [options]

Create a bucket, a user and a policy that lets the user manage that bucket.
The user's password is written to a 600 env file (or generated and printed
nowhere), so it can be sourced by Pulumi or other clients.

Options:
  --user <name>       S3 user/access key (required)
  --bucket <name>     Bucket the user may manage (required)
  --alias <name>      rc alias with root/admin credentials (default: rustfs)
  --policy <name>     Policy name (default: <user>-policy)
  --password <value>  Password when creating or adopting a user
  --output <file>     Credentials file (default: ~/.config/rustfs/<user>.env)
  --check             Verify only; make no changes
  -h, --help          Show this help

Examples:
  $0 --user pulumi --bucket pulumi-state --output ~/.config/pulumi/state.env
  $0 --user longhorn --bucket backup-longhorn --check
EOF
}

user=''
bucket=''
alias_name='rustfs'
policy=''
password=''
output=''
check_only=false

while (($# > 0)); do
    case "$1" in
        --user|--bucket|--alias|--policy|--password|--output)
            if [[ $# -lt 2 || "$2" == -* ]]; then
                printf 'Missing value for %s\n\n' "$1" >&2
                usage >&2
                exit 2
            fi
            case "$1" in
                --user) user="$2" ;;
                --bucket) bucket="$2" ;;
                --alias) alias_name="$2" ;;
                --policy) policy="$2" ;;
                --password) password="$2" ;;
                --output) output="$2" ;;
            esac
            shift 2
            ;;
        --check)
            check_only=true
            shift
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

if [[ -z "$user" || -z "$bucket" ]]; then
    usage >&2
    exit 2
fi

policy="${policy:-${user}-policy}"
output="${output:-$HOME/.config/rustfs/${user}.env}"

#
# Validation
#
command -v rc >/dev/null 2>&1 || {
    printf 'rc not found in PATH.\n' >&2
    exit 1
}

if ! rc alias list 2>/dev/null | awk '{print $1}' | grep -qx "$alias_name"; then
    printf "rc alias '%s' not found. Create it with root credentials first.\n" \
        "$alias_name" >&2
    exit 1
fi

policy_file=''
temp_alias=''

cleanup() {
    if [[ -n "$temp_alias" ]]; then
        rc alias remove "$temp_alias" >/dev/null 2>&1 || true
    fi
    if [[ -n "$policy_file" ]]; then
        rm -f "$policy_file"
    fi
}
trap cleanup EXIT

bucket_exists() {
    rc object list "$alias_name/$bucket/" --summarize >/dev/null 2>&1
}
user_exists() {
    rc admin user info "$alias_name" "$user" >/dev/null 2>&1
}
policy_exists() {
    rc admin policy info "$alias_name" "$policy" >/dev/null 2>&1
}
policy_attached() {
    rc admin user info "$alias_name" "$user" 2>/dev/null | grep -Fq "$policy"
}

read_password_from_file() {
    [[ -f "$output" ]] || return 1
    local file_access file_secret
    file_access=$(sed -n 's/^AWS_ACCESS_KEY_ID=//p' "$output" | head -1)
    file_secret=$(sed -n 's/^AWS_SECRET_ACCESS_KEY=//p' "$output" | head -1)
    if [[ "$file_access" != "$user" ]]; then
        printf '%s belongs to %s, not %s.\n' "$output" "$file_access" "$user" >&2
        return 1
    fi
    [[ -n "$file_secret" ]] || return 1
    printf '%s' "$file_secret"
}

#
# Verify existing resources
#
check_failed=false
if $check_only; then
    if bucket_exists; then
        printf 'ok      bucket %s\n' "$bucket"
    else
        printf 'missing bucket %s\n' "$bucket"
        check_failed=true
    fi
    if user_exists; then
        printf 'ok      user %s\n' "$user"
    else
        printf 'missing user %s\n' "$user"
        check_failed=true
    fi
    if policy_exists; then
        printf 'ok      policy %s\n' "$policy"
    else
        printf 'missing policy %s\n' "$policy"
        check_failed=true
    fi
    if user_exists && policy_attached; then
        printf 'ok      %s attached to %s\n' "$policy" "$user"
    else
        printf 'missing attachment %s -> %s\n' "$policy" "$user"
        check_failed=true
    fi
else
    #
    # Create bucket and user
    #
    if ! bucket_exists; then
        rc bucket create "$alias_name/$bucket" --ignore-existing
    fi

    if user_exists; then
        if [[ -z "$password" ]]; then
            password=$(read_password_from_file || true)
        fi
    else
        if [[ -z "$password" ]]; then
            if ! password=$(read_password_from_file); then
                command -v openssl >/dev/null 2>&1 || {
                    printf 'openssl not found and no --password or --output file.\n' >&2
                    exit 1
                }
                password=$(openssl rand -base64 32)
            fi
        fi
        rc admin user add "$alias_name" "$user" "$password"
    fi

    #
    # Create and attach the bucket policy
    #
    if ! policy_exists; then
        policy_file=$(mktemp)
        cat >"$policy_file" <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": ["s3:*"],
            "Resource": [
                "arn:aws:s3:::${bucket}",
                "arn:aws:s3:::${bucket}/*"
            ]
        }
    ]
}
EOF
        rc admin policy create "$alias_name" "$policy" "$policy_file"
    fi

    if ! policy_attached; then
        rc admin policy attach "$alias_name" "$policy" --user "$user"
    fi

    #
    # Store the credentials for Pulumi or other clients
    #
    if [[ -n "$password" ]]; then
        mkdir -p "$(dirname "$output")"
        (
            umask 077
            printf 'AWS_ACCESS_KEY_ID=%s\nAWS_SECRET_ACCESS_KEY=%s\n' \
                "$user" "$password" >"$output"
        )
        printf 'Wrote credentials to %s\n' "$output"
    else
        printf 'User %s already exists; password not available, so %s was not updated.\n' \
            "$user" "$output" >&2
    fi
fi

#
# Verify the user can actually reach the bucket
#
if [[ -z "$password" && -f "$output" ]]; then
    password=$(read_password_from_file || true)
fi

if [[ -n "$password" ]]; then
    endpoint=$(rc alias list | awk -v a="$alias_name" '$1 == a { print $2; exit }')
    if [[ -n "$endpoint" ]]; then
        temp_alias="__verify_${user//[^a-zA-Z0-9]/_}_$$"
        rc alias set "$temp_alias" "$endpoint" "$user" "$password" >/dev/null
        if rc object list "$temp_alias/$bucket/" --summarize >/dev/null 2>&1; then
            printf 'ok      credentials can list %s\n' "$bucket"
        else
            printf 'credentials cannot list %s\n' "$bucket"
            check_failed=true
        fi
    fi
else
    printf 'credentials not checked (user exists and no password was supplied).\n'
fi

if $check_only && $check_failed; then
    exit 1
fi
