#!/bin/sh
set -eu

# Env:
#   DATA_PATH   writable profile volume
#   SEED_PATH   read-only seeded config volume
#   USER_ID     uid/gid that owns the profile files
#   HERMES_BIN  the gateway's own CLI
#   PLUGINS     comma-separated plugin names, the same list the launch profile loads
#
# One line per profile in marmot-profiles.txt: <profile> <home> <socket>.
#
# This init runs before fix-volume-permissions and as root, and the image ships no
# privilege-drop tool, so the CLI writes as root and the files are handed back to
# USER_ID afterwards; a root-owned config.yaml would lock the gateway out of it.

[ -s "$SEED_PATH/marmot-profiles.txt" ] || exit 0

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
    "$HERMES_BIN" -p "$profile" config set platforms.marmot.enabled true
    "$HERMES_BIN" -p "$profile" config set platforms.marmot.extra.home "$home"
    "$HERMES_BIN" -p "$profile" config set platforms.marmot.extra.socket_path "$socket"
    "$HERMES_BIN" -p "$profile" config set platforms.marmot.extra.media_local_roots \
        "[\"$DATA_PATH/audio_cache\",\"$DATA_PATH/cache/documents\",\"$home/dev/inbound-media\"]"
    # A plugin that is linked but not named here is discovered and never loaded.
    "$HERMES_BIN" -p "$profile" config set plugins.enabled \
        "[\"$(printf '%s' "$PLUGINS" | sed 's/,/","/g')\"]"
    chown -R "$USER_ID:$USER_ID" "$DATA_PATH/profiles/$profile"
done < "$SEED_PATH/marmot-profiles.txt"
