#!/bin/sh
set -eu

# Env:
#   DATA_PATH   writable profile volume
#   SEED_PATH   read-only seeded config volume
#   USER_NAME   runtime user the gateway runs as
#   HERMES_BIN  the gateway's own CLI
#   PLUGINS     comma-separated plugin names, the same list the launch profile loads
#
# One line per profile in marmot-profiles.txt: <profile> <home> <socket>.

[ -s "$SEED_PATH/marmot-profiles.txt" ] || exit 0

# Init containers usually run as root, and a root-owned config.yaml would then
# lock the gateway out of its own profile file.
as_runtime() {
    if [ "$(id -u)" = "0" ]; then
        s6-setuidgid "$USER_NAME" "$@"
    else
        "$@"
    fi
}

while read -r profile home socket; do
    [ -n "$profile" ] || continue
    # A profile directory that does not exist yet is skipped: creating one here
    # would leave a half profile behind instead of waiting for the next start.
    [ -d "$DATA_PATH/profiles/$profile" ] || continue
    # A profile scope loads plugins from its own directory, so the launch copy is
    # linked rather than duplicated.
    mkdir -p "$DATA_PATH/profiles/$profile/plugins"
    case ",$PLUGINS," in
        *",marmot,"*)
            [ -e "$DATA_PATH/profiles/$profile/plugins/marmot" ] ||
                ln -s "$DATA_PATH/plugins/marmot" "$DATA_PATH/profiles/$profile/plugins/marmot"
            ;;
    esac
    # config.yaml carries keys this component does not own, so the CLI merges
    # into it instead of the component seeding a whole file over the top.
    as_runtime "$HERMES_BIN" -p "$profile" config set platforms.marmot.enabled true
    as_runtime "$HERMES_BIN" -p "$profile" config set platforms.marmot.extra.home "$home"
    as_runtime "$HERMES_BIN" -p "$profile" config set platforms.marmot.extra.socket_path "$socket"
    as_runtime "$HERMES_BIN" -p "$profile" config set platforms.marmot.extra.media_local_roots \
        "[\"$DATA_PATH/audio_cache\",\"$DATA_PATH/cache/documents\",\"$home/dev/inbound-media\"]"
    # A plugin that is linked but not named here is discovered and never loaded.
    as_runtime "$HERMES_BIN" -p "$profile" config set plugins.enabled \
        "[\"$(printf '%s' "$PLUGINS" | sed 's/,/","/g')\"]"
done < "$SEED_PATH/marmot-profiles.txt"
