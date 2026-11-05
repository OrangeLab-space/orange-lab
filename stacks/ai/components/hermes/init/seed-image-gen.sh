#!/bin/sh
set -eu

# Env:
#   COMFYUI_URL  endpoint of the ComfyUI the backend submits workflows to
#   HERMES_BIN   the gateway's own CLI
#   HERMES_HOME  the profile whose config.yaml is being written
#   PLUGINS      plugins.enabled, the same list the launch profile loads
#   USER_NAME    runtime user the gateway writes its config as

[ -n "${COMFYUI_URL:-}" ] || exit 0

as_runtime() {
    if [ "$(id -u)" = "0" ]; then
        s6-setuidgid "$USER_NAME" "$@"
    else
        "$@"
    fi
}

if ! as_runtime "$HERMES_BIN" config set image_gen.provider comfyui; then
    echo "seed-image-gen: could not set image_gen.provider" >&2
    exit 0
fi
as_runtime "$HERMES_BIN" config set image_gen.comfyui.base_url "$COMFYUI_URL" ||
    echo "seed-image-gen: could not set image_gen.comfyui.base_url" >&2

workflow_file="$HERMES_HOME/plugins/image_gen/comfyui/workflow.json"
if [ -f "$workflow_file" ]; then
    as_runtime "$HERMES_BIN" config set image_gen.comfyui.workflow_file "$workflow_file" ||
        echo "seed-image-gen: could not set image_gen.comfyui.workflow_file" >&2
fi

as_runtime "$HERMES_BIN" config set plugins.enabled \
    "[\"$(printf '%s' "$PLUGINS" | sed 's/,/","/g')\"]" ||
    echo "seed-image-gen: could not set plugins.enabled" >&2
