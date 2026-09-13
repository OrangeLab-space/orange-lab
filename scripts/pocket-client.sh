#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat <<EOF
Usage: $0 --app-name <name> --client-name <name> --launch-url <url> --callback-url <url> [options]

Create or refresh a Pocket ID OIDC client for the application stack in the current directory.
Existing clients are reused and their secrets are not rotated.

Required parameters:
  --app-name <name>          Pulumi endpoint and config name, e.g. open-webui
  --client-name <name>       Pocket ID client display name, e.g. "Open WebUI"
  --launch-url <url>         Public application URL and Pocket ID launch URL
  --callback-url <url>       OIDC callback URL; may be specified multiple times
  --callback-urls <urls>     Comma- or space-separated OIDC callback URLs

Optional parameters:
  --logout-callback-url <url>      Logout callback URL; may be specified multiple times
  --logout-callback-urls <urls>    Comma- or space-separated logout callback URLs
  --dark-icon-url <url>      URL for the dark-theme client icon
  --light-icon-url <url>     URL for the light-theme client icon
  --pkce-enabled <boolean>   Enable PKCE (default: true)
  -h, --help                 Show this help

Run this script from the application's Pulumi stack directory.

Required Pulumi config:
  pocket:apiKey       API key for the root stack
Required deployed outputs:
  root security.endpoints.pocket
EOF
}

#
# Parameter parsing
#
app_name=''
client_name=''
launch_url=''
callback_urls=()
logout_callback_urls=()
dark_icon_url=''
light_icon_url=''
pkce_enabled=true

while (($# > 0)); do
    case "$1" in
        --app-name|--client-name|--launch-url|--callback-url|--callback-urls|--logout-callback-url|--logout-callback-urls|--dark-icon-url|--light-icon-url|--pkce-enabled)
            if [[ $# -lt 2 || "$2" == -* ]]; then
                printf 'Missing value for %s\n\n' "$1" >&2
                usage >&2
                exit 2
            fi
            case "$1" in
                --app-name) app_name="$2" ;;
                --client-name) client_name="$2" ;;
                --launch-url) launch_url="$2" ;;
                --callback-url) callback_urls+=("$2") ;;
                --callback-urls)
                    if [[ -n "$2" ]]; then
                        read -ra values <<<"${2//,/ }"
                        callback_urls+=("${values[@]}")
                    fi
                    ;;
                --logout-callback-url) logout_callback_urls+=("$2") ;;
                --logout-callback-urls)
                    if [[ -n "$2" ]]; then
                        read -ra values <<<"${2//,/ }"
                        logout_callback_urls+=("${values[@]}")
                    fi
                    ;;
                --dark-icon-url) dark_icon_url="$2" ;;
                --light-icon-url) light_icon_url="$2" ;;
                --pkce-enabled) pkce_enabled="$2" ;;
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
for parameter in app_name client_name launch_url; do
    if [[ -z "${!parameter}" ]]; then
        printf 'Missing required parameter: --%s\n\n' "${parameter//_/-}" >&2
        usage >&2
        exit 2
    fi
done
if ((${#callback_urls[@]} == 0)); then
    printf 'Missing required parameter: --callback-url\n\n' >&2
    usage >&2
    exit 2
fi
if [[ "${pkce_enabled}" != true && "${pkce_enabled}" != false ]]; then
    printf 'Invalid value for --pkce-enabled: %s (expected true or false)\n' "${pkce_enabled}" >&2
    exit 2
fi

#
# Configuration
#
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "${script_dir}/.." && pwd)
root_stack="$repo_root"

if [[ ! -f "$PWD/Pulumi.yaml" ]]; then
    printf 'Run this script from the application Pulumi stack directory.\n' >&2
    exit 1
fi

stack_output() {
    pulumi --cwd "$1" stack output --json
}

if ! pocket_api_key=$(pulumi --cwd "$root_stack" config get pocket:apiKey 2>/dev/null); then
    printf 'Missing secret config: pocket:apiKey\n' >&2
    printf 'Set it with: pulumi config set pocket:apiKey <api-key> --secret\n' >&2
    exit 1
fi

POCKET_ID_URL=$(stack_output "$root_stack" | jq -er '.security.endpoints.pocket')
POCKET_ID_URL="${POCKET_ID_URL%/}"
launch_url="${launch_url%/}"
callback_urls_json=$(printf '%s\n' "${callback_urls[@]}" | jq -R -s 'split("\n") | map(select(length > 0))')
if ((${#logout_callback_urls[@]} == 0)); then
    logout_callback_urls_json='[]'
else
    logout_callback_urls_json=$(printf '%s\n' "${logout_callback_urls[@]}" | jq -R -s 'split("\n") | map(select(length > 0))')
fi

#
# API helper with retry (Pocket ID intermittently answers 400/5xx)
#
pocket_api() {
    local method="$1"
    local endpoint="$2"
    shift 2
    local attempt response status=1
    for attempt in 1 2 3 4 5; do
        if response=$(curl --fail-with-body --silent --show-error -X "${method}" \
            "${POCKET_ID_URL}${endpoint}" "$@" 2>&1); then
            printf '%s' "${response}"
            return 0
        fi
        status=1
        printf 'Pocket ID request failed (attempt %s/5): %s %s\n' "${attempt}" "${method}" "${endpoint}" >&2
        printf '%s\n' "${response}" >&2
        sleep 3
    done
    return "${status}"
}

#
# Upload icons (shared by create and reuse paths)
#
tmp_dir=$(mktemp -d)
trap 'rm -rf "${tmp_dir}"' EXIT

upload_icon() {
    local url="$1"
    local filename="$2"
    local light="$3"
    local extension="${url##*/}"
    extension="${extension%%\?*}"
    extension="${extension##*.}"
    local mime_type

    case "${extension,,}" in
        svg) mime_type='image/svg+xml' ;;
        png) mime_type='image/png' ;;
        jpg|jpeg) mime_type='image/jpeg' ;;
        webp) mime_type='image/webp' ;;
        *)
            printf 'Unsupported icon format: %s\n' "${extension}" >&2
            exit 1
            ;;
    esac

    local icon_path="${tmp_dir}/${filename}.${extension}"
    if ! curl --fail --silent --show-error -o "${icon_path}" "${url}"; then
        printf 'Warning: icon download failed, skipping: %s\n' "${url}" >&2
        return 1
    fi
    # a missing icon is cosmetic and must not fail the whole run
    if ! pocket_api POST "/api/oidc/clients/${client_id}/logo?light=${light}" \
            -H "X-API-KEY: ${pocket_api_key}" \
            -F "file=@${icon_path};type=${mime_type}" > /dev/null; then
        printf 'Warning: icon upload failed - the client works without it, re-run the script to retry.\n' >&2
        return 1
    fi
}

#
# Create client
#
client_list=$(pocket_api GET "/api/oidc/clients?pagination%5Bpage%5D=1&pagination%5Blimit%5D=100" \
    -H "X-API-KEY: ${pocket_api_key}")
client_id=$(jq -er --arg name "${client_name}" \
    '[.data[] | select(.name == $name) | .id][0] // empty' <<<"${client_list}" || true)

if [[ -z "${client_id}" ]]; then
    if ! client_response=$(pocket_api POST /api/oidc/clients \
        -H "X-API-KEY: ${pocket_api_key}" \
        -H 'Content-Type: application/json' \
        --data "$(jq -n \
            --arg name "${client_name}" \
            --arg launch_url "${launch_url}" \
            --argjson callback_urls "${callback_urls_json}" \
            --argjson logout_callback_urls "${logout_callback_urls_json}" \
            --argjson pkce_enabled "${pkce_enabled}" \
            '{
                name: $name,
                callbackURLs: $callback_urls,
                logoutCallbackURLs: $logout_callback_urls,
                launchURL: $launch_url,
                isPublic: false,
                pkceEnabled: $pkce_enabled,
                skipConsent: true
            }')"); then
        printf 'Error: could not create the client after 5 attempts - re-run the script.\n' >&2
        exit 1
    fi
    client_id=$(jq -er '.id' <<<"${client_response}")

    if ! secret_response=$(pocket_api POST "/api/oidc/clients/${client_id}/secret" \
        -H "X-API-KEY: ${pocket_api_key}" \
        -H 'Content-Type: application/json' \
        --data '{}'); then
        printf 'Error: secret rotation failed, deleting the client to leave a clean state - re-run the script.\n' >&2
        pocket_api DELETE "/api/oidc/clients/${client_id}" -H "X-API-KEY: ${pocket_api_key}" >/dev/null || true
        exit 1
    fi
    client_secret=$(jq -er '.secret' <<<"${secret_response}")

    # commands are printed right away so later (non-fatal) failures
    # cannot hide the config values
    printf '\nClient created: %s\n' "${client_name}"
    printf 'pulumi config set %s:auth pocket\n' "${app_name}"
    printf 'pulumi config set %s:auth/clientId %q\n' "${app_name}" "${client_id}"
    printf 'pulumi config set %s:auth/clientSecret %q --secret\n' "${app_name}" "${client_secret}"

    # upload icons on the fresh client, then done
    if [[ -n "${dark_icon_url}" ]]; then
        upload_icon "${dark_icon_url}" dark true || true
    fi
    if [[ -n "${light_icon_url}" ]]; then
        upload_icon "${light_icon_url}" light false || true
    fi

    printf 'Done. If icon uploads warned above, re-run to retry them.\n'
    exit 0
else
    client_secret=''
fi

#
# Sync callback URLs on reused clients (merged, other settings untouched)
#
if [[ "${callback_urls_json}" != '[]' || "${logout_callback_urls_json}" != '[]' ]]; then
    existing_client=$(jq -c --arg name "${client_name}" \
        '[.data[] | select(.name == $name)][0]' <<<"${client_list}")
    missing_callback_urls=$(jq -c -n \
        --argjson existing "${existing_client}" \
        --argjson requested "${callback_urls_json}" \
        '$requested - ($existing.callbackURLs // [])')
    missing_logout_urls=$(jq -c -n \
        --argjson existing "${existing_client}" \
        --argjson requested "${logout_callback_urls_json}" \
        '$requested - ($existing.logoutCallbackURLs // [])')
    existing_pkce_enabled=$(jq -er '.pkceEnabled // false' <<<"${existing_client}")
    if [[ "${missing_callback_urls}" != '[]' || "${missing_logout_urls}" != '[]' || "${existing_pkce_enabled}" != "${pkce_enabled}" ]]; then
        update_body=$(jq -c -n \
            --argjson existing "${existing_client}" \
            --argjson requested_callbacks "${callback_urls_json}" \
            --argjson requested_logout "${logout_callback_urls_json}" \
            --argjson pkce_enabled "${pkce_enabled}" \
            '{
                name: $existing.name,
                description: ($existing.description // ""),
                callbackURLs: ((($existing.callbackURLs // []) + $requested_callbacks) | unique),
                logoutCallbackURLs: ((($existing.logoutCallbackURLs // []) + $requested_logout) | unique),
                isPublic: ($existing.isPublic // false),
                pkceEnabled: $pkce_enabled,
                requiresReauthentication: ($existing.requiresReauthentication // false),
                requiresPushedAuthorizationRequests: ($existing.requiresPushedAuthorizationRequests // false),
                skipConsent: ($existing.skipConsent // false),
                launchURL: $existing.launchURL,
                hasLogo: ($existing.hasLogo // false),
                hasDarkLogo: ($existing.hasDarkLogo // false),
                isGroupRestricted: ($existing.isGroupRestricted // false),
                accessTokenDurationMinutes: ($existing.accessTokenDurationMinutes // 60),
                refreshTokenDurationMinutes: ($existing.refreshTokenDurationMinutes // 43200)
            }')
        pocket_api PUT "/api/oidc/clients/${client_id}" \
            -H "X-API-KEY: ${pocket_api_key}" \
            -H 'Content-Type: application/json' \
            --data "${update_body}" > /dev/null
        printf 'Callback URLs synced.\n'
    else
        printf 'Callback URLs already up to date.\n'
    fi
fi

# Upload icons on the reused client
if [[ -n "${dark_icon_url}" ]]; then
    upload_icon "${dark_icon_url}" dark true || true
fi
if [[ -n "${light_icon_url}" ]]; then
    upload_icon "${light_icon_url}" light false || true
fi

#
# Output
#
printf '\nClient refreshed: %s\n' "${client_name}"
printf 'pulumi config set %s:auth pocket\n' "${app_name}"
printf 'pulumi config set %s:auth/clientId %q\n' "${app_name}" "${client_id}"
if [[ -n "${client_secret}" ]]; then
    printf 'pulumi config set %s:auth/clientSecret %q --secret\n' "${app_name}" "${client_secret}"
else
    printf 'Existing client reused; its secret was not rotated.\n'
fi
