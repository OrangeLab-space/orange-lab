#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat <<EOF
Usage: $0 --group <name> [--friendly-name <label>] [--claim <key>=<value>] [--all-users] [--default-group] ...
       $0 --delete <name> [--delete <name> ...]

Create (or delete) user groups in the Pocket ID instance of the core stack.
Existing groups are reused and their members are never touched, unless
--all-users is given; the friendly name and claims given here are applied to
the group.

Each --group starts a new group. The --friendly-name, --claim, --all-users and
--default-group options that follow apply to the most recently declared group.
--friendly-name defaults to the group name.

Keep the group list out of this script: pass it from a per-instance wrapper.

Only the groups named here are touched - anything else in Pocket ID, including
groups you created by hand, is left alone. Groups are never deleted unless
--delete names them, so re-running is safe.

Run from the repository root.

Required Pulumi config:
  pocket:apiKey   API key for the core stack
Required deployed outputs:
  security.endpoints.public.pocket

Options:
  --delete <name>          Delete the named group; repeatable

Options per group:
  --friendly-name <label>  Display name (default: the group name)
  --claim <key>=<value>    Custom claim; repeatable
  --all-users              Replace the group's members with every existing user
  --members-from <group>   Union the group's members with those of another group
  --default-group          Merge the group into the new-user default groups
                           (rewrites the whole Application Configuration)

Example:
  $0 --group immich-users --group rustfs-users --claim rustfs_policies=readwrite
EOF
}

groups=()
friendly_names=()
claims=()
all_users_flags=()
default_group_flags=()
members_from_list=()
delete_groups=()
current=-1

while (($# > 0)); do
    case "$1" in
        --group)
            if [[ $# -lt 2 || "$2" == -* ]]; then
                printf 'Missing value for --group\n\n' >&2; usage >&2; exit 2
            fi
            groups+=("$2")
            friendly_names+=("$2")
            claims+=("")
            all_users_flags+=("false")
            default_group_flags+=("false")
            members_from_list+=("")
            current=$((${#groups[@]} - 1))
            shift 2
            ;;
        --friendly-name)
            if [[ $# -lt 2 || "$2" == -* ]]; then
                printf 'Missing value for --friendly-name\n\n' >&2; usage >&2; exit 2
            fi
            ((current >= 0)) || { printf '--friendly-name given before any --group\n' >&2; exit 2; }
            friendly_names[current]="$2"
            shift 2
            ;;
        --claim)
            if [[ $# -lt 2 || "$2" == -* ]]; then
                printf 'Missing value for --claim\n\n' >&2; usage >&2; exit 2
            fi
            ((current >= 0)) || { printf '--claim given before any --group\n' >&2; exit 2; }
            claims[current]+="${2}"$'\n'
            shift 2
            ;;
        --all-users)
            ((current >= 0)) || { printf '--all-users given before any --group\n' >&2; exit 2; }
            all_users_flags[current]="true"
            shift
            ;;
        --members-from)
            if [[ $# -lt 2 || "$2" == -* ]]; then
                printf 'Missing value for --members-from\n\n' >&2; usage >&2; exit 2
            fi
            ((current >= 0)) || { printf '--members-from given before any --group\n' >&2; exit 2; }
            members_from_list[current]="$2"
            shift 2
            ;;
        --delete)
            if [[ $# -lt 2 || "$2" == -* ]]; then
                printf 'Missing value for --delete\n\n' >&2; usage >&2; exit 2
            fi
            delete_groups+=("$2")
            shift 2
            ;;
        --default-group)
            ((current >= 0)) || { printf '--default-group given before any --group\n' >&2; exit 2; }
            default_group_flags[current]="true"
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            printf 'Unknown parameter: %s\n\n' "$1" >&2; usage >&2; exit 2
            ;;
    esac
done

if ((${#groups[@]} == 0 && ${#delete_groups[@]} == 0)); then
    printf 'No groups given.\n\n' >&2; usage >&2; exit 2
fi

#
# Configuration
#
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "${script_dir}/.." && pwd)

if ! pocket_api_key=$(pulumi --cwd "$repo_root" config get pocket:apiKey 2>/dev/null); then
    printf 'Missing secret config: pocket:apiKey\n' >&2
    printf 'Set it with: pulumi config set pocket:apiKey <api-key> --secret\n' >&2
    exit 1
fi

POCKET_ID_URL=$(pulumi --cwd "$repo_root" stack output --json | jq -er '.security.endpoints.public.pocket')
POCKET_ID_URL="${POCKET_ID_URL%/}"

#
# API helper with retry (Pocket ID intermittently answers 400/5xx)
#
pocket_api() {
    local method="$1" endpoint="$2" attempt response
    shift 2
    for attempt in 1 2 3 4 5; do
        if response=$(curl --fail-with-body --silent --show-error -X "${method}" \
            "${POCKET_ID_URL}${endpoint}" "$@" 2>&1); then
            printf '%s' "${response}"
            return 0
        fi
        printf 'Pocket ID request failed (attempt %s/5): %s %s\n' "${attempt}" "${method}" "${endpoint}" >&2
        printf '%s\n' "${response}" >&2
        sleep 3
    done
    return 1
}

#
# Echo "<id>\t<friendlyName>" of an existing group by exact name; fail if missing.
#
find_group() {
    pocket_api GET "/api/user-groups?search=$(jq -rn --arg v "$1" '$v|@uri')&pagination%5Blimit%5D=100" \
        -H "X-API-KEY: ${pocket_api_key}" |
        jq -er --arg name "$1" \
            '[.data[] | select(.name == $name) | "\(.id)\t\(.friendlyName)"][0] // empty'
}

#
# Replace the group's members with every existing user.
#
add_all_users() {
    local group_id="$1" page=1 limit=100 batch count ids='[]'
    while :; do
        batch=$(pocket_api GET "/api/users?pagination%5Bpage%5D=${page}&pagination%5Blimit%5D=${limit}" \
            -H "X-API-KEY: ${pocket_api_key}")
        ids=$(jq -c -n --argjson acc "${ids}" --argjson batch "${batch}" \
            '$acc + ($batch.data | map(.id))')
        count=$(jq -r '.data | length' <<<"${batch}")
        if ((count < limit)); then break; fi
        page=$((page + 1))
    done
    pocket_api PUT "/api/user-groups/${group_id}/users" \
        -H "X-API-KEY: ${pocket_api_key}" \
        -H 'Content-Type: application/json' \
        --data "$(jq -n --argjson ids "${ids}" '{userIds: $ids}')" > /dev/null
    printf 'Added all %s user(s) to the group.\n' "$(jq -r 'length' <<<"${ids}")"
}

#
# Union the group's members with those of another group.
#
copy_members() {
    local group_id="$1" source_name="$2" source source_id source_ids existing_ids merged_ids
    source=$(find_group "$source_name") || {
        printf 'Error: --members-from group not found: %s\n' "$source_name" >&2
        exit 1
    }
    source_id="${source%%$'\t'*}"
    source_ids=$(pocket_api GET "/api/user-groups/${source_id}" -H "X-API-KEY: ${pocket_api_key}" |
        jq -c '[.users[]?.id]')
    existing_ids=$(pocket_api GET "/api/user-groups/${group_id}" -H "X-API-KEY: ${pocket_api_key}" |
        jq -c '[.users[]?.id]')
    merged_ids=$(jq -c -n --argjson a "${existing_ids}" --argjson b "${source_ids}" '$a + $b | unique')
    pocket_api PUT "/api/user-groups/${group_id}/users" \
        -H "X-API-KEY: ${pocket_api_key}" \
        -H 'Content-Type: application/json' \
        --data "$(jq -n --argjson ids "${merged_ids}" '{userIds: $ids}')" > /dev/null
    printf 'Copied %s member(s) from %s.\n' "$(jq -r 'length' <<<"${source_ids}")" "$source_name"
}

#
# Merge the group into the new-user default groups. The application
# configuration API replaces the whole object, so read it first and merge.
#
set_default_group() {
    local group_id="$1" config current merged body
    config=$(pocket_api GET /api/application-configuration/all -H "X-API-KEY: ${pocket_api_key}")
    if [[ "$(jq 'length' <<<"${config}")" == "0" ]]; then
        printf 'Error: application configuration came back empty; aborting.\n' >&2
        exit 1
    fi

    current=$(jq -r '[.[] | select(.key == "signupDefaultUserGroupIDs") | .value][0] // ""' <<<"${config}")
    merged=$(jq -c -n --arg c "${current}" --arg id "${group_id}" \
        '((if $c == "" then [] else (try ($c | fromjson) catch []) end)) + [$id] | unique')
    body=$(jq -c 'map({(.key): .value}) | add' <<<"${config}")
    body=$(jq -c --arg v "${merged}" '. + {signupDefaultUserGroupIDs: $v}' <<<"${body}")

    pocket_api PUT /api/application-configuration \
        -H "X-API-KEY: ${pocket_api_key}" \
        -H 'Content-Type: application/json' \
        --data "${body}" > /dev/null

    applied=$(pocket_api GET /api/application-configuration/all -H "X-API-KEY: ${pocket_api_key}" |
        jq -r '[.[] | select(.key == "signupDefaultUserGroupIDs") | .value][0] // ""')
    if ! jq -e -n --arg v "${applied}" --arg id "${group_id}" \
        'try ($v | fromjson) catch [] | index($id) != null' > /dev/null; then
        printf 'Warning: could not confirm the default group was applied (value: %s); check Application Configuration.\n' "${applied}" >&2
    else
        printf 'New users now join this group by default.\n'
    fi
}

if ((${#delete_groups[@]} > 0)); then
    for delete_name in "${delete_groups[@]}"; do
        if delete_existing=$(find_group "$delete_name"); then
            delete_id="${delete_existing%%$'\t'*}"
            pocket_api DELETE "/api/user-groups/${delete_id}" \
                -H "X-API-KEY: ${pocket_api_key}" > /dev/null
            printf 'Group deleted: %s\n' "$delete_name"
        else
            printf 'Group not found: %s\n' "$delete_name"
        fi
    done
fi

if ((${#groups[@]} == 0)); then
    printf 'Done.\n'
    exit 0
fi

for i in "${!groups[@]}"; do
    name="${groups[$i]}"
    friendly="${friendly_names[$i]}"

    if existing=$(find_group "$name"); then
        group_id="${existing%%$'\t'*}"
        existing_friendly="${existing#*$'\t'}"
        printf 'Group exists: %s\n' "$name"
        if [[ "${existing_friendly}" != "${friendly}" ]]; then
            pocket_api PUT "/api/user-groups/${group_id}" \
                -H "X-API-KEY: ${pocket_api_key}" \
                -H 'Content-Type: application/json' \
                --data "$(jq -n --arg name "$name" --arg friendly "$friendly" \
                    '{name: $name, friendlyName: $friendly}')" > /dev/null
            printf 'Friendly name updated: %s -> %s\n' "$existing_friendly" "$friendly"
        fi
    else
        group_id=$(pocket_api POST /api/user-groups \
            -H "X-API-KEY: ${pocket_api_key}" \
            -H 'Content-Type: application/json' \
            --data "$(jq -n --arg name "$name" --arg friendly "$friendly" \
                '{name: $name, friendlyName: $friendly}')" |
            jq -er '.id')
        printf 'Group created: %s\n' "$name"
    fi

    if [[ -n "${claims[$i]}" ]]; then
        claim_json=$(printf '%s' "${claims[$i]}" | jq -R -s '
            split("\n") | map(select(length > 0)) |
            map(split("=") | {key: .[0], value: (.[1:] | join("="))})')
        pocket_api PUT "/api/custom-claims/user-group/${group_id}" \
            -H "X-API-KEY: ${pocket_api_key}" \
            -H 'Content-Type: application/json' \
            --data "${claim_json}" > /dev/null
        printf 'Claims set: %s\n' "$name"
    fi

    if [[ "${all_users_flags[$i]}" == "true" ]]; then
        add_all_users "$group_id"
    fi

    if [[ -n "${members_from_list[$i]}" ]]; then
        copy_members "$group_id" "${members_from_list[$i]}"
    fi

    if [[ "${default_group_flags[$i]}" == "true" ]]; then
        set_default_group "$group_id"
    fi
done

printf 'Done.\n'
