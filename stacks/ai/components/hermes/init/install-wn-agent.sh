#!/bin/sh
set -eu

# Env:
#   DATA_PATH         writable profile volume
#   USER_ID           uid/gid that owns the installed files
#   WN_AGENT_VERSION  release to install, e.g. 0.14.0

bin="$DATA_PATH/.local/bin"
plugin="$DATA_PATH/plugins/marmot"
marker="$DATA_PATH/plugins/.marmot-version"
base="https://github.com/marmot-protocol/mdk/releases/download/wn-agent-v$WN_AGENT_VERSION"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir -p "$bin" "$DATA_PATH/plugins"

# Both artefacts come from the same release, each verified against its
# published .sha256 before anything is copied into the volume.
fetch() {
    wget -q -O "$work/$1" "$base/$1"
    wget -q -O "$work/$1.sha256" "$base/$1.sha256"
    (cd "$work" && sha256sum -c "$1.sha256")
}

if [ -x "$bin/wn-agent" ] && [ "$(cat "$bin/.wn-agent-version" 2>/dev/null)" = "$WN_AGENT_VERSION" ]; then
    echo "wn-agent $WN_AGENT_VERSION already installed"
else
    case "$(uname -m)" in
        x86_64 | aarch64) arch="$(uname -m)" ;;
        *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
    esac
    name="wn-agent-linux-${arch}-${WN_AGENT_VERSION}.tar.gz"
    echo "Downloading $base/$name"
    fetch "$name"
    tar -xzf "$work/$name" -C "$work"
    cp "$work/wn-agent-linux-${arch}/wn-agent" "$bin/wn-agent"
    chmod 0755 "$bin/wn-agent"
    echo "$WN_AGENT_VERSION" > "$bin/.wn-agent-version"
fi

# The binary is only the transport: the gateway reaches it through the upstream
# Hermes plugin, which ships as a separate asset of the same release. Without
# it `platforms.marmot` is configured but never registers as a platform.
if [ -f "$plugin/plugin.yaml" ] && [ "$(cat "$marker" 2>/dev/null)" = "$WN_AGENT_VERSION" ]; then
    echo "marmot plugin $WN_AGENT_VERSION already installed"
else
    pname="hermes-marmot-plugin-${WN_AGENT_VERSION}.tar.gz"
    echo "Downloading $base/$pname"
    fetch "$pname"
    tar -xzf "$work/$pname" -C "$work"
    rm -rf "$plugin"
    mv "$work/hermes-marmot-plugin" "$plugin"
    echo "$WN_AGENT_VERSION" > "$marker"
fi

chown -R "$USER_ID:$USER_ID" "$bin" "$DATA_PATH/plugins"
# The binary is glibc-linked, so Alpine cannot execute it; the sidecar
# (app image) prints the version instead of this init container.
