#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat <<EOF
Usage: $0 --client-name <name> --groups <group,group> [--client-name <name> --groups <group,group>] ...

Restrict existing Pocket ID OIDC clients to the given groups, without touching
their callback or launch URLs. Use it for clients whose application is not
deployed, where the per-app wrapper cannot resolve an endpoint.

Each --client-name starts a new client. The --groups option that follows applies
to it. Groups must already exist.

Run from the repository root.

Required Pulumi config:
  pocket:apiKey   API key for the core stack
Required deployed outputs:
  security.endpoints.public.pocket

Example:
  $0 --client-name "Frigate" --groups admin,frigate-admin
EOF
}

client_names=()
group_lists=()
current=-1

while (($# > 0)); do
    case "$1" in
        --client-name)
            if [[ $# -lt 2 || "$2" == -* ]]; then
                printf 'Missing value for --client-name\n\n' >&2; usage >&2; exit 2
            fi
            client_names+=("$2")
            group_lists+=("")
            current=$((${#client_names[@]} - 1))
            shift 2
            ;;
        --groups)
            if [[ $# -lt 2 || "$2" == -* ]]; then
                printf 'Missing value for --groups\n\n' >&2; usage >&2; exit 2
            fi
            ((current >= 0)) || { printf '--groups given before any --client-name\n' >&2; exit 2; }
            group_lists[current]="$2"
            shift 2
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

if ((${#client_names[@]} == 0)); then
    printf 'No clients given.\n\n' >&2; usage >&2; exit 2
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
# API helper. Fails fast: a non-2xx answer is reported as-is instead of being
# retried, because retrying hides the real cause and can duplicate a write.
#
pocket_api() {
    local method="$1" endpoint="$2" response status body
    shift 2
    if ! response=$(curl --silent --show-error -w $'\n%{http_code}' -X "${method}" \
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

find_client_id() {
    pocket_api GET "/api/oidc/clients?search=$(jq -rn --arg v "$1" '$v|@uri')&pagination%5Blimit%5D=100" \
        -H "X-API-KEY: ${pocket_api_key}" |
        jq -er --arg name "$1" '[.data[] | select(.name == $name) | .id][0] // empty'
}

find_group_id() {
    pocket_api GET "/api/user-groups?search=$(jq -rn --arg v "$1" '$v|@uri')&pagination%5Blimit%5D=100" \
        -H "X-API-KEY: ${pocket_api_key}" |
        jq -er --arg name "$1" '[.data[] | select(.name == $name) | .id][0] // empty'
}

mark_client_restricted() {
    local client_id="$1" client_json update_body
    client_json=$(pocket_api GET "/api/oidc/clients/${client_id}" -H "X-API-KEY: ${pocket_api_key}")
    update_body=$(jq -c -n --argjson existing "${client_json}" '{
        name: $existing.name,
        description: ($existing.description // ""),
        callbackURLs: ($existing.callbackURLs // []),
        logoutCallbackURLs: ($existing.logoutCallbackURLs // []),
        isPublic: ($existing.isPublic // false),
        pkceEnabled: ($existing.pkceEnabled // false),
        requiresReauthentication: ($existing.requiresReauthentication // false),
        requiresPushedAuthorizationRequests: ($existing.requiresPushedAuthorizationRequests // false),
        skipConsent: ($existing.skipConsent // false),
        launchURL: $existing.launchURL,
        hasLogo: ($existing.hasLogo // false),
        hasDarkLogo: ($existing.hasDarkLogo // false),
        isGroupRestricted: true,
        accessTokenDurationMinutes: ($existing.accessTokenDurationMinutes // 60),
        refreshTokenDurationMinutes: ($existing.refreshTokenDurationMinutes // 43200)
    }')
    pocket_api PUT "/api/oidc/clients/${client_id}" \
        -H "X-API-KEY: ${pocket_api_key}" \
        -H 'Content-Type: application/json' \
        --data "${update_body}" > /dev/null
}

for i in "${!client_names[@]}"; do
    client_name="${client_names[$i]}"
    group_list="${group_lists[$i]}"

    if [[ -z "${group_list}" ]]; then
        printf 'Skipping %s: no --groups given.\n' "${client_name}" >&2
        continue
    fi

    if ! client_id=$(find_client_id "${client_name}"); then
        printf 'No Pocket ID client named "%s"; skipping.\n' "${client_name}" >&2
        continue
    fi

    group_ids=()
    for group_name in ${group_list//,/ }; do
        if ! group_id=$(find_group_id "${group_name}"); then
            printf 'Error: Pocket ID group not found: %s\n' "${group_name}" >&2
            exit 1
        fi
        group_ids+=("${group_id}")
    done

    pocket_api PUT "/api/oidc/clients/${client_id}/allowed-user-groups" \
        -H "X-API-KEY: ${pocket_api_key}" \
        -H 'Content-Type: application/json' \
        --data "$(jq -n '{userGroupIds: $ARGS.positional}' --args "${group_ids[@]}")" > /dev/null
    mark_client_restricted "${client_id}"
    printf 'Client restricted: %s -> %s\n' "${client_name}" "${group_list}"
done

printf 'Done.\n'
