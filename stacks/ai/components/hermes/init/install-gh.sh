#!/bin/sh
set -eu

# Env:
#   DATA_PATH   writable profile volume
#   USER_ID     uid/gid that owns the installed binary
#   GH_VERSION  release to install, e.g. 2.103.3

# `gh` is not in the image either; its token comes from `.env` (see seed-profile.sh).
bin="$DATA_PATH/.local/bin"
mkdir -p "$bin"

if [ -x "$bin/gh" ] && [ "$(cat "$bin/.gh-version" 2>/dev/null)" = "$GH_VERSION" ]; then
    echo "gh $GH_VERSION already installed"
else
    case "$(uname -m)" in
        x86_64) arch=amd64 ;;
        aarch64) arch=arm64 ;;
        *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
    esac
    base="https://github.com/cli/cli/releases/download/v$GH_VERSION"
    name="gh_${GH_VERSION}_linux_${arch}.tar.gz"
    work="$(mktemp -d)"
    echo "Downloading $base/$name"
    wget -q -O "$work/$name" "$base/$name"
    wget -q -O "$work/checksums.txt" "$base/gh_${GH_VERSION}_checksums.txt"
    grep "  $name$" "$work/checksums.txt" > "$work/$name.sha256"
    (cd "$work" && sha256sum -c "$name.sha256")
    tar -xzf "$work/$name" -C "$work"
    cp "$work/gh_${GH_VERSION}_linux_${arch}/bin/gh" "$bin/gh"
    chmod 0755 "$bin/gh"
    rm -rf "$work"
    echo "$GH_VERSION" > "$bin/.gh-version"
fi

chown -R "$USER_ID:$USER_ID" "$bin"
"$bin/gh" --version
