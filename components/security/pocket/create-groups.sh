#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat <<EOF
Usage: $0 [section] [--print-spec]

Create Pocket ID groups for OrangeLab. Run from the repository root.
Sections can be run independently; the default is all of them.

Re-running only creates or updates the listed groups - it never deletes
anything, and groups you added by hand are left untouched. Remove a group
explicitly with scripts/pocket-groups.sh --delete <name>.

Sections:
  base         shared groups: admin, vpn-users
  app-admins   per-app admin groups
  app-users    per-app user groups
  all          every section (default)

Options:
  --print-spec   Print the expected group spec as JSON and exit without
                 touching Pocket ID (used by scripts/pocket-verify.sh)

Example:
  $0 app-admins
  $0 --print-spec | jq
EOF
}

pocket_groups="$(git rev-parse --show-toplevel)/scripts/pocket-groups.sh"

section=all
print_spec=false
for arg in "$@"; do
    case "$arg" in
        --print-spec) print_spec=true ;;
        -h|--help)
            usage
            exit 0
            ;;
        base|app-admins|app-users|all) section="$arg" ;;
        *)
            printf 'Unknown parameter: %s\n\n' "$arg" >&2
            usage >&2
            exit 2
            ;;
    esac
done

spec_args=()
if [[ "$print_spec" == true ]]; then
    spec_args=(--print-spec)
fi

base() {
    "$pocket_groups" "${spec_args[@]}" \
        --group admin \
            --friendly-name "Admins - All apps" \
            --claim rustfs_policies=consoleAdmin \
            --claim headplane_role=admin \
        --group vpn-users \
            --friendly-name "Users - VPN" \
            --all-users \
            --default-group
}

app_admins() {
    "$pocket_groups" "${spec_args[@]}" \
        --group rustfs-admin \
            --friendly-name "Admins - Storage/RustFS" \
            --claim rustfs_policies=consoleAdmin \
        --group technitium-admin \
            --friendly-name "Admins - Network/Technitium" \
        --group prometheus-admin \
            --friendly-name "Admins - Monitoring/Prometheus" \
        --group forgejo-admin \
            --friendly-name "Admins - Dev/Forgejo" \
        --group home-assistant-admin \
            --friendly-name "Admins - IoT/Home Assistant" \
        --group frigate-admin \
            --friendly-name "Admins - IoT/Frigate" \
        --group jellyfin-admin \
            --friendly-name "Admins - Media/Jellyfin" \
        --group traefik-admin \
            --friendly-name "Admins - Network/Traefik" \
        --group zot-admin \
            --friendly-name "Admins - Network/Zot" \
        --group beszel-admin \
            --friendly-name "Admins - Monitoring/Beszel" \
        --group longhorn-admin \
            --friendly-name "Admins - Storage/Longhorn" \
        --group invokeai-admin \
            --friendly-name "Admins - AI/InvokeAI"
}

app_users() {
    "$pocket_groups" "${spec_args[@]}" \
        --group open-webui-users \
            --friendly-name "Users - AI/Open WebUI" \
        --group n8n-users \
            --friendly-name "Users - AI/n8n" \
        --group immich-users \
            --friendly-name "Users - Media/Immich" \
        --group jellyfin-users \
            --friendly-name "Users - Media/Jellyfin" \
        --group droppedneedle-users \
            --friendly-name "Users - Media/DroppedNeedle" \
        --group seerr-users \
            --friendly-name "Users - Media/Seerr" \
        --group mempool-users \
            --friendly-name "Users - Bitcoin/Mempool" \
        --group forgejo-users \
            --friendly-name "Users - Dev/Forgejo" \
        --group nextcloud-users \
            --friendly-name "Users - Apps/Nextcloud" \
            --all-users \
            --default-group \
        --group vaultwarden-users \
            --friendly-name "Users - Apps/Vaultwarden" \
            --all-users \
            --default-group \
        --group rustfs-users \
            --friendly-name "Users - Storage/RustFS" \
            --claim rustfs_policies=readwrite
}

case "$section" in
    base) sections=(base) ;;
    app-admins) sections=(app_admins) ;;
    app-users) sections=(app_users) ;;
    all) sections=(base app_admins app_users) ;;
    *)
        printf 'Unknown section: %s\n\n' "$section" >&2
        usage >&2
        exit 2
        ;;
esac

if [[ "$print_spec" == true ]]; then
    for s in "${sections[@]}"; do "$s"; done | jq -s 'add | sort_by(.name)'
else
    for s in "${sections[@]}"; do "$s"; done
fi
