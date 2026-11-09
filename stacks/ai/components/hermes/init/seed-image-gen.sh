#!/bin/sh
set -eu

# Env:
#   COMFYUI_URL  endpoint of the ComfyUI the backend submits workflows to
#   HERMES_BIN   the gateway's own CLI
#   HERMES_HOME  the profile whose config.yaml is being written
#   PLUGINS      plugins.enabled, the same list the launch profile loads
#   USER_NAME    runtime user the gateway writes its config as
#   USER_ID      uid/gid of that user, for handing the file back

[ -n "${COMFYUI_URL:-}" ] || exit 0

failed=0

# This step runs as root, but config.yaml has to stay writable by the runtime
# user. The init container's PATH does not include /command, so a bare
# `s6-setuidgid` lookup fails and every write is skipped — resolve the tool by
# absolute path, and when it is absent write as root and hand the file back.
as_runtime() {
    if [ "$(id -u)" != "0" ]; then
        "$@"
        return $?
    fi
    if [ -x /command/s6-setuidgid ]; then
        /command/s6-setuidgid "$USER_NAME" "$@"
        return $?
    fi
    "$@"
    status=$?
    if [ "$status" = "0" ] && [ -n "${USER_ID:-}" ] && [ -f "$HERMES_HOME/config.yaml" ]; then
        chown "$USER_ID:$USER_ID" "$HERMES_HOME/config.yaml"
    fi
    return "$status"
}

# A failed write means the backend stays unconfigured, so it has to be visible:
# the old form exited 0 after a failed write and the pod started without it.
set_key() {
    if ! as_runtime "$HERMES_BIN" config set "$@"; then
        echo "seed-image-gen: could not set $1" >&2
        failed=1
    fi
}

set_key image_gen.provider comfyui
set_key image_gen.comfyui.base_url "$COMFYUI_URL"

workflow_file="$HERMES_HOME/plugins/image_gen/comfyui/workflow.json"
if [ -f "$workflow_file" ]; then
    set_key image_gen.comfyui.workflow_file "$workflow_file"
fi

set_key plugins.enabled \
    "[\"$(printf '%s' "$PLUGINS" | sed 's/,/","/g')\"]"

exit "$failed"
