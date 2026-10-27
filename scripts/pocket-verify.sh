#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat <<EOF
Usage: $0 [--app <name>] [--json] [--quiet]

Read-only audit of the Pocket ID instance against what this repository declares:
the groups from components/security/pocket/create-groups.sh, and the OIDC
clients from the per-app pocket-<app>.sh wrappers together with each stack's
<app>:auth/allowedGroups.

Exits non-zero when the live instance has drifted from the declared state.
Groups and clients that nothing in the repository declares are reported as
notes, not drift - they are assumed to have been added by hand.

Progress is written to stderr; --json and --quiet suppress it.

Run from the repository root.

Required Pulumi config:
  pocket:apiKey   API key for the core stack
Required deployed outputs:
  security.endpoints.public.pocket

Options:
  --app <name>   Only check this application (its client and its <name>-* groups)
  --json         Machine-readable output
  --quiet        Human output lists drift only

Example:
  $0
  $0 --app immich
  $0 --json | jq
EOF
}

app_filter=''
json_output=false
quiet=false

while (($# > 0)); do
    case "$1" in
        --app)
            if [[ $# -lt 2 || "$2" == -* ]]; then
                printf 'Missing value for --app\n\n' >&2; usage >&2; exit 2
            fi
            app_filter="$2"
            shift 2
            ;;
        --json)
            json_output=true
            shift
            ;;
        --quiet)
            quiet=true
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

#
# Configuration
#
# Progress goes to stderr so stdout stays parseable, and is suppressed for
# --json (machine consumers) and --quiet (results only).
#
progress() {
    if [[ "${json_output}" == false && "${quiet}" == false ]]; then
        printf '%s\n' "$*" >&2
    fi
}

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "${script_dir}/.." && pwd)

progress 'Reading Pulumi configuration...'

if ! pocket_api_key=$(pulumi --cwd "$repo_root" config get pocket:apiKey 2>/dev/null); then
    printf 'Missing secret config: pocket:apiKey\n' >&2
    printf 'Set it with: pulumi config set pocket:apiKey <api-key> --secret\n' >&2
    exit 2
fi

if ! POCKET_ID_URL=$(pulumi --cwd "$repo_root" stack output --json 2>/dev/null |
        jq -er '.security.endpoints.public.pocket' 2>/dev/null); then
    printf 'Could not read security.endpoints.public.pocket from the core stack output.\n' >&2
    exit 2
fi
POCKET_ID_URL="${POCKET_ID_URL%/}"

#
# API helper. Fails fast: a non-2xx answer is reported as-is instead of being
# retried, because retrying hides the real cause and can duplicate a write.
#
pocket_api() {
    local method="$1" endpoint="$2" response status body
    shift 2
    if ! response=$(curl --silent --show-error -w $'\n%{http_code}' -X "${method}" \
        -H "X-API-KEY: ${pocket_api_key}" \
        "${POCKET_ID_URL}${endpoint}" "$@" 2>&1); then
        printf 'Pocket ID request failed: %s %s\n%s\n' "${method}" "${endpoint}" "${response}" >&2
        return 1
    fi
    status="${response##*$'\n'}"
    body="${response%$'\n'*}"
    if ((status >= 400)); then
        printf 'Pocket ID returned HTTP %s: %s %s\n%s\n' "${status}" "${method}" "${endpoint}" "${body}" >&2
        return 1
    fi
    printf '%s' "${body}"
}

drift_lines=()
note_lines=()

add_drift() { drift_lines+=("$1"$'\t'"$2"); }
add_note() { note_lines+=("$1"$'\t'"$2"); }

# Renders "<subject>\t<detail>" lines as a JSON array.
to_json() {
    if (($# == 0)); then
        printf '[]'
    else
        printf '%s\n' "$@" |
            jq -R -s 'split("\n") | map(select(length > 0) | split("\t") |
                {subject: .[0], detail: (.[1:] | join("\t"))})'
    fi
}

# Reads a stack's configuration once and caches it: `pulumi config` costs about
# a second per call, and every app in a stack needs the same one. Sets
# stack_config_json instead of printing, so the cache survives (a command
# substitution would run this in a subshell and lose the write).
declare -A stack_config_cache
stack_config_json=''
load_stack_config() {
    local dir="$1" label
    if [[ -z "${stack_config_cache[$dir]+x}" ]]; then
        if [[ "${dir}" == "${repo_root}" ]]; then
            label='core'
        else
            label="${dir#"${repo_root}/"}"
        fi
        progress "  reading Pulumi config: ${label}"
        stack_config_cache[$dir]=$(pulumi --cwd "$dir" config --json 2>/dev/null || printf '{}')
    fi
    stack_config_json="${stack_config_cache[$dir]}"
}

#
# Declared state
#
progress 'Reading the declared group spec...'
expected_groups=$(cd "$repo_root" && ./components/security/pocket/create-groups.sh --print-spec)

#
# Live state
#
progress "Querying Pocket ID at ${POCKET_ID_URL}..."
live_groups=$(pocket_api GET '/api/user-groups?pagination%5Blimit%5D=100')
groups_index=$(jq -c '[.data[] | {id, name}]' <<<"${live_groups}")
live_clients=$(pocket_api GET '/api/oidc/clients?pagination%5Blimit%5D=100')

users='[]'
page=1
limit=100
while :; do
    batch=$(pocket_api GET "/api/users?pagination%5Bpage%5D=${page}&pagination%5Blimit%5D=${limit}")
    users=$(jq -c -n --argjson acc "${users}" --argjson batch "${batch}" '$acc + ($batch.data // [])')
    if (($(jq -r '.data | length' <<<"${batch}") < limit)); then
        break
    fi
    page=$((page + 1))
done
all_user_ids=$(jq -c '[.[].id] | sort' <<<"${users}")

#
# Groups
#
if [[ -n "${app_filter}" ]]; then
    group_count=$(jq -r --arg prefix "${app_filter}-" '[.[] | select(.name | startswith($prefix))] | length' <<<"${expected_groups}")
else
    group_count=$(jq -r 'length' <<<"${expected_groups}")
fi
progress "Checking ${group_count} group(s)..."
while IFS= read -r name; do
    [[ -n "${name}" ]] || continue
    if [[ -n "${app_filter}" && "${name}" != "${app_filter}-"* ]]; then
        continue
    fi

    want=$(jq -c --arg name "${name}" '[.[] | select(.name == $name)][0]' <<<"${expected_groups}")
    got=$(jq -c --arg name "${name}" '.data[] | select(.name == $name)' <<<"${live_groups}")

    if [[ -z "${got}" ]]; then
        add_drift "group ${name}" "missing"
        continue
    fi

    want_friendly=$(jq -r '.friendlyName' <<<"${want}")
    got_friendly=$(jq -r '.friendlyName' <<<"${got}")
    if [[ "${want_friendly}" != "${got_friendly}" ]]; then
        add_drift "group ${name}" "friendly name is \"${got_friendly}\", expected \"${want_friendly}\""
    fi

    want_claims=$(jq -c '.claims | to_entries | map({key, value}) | sort_by(.key)' <<<"${want}")
    got_claims=$(jq -c '(.customClaims // []) | map({key, value}) | sort_by(.key)' <<<"${got}")
    if [[ "${want_claims}" != "${got_claims}" ]]; then
        add_drift "group ${name}" "claims are ${got_claims}, expected ${want_claims}"
    fi

    if [[ "$(jq -r '.allUsers' <<<"${want}")" == "true" ]]; then
        group_id=$(jq -r '.id' <<<"${got}")
        members=$(pocket_api GET "/api/user-groups/${group_id}" | jq -c '[.users[]?.id] | sort')
        if [[ "${members}" != "${all_user_ids}" ]]; then
            add_drift "group ${name}" \
                "has $(jq -r 'length' <<<"${members}") member(s), expected every user ($(jq -r 'length' <<<"${all_user_ids}"))"
        fi
    fi
done < <(jq -r '.[].name' <<<"${expected_groups}")

if [[ -z "${app_filter}" ]]; then
    while IFS= read -r name; do
        [[ -n "${name}" ]] || continue
        if ! jq -e --arg name "${name}" 'any(.[]; .name == $name)' >/dev/null <<<"${expected_groups}"; then
            add_note "group ${name}" "not declared by create-groups.sh - left untouched"
        fi
    done < <(jq -r '.data[].name' <<<"${live_groups}")

    want_defaults=$(jq -r '[.[] | select(.defaultGroup) | .name] | sort | join(",")' <<<"${expected_groups}")
    got_defaults=$(pocket_api GET /api/application-configuration/all | jq -r --argjson groups "${groups_index}" '
        ([.[] | select(.key == "signupDefaultUserGroupIDs") | .value][0] // "[]" | (try fromjson catch [])) as $ids
        | $groups | map(select(.id as $i | $ids | index($i)) | .name) | sort | join(",")')
    if [[ "${want_defaults}" != "${got_defaults}" ]]; then
        add_drift "default signup groups" "are \"${got_defaults}\", expected \"${want_defaults}\""
    fi
fi

#
# Clients - declared by the wrappers plus each stack's <app>:auth/allowedGroups
#
expected_client_names=()
mapfile -t wrappers < <(find "${repo_root}/components" "${repo_root}/stacks" -name 'pocket-*.sh' -not -path '*/node_modules/*' | sort)

if [[ -n "${app_filter}" ]]; then
    progress "Checking the client declared for ${app_filter}..."
else
    progress "Checking ${#wrappers[@]} client(s)..."
fi

for wrapper in "${wrappers[@]}"; do
    app=$(sed -n 's/^app_name=//p' "${wrapper}" | head -n1 | tr -d '"')
    client=$(sed -n 's/^client_name=//p' "${wrapper}" | head -n1 | sed 's/^"//; s/"$//')
    rel="${wrapper#"${repo_root}/"}"

    if [[ -z "${app}" || -z "${client}" ]]; then
        add_note "wrapper ${rel}" "could not read app_name/client_name - skipped"
        continue
    fi
    if [[ -n "${app_filter}" && "${app}" != "${app_filter}" ]]; then
        continue
    fi

    stack_dir="${repo_root}"
    if [[ "${rel}" == stacks/* ]]; then
        rest="${rel#stacks/}"
        stack_dir="${repo_root}/stacks/${rest%%/*}"
    fi

    load_stack_config "${stack_dir}"
    allowed_raw=$(jq -r --arg key "${app}:auth/allowedGroups" '.[$key].value // ""' <<<"${stack_config_json}")
    want_allowed=$(printf '%s' "${allowed_raw}" | tr ',' '\n' | sed '/^$/d' | sort | paste -sd, -)

    wants_launch=false
    if grep -q -- '--launch-url' "${wrapper}"; then
        wants_launch=true
    fi

    expected_client_names+=("${client}")

    got=$(jq -c --arg client "${client}" '.data[] | select(.name == $client)' <<<"${live_clients}")
    if [[ -z "${got}" ]]; then
        add_drift "client ${client}" "missing (declared by ${rel})"
        continue
    fi

    restricted=$(jq -r '.isGroupRestricted // false' <<<"${got}")
    got_allowed=$(jq -r '[(.allowedUserGroups // [])[].name] | sort | join(",")' <<<"${got}")

    if [[ -n "${want_allowed}" ]]; then
        if [[ "${restricted}" != "true" ]]; then
            add_drift "client ${client}" "is not group-restricted (isGroupRestricted=false)"
        fi
        if [[ "${got_allowed}" != "${want_allowed}" ]]; then
            add_drift "client ${client}" "allowed groups are \"${got_allowed}\", expected \"${want_allowed}\""
        fi
    elif [[ "${restricted}" == "true" ]]; then
        add_drift "client ${client}" "is group-restricted but ${app}:auth/allowedGroups is unset"
    fi

    launch=$(jq -r '.launchURL // ""' <<<"${got}")
    if [[ "${wants_launch}" == "true" ]]; then
        if [[ -z "${launch}" ]]; then
            add_drift "client ${client}" "wrapper passes --launch-url but the client has no launch URL (no My Apps tile)"
        fi
    elif [[ -n "${launch}" ]]; then
        add_drift "client ${client}" "has launch URL \"${launch}\" but its wrapper passes no --launch-url (unexpected tile)"
    fi
done

if [[ -n "${app_filter}" && ${#expected_client_names[@]} == 0 ]]; then
    printf 'No pocket-<app>.sh wrapper found for --app %s.\n' "${app_filter}" >&2
    exit 2
fi

if [[ -z "${app_filter}" ]]; then
    while IFS= read -r name; do
        [[ -n "${name}" ]] || continue
        declared=false
        for client in "${expected_client_names[@]}"; do
            if [[ "${client}" == "${name}" ]]; then
                declared=true
                break
            fi
        done
        if [[ "${declared}" == "false" ]]; then
            add_note "client ${name}" "not declared by any pocket-<app>.sh - left untouched"
        fi
    done < <(jq -r '.data[].name' <<<"${live_clients}")
fi

#
# Output
#
if [[ "${json_output}" == true ]]; then
    jq -n \
        --arg instance "${POCKET_ID_URL}" \
        --argjson drift "$(to_json "${drift_lines[@]}")" \
        --argjson notes "$(to_json "${note_lines[@]}")" \
        '{instance: $instance, drift: $drift, notes: $notes}'
else
    if ((${#drift_lines[@]} > 0)); then
        printf 'drift\n'
        printf '%s\n' "${drift_lines[@]}" | while IFS=$'\t' read -r subject detail; do
            printf '  x %s: %s\n' "${subject}" "${detail}"
        done
    fi
    if ((${#note_lines[@]} > 0)) && [[ "${quiet}" != true ]]; then
        printf 'notes\n'
        printf '%s\n' "${note_lines[@]}" | while IFS=$'\t' read -r subject detail; do
            printf '  - %s: %s\n' "${subject}" "${detail}"
        done
    fi
    printf '\nPocket ID: %s\n' "${POCKET_ID_URL}"
    if ((${#drift_lines[@]} == 0)); then
        printf 'No drift: the declared groups and clients all match.\n'
    else
        printf '%s drift(s), %s note(s).\n' "${#drift_lines[@]}" "${#note_lines[@]}"
    fi
fi

if ((${#drift_lines[@]} > 0)); then
    exit 1
fi
