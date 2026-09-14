#!/usr/bin/env bash
# Lists enabled apps and their volume types (static fromVolume vs dynamic)
# Usage: ./scripts/list-volumes.sh

set -euo pipefail

# Apps to exclude (system components and hostpath-based apps)
EXCLUDE_APPS=(
  "amd-gpu-operator"
  "cert-manager"
  "cloudnative-pg"
  "longhorn"
  "mariadb-operator"
  "minio"
  "nfd"
  "nvidia-gpu-operator"
  "rustfs"
  "tailscale"
  "traefik"
)

# Get all config as JSON
config=$(pulumi config -j) || {
  echo "Error: Failed to read Pulumi config. Run this script from a stack directory (e.g. stacks/apps)."
  exit 1
}

# Get enabled apps (excluding system components and hostpath apps)
enabled_apps=$(echo "$config" | jq -r '
  to_entries |
  map(select(.key | endswith(":enabled")) | select(.value.value == "true")) |
  map(.key | rtrimstr(":enabled")) |
  .[]
' | while read -r app; do
  skip=false
  for exclude in "${EXCLUDE_APPS[@]}"; do
    if [[ "$app" == "$exclude" ]]; then
      skip=true
      break
    fi
  done
  if [[ "$skip" == false ]]; then
    echo "$app"
  fi
done | sort)

echo "Static volumes (fromVolume):"
for app in $enabled_apps; do
  # Check if app or any sub-component has fromVolume
  has_fromvolume=$(echo "$config" | jq --arg app "$app" '
    to_entries |
    map(select(.key | startswith($app + ":") and contains("fromVolume"))) |
    length > 0
  ')
  
  if [[ "$has_fromvolume" == "true" ]]; then
    # List all fromVolume entries for this app
    echo "$config" | jq -r --arg app "$app" '
      to_entries |
      map(select(.key | startswith($app + ":") and contains("fromVolume"))) |
      map(.key | capture("^(?<fullkey>[^:]+:(?<subpath>.*)?fromVolume)$")) |
      map(if .subpath == "" then $app else "\($app)/\(.subpath | rtrimstr("/"))" end) |
      .[]
    '
  fi
done | sort -u

echo ""
echo "Dynamic volumes:"
for app in $enabled_apps; do
  # Check if app has NO fromVolume
  has_fromvolume=$(echo "$config" | jq --arg app "$app" '
    to_entries |
    map(select(.key | startswith($app + ":") and contains("fromVolume"))) |
    length > 0
  ')
  
  if [[ "$has_fromvolume" == "false" ]]; then
    echo "$app"
  fi
done | sort -u
