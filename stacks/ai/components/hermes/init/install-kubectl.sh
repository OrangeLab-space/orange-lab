#!/bin/sh
set -eu

# Env:
#   DATA_PATH        writable profile volume
#   USER_ID          uid/gid that owns the installed binary
#   KUBECTL_VERSION  release to install, e.g. v1.36.6

# `kubectl` is not in the image. It lands in the profile's own bin directory,
# which the image already puts on PATH, so no shell configuration is needed.
bin="$DATA_PATH/.local/bin"
mkdir -p "$bin"

if [ -x "$bin/kubectl" ] && [ "$(cat "$bin/.kubectl-version" 2>/dev/null)" = "$KUBECTL_VERSION" ]; then
    echo "kubectl $KUBECTL_VERSION already installed"
else
    case "$(uname -m)" in
        x86_64) arch=amd64 ;;
        aarch64) arch=arm64 ;;
        *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
    esac
    url="https://dl.k8s.io/release/$KUBECTL_VERSION/bin/linux/$arch/kubectl"
    echo "Downloading $url"
    wget -q -O "$bin/kubectl.tmp" "$url"
    wget -q -O "$bin/kubectl.sha256" "$url.sha256"
    expected="$(cat "$bin/kubectl.sha256")"
    actual="$(sha256sum "$bin/kubectl.tmp" | cut -d" " -f1)"
    [ "$expected" = "$actual" ] || { echo "kubectl checksum mismatch" >&2; exit 1; }
    rm -f "$bin/kubectl.sha256"
    chmod 0755 "$bin/kubectl.tmp"
    mv "$bin/kubectl.tmp" "$bin/kubectl"
    echo "$KUBECTL_VERSION" > "$bin/.kubectl-version"
fi

chown -R "$USER_ID:$USER_ID" "$bin"
"$bin/kubectl" version --client
