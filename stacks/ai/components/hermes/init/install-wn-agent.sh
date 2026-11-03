#!/bin/sh
set -eu

# Env:
#   DATA_PATH         writable profile volume
#   USER_ID           uid/gid that owns the installed binary
#   WN_AGENT_VERSION  release to install, e.g. 0.14.0

bin="$DATA_PATH/.local/bin"
mkdir -p "$bin"

if [ -x "$bin/wn-agent" ] && [ "$(cat "$bin/.wn-agent-version" 2>/dev/null)" = "$WN_AGENT_VERSION" ]; then
    echo "wn-agent $WN_AGENT_VERSION already installed"
else
    case "$(uname -m)" in
        x86_64 | aarch64) arch="$(uname -m)" ;;
        *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
    esac
    base="https://github.com/marmot-protocol/mdk/releases/download/wn-agent-v$WN_AGENT_VERSION"
    name="wn-agent-linux-${arch}-${WN_AGENT_VERSION}.tar.gz"
    work="$(mktemp -d)"
    echo "Downloading $base/$name"
    wget -q -O "$work/$name" "$base/$name"
    wget -q -O "$work/$name.sha256" "$base/$name.sha256"
    (cd "$work" && sha256sum -c "$name.sha256")
    tar -xzf "$work/$name" -C "$work"
    cp "$work/wn-agent-linux-${arch}/wn-agent" "$bin/wn-agent"
    chmod 0755 "$bin/wn-agent"
    rm -rf "$work"
    echo "$WN_AGENT_VERSION" > "$bin/.wn-agent-version"
fi

chown -R "$USER_ID:$USER_ID" "$bin"
# The binary is glibc-linked, so Alpine cannot execute it; the sidecar
# (app image) prints the version instead of this init container.
