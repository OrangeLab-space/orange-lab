#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat <<EOF
Usage: $0 [section]

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

Example:
  $0 app-admins
EOF
}

pocket_groups="$(git rev-parse --show-toplevel)/scripts/pocket-groups.sh"

section="${1:-all}"

base() {
    "$pocket_groups" \
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
    "$pocket_groups" \
        --group rustfs-admin \
            --friendly-name "Admins - Storage/RustFS" \
            --claim rustfs_policies=consoleAdmin \
        --group technitium-admin \
            --friendly-name "Admins - Network/Technitium" \
        --group grafana-admin \
            --friendly-name "Admins - Monitoring/Grafana" \
        --group forgejo-admin \
            --friendly-name "Admins - Dev/Forgejo" \
        --group home-assistant-admin \
            --friendly-name "Admins - IoT/Home Assistant" \
        --group frigate-admin \
            --friendly-name "Admins - IoT/Frigate" \
        --group jellyfin-admin \
            --friendly-name "Admins - Media/Jellyfin"
}

app_users() {
    "$pocket_groups" \
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
    base)
        base
        ;;
    app-admins)
        app_admins
        ;;
    app-users)
        app_users
        ;;
    all)
        base
        app_admins
        app_users
        ;;
    -h|--help)
        usage
        exit 0
        ;;
    *)
        printf 'Unknown section: %s\n\n' "$section" >&2
        usage >&2
        exit 2
        ;;
esac
